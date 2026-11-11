// What the dispatcher does with a due schedule (design 4.5.3, R-16): the newest overdue time is checked or missed, older ones are
// folded into ONE merge record, a once-schedule never becomes an instant task.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { occurrenceKey, type Cadence } from "./cadence.js";
import {
  DEFAULT_DISPATCH_WINDOW_MS,
  MAX_DISPATCH_WINDOW_MS,
  ON_TIME_MS,
  overdueTimes,
  planDue,
  windowOf,
} from "./dispatch-plan.js";

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const sched = (
  cadence: Cadence,
  nextDueAt: number | null,
  over: { dispatchWindowMs?: number | null; tz?: string } = {},
) => ({
  id: "sc_X",
  cadence,
  tz: over.tz ?? "Asia/Shanghai",
  createdAt: T0,
  nextDueAt,
  dispatchWindowMs: over.dispatchWindowMs ?? null,
});

describe("planDue", () => {
  it("does nothing before the due time", () => {
    assert.deepEqual(
      planDue(sched({ kind: "interval", minutes: 15, anchorAt: T0 }, T0 + 15 * MIN), T0),
      [],
    );
    assert.deepEqual(planDue(sched({ kind: "interval", minutes: 15, anchorAt: T0 }, null), T0), []);
  });

  it("fires a due time reached by the running timer as `scheduled`", () => {
    const [a, ...rest] = planDue(
      sched({ kind: "interval", minutes: 15, anchorAt: T0 }, T0),
      T0 + 30_000,
    );
    assert.equal(rest.length, 0);
    assert.deepEqual(a, {
      kind: "fire",
      occurrenceKey: occurrenceKey("sc_X", T0),
      plannedAt: T0,
      source: "scheduled",
    });
  });

  it("calls a late but in-window due time a catch-up", () => {
    const [a] = planDue(
      sched({ kind: "interval", minutes: 120, anchorAt: T0 }, T0),
      T0 + ON_TIME_MS + 1,
    );
    assert.equal(a?.kind, "fire");
    assert.equal((a as { source: string }).source, "catch_up");
  });

  it("checks the newest overdue time once and merges the older ones into one record", () => {
    const actions = planDue(
      sched({ kind: "interval", minutes: 15, anchorAt: T0 }, T0),
      T0 + 52 * MIN,
    );
    assert.equal(actions.length, 2);
    const [fire, merge] = actions;
    assert.deepEqual(fire, {
      kind: "fire",
      occurrenceKey: occurrenceKey("sc_X", T0 + 45 * MIN),
      plannedAt: T0 + 45 * MIN,
      source: "catch_up",
    });
    assert.equal(merge?.kind, "merge");
    assert.deepEqual((merge as { merged: string[] }).merged, [
      occurrenceKey("sc_X", T0),
      occurrenceKey("sc_X", T0 + 15 * MIN),
      occurrenceKey("sc_X", T0 + 30 * MIN),
    ]);
    assert.equal((merge as { plannedAt: number }).plannedAt, T0 + 30 * MIN);
  });

  it("records the newest time as missed when it is past the window, never as an instant check", () => {
    const actions = planDue(
      sched({ kind: "interval", minutes: 120, anchorAt: T0 }, T0, { dispatchWindowMs: 10 * MIN }),
      T0 + 360 * MIN + 60 * MIN,
    );
    assert.equal(actions[0]?.kind, "miss");
    assert.equal(actions[1]?.kind, "merge");
  });

  it("a once-schedule past its window is missed; inside it, it fires", () => {
    const once: Cadence = { kind: "once", at: T0 };
    assert.equal(planDue(sched(once, T0), T0 + 2 * 60 * MIN)[0]?.kind, "miss");
    assert.equal(planDue(sched(once, T0), T0 + 20 * MIN)[0]?.kind, "fire");
  });

  it("uses the schedule's own window, capped at 24 hours", () => {
    assert.equal(windowOf({ dispatchWindowMs: null }), DEFAULT_DISPATCH_WINDOW_MS);
    assert.equal(windowOf({ dispatchWindowMs: 5 * MIN }), 5 * MIN);
    assert.equal(windowOf({ dispatchWindowMs: 99 * 60 * MIN }), MAX_DISPATCH_WINDOW_MS);
  });

  it("walks a very old schedule without scanning every missed time", () => {
    const old = sched({ kind: "interval", minutes: 15, anchorAt: T0 }, T0);
    const now = T0 + 90 * 24 * 60 * MIN;
    const { times, truncated } = overdueTimes(old, now);
    assert.equal(truncated, true);
    assert.ok(times.length <= 600);
    assert.ok((times[times.length - 1] as number) <= now);
    const actions = planDue(old, now);
    assert.equal(actions[0]?.kind, "fire");
  });

  it("daily times follow the wall clock of the schedule's time zone", () => {
    const daily: Cadence = { kind: "daily", times: ["09:00"] };
    // 2026-03-02 09:00 in Shanghai is 01:00 UTC
    const due = Date.UTC(2026, 2, 2, 1, 0);
    const [a] = planDue(sched(daily, due), due + 10_000);
    assert.equal(a?.kind, "fire");
    assert.equal((a as { plannedAt: number }).plannedAt, due);
  });
});
