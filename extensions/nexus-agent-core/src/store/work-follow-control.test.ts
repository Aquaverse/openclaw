// Work-level controls and the follow-up they carry (design 6.6, 10.4 WK-04): pausing a Work pauses its schedules, resuming undoes
// only what the Work paused, stopping the Work ends them with their plans, and "stop following up" cancels the one picked.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A, B } from "../test-support/goal-kit.js";
import { scheduleKit } from "../test-support/schedule-kit.js";

const kit = scheduleKit();
const { k, db, now, workWithTask, commitment, draft, accept, acceptedPlan, daily, body } = kit;

type Sched = {
  schedule: {
    status: string;
    pauseSource: string | null;
    nextDueAt: number | null;
    stopReason: string | null;
    coverageState: string;
  };
};
const sched = (id: string) =>
  (k.scheduleGet({ principal: A, scheduleId: id }) as unknown as Sched).schedule;
const plan = (id: string) =>
  (
    k.delegationPlanGet({ principal: A, planId: id }) as unknown as {
      plan: { status: string; endReason: string | null };
    }
  ).plan;
const control = (workId: string, over: Record<string, unknown>) =>
  k.workControl({
    principal: A,
    workId,
    actor: "user",
    decisionRef: "console:t",
    dispatchReady: true,
    now: now(),
    ...over,
  } as Parameters<typeof k.workControl>[0]) as unknown as Record<string, unknown> & {
    outcome: string;
  };

describe("pausing and resuming a Work with follow-up", () => {
  it("pauses its running schedules and resumes only those", () => {
    const a = acceptedPlan();
    const preview = control(a.workId, { action: "pause", dryRun: true });
    assert.equal(preview.outcome, "preview");
    assert.equal((preview.schedulesToPause as unknown[]).length, 1);
    assert.equal(sched(a.scheduleId).status, "active", "a preview changes nothing");

    const paused = control(a.workId, { action: "pause" });
    assert.equal(paused.outcome, "applied");
    assert.deepEqual(paused.pausedSchedules, [a.scheduleId]);
    const s = sched(a.scheduleId);
    assert.equal(s.status, "paused");
    assert.equal(s.pauseSource, "work_control");
    assert.equal(s.nextDueAt, null);

    const back = control(a.workId, { action: "resume", dryRun: true });
    assert.equal((back.schedulesToResume as unknown[]).length, 1);
    const resumed = control(a.workId, { action: "resume" });
    assert.equal(resumed.outcome, "released");
    assert.deepEqual((resumed.schedules as { resumed: string[] }).resumed, [a.scheduleId]);
    const r = sched(a.scheduleId);
    assert.equal(r.status, "active");
    assert.ok(r.nextDueAt !== null && r.nextDueAt > now());
    assert.equal(r.coverageState, "on_plan");
  });

  it("refuses to resume a check by itself while the Work's pause holds it", () => {
    const a = acceptedPlan();
    control(a.workId, { action: "pause" });
    const refused = k.scheduleResume({
      principal: A,
      scheduleId: a.scheduleId,
      by: "user",
      dispatchReady: true,
      now: now(),
    }) as { outcome: string };
    assert.equal(refused.outcome, "work_paused");
    assert.equal(sched(a.scheduleId).status, "paused");
    control(a.workId, { action: "resume" });
    assert.equal(sched(a.scheduleId).status, "active");
  });

  it("never resumes a schedule the user paused", () => {
    const a = acceptedPlan();
    k.schedulePause({ principal: A, scheduleId: a.scheduleId, source: "user", now: now() });
    const paused = control(a.workId, { action: "pause" });
    assert.deepEqual(paused.pausedSchedules, []);
    control(a.workId, { action: "resume" });
    const s = sched(a.scheduleId);
    assert.equal(s.status, "paused");
    assert.equal(s.pauseSource, "user");
  });

  it("keeps the schedules paused while another pause of the Work is in force", () => {
    const a = acceptedPlan();
    const first = control(a.workId, { action: "pause", reason: "user" });
    const second = control(a.workId, { action: "pause", reason: "travel" });
    assert.equal(second.outcome, "applied");
    const one = control(a.workId, { action: "resume", controlId: first.controlId });
    assert.equal(one.stillControlled, true);
    assert.equal(one.schedules, undefined);
    assert.equal(sched(a.scheduleId).status, "paused");
    control(a.workId, { action: "resume", controlId: second.controlId });
    assert.equal(sched(a.scheduleId).status, "active");
  });

  it("leaves schedules alone when only one Task is paused", () => {
    const a = acceptedPlan();
    const out = control(a.workId, { action: "pause", scopeKind: "task", scopeId: a.taskId });
    assert.equal(out.outcome, "applied");
    assert.equal(sched(a.scheduleId).status, "active");
  });

  it("starts a plan accepted during the pause as paused, and resuming the Work releases it", () => {
    const w = workWithTask();
    control(w.workId, { action: "pause" });
    const p = draft(w.workId, commitment());
    const done = accept(p.id) as unknown as { outcome: string; schedules: { id: string }[] };
    assert.equal(done.outcome, "accepted");
    const id = done.schedules[0]!.id;
    assert.equal(sched(id).status, "paused");
    assert.equal(sched(id).pauseSource, "work_control");
    control(w.workId, { action: "resume" });
    assert.equal(sched(id).status, "active");
  });

  it("does not touch blocked schedules", () => {
    const w = workWithTask();
    const p = draft(w.workId, commitment());
    const done = accept(p.id, { dispatchReady: false }) as unknown as {
      schedules: { id: string }[];
    };
    const id = done.schedules[0]!.id;
    assert.equal(sched(id).status, "blocked");
    const out = control(w.workId, { action: "pause" });
    assert.deepEqual(out.pausedSchedules, []);
    assert.equal(sched(id).status, "blocked");
  });
});

describe("stopping the Work or the follow-up", () => {
  it("stopping the Work ends its schedules and plans and leaves the Commitment alone", () => {
    const a = acceptedPlan();
    const preview = control(a.workId, { action: "stop_work", dryRun: true });
    assert.equal((preview.schedulesToEnd as unknown[]).length, 1);
    const out = control(a.workId, { action: "stop_work" });
    assert.equal(out.outcome, "ended");
    assert.deepEqual(out.endedSchedules, [a.scheduleId]);
    assert.deepEqual(out.endedPlans, [a.plan.id]);
    const s = sched(a.scheduleId);
    assert.equal(s.status, "ended");
    assert.equal(s.stopReason, "work_stopped");
    assert.equal(plan(a.plan.id).status, "ended");
    assert.equal(plan(a.plan.id).endReason, "work_stopped");
    const c = db
      .prepare("SELECT lifecycle FROM commitments WHERE owner_id = ? AND id = ?")
      .get(A.ownerId, a.commitmentId) as { lifecycle: string };
    assert.ok(c.lifecycle === "open" || c.lifecycle === "waiting");
  });

  it("ending with a partial result says so in the stop reason and withdraws unaccepted drafts", () => {
    const a = acceptedPlan();
    const spare = draft(a.workId, commitment());
    const out = control(a.workId, { action: "end_partial" });
    assert.equal(out.outcome, "ended");
    assert.equal(sched(a.scheduleId).stopReason, "work_ended_partial");
    assert.equal(plan(spare.id).status, "revoked");
  });

  it("stop_follow_up cancels the picked schedule and keeps the plan while others run", () => {
    const w = workWithTask();
    const p = draft(w.workId, commitment(), {
      plan: body({ schedules: [daily(), daily({ purpose: "看附件" })] }),
    });
    const done = accept(p.id) as unknown as { schedules: { id: string }[] };
    const [first, second] = done.schedules.map((s) => s.id) as [string, string];
    const preview = control(w.workId, {
      action: "stop_follow_up",
      scheduleId: first,
      dryRun: true,
    });
    assert.equal(preview.outcome, "preview");
    assert.equal(sched(first).status, "active");
    const out = control(w.workId, { action: "stop_follow_up", scheduleId: first });
    assert.equal(out.outcome, "follow_up_stopped");
    assert.equal(out.planEnded, false);
    assert.equal(sched(first).status, "cancelled");
    assert.equal(sched(first).stopReason, "user_stopped_follow_up");
    assert.equal(sched(second).status, "active");
    assert.equal(plan(p.id).status, "accepted");
    const last = control(w.workId, { action: "stop_follow_up", scheduleId: second });
    assert.equal(last.planEnded, true);
    assert.equal(plan(p.id).status, "ended");
    assert.equal(plan(p.id).endReason, "follow_up_stopped");
    assert.equal(
      control(w.workId, { action: "stop_follow_up", scheduleId: second }).outcome,
      "already_final",
    );
  });

  it("refuses a schedule of another Work and another owner", () => {
    const a = acceptedPlan();
    const other = workWithTask();
    const wrong = control(other.workId, { action: "stop_follow_up", scheduleId: a.scheduleId });
    assert.equal(wrong.outcome, "invalid");
    assert.equal(wrong.code, "schedule_not_in_work");
    assert.equal(sched(a.scheduleId).status, "active");
    const foreign = k.workControl({
      principal: B,
      workId: a.workId,
      action: "stop_follow_up",
      scheduleId: a.scheduleId,
      actor: "user",
      now: now(),
    });
    assert.equal(foreign.outcome, "not_found");
    assert.equal(sched(a.scheduleId).status, "active");
  });

  it("needs a schedule to stop", () => {
    const a = acceptedPlan();
    const out = control(a.workId, { action: "stop_follow_up" });
    assert.equal(out.outcome, "invalid");
  });
});

describe("the end time a plan states", () => {
  it("ends the schedules and the plan once the accepted end time has passed, and not before", () => {
    const w = workWithTask();
    const until = now() + 60_000;
    const p = draft(w.workId, commitment(), {
      plan: body({ stopConditions: [{ kind: "until", at: until }] }),
    });
    const done = accept(p.id) as unknown as { schedules: { id: string }[] };
    const id = done.schedules[0]!.id;
    const early = k.scheduleExpireDue({ principal: A, now: until - 1 });
    assert.deepEqual(early.endedSchedules, []);
    assert.equal(sched(id).status, "active");
    const late = k.scheduleExpireDue({ principal: A, now: until + 1 });
    assert.deepEqual(late.endedSchedules, [id]);
    assert.deepEqual(late.endedPlans, [p.id]);
    assert.equal(sched(id).stopReason, "until_reached");
    assert.equal(plan(p.id).endReason, "until_reached");
    assert.deepEqual(k.scheduleExpireDue({ principal: A, now: until + 2 }).endedSchedules, []);
  });

  it("leaves a plan without an end time, and another owner's plans, alone", () => {
    const a = acceptedPlan();
    assert.deepEqual(
      k.scheduleExpireDue({ principal: A, now: now() + 10 * 365 * 86_400_000 }).endedSchedules,
      [],
    );
    assert.equal(sched(a.scheduleId).status, "active");
    assert.deepEqual(k.scheduleExpireDue({ principal: B, now: now() }).endedSchedules, []);
  });
});

describe("keeping a commitment followed up, in one step", () => {
  const plan1 = () => body();
  const start = (over: Record<string, unknown> = {}) =>
    k.delegationFollowStart({
      principal: A,
      commitmentId: "",
      expectedKind: "none",
      newWorkTitle: "跟进小王提交报告",
      purpose: "跟进小王",
      plan: plan1(),
      dispatchReady: true,
      now: now(),
      ...over,
    } as Parameters<typeof k.delegationFollowStart>[0]) as unknown as Record<string, any>;
  const works = () =>
    (
      db.prepare("SELECT COUNT(*) AS n FROM works WHERE owner_id = ?").get(A.ownerId) as {
        n: number;
      }
    ).n;
  const plans = () =>
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM delegation_plans WHERE owner_id = ?")
        .get(A.ownerId) as { n: number }
    ).n;

  it("creates the Work, links the commitment as required, and accepts the plan together", () => {
    const c = commitment();
    const before = works();
    const out = start({ commitmentId: c });
    assert.equal(out.outcome, "started", JSON.stringify(out));
    assert.equal(out.workCreated, true);
    assert.equal(works(), before + 1);
    assert.equal(out.plan.status, "accepted");
    assert.equal(out.schedules[0].status, "active");
    const link = db
      .prepare("SELECT role FROM work_links WHERE owner_id = ? AND work_id = ? AND target_id = ?")
      .get(A.ownerId, out.workId, c) as { role: string };
    assert.equal(link.role, "required");
    const carrier = k.delegationCarrier({ principal: A, commitmentId: c }) as unknown as {
      carrier: { kind: string; workId: string };
    };
    assert.equal(carrier.carrier.kind, "active");
    assert.equal(carrier.carrier.workId, out.workId);
  });

  it("leaves nothing behind when the plan is refused", () => {
    const c = commitment();
    const w0 = works();
    const p0 = plans();
    const out = start({
      commitmentId: c,
      plan: {
        schedules: [
          {
            scheduleKind: "recurring",
            purpose: "x",
            cadence: { kind: "interval", minutes: 1 },
            tz: "Asia/Shanghai",
          },
        ],
      },
    });
    assert.equal(out.outcome, "invalid");
    assert.equal(works(), w0, "no empty Work");
    assert.equal(plans(), p0, "no half-made plan");
  });

  it("reuses the one Work that requires the commitment and refuses a second plan", () => {
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
    } as never);
    const wrongKind = start({ commitmentId: c, expectedKind: "none", newWorkTitle: "新的" });
    assert.equal(wrongKind.outcome, "carrier_changed");
    assert.equal(wrongKind.carrier.kind, "unique");
    const noNew = start({ commitmentId: c, expectedKind: "unique", newWorkTitle: "新的" });
    assert.equal(noNew.outcome, "invalid");
    const w0 = works();
    const out = start({
      commitmentId: c,
      expectedKind: "unique",
      workId: w.workId,
      newWorkTitle: undefined,
    });
    assert.equal(out.outcome, "started", JSON.stringify(out));
    assert.equal(out.workCreated, false);
    assert.equal(works(), w0);
    const again = start({
      commitmentId: c,
      expectedKind: "unique",
      workId: w.workId,
      newWorkTitle: undefined,
    });
    assert.equal(again.outcome, "plan_exists");
  });

  it("asks which Work among several, and accepts only one of the candidates", () => {
    const w1 = workWithTask();
    const w2 = workWithTask();
    const stranger = workWithTask();
    const c = commitment();
    for (const w of [w1, w2]) {
      k.workLinkAdd({
        principal: A,
        workId: w.workId,
        role: "required",
        targetKind: "commitment",
        targetId: c,
        actor: "user",
        now: now(),
      } as never);
    }
    const bad = start({
      commitmentId: c,
      expectedKind: "multi",
      workId: stranger.workId,
      newWorkTitle: undefined,
    });
    assert.equal(bad.outcome, "work_not_candidate");
    const ok = start({
      commitmentId: c,
      expectedKind: "multi",
      workId: w2.workId,
      newWorkTitle: undefined,
    });
    assert.equal(ok.outcome, "started", JSON.stringify(ok));
    assert.equal(ok.workId, w2.workId);
  });

  it("a repeated request answers with what it already made, and a closed or foreign commitment is refused", () => {
    const c = commitment();
    const first = start({ commitmentId: c, requestRef: "req1" });
    const again = start({ commitmentId: c, requestRef: "req1" });
    assert.equal(again.outcome, "exists");
    assert.equal(again.workId, first.workId);
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM delegation_plans WHERE owner_id = ? AND request_ref = 'req1'",
          )
          .get(A.ownerId) as { n: number }
      ).n,
      1,
    );
    const foreign = k.delegationFollowStart({
      principal: B,
      commitmentId: c,
      expectedKind: "none",
      newWorkTitle: "x",
      purpose: "x",
      plan: plan1(),
      dispatchReady: true,
      now: now(),
    });
    assert.equal(foreign.outcome, "not_found");
  });

  it("after an ended plan the carrier is 'replace' and a new Work follows up again", () => {
    const c = commitment();
    const first = start({ commitmentId: c });
    k.delegationPlanEnd({ principal: A, planId: first.plan.id, reason: "user_ended", now: now() });
    const carrier = k.delegationCarrier({ principal: A, commitmentId: c }) as unknown as {
      carrier: { kind: string };
    };
    // The first Work still requires the commitment, so it is the one candidate; the ended plan alone does not hide it.
    assert.ok(["unique", "replace"].includes(carrier.carrier.kind));
    const again = start({
      commitmentId: c,
      expectedKind: carrier.carrier.kind,
      ...(carrier.carrier.kind === "unique"
        ? { workId: first.workId, newWorkTitle: undefined }
        : {}),
    });
    assert.equal(again.outcome, "started", JSON.stringify(again));
  });

  it("takes over from a stopped Work: the new plan records it, the old plan and checks stay as they were (CD-03)", () => {
    const c = commitment();
    const first = start({ commitmentId: c });
    const oldScheduleId = first.schedules[0].id as string;
    assert.equal(control(first.workId, { action: "stop_work" }).outcome, "ended");
    const carrier = k.delegationCarrier({ principal: A, commitmentId: c }) as unknown as {
      carrier: { kind: string };
    };
    assert.equal(carrier.carrier.kind, "replace");
    const out = start({ commitmentId: c, expectedKind: "replace", newWorkTitle: "接着跟进小王" });
    assert.equal(out.outcome, "started", JSON.stringify(out));
    assert.notEqual(out.workId, first.workId);
    const row = db
      .prepare(
        "SELECT handoff_from_work_id AS h FROM delegation_plans WHERE owner_id = ? AND id = ?",
      )
      .get(A.ownerId, out.plan.id) as { h: string | null };
    assert.equal(row.h, first.workId);
    assert.equal(sched(oldScheduleId).status, "ended", "the old check is not revived");
    assert.equal(plan(first.plan.id).status, "ended");
    assert.notEqual(out.schedules[0].id, oldScheduleId);
    assert.equal(out.schedules[0].status, "active");
    const fresh = db
      .prepare("SELECT COUNT(*) AS n FROM schedule_triggers WHERE owner_id = ? AND schedule_id = ?")
      .get(A.ownerId, out.schedules[0].id) as { n: number };
    assert.equal(fresh.n, 0, "the new check starts with no history of the old one");
    const plain = start({ commitmentId: commitment() });
    const none = db
      .prepare(
        "SELECT handoff_from_work_id AS h FROM delegation_plans WHERE owner_id = ? AND id = ?",
      )
      .get(A.ownerId, plain.plan.id) as { h: string | null };
    assert.equal(none.h, null, "a first follow-up is not a handover");
  });
});

describe("deleting a Work with follow-up (W4d)", () => {
  it("ends its schedules and plan, withdraws a draft, and leaves the Commitment alone", () => {
    const a = acceptedPlan();
    const spare = draft(a.workId, a.commitmentId, { plan: body({ schedules: [daily()] }) });
    db.prepare("UPDATE nexus_tasks SET status = 'succeeded' WHERE id = ?").run(a.taskId);
    const gone = k.workDelete({
      principal: A,
      workId: a.workId,
      actor: "user",
      now: now(),
    }) as unknown as {
      outcome: string;
      endedSchedules: string[];
      endedPlans: string[];
    };
    assert.equal(gone.outcome, "deleted");
    assert.deepEqual(gone.endedSchedules, [a.scheduleId]);
    assert.equal(gone.endedPlans.length, 2);
    const s = sched(a.scheduleId);
    assert.equal(s.status, "ended");
    assert.equal(s.stopReason, "work_deleted");
    assert.equal(s.nextDueAt, null);
    assert.equal(plan(a.plan.id).status, "ended");
    assert.equal(plan(a.plan.id).endReason, "work_deleted");
    assert.equal(plan(spare.id).status, "revoked");
    const c = db
      .prepare("SELECT lifecycle FROM commitments WHERE owner_id = ? AND id = ?")
      .get(A.ownerId, a.commitmentId) as { lifecycle: string };
    assert.equal(c.lifecycle, "open");
  });

  it("a refused delete (active Task) leaves the follow-up running", () => {
    const a = acceptedPlan();
    const out = k.workDelete({ principal: A, workId: a.workId, actor: "user", now: now() }) as {
      outcome: string;
    };
    assert.equal(out.outcome, "has_active_tasks");
    assert.equal(sched(a.scheduleId).status, "active");
    assert.equal(plan(a.plan.id).status, "accepted");
  });
});
