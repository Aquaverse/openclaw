// Two things about a plan that is edited or a check that ended: a check that ended or was stopped inside a running plan can be
// restored; and when a running plan is replaced by an edit, a check the edit did not touch (same words, same cadence) keeps
// its paused or stopped state, while a new or changed check starts the chosen way.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A } from "../test-support/goal-kit.js";
import { scheduleKit } from "../test-support/schedule-kit.js";
import type { ScheduleSpec } from "./types.js";

type Row = {
  id: string;
  purpose: string;
  status: string;
  stop_reason: string | null;
  next_due_at: number | null;
  pause_source: string | null;
};

function running(specs: ScheduleSpec[]) {
  const w = scheduleKit();
  const work = w.workWithTask();
  const commitmentId = w.commitment();
  const plan = w.draft(work.workId, commitmentId, { plan: w.body({ schedules: specs }) });
  const done = w.accept(plan.id);
  assert.equal(done.outcome, "accepted", JSON.stringify(done));
  const rowsOf = (planId: string): Row[] =>
    w.db
      .prepare(
        "SELECT id, purpose, status, stop_reason, next_due_at, pause_source FROM schedules WHERE plan_id = ?",
      )
      .all(planId) as Row[];
  const of = (planId: string, purpose: string) =>
    rowsOf(planId).find((r) => r.purpose === purpose)!;
  return { w, work, commitmentId, plan, rowsOf, of };
}

describe("restoring a check that ended or was stopped", () => {
  it("brings a stopped check back on its cadence, and refuses what is not restorable", () => {
    const r = running([r0("甲"), r0("乙")]);
    const jia = r.of(r.plan.id, "甲");
    assert.equal(
      r.w.k.scheduleRestore({
        principal: A,
        scheduleId: jia.id,
        dispatchReady: true,
        now: r.w.now(),
      }).outcome,
      "not_final",
    );
    r.w.k.scheduleCancel({ principal: A, scheduleId: jia.id, now: r.w.now() });
    const out = r.w.k.scheduleRestore({
      principal: A,
      scheduleId: jia.id,
      dispatchReady: true,
      now: r.w.now(),
    });
    assert.equal(out.outcome, "restored", JSON.stringify(out));
    const back = r.of(r.plan.id, "甲");
    assert.equal(back.status, "active");
    assert.equal(back.stop_reason, null);
    assert.ok((back.next_due_at ?? 0) > 0);
  });

  it("does not restore a check of a plan that was replaced", () => {
    const r = running([r0("甲")]);
    const old = r.of(r.plan.id, "甲");
    const next = r.w.draft(r.w.workWithTask().workId, r.commitmentId, {
      plan: r.w.body({ schedules: [r0("甲")] }),
    });
    const done = r.w.accept(next.id, {
      replaces: { planId: r.plan.id, planVersion: r.plan.planVersion },
    });
    assert.equal(done.outcome, "accepted", JSON.stringify(done));
    const out = r.w.k.scheduleRestore({
      principal: A,
      scheduleId: old.id,
      dispatchReady: true,
      now: r.w.now(),
    });
    assert.equal(out.outcome, "not_restorable");
  });
});

function r0(purpose: string, times = ["09:00"]): ScheduleSpec {
  return {
    scheduleKind: "recurring",
    purpose,
    cadence: { kind: "daily", times },
    tz: "Asia/Shanghai",
  };
}

describe("editing a running plan", () => {
  it("keeps the paused and stopped state of an untouched check; a new or changed one starts the chosen way", () => {
    const r = running([r0("甲"), r0("乙"), r0("丙"), r0("丁")]);
    const id = (p: string) => r.of(r.plan.id, p).id;
    r.w.k.schedulePause({ principal: A, scheduleId: id("甲"), source: "user", now: r.w.now() });
    r.w.k.scheduleCancel({ principal: A, scheduleId: id("乙"), now: r.w.now() });
    r.w.k.schedulePause({ principal: A, scheduleId: id("丙"), source: "user", now: r.w.now() });
    const next = r.w.draft(r.w.workWithTask().workId, r.commitmentId, {
      // 甲 and 乙 untouched; 丙 gets a new time; 戊 is new; 丁 untouched and running.
      plan: r.w.body({
        schedules: [r0("甲"), r0("乙"), r0("丙", ["10:30"]), r0("丁"), r0("戊")],
      }),
      startIntent: "now",
    });
    const done = r.w.accept(next.id, {
      replaces: { planId: r.plan.id, planVersion: r.plan.planVersion },
    });
    assert.equal(done.outcome, "accepted", JSON.stringify(done));
    const jia = r.of(next.id, "甲");
    assert.equal(jia.status, "paused");
    assert.equal(jia.pause_source, "user");
    assert.equal(jia.next_due_at, null);
    const yi = r.of(next.id, "乙");
    assert.equal(yi.status, "cancelled");
    assert.equal(yi.stop_reason, "user_cancelled");
    // changed cadence: not carried, so it is active and starts now ("start now")
    const bing = r.of(next.id, "丙");
    assert.equal(bing.status, "active");
    assert.ok(bing.next_due_at !== null);
    // new check starts now
    assert.equal(r.of(next.id, "戊").status, "active");
    // untouched and running: stays on its cadence, not started again at once
    const ding = r.of(next.id, "丁");
    assert.equal(ding.status, "active");
    const wu = r.of(next.id, "戊");
    assert.ok((wu.next_due_at ?? 0) <= (ding.next_due_at ?? 0));
    assert.ok(
      (ding.next_due_at ?? 0) > (wu.next_due_at ?? 0),
      "an untouched running check does not start now",
    );
  });
});
