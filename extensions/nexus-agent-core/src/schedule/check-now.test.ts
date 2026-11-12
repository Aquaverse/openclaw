// "Check now" (design 4.5.3, W4c): the user's own request runs the same check as a due time, as an extra one. It never moves the
// schedule's beat, waits for a free slot, respects a cooldown, refuses a paused or foreign schedule, and asks the host at once.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { dispatchKit, MIN } from "../test-support/dispatch-kit.js";
import { A, B } from "../test-support/goal-kit.js";
import { MANUAL_TRIGGER_COOLDOWN_MS } from "./types.js";

describe("dispatcher: check now", () => {
  it("starts one extra check at once, asks the host right away and leaves the schedule's own beat alone", async () => {
    const w = dispatchKit();
    const f = w.follow({}, false);
    const before = w.schedule(f.scheduleId);
    assert.ok((before.nextDueAt as number) > w.now(), "nothing is due yet");
    const out = await w.dispatcher.checkNow(A, f.scheduleId);
    assert.equal(out.outcome, "started");
    const [t] = w.triggers(f.scheduleId);
    assert.equal(t?.outcome, "created");
    assert.equal(t?.source, "manual");
    assert.equal(t?.turnState, "scheduled", "the host was asked without waiting for the timer");
    assert.equal(w.host.scheduled.length, 1);
    assert.equal(w.taskRow(t!.taskId!)?.kind, "schedule_check");
    const after = w.schedule(f.scheduleId);
    assert.equal(after.nextDueAt, before.nextDueAt, "an extra check does not move the beat");
    assert.equal(after.status, "active");
    assert.ok(w.changedWorks.includes(f.workId));
  });

  it("allows one manual check per cooldown, and a busy slot refuses it even after the cooldown", async () => {
    const w = dispatchKit();
    const f = w.follow({}, false);
    const first = await w.dispatcher.checkNow(A, f.scheduleId);
    assert.equal(first.outcome, "started");
    w.advance(MIN);
    const again = await w.dispatcher.checkNow(A, f.scheduleId);
    assert.equal(again.outcome, "cooldown");
    assert.ok(again.outcome === "cooldown" && again.retryAt > w.now());
    assert.ok(
      again.outcome === "cooldown" && again.retryAt - w.now() <= MANUAL_TRIGGER_COOLDOWN_MS,
    );
    assert.equal(w.triggers(f.scheduleId).length, 1, "a refused request leaves no trace");
    w.advance(MANUAL_TRIGGER_COOLDOWN_MS);
    const busy = await w.dispatcher.checkNow(A, f.scheduleId);
    assert.equal(busy.outcome, "slot_busy", "the first check has not finished");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM nexus_tasks WHERE kind = 'schedule_check'"), 1);
    // once the first check ended, a new one may start
    const first1 = w.triggers(f.scheduleId)[0]!;
    w.db
      .prepare("UPDATE nexus_tasks SET status = 'succeeded', ended_at = 1 WHERE id = ?")
      .run(first1.taskId!);
    const next = await w.dispatcher.checkNow(A, f.scheduleId);
    assert.equal(next.outcome, "started");
    assert.equal(w.triggers(f.scheduleId).filter((t) => t.source === "manual").length, 2);
  });

  it("does not start a check on a paused schedule or one that belongs to someone else", async () => {
    const w = dispatchKit();
    const f = w.follow({}, false);
    w.k.schedulePause({ principal: A, scheduleId: f.scheduleId, source: "user", now: w.now() });
    assert.equal((await w.dispatcher.checkNow(A, f.scheduleId)).outcome, "not_active");
    assert.equal((await w.dispatcher.checkNow(B, f.scheduleId)).outcome, "not_found");
    assert.equal(w.triggers(f.scheduleId).length, 0);
    assert.equal(w.host.scheduled.length, 0);
  });

  it("a Work pause holds it too", async () => {
    const w = dispatchKit();
    const f = w.follow({}, false);
    w.k.workControl({
      principal: A,
      workId: f.workId,
      action: "pause",
      actor: "user",
      decisionRef: "console:t",
      dispatchReady: true,
      now: w.now(),
    } as never);
    assert.equal((await w.dispatcher.checkNow(A, f.scheduleId)).outcome, "not_active");
  });

  it("blocks the schedule with the real gap instead of starting when its prerequisite is gone (INV-11)", async () => {
    const w = dispatchKit();
    const f = w.follow({}, false);
    w.db
      .prepare("UPDATE commitments SET lifecycle = 'cancelled', cancelled_at = 1 WHERE id = ?")
      .run(f.commitmentId);
    const out = await w.dispatcher.checkNow(A, f.scheduleId);
    assert.equal(out.outcome, "blocked");
    assert.equal(w.schedule(f.scheduleId).status, "blocked");
    assert.equal(w.host.scheduled.length, 0);
    assert.equal(w.triggers(f.scheduleId).length, 0);
  });
});
