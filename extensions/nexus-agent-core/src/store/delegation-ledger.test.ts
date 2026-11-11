// Follow-up plans (design 4.5.1, 9.5, INV-10): a draft is not a schedule, accepting is one transaction that writes the plan, its
// schedules and the carrier Work's reference together (and only after every check), a repeated click gives the same receipt,
// one Commitment has one accepted plan, and replacing it needs the current plan's id and version.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A, B } from "../test-support/goal-kit.js";
import { scheduleKit } from "../test-support/schedule-kit.js";

const kit = scheduleKit();
const { k, db, now, count, workWithTask, commitment, draft, accept, acceptedPlan, daily, body } =
  kit;

const plansOf = (commitmentId: string, status?: string) =>
  count(
    `SELECT COUNT(*) AS c FROM delegation_plans WHERE plan_owner_id = ?${status ? " AND status = ?" : ""}`,
    ...(status ? [commitmentId, status] : [commitmentId]),
  );
const row = <T>(sql: string, ...params: (string | number)[]) => db.prepare(sql).get(...params) as T;

describe("delegation plans: schema", () => {
  it("applies stage7-0008 and creates the four tables", () => {
    const names = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
    for (const table of [
      "delegation_plans",
      "schedules",
      "schedule_triggers",
      "goal_briefing_policies",
    ]) {
      assert.ok(names.has(table), table);
    }
    assert.equal(
      count("SELECT COUNT(*) AS c FROM schema_migrations WHERE id = 'stage7-0008-schedules'"),
      1,
    );
  });
});

describe("delegation plans: drafts", () => {
  it("a draft is never a schedule, and a replayed create answers with the same plan", () => {
    const w = workWithTask();
    const c = commitment();
    const first = draft(w.workId, c, { requestRef: "req-1" });
    assert.equal(first.status, "draft");
    assert.equal(first.planVersion, 1);
    assert.equal(
      count("SELECT COUNT(*) AS c FROM schedules"),
      count("SELECT COUNT(*) AS c FROM schedules WHERE plan_id <> ?", first.id),
    );
    const again = k.delegationPlanCreate({
      principal: A,
      workId: w.workId,
      planOwnerType: "commitment",
      planOwnerId: c,
      purpose: "跟进",
      createdBy: "user",
      requestRef: "req-1",
      now: now(),
    });
    assert.equal(again.outcome, "exists");
    assert.equal((again as { plan: { id: string } }).plan.id, first.id);
    assert.equal(plansOf(c), 1);
  });

  it("rejects what the plan cannot rest on", () => {
    const w = workWithTask();
    const c = commitment();
    const base = {
      principal: A,
      workId: w.workId,
      planOwnerType: "commitment" as const,
      planOwnerId: c,
      purpose: "跟进",
      createdBy: "user" as const,
      now: now(),
    };
    const code = (over: Record<string, unknown>) => {
      const out = k.delegationPlanCreate({ ...base, ...over } as Parameters<
        typeof k.delegationPlanCreate
      >[0]);
      return out.outcome === "invalid" ? (out as { code: string }).code : out.outcome;
    };
    assert.equal(code({ purpose: "  " }), "bad_purpose");
    assert.equal(code({ planOwnerType: "team" }), "bad_plan_owner_type");
    assert.equal(code({ workId: "w_nope" }), "work_not_found");
    assert.equal(code({ planOwnerId: "c_nope" }), "owner_missing");
    assert.equal(
      code({
        plan: body({
          schedules: [
            daily({ cadence: { kind: "interval", minutes: 14 }, scheduleKind: "recurring" }),
          ],
        }),
      }),
      "below_minimum",
    );
    assert.equal(
      code({
        plan: body({
          schedules: [daily({ scheduleKind: "once", cadence: { kind: "once", at: 5 } })],
        }),
      }),
      "once_in_past",
    );
    assert.equal(
      code({
        plan: body({ stopConditions: [{ kind: "goal_event", goalId: "", events: ["completed"] }] }),
      }),
      "bad_stop_conditions",
    );
    assert.equal(code({ startIntent: "later" }), "bad_start_intent");
    assert.equal(code({ replacesPlanId: "dp_nope" }), "bad_replaces");
    assert.equal(code({ createdBy: "robot" }), "bad_created_by");
    k.commitmentCancel({ principal: A, commitmentId: c, reason: "不做了", now: now() });
    assert.equal(code({}), "owner_closed");
  });

  it("does not see another owner's Work or Commitment", () => {
    const w = workWithTask();
    const c = commitment();
    const out = k.delegationPlanCreate({
      principal: B,
      workId: w.workId,
      planOwnerType: "commitment",
      planOwnerId: c,
      purpose: "跟进",
      createdBy: "user",
      now: now(),
    });
    assert.equal(out.outcome, "work_not_found");
    const mine = draft(w.workId, c);
    assert.equal(k.delegationPlanGet({ principal: B, planId: mine.id }).outcome, "not_found");
    assert.equal(k.delegationPlanList({ principal: B }).plans.length, 0);
  });

  it("edits only a draft, by compare-and-set on the plan version", () => {
    const p = draft(workWithTask().workId, commitment());
    const stale = k.delegationPlanUpdate({
      principal: A,
      planId: p.id,
      expectedPlanVersion: 7,
      changes: { purpose: "x" },
      now: now(),
    });
    assert.equal(stale.outcome, "conflict");
    const ok = k.delegationPlanUpdate({
      principal: A,
      planId: p.id,
      expectedPlanVersion: 1,
      changes: { purpose: "新的目的" },
      now: now(),
    });
    assert.equal(ok.outcome, "updated");
    assert.equal((ok as { plan: { planVersion: number; purpose: string } }).plan.planVersion, 2);
    const bad = k.delegationPlanUpdate({
      principal: A,
      planId: p.id,
      expectedPlanVersion: 2,
      changes: { plan: body({ schedules: [] }), gaps: [{ code: "" }] },
      now: now(),
    });
    assert.equal((bad as { code: string }).code, "bad_gaps");
    assert.equal(accept(p.id, { expectedPlanVersion: 2 }).outcome, "accepted");
    const late = k.delegationPlanUpdate({
      principal: A,
      planId: p.id,
      expectedPlanVersion: 2,
      changes: { purpose: "又改" },
      now: now(),
    });
    assert.equal(late.outcome, "not_draft");
  });

  it("revokes a draft but not an accepted plan", () => {
    const d = draft(workWithTask().workId, commitment());
    assert.equal(
      k.delegationPlanRevoke({ principal: A, planId: d.id, now: now() }).outcome,
      "revoked",
    );
    assert.equal(
      k.delegationPlanRevoke({ principal: A, planId: d.id, now: now() }).outcome,
      "unchanged",
    );
    assert.equal(accept(d.id).outcome, "not_draft");
    const a = acceptedPlan();
    assert.equal(
      k.delegationPlanRevoke({ principal: A, planId: a.plan.id, now: now() }).outcome,
      "not_draft",
    );
  });
});

describe("delegation plans: accepting", () => {
  it("writes plan, schedule, carrier reference and receipt together, and a second click changes nothing", () => {
    const w = workWithTask();
    const c = commitment();
    const p = draft(w.workId, c);
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM work_links WHERE work_id = ? AND target_id = ?",
        w.workId,
        c,
      ),
      0,
    );
    const done = accept(p.id);
    assert.equal(done.outcome, "accepted");
    const a = done as Extract<typeof done, { outcome: "accepted" }>;
    assert.equal(a.plan.status, "accepted");
    assert.equal(a.plan.acceptedResponsibilityVersion, 1);
    assert.equal(a.schedules.length, 1);
    const s = a.schedules[0]!;
    assert.equal(s.status, "active");
    assert.equal(s.ownerType, "commitment");
    assert.equal(s.ownerRef, c);
    assert.equal(s.workId, w.workId);
    assert.equal(s.planId, p.id);
    assert.equal(s.planVersion, 1);
    assert.ok(s.nextDueAt !== null && s.nextDueAt > 0);
    assert.equal(a.receipt.carrierLink, "added");
    const link = row<{ role: string }>(
      "SELECT role FROM work_links WHERE work_id = ? AND target_id = ? AND ended_at IS NULL",
      w.workId,
      c,
    );
    assert.equal(link.role, "reference");

    const again = accept(p.id);
    assert.equal(again.outcome, "already_accepted");
    assert.deepEqual((again as { receipt: unknown }).receipt, a.receipt);
    assert.equal(count("SELECT COUNT(*) AS c FROM schedules WHERE plan_id = ?", p.id), 1);
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM work_links WHERE work_id = ? AND target_id = ?",
        w.workId,
        c,
      ),
      1,
    );
  });

  it("keeps an existing required link instead of adding a second one", () => {
    const w = workWithTask();
    const c = commitment();
    k.workLinkAdd({
      principal: A,
      workId: w.workId,
      role: "required",
      targetKind: "commitment",
      targetId: c,
      actor: "user",
      now: now(),
    });
    const done = accept(draft(w.workId, c).id);
    assert.equal((done as { receipt: { carrierLink: string } }).receipt.carrierLink, "existing");
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM work_links WHERE work_id = ? AND target_id = ?",
        w.workId,
        c,
      ),
      1,
    );
  });

  it("refuses while gaps remain, and writes nothing", () => {
    const w = workWithTask();
    const c = commitment();
    const p = draft(w.workId, c, { gaps: [{ code: "source_not_connected", ref: "mail" }] });
    const out = accept(p.id);
    assert.equal(out.outcome, "gaps");
    assert.equal(count("SELECT COUNT(*) AS c FROM schedules WHERE plan_id = ?", p.id), 0);
    assert.equal(plansOf(c, "accepted"), 0);
    k.delegationPlanUpdate({
      principal: A,
      planId: p.id,
      expectedPlanVersion: 1,
      changes: { gaps: [] },
      now: now(),
    });
    assert.equal(accept(p.id, { expectedPlanVersion: 2 }).outcome, "accepted");
  });

  it("checks everything before it writes: a stale version, a changed Work, a past one-time check, a closed owner", () => {
    const w = workWithTask();
    const c = commitment();
    const p = draft(w.workId, c);
    assert.equal(accept(p.id, { expectedPlanVersion: 9 }).outcome, "conflict");
    db.prepare("UPDATE works SET current_work_version = current_work_version + 1 WHERE id = ?").run(
      w.workId,
    );
    assert.equal(accept(p.id).outcome, "work_changed");
    db.prepare("UPDATE works SET current_work_version = current_work_version - 1 WHERE id = ?").run(
      w.workId,
    );

    const soon = now() + 5_000;
    const once = draft(w.workId, commitment(), {
      plan: body({
        schedules: [daily({ scheduleKind: "once", cadence: { kind: "once", at: soon } })],
      }),
    });
    for (let i = 0; i < 8; i += 1) {
      now();
    }
    const late = accept(once.id);
    assert.equal(late.outcome, "invalid");
    assert.equal((late as { code: string }).code, "once_in_past");
    assert.equal(count("SELECT COUNT(*) AS c FROM schedules WHERE plan_id = ?", once.id), 0);
    assert.equal(
      row<{ status: string }>("SELECT status FROM delegation_plans WHERE id = ?", once.id).status,
      "draft",
    );
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM work_links WHERE work_id = ? AND target_id = ?",
        w.workId,
        once.planOwnerId,
      ),
      0,
    );

    const c3 = commitment();
    const p3 = draft(w.workId, c3);
    k.commitmentCancel({ principal: A, commitmentId: c3, reason: "不做了", now: now() });
    assert.equal(accept(p3.id).outcome, "owner_closed");
  });

  it("saves the schedules blocked when no dispatcher exists, and syncing the host brings them back", () => {
    const w = workWithTask();
    const c = commitment();
    const done = accept(draft(w.workId, c).id, { dispatchReady: false });
    const a = done as Extract<typeof done, { outcome: "accepted" }>;
    const s = a.schedules[0]!;
    assert.equal(s.status, "blocked");
    assert.equal(s.nextDueAt, null);
    assert.equal(s.coverageState, "unavailable");
    assert.deepEqual(s.blockReasons, [
      { code: "prerequisite_missing", ref: "host_capability:scheduled_dispatch", actor: "system" },
    ]);
    assert.deepEqual(a.receipt.blockedScheduleIds, [s.id]);
    const synced = k.scheduleSyncHost({ principal: A, dispatchReady: true, now: now() });
    assert.ok(synced.unblocked.includes(s.id));
    const live = k.scheduleGet({ principal: A, scheduleId: s.id });
    assert.equal((live as { schedule: { status: string } }).schedule.status, "active");
    const gone = k.scheduleSyncHost({ principal: A, dispatchReady: false, now: now() });
    assert.ok(gone.blocked.includes(s.id));
  });

  it("a watch schedule needs no dispatcher", () => {
    const w = workWithTask();
    const p = draft(w.workId, commitment(), {
      plan: body({ schedules: [daily({ executorKind: "watch", executorRef: "watch-1" })] }),
    });
    const done = accept(p.id, { dispatchReady: false });
    assert.equal((done as { schedules: { status: string }[] }).schedules[0]!.status, "active");
  });

  it("start now makes the first check due at once", () => {
    const w = workWithTask();
    const at = now();
    const done = accept(draft(w.workId, commitment(), { startIntent: "now" }).id, { now: at + 10 });
    assert.equal((done as { schedules: { nextDueAt: number }[] }).schedules[0]!.nextDueAt, at + 10);
  });

  it("rolls back whole when a write fails midway", () => {
    const w = workWithTask();
    const c = commitment();
    const p = draft(w.workId, c);
    db.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON work_links BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      assert.throws(() => accept(p.id));
    } finally {
      db.exec("DROP TRIGGER boom");
    }
    assert.equal(count("SELECT COUNT(*) AS c FROM schedules WHERE plan_id = ?", p.id), 0);
    assert.equal(
      row<{ status: string }>("SELECT status FROM delegation_plans WHERE id = ?", p.id).status,
      "draft",
    );
    assert.equal(accept(p.id).outcome, "accepted");
  });
});

describe("delegation plans: one accepted plan per Commitment", () => {
  it("a second plan is refused until it replaces the current one by id and version", () => {
    const first = acceptedPlan();
    const w2 = workWithTask();
    const second = draft(w2.workId, first.commitmentId);
    const refused = accept(second.id);
    assert.equal(refused.outcome, "plan_exists");
    assert.equal((refused as { currentPlanId: string }).currentPlanId, first.plan.id);

    const wrong = accept(second.id, { replaces: { planId: first.plan.id, planVersion: 9 } });
    assert.equal(wrong.outcome, "current_changed");
    assert.equal(plansOf(first.commitmentId, "accepted"), 1);

    const done = accept(second.id, {
      replaces: { planId: first.plan.id, planVersion: first.plan.planVersion },
    });
    assert.equal(done.outcome, "accepted");
    assert.equal(
      (done as { receipt: { replacedPlanId: string } }).receipt.replacedPlanId,
      first.plan.id,
    );
    const old = row<{ status: string; end_reason: string }>(
      "SELECT status, end_reason FROM delegation_plans WHERE id = ?",
      first.plan.id,
    );
    assert.deepEqual([old.status, old.end_reason], ["ended", "replaced"]);
    const oldSchedule = row<{ status: string; stop_reason: string }>(
      "SELECT status, stop_reason FROM schedules WHERE id = ?",
      first.scheduleId,
    );
    assert.deepEqual([oldSchedule.status, oldSchedule.stop_reason], ["cancelled", "plan_replaced"]);
    assert.equal(plansOf(first.commitmentId, "accepted"), 1);
  });

  it("the database itself refuses a second accepted plan", () => {
    const first = acceptedPlan();
    const spare = draft(workWithTask().workId, first.commitmentId);
    assert.throws(() =>
      db
        .prepare(
          "UPDATE delegation_plans SET status = 'accepted', accepted_at = 1, accepted_responsibility_version = 1 WHERE id = ?",
        )
        .run(spare.id),
    );
  });

  it("two plans on different Commitments do not collide", () => {
    acceptedPlan();
    acceptedPlan();
  });
});

describe("delegation plans: ending", () => {
  it("ends an accepted plan and cancels its schedules", () => {
    const a = acceptedPlan();
    const out = k.delegationPlanEnd({
      principal: A,
      planId: a.plan.id,
      reason: "不用了",
      now: now(),
    });
    assert.equal(out.outcome, "ended");
    assert.deepEqual((out as { cancelledScheduleIds: string[] }).cancelledScheduleIds, [
      a.scheduleId,
    ]);
    const s = row<{ status: string; stop_reason: string }>(
      "SELECT status, stop_reason FROM schedules WHERE id = ?",
      a.scheduleId,
    );
    assert.deepEqual([s.status, s.stop_reason], ["cancelled", "plan_ended"]);
    assert.equal(
      k.delegationPlanEnd({ principal: A, planId: a.plan.id, reason: "x", now: now() }).outcome,
      "unchanged",
    );
    // The Commitment is free for a new plan again.
    assert.equal(accept(draft(workWithTask().workId, a.commitmentId).id).outcome, "accepted");
  });

  it("does not end a draft", () => {
    const d = draft(workWithTask().workId, commitment());
    assert.equal(
      k.delegationPlanEnd({ principal: A, planId: d.id, reason: "x", now: now() }).outcome,
      "not_accepted",
    );
  });
});

describe("delegation plans: Goal plans", () => {
  it("accepting links the carrier Work to the Goal, and an executive Work is refused", () => {
    const goal = kit.mustGoal(kit.createViaGrant(A, "学钢琴").created);
    const w = workWithTask();
    const p = k.delegationPlanCreate({
      principal: A,
      workId: w.workId,
      planOwnerType: "personal_goal",
      planOwnerId: goal.id,
      purpose: "每周看练琴进度",
      plan: body(),
      createdBy: "agent",
      now: now(),
    });
    assert.equal(p.outcome, "created");
    const planId = (p as { plan: { id: string } }).plan.id;
    const done = accept(planId);
    assert.equal(done.outcome, "accepted");
    assert.equal((done as { receipt: { carrierLink: string } }).receipt.carrierLink, "added");
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM goal_work_links WHERE goal_id = ? AND work_id = ? AND role = 'reference' AND ended_at IS NULL",
        goal.id,
        w.workId,
      ),
      1,
    );

    const exec = k.create({
      principal: A,
      id: "TX",
      kind: "errand",
      title: "exec",
      goal: { text: "g" },
      entities: null,
      idempotencyKey: "op_TX",
      fingerprint: "fp",
      sessionKey: "agent:main:main",
      now: now(),
      work: { title: "Exec Work", origin: "user", contextMode: "executive" },
    });
    const refused = k.delegationPlanCreate({
      principal: A,
      workId: (exec as { workId: string }).workId,
      planOwnerType: "personal_goal",
      planOwnerId: goal.id,
      purpose: "x",
      createdBy: "user",
      now: now(),
    });
    assert.equal(refused.outcome, "executive_work");
  });
});

describe("delegation plans: who carries a Commitment's follow-up", () => {
  const carrier = (id: string) =>
    (
      k.delegationCarrier({ principal: A, commitmentId: id }) as {
        carrier: Record<string, unknown>;
      }
    ).carrier;
  const endLink = (workId: string, commitmentId: string) => {
    const link = row<{ id: string }>(
      "SELECT id FROM work_links WHERE work_id = ? AND target_id = ? AND ended_at IS NULL",
      workId,
      commitmentId,
    );
    const out = k.workLinkEnd({
      principal: A,
      workId,
      linkId: link.id,
      basis: "test",
      actor: "user",
      acknowledgeGap: true,
      now: now(),
    });
    assert.equal(out.outcome, "ended", JSON.stringify(out));
  };
  it("answers none, unique, multi, active, paused and replace", () => {
    const c = commitment();
    assert.deepEqual(carrier(c), { kind: "none" });
    const w1 = workWithTask();
    k.workLinkAdd({
      principal: A,
      workId: w1.workId,
      role: "reference",
      targetKind: "commitment",
      targetId: c,
      actor: "user",
      now: now(),
    });
    assert.deepEqual(carrier(c), { kind: "none" }, "a Work that only cites it cannot carry it");
    k.workLinkAdd({
      principal: A,
      workId: w1.workId,
      role: "required",
      targetKind: "commitment",
      targetId: c,
      actor: "user",
      now: now(),
    });
    // The Work already cites it as a reference; end that link first, then require it.
    endLink(w1.workId, c);
    k.workLinkAdd({
      principal: A,
      workId: w1.workId,
      role: "required",
      targetKind: "commitment",
      targetId: c,
      actor: "user",
      now: now(),
    });
    assert.deepEqual(carrier(c), { kind: "unique", workId: w1.workId });
    const w2 = workWithTask();
    k.workLinkAdd({
      principal: A,
      workId: w2.workId,
      role: "required",
      targetKind: "commitment",
      targetId: c,
      actor: "user",
      now: now(),
    });
    const multi = carrier(c);
    assert.equal(multi.kind, "multi");
    assert.equal((multi.candidates as unknown[]).length, 2);

    const done = accept(draft(w1.workId, c).id);
    const sid = (done as { schedules: { id: string }[] }).schedules[0]!.id;
    const active = carrier(c);
    assert.equal(active.kind, "active");
    assert.equal(active.workId, w1.workId);
    k.schedulePause({ principal: A, scheduleId: sid, source: "user", now: now() });
    assert.equal(carrier(c).kind, "paused");
    k.delegationPlanEnd({
      principal: A,
      planId: active.planId as string,
      reason: "换人",
      now: now(),
    });
    endLink(w1.workId, c);
    endLink(w2.workId, c);
    assert.equal(carrier(c).kind, "replace");
  });
  it("is not found for another owner", () => {
    const c = commitment();
    assert.equal(k.delegationCarrier({ principal: B, commitmentId: c }).outcome, "not_found");
  });
});

describe("goal letter policy", () => {
  it("is off by default, needs a cadence to be on, and is changed by compare-and-set", () => {
    const goal = kit.mustGoal(kit.createViaGrant(A, "读书").created);
    const get = (owner = A) => k.goalBriefingGet({ principal: owner, goalId: goal.id });
    assert.deepEqual(
      (get() as { policy: { enabled: boolean; version: number } }).policy.enabled,
      false,
    );
    assert.equal(
      k.goalBriefingSet({ principal: A, goalId: goal.id, enabled: true, now: now() }).outcome,
      "invalid",
    );
    const saved = k.goalBriefingSet({
      principal: A,
      goalId: goal.id,
      enabled: true,
      cadence: { kind: "weekly", weekday: 0 },
      expectedVersion: 0,
      now: now(),
    });
    assert.equal(saved.outcome, "saved");
    assert.equal((saved as { policy: { version: number } }).policy.version, 1);
    assert.equal(
      k.goalBriefingSet({
        principal: A,
        goalId: goal.id,
        enabled: true,
        expectedVersion: 0,
        now: now(),
      }).outcome,
      "conflict",
    );
    assert.equal(
      k.goalBriefingSet({ principal: A, goalId: goal.id, enabled: true, now: now() }).outcome,
      "unchanged",
    );
    const off = k.goalBriefingSet({ principal: A, goalId: goal.id, enabled: false, now: now() });
    assert.equal((off as { policy: { enabled: boolean; version: number } }).policy.version, 2);
    assert.equal(
      k.goalBriefingSet({
        principal: A,
        goalId: goal.id,
        enabled: true,
        cadence: { kind: "weekly", weekday: 9 },
        now: now(),
      }).outcome,
      "invalid",
    );
    assert.equal(k.goalBriefingGet({ principal: B, goalId: goal.id }).outcome, "not_found");
  });
});
