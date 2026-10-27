// Goals kernel tests, G2: metrics (manual and claim-backed), live state of pointers, and the purge receipt count.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A, B, setup } from "../test-support/goal-kit.js";
import type { GoalMetricRecord } from "./goal-types.js";
import type { Principal } from "./types.js";

const REACHED = "Reached: {name} ({value})";

describe("goal metrics and live pointers", () => {
  const { k, now, db, count, createViaGrant, mustGoal, task } = setup();
  const goal = mustGoal(createViaGrant(A, "Get fit for the spring").created);
  const set = (over: Record<string, unknown> = {}) =>
    k.goalMetricSet({
      principal: A,
      goalId: goal.id,
      ...(over.metricId
        ? {}
        : {
            name: "Weekly runs",
            unit: "runs",
            target: 3,
            source: "manual",
            ...(over.source === "claim" ? {} : { current: 1 }),
          }),
      reachedText: REACHED,
      now: now(),
      ...over,
    } as Parameters<typeof k.goalMetricSet>[0]);
  const metricOf = (out: ReturnType<typeof set>): GoalMetricRecord => {
    assert.ok("metric" in out, `expected a metric, got ${out.outcome}`);
    return out.metric;
  };
  let subjects = 0;
  const claim = (principal: Principal, taskId: string, value: unknown = { value: 42 }): string => {
    subjects += 1;
    const out = k.addClaim({
      principal,
      taskId,
      subject: `figure-${subjects}`,
      predicate: "is",
      value,
      state: "ASSERTED",
      actor: "agent",
      now: now(),
    });
    assert.ok(out.outcome === "created", `claim: ${out.outcome}`);
    return out.claim.id;
  };

  it("creates a manual metric, updates it by id and refuses a clashing name", () => {
    const created = set();
    assert.equal(created.outcome, "created");
    const metric = metricOf(created);
    assert.equal(metric.source, "manual");
    assert.equal(metric.current, 1);
    assert.equal(metric.asOf !== null, true);
    const updated = set({ metricId: metric.id, current: 2, name: undefined });
    assert.equal(updated.outcome, "updated");
    assert.equal(metricOf(updated).current, 2);
    assert.equal(metricOf(updated).target, 3);
    const other = metricOf(set({ name: "Sleep", unit: "h", target: 8, current: null }));
    assert.equal(set({ metricId: other.id, name: "Weekly runs" }).outcome, "name_taken");
    assert.equal(set({ metricId: "GM-missing" }).outcome, "metric_not_found");
  });

  it("validates names, units and figures", () => {
    const code = (over: Record<string, unknown>) => (set(over) as { code?: string }).code;
    assert.equal(code({ name: "  " }), "bad_metric_name");
    assert.equal(code({ name: "x".repeat(61) }), "bad_metric_name");
    assert.equal(code({ name: "N1", unit: "u".repeat(21) }), "bad_metric_unit");
    assert.equal(code({ name: "N2", target: Number.NaN }), "bad_metric_value");
    assert.equal(code({ name: "N3", current: 1e13 }), "bad_metric_value");
    assert.equal(code({ name: "N4", source: "other" }), "bad_metric_source");
    assert.equal(code({ name: "N5", taskId: "T1" }), "bad_metric_source");
  });

  it("writes one system entry per crossing of the target, never completes the goal", () => {
    const m = metricOf(set({ name: "Savings", unit: "USD", target: 100, current: 50 }));
    const entries = () =>
      count(
        "SELECT COUNT(*) AS c FROM goal_entries WHERE owner_id = ? AND goal_id = ? AND text LIKE 'Reached:%'",
        A.ownerId,
        goal.id,
      );
    assert.equal(entries(), 0);
    const hit = set({ metricId: m.id, current: 100 });
    assert.equal((hit as { reachedNow: boolean }).reachedNow, true);
    assert.equal(entries(), 1);
    const again = set({ metricId: m.id, current: 120 });
    assert.equal((again as { reachedNow: boolean }).reachedNow, false);
    assert.equal(entries(), 1);
    set({ metricId: m.id, current: 90 });
    const second = set({ metricId: m.id, current: 100 });
    assert.equal((second as { reachedNow: boolean }).reachedNow, true);
    assert.equal(entries(), 2);
    assert.equal(k.goalGet({ principal: A, goalId: goal.id })?.goal.status, "active");
  });

  it("a down metric reaches its target from above", () => {
    const m = metricOf(
      set({ name: "Subscriptions", unit: "USD", direction: "down", target: 200, current: 260 }),
    );
    assert.equal(
      (set({ metricId: m.id, current: 190 }) as { reachedNow: boolean }).reachedNow,
      true,
    );
  });

  it("caps the metrics of one goal", () => {
    const g = mustGoal(
      createViaGrant(A, "A goal with many metrics", { category: "something_else" }).created,
    );
    for (let i = 0; i < 10; i += 1) {
      const out = k.goalMetricSet({
        principal: A,
        goalId: g.id,
        name: `M${i}`,
        source: "manual",
        reachedText: REACHED,
        now: now(),
      });
      assert.equal(out.outcome, "created");
    }
    const over = k.goalMetricSet({
      principal: A,
      goalId: g.id,
      name: "M10",
      source: "manual",
      reachedText: REACHED,
      now: now(),
    });
    assert.equal(over.outcome, "limit_reached");
  });

  it("claim metrics: pointer validated, no figure stored, label follows the claim", () => {
    task(A, "T-claim");
    const C1 = claim(A, "T-claim", { value: 42 });
    const bad = set({ name: "Weight", source: "claim", taskId: "T-claim", claimId: "C-none" });
    assert.equal(bad.outcome, "claim_not_found");
    assert.equal(
      set({ name: "Weight", source: "claim", taskId: "T-none", claimId: C1 }).outcome,
      "task_not_found",
    );
    assert.equal(
      (set({ name: "Weight", source: "claim", taskId: "T-claim" }) as { code: string }).code,
      "bad_metric_source",
    );
    assert.equal(
      (
        set({ name: "Weight", source: "claim", taskId: "T-claim", claimId: C1, current: 5 }) as {
          code: string;
        }
      ).code,
      "bad_metric_source",
    );
    const made = metricOf(
      set({
        name: "Weight",
        unit: "kg",
        source: "claim",
        taskId: "T-claim",
        claimId: C1,
        current: undefined,
        target: 40,
        direction: "down",
      }),
    );
    assert.equal(made.current, null);
    assert.equal(
      (
        db.prepare("SELECT current FROM goal_metrics WHERE id = ?").get(made.id) as {
          current: unknown;
        }
      ).current,
      null,
    );
    const read = (): GoalMetricRecord => {
      const metrics = k.goalGet({ principal: A, goalId: goal.id })?.metrics ?? [];
      const hit = metrics.find((m) => m.id === made.id);
      assert.ok(hit);
      return hit;
    };
    assert.equal(read().current, 42);
    assert.equal(read().pointer?.claimState, "ASSERTED");
    db.prepare("UPDATE claims SET state = 'REFUTED' WHERE owner_id = ? AND id = ?").run(
      A.ownerId,
      C1,
    );
    assert.equal(read().pointer?.claimState, "REFUTED");
    db.prepare("UPDATE claims SET value_json = ? WHERE owner_id = ? AND id = ?").run(
      '"n/a"',
      A.ownerId,
      C1,
    );
    assert.equal(read().current, null);
    // the source is fixed once the metric exists
    assert.equal(
      (set({ metricId: made.id, source: "manual" }) as { code: string }).code,
      "bad_metric_source",
    );
  });

  it("a metric on another owner's Task or claim is refused", () => {
    task(B, "T-b");
    const CB = claim(B, "T-b");
    assert.equal(
      set({ name: "Theirs", source: "claim", taskId: "T-b", claimId: CB }).outcome,
      "task_not_found",
    );
    assert.equal(
      k.goalMetricSet({
        principal: B,
        goalId: goal.id,
        name: "x",
        source: "manual",
        reachedText: REACHED,
        now: now(),
      }).outcome,
      "not_found",
    );
  });

  it("finance goals accept manual metrics only", () => {
    const fin = mustGoal(createViaGrant(A, "Save for a house", { category: "finance" }).created);
    task(A, "T-fin");
    const CF = claim(A, "T-fin");
    const out = k.goalMetricSet({
      principal: A,
      goalId: fin.id,
      name: "Savings",
      source: "claim",
      taskId: "T-fin",
      claimId: CF,
      reachedText: REACHED,
      now: now(),
    });
    assert.deepEqual(out, { outcome: "refused", reason: "finance_manual_only" });
    assert.equal(
      k.goalMetricSet({
        principal: A,
        goalId: fin.id,
        name: "Savings",
        unit: "USD",
        source: "manual",
        current: 10,
        target: 100,
        reachedText: REACHED,
        now: now(),
      }).outcome,
      "created",
    );
  });

  it("entries and task links carry the live state of their Task and claim", () => {
    task(A, "T-live");
    const CL = claim(A, "T-live");
    const add = k.goalEntryAdd({
      principal: A,
      goalId: goal.id,
      kind: "note",
      text: "Booked the venue",
      author: "user",
      taskId: "T-live",
      claimId: CL,
      allowCompleted: true,
      now: now(),
    });
    assert.equal(add.outcome, "added");
    assert.equal(
      k.goalLinkAdd({ principal: A, goalId: goal.id, kind: "task", refId: "T-live", now: now() })
        .outcome,
      "linked",
    );
    const get = () => k.goalGet({ principal: A, goalId: goal.id });
    const entry = get()?.entries.find((e) => e.taskId === "T-live");
    assert.equal(entry?.pointer?.taskStatus, "clarifying");
    assert.equal(entry?.pointer?.claimState, "ASSERTED");
    assert.equal(entry?.text, "Booked the venue");
    assert.equal(get()?.links.find((l) => l.refId === "T-live")?.task?.title, "task T-live");
    db.prepare("UPDATE claims SET state = 'REFUTED' WHERE owner_id = ? AND id = ?").run(
      A.ownerId,
      CL,
    );
    const refuted = get()?.entries.find((e) => e.taskId === "T-live");
    assert.equal(refuted?.pointer?.claimState, "REFUTED");
    assert.equal(refuted?.text, "Booked the venue");
    db.prepare("UPDATE nexus_tasks SET purged_at = 1 WHERE owner_id = ? AND id = ?").run(
      A.ownerId,
      "T-live",
    );
    const gone = get()?.entries.find((e) => e.taskId === "T-live");
    assert.equal(gone?.pointer?.taskGone, true);
    assert.equal(gone?.pointer?.claimGone, true);
    assert.equal(get()?.links.find((l) => l.refId === "T-live")?.targetGone, true);
  });

  it("metrics cascade with the goal and the purge receipt counts them", () => {
    const g = mustGoal(
      createViaGrant(A, "A goal to purge", { category: "something_else" }).created,
    );
    for (const name of ["One", "Two"]) {
      k.goalMetricSet({
        principal: A,
        goalId: g.id,
        name,
        source: "manual",
        current: 1,
        reachedText: REACHED,
        now: now(),
      });
    }
    k.goalDelete({ principal: A, goalId: g.id, now: now() });
    const begin = k.goalPurgeBegin({
      principal: A,
      goalId: g.id,
      requestedBy: "operator",
      attemptId: "att-1",
      leaseMs: 60_000,
      now: now(),
    });
    assert.equal(begin.outcome, "started");
    const done = k.goalPurgeFinalize({
      ownerId: A.ownerId,
      goalId: g.id,
      attemptId: "att-1",
      leaseMs: 60_000,
      now: now(),
    });
    assert.equal(done.outcome, "purged");
    assert.equal((done as { receipt: { metricCount: number } }).receipt.metricCount, 2);
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM goal_metrics WHERE owner_id = ? AND goal_id = ?",
        A.ownerId,
        g.id,
      ),
      0,
    );
  });

  it("removes a metric and refuses writes on a proposed or deleted goal", () => {
    const m = metricOf(set({ name: "Temp", target: null, current: null }));
    assert.equal(
      k.goalMetricRemove({ principal: A, goalId: goal.id, metricId: m.id, now: now() }).outcome,
      "removed",
    );
    assert.equal(
      k.goalMetricRemove({ principal: A, goalId: goal.id, metricId: m.id, now: now() }).outcome,
      "metric_not_found",
    );
    const proposed = k.goalPropose({
      principal: A,
      category: "interests",
      fields: { title: "Learn the cello properly" },
      sensitivity: "normal",
      idempotencyKey: "pm-1",
      now: now(),
    });
    assert.equal(proposed.outcome, "proposed");
    const pid = (proposed as { goal: { id: string } }).goal.id;
    assert.equal(
      k.goalMetricSet({
        principal: A,
        goalId: pid,
        name: "x",
        source: "manual",
        reachedText: REACHED,
        now: now(),
      }).outcome,
      "bad_state",
    );
  });
});
