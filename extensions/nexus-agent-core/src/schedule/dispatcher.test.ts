// The schedule dispatcher (design 4.5.3, W4b): a due time becomes ONE check Task and ONE trigger record, however often the timer
// ticks or the process restarts; busy slots skip, old due times merge, hopeless ones are missed, a refusing host gives up honestly.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { MAX_TURN_ATTEMPTS } from "../store/schedule-check-ledger.js";
import { dispatchKit, MIN } from "../test-support/dispatch-kit.js";
import { A, B } from "../test-support/goal-kit.js";
import { checkSessionKey, MAX_FIRES_PER_TICK, TURN_GRACE_MS } from "./dispatcher.js";

describe("dispatcher: firing a check", () => {
  it("every check gets a session of its own, in lower case", () => {
    assert.notEqual(checkSessionKey("sc_ABC", 1_000), checkSessionKey("sc_ABC", 2_000));
    assert.notEqual(checkSessionKey("sc_ABC", 1_000), checkSessionKey("sc_DEF", 1_000));
    const key = checkSessionKey("sc_ABC", 1_000);
    assert.equal(key, key.toLowerCase());
    assert.ok(key.startsWith("agent:main:nexus-check-"));
  });

  it("turns a due time into one check Task on the schedule's Work and asks the host to run it", async () => {
    const w = dispatchKit();
    const f = w.follow();
    w.advance(10_000);
    const report = await w.dispatcher.tick();
    assert.equal(report?.fired, 1);
    assert.equal(report?.turnsScheduled, 1);
    const [t] = w.triggers(f.scheduleId);
    assert.equal(t?.outcome, "created");
    assert.equal(t?.source, "scheduled");
    assert.equal(t?.turnState, "scheduled");
    assert.equal(t?.turnJobId, "job_1");
    assert.equal(t?.slotOpen, true);
    const task = w.taskRow(t!.taskId!);
    assert.equal(task?.kind, "schedule_check");
    assert.equal(task?.status, "clarifying");
    assert.equal(
      w.db.prepare("SELECT work_id FROM task_work_owner WHERE task_id = ?").get(t!.taskId!) &&
        (
          w.db.prepare("SELECT work_id FROM task_work_owner WHERE task_id = ?").get(t!.taskId!) as {
            work_id: string;
          }
        ).work_id,
      f.workId,
    );
    assert.equal(w.host.scheduled.length, 1);
    const call = w.host.scheduled[0]!;
    assert.equal(call.sessionKey, checkSessionKey(f.scheduleId, t!.plannedAt));
    assert.match(call.message, new RegExp(`\\[nexus:check:${t!.id}\\]`));
    assert.equal(call.tag, `nexus-check-${t!.id}`);
    assert.ok(!call.tag.includes(":"));
    // the schedule moved on: the next due time is in the future
    assert.ok((w.schedule(f.scheduleId).nextDueAt as number) > w.now());
    assert.ok(w.changedWorks.includes(f.workId));
  });

  it("a second tick, a replayed tick and a restart never create a second check", async () => {
    const w = dispatchKit();
    const f = w.follow();
    w.advance(10_000);
    await w.dispatcher.tick();
    await w.dispatcher.tick();
    await w.dispatcher.tick();
    assert.equal(w.triggers(f.scheduleId).length, 1);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM nexus_tasks WHERE kind = 'schedule_check'"), 1);
    assert.equal(w.host.scheduled.length, 1);
  });

  it("heals a crash between creating the Task and recording the trigger: same Task, no second one", async () => {
    const w = dispatchKit();
    const f = w.follow();
    w.advance(10_000);
    const due = w.schedule(f.scheduleId).nextDueAt as number;
    const key = `schedcheck:${f.scheduleId}:${f.scheduleId}@${due}#0`;
    const made = await w.store.create({
      principal: A,
      id: "TORPHAN01",
      kind: "schedule_check",
      title: "跟进检查",
      goal: { text: "x" },
      entities: null,
      idempotencyKey: key,
      fingerprint: key,
      sessionKey: checkSessionKey(f.scheduleId, 1),
      now: w.now(),
      work: { workId: f.workId, title: "跟进检查", origin: "agent" },
    });
    assert.equal(made.outcome, "created");
    await w.dispatcher.tick();
    const [t] = w.triggers(f.scheduleId);
    assert.equal(t?.taskId, "TORPHAN01");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM nexus_tasks WHERE kind = 'schedule_check'"), 1);
  });

  it("skips a due time while the previous check is still open, and says why", async () => {
    const w = dispatchKit();
    const f = w.follow();
    w.advance(10_000);
    await w.dispatcher.tick();
    w.advance(16 * MIN);
    const report = await w.dispatcher.tick();
    assert.equal(report?.skipped, 1);
    const rows = w.triggers(f.scheduleId);
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.outcome, "skipped");
    assert.equal(rows[1]?.skipReason, "previous_check_open");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM nexus_tasks WHERE kind = 'schedule_check'"), 1);
  });

  it("opens the slot again when the previous check Task ended, so the next due time fires", async () => {
    const w = dispatchKit();
    const f = w.follow();
    w.advance(10_000);
    await w.dispatcher.tick();
    const first = w.triggers(f.scheduleId)[0]!;
    w.db
      .prepare("UPDATE nexus_tasks SET status = 'succeeded', ended_at = 1 WHERE id = ?")
      .run(first.taskId!);
    w.advance(16 * MIN);
    const report = await w.dispatcher.tick();
    assert.equal(report?.fired, 1);
    assert.equal(w.triggers(f.scheduleId).filter((t) => t.outcome === "created").length, 2);
  });

  it("checks the newest overdue time as a catch-up and folds the older ones into one merged record", async () => {
    const w = dispatchKit();
    const f = w.follow();
    w.advance(52 * MIN);
    const report = await w.dispatcher.tick();
    assert.equal(report?.fired, 1);
    assert.equal(report?.merged, 1);
    const rows = w.triggers(f.scheduleId);
    const created = rows.find((t) => t.outcome === "created");
    const merged = rows.find((t) => t.outcome === "merged");
    assert.equal(created?.source, "catch_up");
    assert.equal(merged?.mergedOccurrenceKeys.length, 3);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM nexus_tasks WHERE kind = 'schedule_check'"), 1);
  });

  it("records a due time past its window as missed and degrades coverage; no Task, no instant check", async () => {
    const w = dispatchKit();
    const f = w.follow({
      cadence: { kind: "interval", minutes: 120, anchorAt: 5_000_000_000 },
      dispatchWindowMs: 10 * MIN,
    });
    w.advance(7 * 60 * MIN);
    const report = await w.dispatcher.tick();
    assert.equal(report?.missed, 1);
    assert.equal(report?.fired, 0);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM nexus_tasks WHERE kind = 'schedule_check'"), 0);
    const s = w.schedule(f.scheduleId);
    assert.equal(s.coverageState, "degraded");
    assert.equal(s.coverageNote, "missed_window");
    assert.ok((s.nextDueAt as number) > w.now());
  });

  it("a once-schedule fires once and ends dispatched_once; past its window it ends missed_window", async () => {
    const w = dispatchKit();
    const at = w.now() + 30 * MIN;
    const f = w.follow({ scheduleKind: "once", cadence: { kind: "once", at } }, false);
    w.setClock(at + 10_000);
    await w.dispatcher.tick();
    assert.equal(w.schedule(f.scheduleId).status, "ended");
    assert.equal(w.schedule(f.scheduleId).stopReason, "dispatched_once");

    const late = dispatchKit();
    const at2 = late.now() + 30 * MIN;
    const g = late.follow({ scheduleKind: "once", cadence: { kind: "once", at: at2 } }, false);
    late.setClock(at2 + 3 * 60 * MIN);
    await late.dispatcher.tick();
    assert.equal(late.schedule(g.scheduleId).stopReason, "missed_window");
    assert.equal(
      late.count("SELECT COUNT(*) AS c FROM nexus_tasks WHERE kind = 'schedule_check'"),
      0,
    );
  });

  it("blocks the schedule with the real gap instead of firing when its prerequisite is gone (INV-11)", async () => {
    const w = dispatchKit();
    const f = w.follow();
    // The carrier Work stops citing the commitment: a real gap while the commitment itself is still open.
    w.db.prepare("UPDATE work_links SET ended_at = 1 WHERE target_id = ?").run(f.commitmentId);
    w.advance(10_000);
    const report = await w.dispatcher.tick();
    assert.equal(report?.blocked, 1);
    assert.equal(report?.fired, 0);
    const s = w.schedule(f.scheduleId);
    assert.equal(s.status, "blocked");
    assert.match(s.blockReasons[0]?.ref ?? "", /carrier_link_missing/);
    assert.equal(w.host.scheduled.length, 0);
  });

  it("fires at most five checks per tick; the rest wait for the next tick", async () => {
    const w = dispatchKit();
    const made = Array.from({ length: MAX_FIRES_PER_TICK + 2 }, () => w.follow());
    w.advance(10_000);
    const first = await w.dispatcher.tick();
    assert.equal(first?.fired, MAX_FIRES_PER_TICK);
    const second = await w.dispatcher.tick();
    assert.equal(second?.fired, 2);
    for (const f of made) {
      assert.equal(w.triggers(f.scheduleId).filter((t) => t.outcome === "created").length, 1);
    }
  });

  it("never touches another owner's schedules", async () => {
    const w = dispatchKit();
    const f = w.follow();
    w.advance(10_000);
    const out = w.k.scheduleDueList({ principal: B, now: w.now() });
    assert.deepEqual(out.schedules, []);
    const begin = w.k.scheduleDispatchBegin({
      principal: B,
      scheduleId: f.scheduleId,
      occurrenceKey: "k",
      now: w.now(),
    });
    assert.equal(begin.outcome, "not_found");
  });
});

describe("dispatcher: the host turn", () => {
  it("keeps asking a refusing host, then gives up: Task failed, slot open, coverage degraded", async () => {
    const w = dispatchKit();
    const f = w.follow();
    w.host.refuse = true;
    w.advance(10_000);
    for (let i = 0; i < MAX_TURN_ATTEMPTS; i += 1) {
      await w.dispatcher.tick();
    }
    const [t] = w.triggers(f.scheduleId);
    assert.equal(t?.turnState, "failed");
    assert.match(t?.failReason ?? "", /turn_not_started/);
    assert.equal(t?.slotOpen, false);
    assert.equal(w.taskRow(t!.taskId!)?.status, "failed");
    const s = w.schedule(f.scheduleId);
    assert.equal(s.coverageState, "degraded");
    assert.equal(s.coverageNote, "check_failed");
    assert.equal(w.host.scheduled.length, MAX_TURN_ATTEMPTS);
  });

  it("a host that throws is counted like a refusal and recovers when it answers again", async () => {
    const w = dispatchKit();
    const f = w.follow();
    w.host.failWith = new Error("cron down");
    w.advance(10_000);
    await w.dispatcher.tick();
    assert.equal(w.triggers(f.scheduleId)[0]?.turnState, "pending");
    w.host.failWith = undefined;
    await w.dispatcher.tick();
    assert.equal(w.triggers(f.scheduleId)[0]?.turnState, "scheduled");
    assert.equal(w.triggers(f.scheduleId).length, 1);
  });

  it("closes a turn that was scheduled but never reported within the grace time, and removes its host job", async () => {
    const w = dispatchKit();
    const f = w.follow({
      cadence: { kind: "interval", minutes: 24 * 60, anchorAt: 5_000_000_000 },
    });
    w.advance(10_000);
    await w.dispatcher.tick();
    w.advance(TURN_GRACE_MS + MIN);
    const report = await w.dispatcher.tick();
    assert.equal(report?.turnsFailed, 1);
    const [t] = w.triggers(f.scheduleId);
    assert.equal(t?.turnState, "failed");
    assert.equal(t?.failReason, "turn_never_started");
    assert.equal(t?.slotOpen, false);
    assert.equal(w.taskRow(t!.taskId!)?.status, "failed");
    assert.ok(w.host.unscheduled.some((u) => u.tag === `nexus-check-${t!.id}`));
  });
});

describe("dispatcher: the host capability", () => {
  it("syncHost(true) brings back schedules that only waited for a dispatcher; syncHost(false) blocks them again", async () => {
    const w = dispatchKit();
    const wk = w.workWithTask();
    const c = w.commitment();
    const plan = w.draft(wk.workId, c, {
      plan: w.body({ schedules: [w.daily()] }),
    });
    const done = w.accept(plan.id, { dispatchReady: false });
    assert.equal(done.outcome, "accepted");
    const id = (done as { schedules: { id: string }[] }).schedules[0]!.id;
    assert.equal(w.schedule(id).status, "blocked");
    const up = await w.dispatcher.syncHost(true);
    assert.deepEqual(up.unblocked, [id]);
    assert.equal(w.schedule(id).status, "active");
    const down = await w.dispatcher.syncHost(false);
    assert.deepEqual(down.blocked, [id]);
    assert.equal(w.schedule(id).status, "blocked");
  });
});
