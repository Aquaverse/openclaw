// CD-04 (design 6.4): when the commitment a follow-up plan belongs to ends, the plan is wrapped up, not cut off. Nothing new is
// started, a check already running may finish for at most 30 minutes, then the plan and its checks end for good, and reopening
// the commitment brings nothing back (INV-10).
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { PLAN_WRAPUP_MS } from "../schedule/types.js";
import { dispatchKit } from "../test-support/dispatch-kit.js";
import { A } from "../test-support/goal-kit.js";

type Plan = {
  status: string;
  endReason: string | null;
  endRequestedAt: number | null;
  wrapupUntil: number | null;
  endedAt: number | null;
};
const planOf = (w: ReturnType<typeof dispatchKit>, id: string) =>
  (w.k.delegationPlanGet({ principal: A, planId: id }) as unknown as { plan: Plan }).plan;
const close = (w: ReturnType<typeof dispatchKit>, id: string, how: "resolve" | "cancel") =>
  (how === "resolve" ? w.k.commitmentResolve : w.k.commitmentCancel)({
    principal: A,
    commitmentId: id,
    reason: "已处理",
    now: w.now(),
  } as never) as unknown as { outcome: string };

describe("a plan whose commitment ended", () => {
  it("ends at once when no check is running: fulfilled → ended, cancelled → cancelled", () => {
    const w = dispatchKit();
    const done = w.follow({}, false);
    assert.equal(close(w, done.commitmentId, "resolve").outcome, "resolved");
    assert.equal(planOf(w, done.planId).status, "ended");
    assert.equal(planOf(w, done.planId).endReason, "commitment_resolved");
    const s = w.schedule(done.scheduleId);
    assert.equal(s.status, "ended");
    assert.equal(s.stopReason, "commitment_resolved");
    assert.equal(s.nextDueAt, null);
    const gone = w.follow({}, false);
    assert.equal(close(w, gone.commitmentId, "cancel").outcome, "cancelled");
    assert.equal(w.schedule(gone.scheduleId).status, "cancelled");
    assert.equal(w.schedule(gone.scheduleId).stopReason, "commitment_cancelled");
  });

  it("the preview lists the plan that will be wrapped up and changes nothing", () => {
    const w = dispatchKit();
    const f = w.follow({}, false);
    const preview = w.k.commitmentCancel({
      principal: A,
      commitmentId: f.commitmentId,
      reason: "x",
      dryRun: true,
      now: w.now(),
    } as never) as unknown as {
      outcome: string;
      impact: { plansToWrapUp: { planId: string; purpose: string }[] };
    };
    assert.equal(preview.outcome, "preview");
    assert.deepEqual(
      preview.impact.plansToWrapUp.map((p) => p.planId),
      [f.planId],
    );
    assert.equal(planOf(w, f.planId).status, "accepted");
    assert.equal(planOf(w, f.planId).endRequestedAt, null);
  });

  it("keeps a running check going, starts nothing new, then ends when it is done", async () => {
    const w = dispatchKit();
    const f = w.follow();
    w.advance(10_000);
    await w.dispatcher.tick();
    const first = w.triggers(f.scheduleId)[0]!;
    assert.equal(first.outcome, "created");
    close(w, f.commitmentId, "resolve");
    const wrapping = planOf(w, f.planId);
    assert.equal(wrapping.status, "accepted", "still accepted while a check runs");
    assert.equal(wrapping.endReason, "commitment_resolved");
    assert.equal(wrapping.wrapupUntil! - wrapping.endRequestedAt!, PLAN_WRAPUP_MS);
    assert.equal(w.schedule(f.scheduleId).nextDueAt, null, "no due time is left to start anything");
    assert.equal(w.schedule(f.scheduleId).status, "active");
    assert.equal((await w.dispatcher.checkNow(A, f.scheduleId)).outcome, "wrapping_up");
    w.advance(20 * 60_000);
    await w.dispatcher.tick();
    assert.equal(
      w.triggers(f.scheduleId).filter((t) => t.outcome === "created").length,
      1,
      "no second check was started",
    );
    assert.equal(planOf(w, f.planId).status, "accepted", "the running check still has time");
    w.db
      .prepare(
        'UPDATE schedule_triggers SET turn_state = \'reported\', slot_open = 0, report_json = \'{"outcome":"changed","summary":"交了"}\' WHERE id = ?',
      )
      .run(first.id);
    await w.dispatcher.tick();
    assert.equal(planOf(w, f.planId).status, "ended");
    assert.equal(w.schedule(f.scheduleId).status, "ended");
  });

  it("ends when the window is over even if the check never finished", async () => {
    const w = dispatchKit();
    const f = w.follow();
    w.advance(10_000);
    await w.dispatcher.tick();
    close(w, f.commitmentId, "cancel");
    w.advance(PLAN_WRAPUP_MS + 60_000);
    await w.dispatcher.tick();
    assert.equal(planOf(w, f.planId).status, "ended");
    assert.equal(w.schedule(f.scheduleId).status, "cancelled");
  });

  it("a paused check cannot be resumed while the plan wraps up, and reopening brings nothing back", async () => {
    const w = dispatchKit();
    const f = w.follow();
    w.advance(10_000);
    await w.dispatcher.tick();
    close(w, f.commitmentId, "resolve");
    const out = w.k.scheduleResume({
      principal: A,
      scheduleId: f.scheduleId,
      by: "user",
      dispatchReady: true,
      now: w.now(),
    } as never) as unknown as { outcome: string };
    assert.notEqual(out.outcome, "resumed");
    w.advance(PLAN_WRAPUP_MS + 60_000);
    await w.dispatcher.tick();
    const reopened = w.k.commitmentReopen({
      principal: A,
      commitmentId: f.commitmentId,
      reason: "还没好",
      now: w.now(),
    } as never) as unknown as { outcome: string };
    assert.equal(reopened.outcome, "reopened", JSON.stringify(reopened));
    assert.equal(planOf(w, f.planId).status, "ended");
    assert.equal(w.schedule(f.scheduleId).status, "ended");
    w.advance(60 * 60_000);
    await w.dispatcher.tick();
    assert.equal(
      w.triggers(f.scheduleId).filter((t) => t.outcome === "created").length,
      1,
      "nothing was started after the end",
    );
  });

  it("a commitment closed behind the ledger's back is wrapped up by the next tick", async () => {
    const w = dispatchKit();
    const f = w.follow({}, false);
    w.db
      .prepare(
        "UPDATE commitments SET lifecycle = 'resolved', resolution_basis = 'manual_override', resolution_reason = 'x', resolved_at = 1 WHERE id = ?",
      )
      .run(f.commitmentId);
    await w.dispatcher.tick();
    assert.equal(planOf(w, f.planId).status, "ended");
    assert.equal(planOf(w, f.planId).endReason, "commitment_resolved");
    assert.equal(w.schedule(f.scheduleId).status, "ended");
  });

  it("only the plans owned by that commitment are touched", () => {
    const w = dispatchKit();
    const a = w.follow({}, false);
    const b = w.follow({}, false);
    close(w, a.commitmentId, "resolve");
    assert.equal(planOf(w, a.planId).status, "ended");
    assert.equal(planOf(w, b.planId).status, "accepted");
    assert.equal(w.schedule(b.scheduleId).status, "active");
  });
});
