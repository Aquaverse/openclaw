// Schedules (design 4.5.2, 4.5.3, INV-10/12): the state machine and its pause rules, blocking with real reasons, no way back from
// ended or cancelled, and the trigger records that keep a due time from creating a check Task twice.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A, B } from "../test-support/goal-kit.js";
import { scheduleKit } from "../test-support/schedule-kit.js";

const kit = scheduleKit();
const { k, db, now, count, workWithTask, commitment, draft, accept, acceptedPlan, daily, body } =
  kit;

type S = {
  schedule: {
    id: string;
    status: string;
    pauseSource: string | null;
    nextDueAt: number | null;
    revision: number;
    stopReason: string | null;
  };
};
const get = (id: string, owner = A) =>
  k.scheduleGet({ principal: owner, scheduleId: id, triggers: 20 }) as unknown as S & {
    triggers: { outcome: string; slotOpen: boolean }[];
    gaps: unknown[];
  };
const status = (id: string) => get(id).schedule.status;
const row = <T>(sql: string, ...params: (string | number)[]) => db.prepare(sql).get(...params) as T;

/** An accepted plan whose one schedule is the given spec. */
const withSpec = (spec: ReturnType<typeof daily>) => {
  const w = workWithTask();
  const c = commitment();
  const plan = draft(w.workId, c, { plan: body({ schedules: [spec] }) });
  const done = accept(plan.id);
  assert.equal(done.outcome, "accepted", JSON.stringify(done));
  return {
    ...w,
    commitmentId: c,
    planId: plan.id,
    scheduleId: (done as { schedules: { id: string }[] }).schedules[0]!.id,
  };
};

describe("schedule state machine", () => {
  it("pauses and resumes; a user's pause is never undone by work control or the system", () => {
    const a = acceptedPlan();
    const paused = k.schedulePause({
      principal: A,
      scheduleId: a.scheduleId,
      source: "user",
      now: now(),
    });
    assert.equal(paused.outcome, "paused");
    const s = get(a.scheduleId).schedule;
    assert.equal(s.status, "paused");
    assert.equal(s.pauseSource, "user");
    assert.equal(s.nextDueAt, null);
    assert.equal(
      k.schedulePause({ principal: A, scheduleId: a.scheduleId, source: "user", now: now() })
        .outcome,
      "unchanged",
    );
    for (const by of ["work_control", "system"] as const) {
      assert.equal(
        k.scheduleResume({
          principal: A,
          scheduleId: a.scheduleId,
          by,
          dispatchReady: true,
          now: now(),
        }).outcome,
        "manual_pause_kept",
      );
    }
    assert.equal(status(a.scheduleId), "paused");
    const resumed = k.scheduleResume({
      principal: A,
      scheduleId: a.scheduleId,
      by: "user",
      dispatchReady: true,
      now: now(),
    });
    assert.equal(resumed.outcome, "resumed");
    const r = get(a.scheduleId).schedule;
    assert.equal(r.status, "active");
    assert.equal(r.pauseSource, null);
    assert.ok(r.nextDueAt !== null);
  });

  it("a work-control pause is undone by work control, and the user's pause takes it over", () => {
    const a = acceptedPlan();
    k.schedulePause({ principal: A, scheduleId: a.scheduleId, source: "work_control", now: now() });
    assert.equal(get(a.scheduleId).schedule.pauseSource, "work_control");
    k.schedulePause({ principal: A, scheduleId: a.scheduleId, source: "user", now: now() });
    assert.equal(get(a.scheduleId).schedule.pauseSource, "user");
    k.schedulePause({ principal: A, scheduleId: a.scheduleId, source: "work_control", now: now() });
    assert.equal(
      get(a.scheduleId).schedule.pauseSource,
      "user",
      "work control does not take the pause back",
    );
    const b = acceptedPlan();
    k.schedulePause({ principal: A, scheduleId: b.scheduleId, source: "work_control", now: now() });
    assert.equal(
      k.scheduleResume({
        principal: A,
        scheduleId: b.scheduleId,
        by: "work_control",
        dispatchReady: true,
        now: now(),
      }).outcome,
      "resumed",
    );
  });

  it("will not resume while a prerequisite is missing, and says which", () => {
    const a = acceptedPlan();
    k.schedulePause({ principal: A, scheduleId: a.scheduleId, source: "user", now: now() });
    k.commitmentCancel({
      principal: A,
      commitmentId: a.commitmentId,
      reason: "不做了",
      now: now(),
    });
    const out = k.scheduleResume({
      principal: A,
      scheduleId: a.scheduleId,
      by: "user",
      dispatchReady: true,
      now: now(),
    });
    assert.equal(out.outcome, "gaps");
    assert.deepEqual(
      (out as { gaps: { code: string }[] }).gaps.map((g) => g.code),
      ["owner_closed"],
    );
    assert.equal(status(a.scheduleId), "paused");

    const b = acceptedPlan();
    k.schedulePause({ principal: A, scheduleId: b.scheduleId, source: "user", now: now() });
    db.prepare(
      "UPDATE work_links SET ended_at = 1, end_basis = 'x' WHERE work_id = ? AND target_id = ?",
    ).run(b.workId, b.commitmentId);
    const gap = k.scheduleResume({
      principal: A,
      scheduleId: b.scheduleId,
      by: "user",
      dispatchReady: true,
      now: now(),
    });
    assert.deepEqual(
      (gap as { gaps: { code: string }[] }).gaps.map((g) => g.code),
      ["carrier_link_missing"],
    );
  });

  it("resuming without a dispatcher blocks instead of claiming coverage", () => {
    const a = acceptedPlan();
    k.schedulePause({ principal: A, scheduleId: a.scheduleId, source: "user", now: now() });
    k.scheduleResume({
      principal: A,
      scheduleId: a.scheduleId,
      by: "user",
      dispatchReady: false,
      now: now(),
    });
    const s = get(a.scheduleId).schedule;
    assert.equal(s.status, "blocked");
  });

  it("a one-time check whose time passed while paused ends as missed, never as an instant task", () => {
    const at = now() + 20_000;
    const w = withSpec(daily({ scheduleKind: "once", cadence: { kind: "once", at } }));
    k.schedulePause({ principal: A, scheduleId: w.scheduleId, source: "user", now: now() });
    while (now() < at + 1_000) {
      /* advance the test clock */
    }
    const out = k.scheduleResume({
      principal: A,
      scheduleId: w.scheduleId,
      by: "user",
      dispatchReady: true,
      now: now(),
    });
    assert.equal(out.outcome, "missed_window");
    assert.equal(get(w.scheduleId).schedule.stopReason, "missed_window");
    assert.equal(
      count("SELECT COUNT(*) AS c FROM schedule_triggers WHERE schedule_id = ?", w.scheduleId),
      0,
    );
  });

  it("cancel is final: nothing brings a cancelled or ended schedule back", () => {
    const a = acceptedPlan();
    const out = k.scheduleCancel({ principal: A, scheduleId: a.scheduleId, now: now() });
    assert.equal(out.outcome, "cancelled");
    assert.equal(get(a.scheduleId).schedule.stopReason, "user_cancelled");
    assert.equal(
      k.scheduleCancel({ principal: A, scheduleId: a.scheduleId, now: now() }).outcome,
      "already_final",
    );
    assert.equal(
      k.scheduleResume({
        principal: A,
        scheduleId: a.scheduleId,
        by: "user",
        dispatchReady: true,
        now: now(),
      }).outcome,
      "already_final",
    );
    assert.equal(
      k.schedulePause({ principal: A, scheduleId: a.scheduleId, source: "user", now: now() })
        .outcome,
      "already_final",
    );
    assert.throws(() =>
      db
        .prepare(
          "UPDATE schedules SET status = 'active', ended_at = NULL, stop_reason = NULL WHERE id = ?",
        )
        .run(a.scheduleId),
    );
  });

  it("checks the revision when the caller gives one", () => {
    const a = acceptedPlan();
    const rev = get(a.scheduleId).schedule.revision;
    assert.equal(
      k.schedulePause({
        principal: A,
        scheduleId: a.scheduleId,
        source: "user",
        expectedRevision: rev + 5,
        now: now(),
      }).outcome,
      "conflict",
    );
    assert.equal(
      k.schedulePause({
        principal: A,
        scheduleId: a.scheduleId,
        source: "user",
        expectedRevision: rev,
        now: now(),
      }).outcome,
      "paused",
    );
  });

  it("keeps another owner's schedule out of reach", () => {
    const a = acceptedPlan();
    assert.equal(k.scheduleGet({ principal: B, scheduleId: a.scheduleId }).outcome, "not_found");
    assert.equal(
      k.schedulePause({ principal: B, scheduleId: a.scheduleId, source: "user", now: now() })
        .outcome,
      "not_found",
    );
    assert.equal(k.scheduleList({ principal: B }).schedules.length, 0);
    assert.equal(k.scheduleList({ principal: A, planId: a.plan.id }).schedules.length, 1);
    assert.equal(
      k.scheduleList({ principal: A, planId: a.plan.id, statuses: ["paused"] }).schedules.length,
      0,
    );
  });

  it("the work of a schedule cannot change", () => {
    const a = acceptedPlan();
    const other = workWithTask();
    assert.throws(() =>
      db.prepare("UPDATE schedules SET work_id = ? WHERE id = ?").run(other.workId, a.scheduleId),
    );
  });
});

describe("schedule blocking", () => {
  it("blocks with real reasons, refuses to rewrite a pause as a block, and unblocks only when the gap is closed", () => {
    const a = acceptedPlan();
    assert.equal(
      (
        k.scheduleBlock({ principal: A, scheduleId: a.scheduleId, reasons: [], now: now() }) as {
          code: string;
        }
      ).code,
      "bad_block_reasons",
    );
    assert.equal(
      (
        k.scheduleBlock({
          principal: A,
          scheduleId: a.scheduleId,
          reasons: [{ code: "made_up" as never, actor: "system" }],
          now: now(),
        }) as { code: string }
      ).code,
      "bad_block_reasons",
    );
    const blocked = k.scheduleBlock({
      principal: A,
      scheduleId: a.scheduleId,
      reasons: [{ code: "source_auth_expired", ref: "mail", actor: "user" }],
      now: now(),
    });
    assert.equal(blocked.outcome, "blocked");
    const s = get(a.scheduleId).schedule as unknown as {
      status: string;
      nextDueAt: number | null;
      coverageState: string;
      blockReasons: unknown[];
    };
    assert.equal(s.status, "blocked");
    assert.equal(s.nextDueAt, null);
    assert.equal(s.coverageState, "unavailable");
    assert.equal(
      k.schedulePause({ principal: A, scheduleId: a.scheduleId, source: "user", now: now() })
        .outcome,
      "is_blocked",
    );

    assert.equal(
      k.scheduleUnblock({ principal: A, scheduleId: a.scheduleId, dispatchReady: true, now: now() })
        .outcome,
      "unblocked",
    );
    assert.equal(status(a.scheduleId), "active");
    assert.equal(
      k.scheduleUnblock({ principal: A, scheduleId: a.scheduleId, dispatchReady: true, now: now() })
        .outcome,
      "not_blocked",
    );

    k.schedulePause({ principal: A, scheduleId: a.scheduleId, source: "user", now: now() });
    assert.equal(
      k.scheduleBlock({
        principal: A,
        scheduleId: a.scheduleId,
        reasons: [{ code: "browser_not_ready", actor: "system" }],
        now: now(),
      }).outcome,
      "is_paused",
    );
    assert.equal(status(a.scheduleId), "paused");
  });

  it("stays blocked while the Commitment is closed, with the gap as the reason", () => {
    const a = acceptedPlan();
    k.scheduleBlock({
      principal: A,
      scheduleId: a.scheduleId,
      reasons: [{ code: "permission_missing", actor: "user" }],
      now: now(),
    });
    k.commitmentCancel({
      principal: A,
      commitmentId: a.commitmentId,
      reason: "不做了",
      now: now(),
    });
    const out = k.scheduleUnblock({
      principal: A,
      scheduleId: a.scheduleId,
      dispatchReady: true,
      now: now(),
    });
    assert.equal(out.outcome, "still_blocked");
    assert.deepEqual(
      (out as { reasons: { code: string; ref: string }[] }).reasons.map((r) => r.ref.split(":")[0]),
      ["owner_closed"],
    );
  });

  it("the database refuses a blocked schedule with no reason", () => {
    const a = acceptedPlan();
    assert.throws(() =>
      db
        .prepare("UPDATE schedules SET status = 'blocked', block_reasons_json = '[]' WHERE id = ?")
        .run(a.scheduleId),
    );
    assert.throws(() =>
      db
        .prepare("UPDATE schedules SET status = 'paused', pause_source = NULL WHERE id = ?")
        .run(a.scheduleId),
    );
  });
});

describe("schedule triggers", () => {
  const fire = (s: { scheduleId: string }, key: string, over: Record<string, unknown> = {}) =>
    k.scheduleRecordTrigger({
      principal: A,
      scheduleId: s.scheduleId,
      occurrenceKey: key,
      plannedAt: 5_000_000,
      source: "scheduled",
      outcome: "created",
      now: now(),
      ...over,
    } as Parameters<typeof k.scheduleRecordTrigger>[0]);

  it("records a due time once: a replay answers with the first record and creates nothing", () => {
    const a = acceptedPlan();
    const first = fire(a, "k1", { taskId: a.taskId });
    assert.equal(first.outcome, "recorded");
    const t = (first as { trigger: { slotOpen: boolean; outcome: string; planVersion: number } })
      .trigger;
    assert.equal(t.outcome, "created");
    assert.equal(t.slotOpen, true);
    assert.equal(t.planVersion, 1);
    const replay = fire(a, "k1", { taskId: a.taskId });
    assert.equal(replay.outcome, "duplicate");
    assert.equal(
      count("SELECT COUNT(*) AS c FROM schedule_triggers WHERE schedule_id = ?", a.scheduleId),
      1,
    );
  });

  it("moves a recurring schedule on to its next time; a missed beat is merged, not replayed", () => {
    const a = acceptedPlan();
    const before = get(a.scheduleId).schedule.nextDueAt as number;
    const at = now();
    fire(a, "k2", { taskId: a.taskId, plannedAt: before, now: at });
    const after = get(a.scheduleId).schedule.nextDueAt as number;
    assert.ok(
      after > Math.max(before, at),
      "the next time lies after both the planned time and now",
    );
    const merged = fire(a, "k3", {
      outcome: "merged",
      mergedOccurrenceKeys: ["x1", "x2"],
      plannedAt: after,
      now: now(),
    });
    assert.equal(merged.outcome, "recorded");
    assert.deepEqual(
      (merged as { trigger: { mergedOccurrenceKeys: string[] } }).trigger.mergedOccurrenceKeys,
      ["x1", "x2"],
    );
    assert.equal(
      (fire(a, "k4", { outcome: "merged", now: now() }) as { code: string }).code,
      "merged_keys_required",
    );
  });

  it("only a Task the schedule's Work owns can be recorded", () => {
    const a = acceptedPlan();
    const stranger = workWithTask();
    assert.equal(fire(a, "k5", { taskId: stranger.taskId }).outcome, "task_not_owned");
    assert.equal((fire(a, "k6") as { code: string }).code, "task_required");
    assert.equal(
      count("SELECT COUNT(*) AS c FROM schedule_triggers WHERE schedule_id = ?", a.scheduleId),
      0,
    );
  });

  it("one fired Task holds the slot until it is final", () => {
    const a = acceptedPlan();
    const second = workWithTask(A, a.workId);
    assert.equal(fire(a, "s1", { taskId: a.taskId }).outcome, "recorded");
    const busy = fire(a, "s2", { taskId: second.taskId });
    assert.equal(busy.outcome, "slot_busy");
    assert.equal((busy as { openTaskId: string }).openTaskId, a.taskId);
    assert.equal(
      count("SELECT COUNT(*) AS c FROM schedule_triggers WHERE occurrence_key = 's2'"),
      0,
    );
    // The database holds the same rule: a second open slot for the schedule cannot be written.
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO schedule_triggers (owner_id, id, schedule_id, schedule_revision, occurrence_key, plan_version, source, planned_at, outcome, task_id, slot_open, created_at) " +
            "SELECT owner_id, 'dup', schedule_id, 1, 'dup', 1, 'scheduled', 1, 'created', 'x', 1, 1 FROM schedule_triggers WHERE occurrence_key = 's1'",
        )
        .run(),
    );
    // The first Task ends: the slot frees (by the hook, or by the check that reads the Task).
    db.prepare("UPDATE nexus_tasks SET status = 'succeeded' WHERE id = ?").run(a.taskId);
    assert.equal(fire(a, "s3", { taskId: second.taskId }).outcome, "recorded");
    assert.equal(
      row<{ slot_open: number }>(
        "SELECT slot_open FROM schedule_triggers WHERE occurrence_key = 's1'",
      ).slot_open,
      0,
    );
  });

  it("releases a slot by Task, and reconciles slots whose Task already ended", () => {
    const a = acceptedPlan();
    fire(a, "r1", { taskId: a.taskId });
    assert.equal(k.scheduleReleaseSlot({ principal: A, taskId: a.taskId, now: now() }).released, 1);
    assert.equal(k.scheduleReleaseSlot({ principal: A, taskId: a.taskId, now: now() }).released, 0);
    const b = acceptedPlan();
    fire(b, "r2", { taskId: b.taskId });
    assert.equal(
      k.scheduleReconcileSlots({ principal: A, now: now() }).released,
      0,
      "its Task is still running",
    );
    db.prepare("UPDATE nexus_tasks SET status = 'failed' WHERE id = ?").run(b.taskId);
    assert.equal(k.scheduleReconcileSlots({ principal: A, now: now() }).released, 1);
  });

  it("a one-time schedule ends after its single dispatch, or when its window passed", () => {
    const at = now() + 50_000;
    const one = withSpec(daily({ scheduleKind: "once", cadence: { kind: "once", at } }));
    assert.equal(fire(one, "o1", { taskId: one.taskId, plannedAt: at }).outcome, "recorded");
    const s = get(one.scheduleId).schedule;
    assert.deepEqual([s.status, s.stopReason, s.nextDueAt], ["ended", "dispatched_once", null]);

    const late = withSpec(
      daily({ scheduleKind: "once", cadence: { kind: "once", at: now() + 50_000 } }),
    );
    assert.equal(fire(late, "o2", { outcome: "missed", plannedAt: at }).outcome, "recorded");
    assert.equal(get(late.scheduleId).schedule.stopReason, "missed_window");
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM schedule_triggers WHERE schedule_id = ? AND outcome = 'created'",
        late.scheduleId,
      ),
      0,
    );
  });

  it("a trigger that arrives after the schedule ended is kept and creates nothing", () => {
    const a = acceptedPlan();
    k.scheduleCancel({ principal: A, scheduleId: a.scheduleId, now: now() });
    const out = fire(a, "q1", { taskId: a.taskId });
    assert.equal(out.outcome, "recorded");
    const t = (
      out as {
        trigger: { outcome: string; taskId: string | null; slotOpen: boolean; skipReason: string };
      }
    ).trigger;
    assert.deepEqual(
      [t.outcome, t.taskId, t.slotOpen, t.skipReason],
      ["quarantined", null, false, "cancelled"],
    );
  });

  it("a paused or blocked schedule creates no Task, but may record that it skipped", () => {
    const a = acceptedPlan();
    k.schedulePause({ principal: A, scheduleId: a.scheduleId, source: "user", now: now() });
    assert.equal(fire(a, "p1", { taskId: a.taskId }).outcome, "not_active");
    const skipped = fire(a, "p2", { outcome: "skipped", skipReason: "paused" });
    assert.equal(skipped.outcome, "recorded");
    assert.equal(status(a.scheduleId), "paused");
  });

  it("a manual run needs five minutes between two accepted ones and does not move the beat", () => {
    const a = acceptedPlan();
    const second = workWithTask(A, a.workId);
    const next = get(a.scheduleId).schedule.nextDueAt;
    const at = now();
    assert.equal(
      fire(a, "m1", { source: "manual", taskId: a.taskId, now: at }).outcome,
      "recorded",
    );
    assert.equal(get(a.scheduleId).schedule.nextDueAt, next);
    db.prepare("UPDATE schedule_triggers SET slot_open = 0 WHERE occurrence_key = 'm1'").run();
    const soon = fire(a, "m2", { source: "manual", taskId: second.taskId, now: at + 60_000 });
    assert.equal(soon.outcome, "cooldown");
    assert.equal((soon as { retryAt: number }).retryAt, at + 5 * 60_000);
    assert.equal(
      fire(a, "m3", { source: "manual", taskId: second.taskId, now: at + 5 * 60_000 }).outcome,
      "recorded",
    );
  });

  it("rejects a malformed trigger", () => {
    const a = acceptedPlan();
    for (const over of [
      { occurrenceKey: "" },
      { plannedAt: -1 },
      { source: "cron" },
      { outcome: "lost" },
    ]) {
      const out = fire(a, "z", over);
      assert.equal(out.outcome, "invalid", JSON.stringify(over));
    }
  });
});

describe("schedule rows written by the database", () => {
  it("legacy watches come only from a migration, and a plan schedule needs its plan", () => {
    const a = acceptedPlan();
    const insert = (ownerType: string, via: string, plan: string | null) =>
      db
        .prepare(
          "INSERT INTO schedules (owner_id, id, work_id, owner_type, owner_ref, plan_id, plan_version, schedule_kind, purpose, cadence_json, tz, executor_kind, executor_ref, status, created_via, revision, created_at, updated_at) " +
            `VALUES ('owner-a', ?, ?, ?, 'r', ?, ${plan ? 1 : "NULL"}, 'recurring', 'p', '{}', 'UTC', 'watch', 'w', 'active', ?, 1, 1, 1)`,
        )
        .run(`x_${ownerType}_${via}_${plan}`, a.workId, ownerType, plan, via);
    assert.throws(() => insert("legacy_watch", "plan", null));
    assert.throws(() => insert("commitment", "plan", null));
    assert.doesNotThrow(() => insert("legacy_watch", "migration", null));
    assert.doesNotThrow(() => insert("commitment", "plan", a.plan.id));
  });
});

describe("schedules in the Work view", () => {
  const flagsOf = (workId: string) =>
    (
      k.workGet({ principal: A, workId, now: now(), eventLimit: 5 }) as {
        state: { flags?: string[] };
      }
    ).state.flags ?? [];
  it("a schedule's coverage reaches the Work: on plan while live, unavailable while paused or blocked, gone when cancelled", () => {
    const a = acceptedPlan();
    assert.ok(flagsOf(a.workId).includes("coverage_on_plan"));
    k.schedulePause({ principal: A, scheduleId: a.scheduleId, source: "user", now: now() });
    assert.ok(flagsOf(a.workId).includes("coverage_unavailable"));
    k.scheduleResume({
      principal: A,
      scheduleId: a.scheduleId,
      by: "user",
      dispatchReady: true,
      now: now(),
    });
    assert.ok(flagsOf(a.workId).includes("coverage_on_plan"));
    k.scheduleBlock({
      principal: A,
      scheduleId: a.scheduleId,
      reasons: [
        {
          code: "prerequisite_missing",
          ref: "host_capability:scheduled_dispatch",
          actor: "system",
        },
      ],
      now: now(),
    });
    assert.ok(flagsOf(a.workId).includes("coverage_unavailable"));
    k.scheduleCancel({ principal: A, scheduleId: a.scheduleId, now: now() });
    assert.ok(!flagsOf(a.workId).some((f) => f.startsWith("coverage_")));
  });
});
