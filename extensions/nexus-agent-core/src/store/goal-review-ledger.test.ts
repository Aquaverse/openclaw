// Goals kernel tests, G3a: the review reminder plan (cadence, due, later, reviewed) and the once-per-due chat nudge.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A, B, setup } from "../test-support/goal-kit.js";
import { GOAL_REVIEW_PERIOD_MS, GOAL_REVIEW_SNOOZE_MS } from "./goal-types.js";

const DAY = 24 * 60 * 60 * 1000;

describe("goal review plans", () => {
  const { k, now, db, count, createViaGrant, mustGoal } = setup();
  const goal = mustGoal(createViaGrant(A, "Learn piano this year").created);
  const other = mustGoal(createViaGrant(A, "Save for a trip").created);
  const set = (goalId: string, cadence: "weekly" | "biweekly" | "monthly" | null, at = now()) =>
    k.goalReviewSet({ principal: A, goalId, cadence, now: at });
  const plans = (at: number, dueOnly = false) =>
    k.goalReviewList({ principal: A, dueOnly, now: at });

  it("starts the first reminder one period away and is not due before that", () => {
    const at = now();
    const out = set(goal.id, "weekly", at);
    assert.ok(out.outcome === "set");
    assert.equal(out.plan.nextDueAt, at + GOAL_REVIEW_PERIOD_MS.weekly);
    assert.equal(out.plan.due, false);
    assert.equal(plans(at + 6 * DAY, true).length, 0);
    const due = plans(at + 7 * DAY + 1, true);
    assert.equal(due.length, 1);
    assert.equal(due[0]?.goalId, goal.id);
  });

  it("changing the cadence restarts the count and clears the quiet-down marks; the same cadence changes nothing", () => {
    const g = mustGoal(createViaGrant(A, "Practise drawing daily").created);
    const at = now();
    set(g.id, "weekly", at);
    const same = set(g.id, "weekly", at + DAY);
    assert.ok(same.outcome === "set");
    assert.equal(same.plan.nextDueAt, at + 7 * DAY);
    const changed = set(g.id, "monthly", at + 8 * DAY);
    assert.ok(changed.outcome === "set");
    assert.equal(changed.plan.nextDueAt, at + 8 * DAY + 30 * DAY);
    assert.equal(changed.plan.snoozedUntil, null);
    assert.equal(count("SELECT COUNT(*) AS c FROM goal_review_plans WHERE goal_id = ?", g.id), 1);
  });

  it("turns off by deleting the plan", () => {
    set(other.id, "biweekly");
    assert.equal(set(other.id, null).outcome, "cleared");
    assert.equal(
      plans(Date.now() + 365 * DAY).some((p) => p.goalId === other.id),
      false,
    );
  });

  it("refuses a missing, proposed, completed or deleted goal", () => {
    assert.equal(set("G-missing", "weekly").outcome, "not_found");
    const proposed = mustGoal(
      k.goalPropose({
        principal: A,
        category: "interests",
        fields: { title: "Maybe learn to sail" },
        sensitivity: "normal",
        idempotencyKey: "rp-1",
        now: now(),
      }),
    );
    assert.equal(set(proposed.id, "weekly").outcome, "bad_state");
    const done = mustGoal(createViaGrant(A, "Finish the garden shed").created);
    set(done.id, "weekly");
    assert.equal(
      k.goalComplete({ principal: A, goalId: done.id, maxActive: 20, now: now() }).outcome,
      "done",
    );
    assert.equal(set(done.id, "monthly").outcome, "bad_state");
    // A completed goal's plan stays in the table but never counts as due.
    assert.equal(
      plans(Date.now() + 365 * DAY, true).some((p) => p.goalId === done.id),
      false,
    );
  });

  it("is private to its owner", () => {
    set(goal.id, "weekly");
    assert.equal(
      k.goalReviewSet({ principal: B, goalId: goal.id, cadence: "weekly", now: now() }).outcome,
      "not_found",
    );
    assert.equal(k.goalReviewList({ principal: B, now: Date.now() + 365 * DAY }).length, 0);
    assert.equal(
      k.goalReviewAct({ principal: B, goalId: goal.id, action: "done", now: now() }).outcome,
      "not_found",
    );
    assert.equal(
      k.goalReviewNudge({ principal: B, limit: 3, now: Date.now() + 365 * DAY }).length,
      0,
    );
  });

  it("'reviewed' moves the date one period on from now, writes one system entry and re-arms the nudge", () => {
    const at = now();
    set(goal.id, "weekly", at);
    const later = at + 9 * DAY;
    const before = count(
      "SELECT COUNT(*) AS c FROM goal_entries WHERE owner_id = ? AND goal_id = ?",
      "owner-a",
      goal.id,
    );
    const out = k.goalReviewAct({
      principal: A,
      goalId: goal.id,
      action: "done",
      entryText: "Reviewed",
      now: later,
    });
    assert.ok(out.outcome === "done");
    assert.equal(out.plan.nextDueAt, later + 7 * DAY);
    assert.equal(out.plan.lastReviewedAt, later);
    assert.equal(out.plan.due, false);
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM goal_entries WHERE owner_id = ? AND goal_id = ?",
        "owner-a",
        goal.id,
      ),
      before + 1,
    );
    const entry = db
      .prepare(
        "SELECT kind, author, text FROM goal_entries WHERE owner_id = ? AND goal_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get("owner-a", goal.id) as { kind: string; author: string; text: string };
    assert.deepEqual({ ...entry }, { kind: "system", author: "system", text: "Reviewed" });
  });

  it("'later' hides the reminder for two days, then it is due again and may be mentioned again", () => {
    const g = mustGoal(createViaGrant(A, "Walk every morning").created);
    const at = now();
    set(g.id, "weekly", at);
    const due = at + 8 * DAY;
    assert.equal(
      k.goalReviewNudge({ principal: A, limit: 9, now: due }).some((r) => r.goalId === g.id),
      true,
    );
    const out = k.goalReviewAct({ principal: A, goalId: g.id, action: "snooze", now: due });
    assert.ok(out.outcome === "snoozed");
    assert.equal(out.plan.snoozedUntil, due + GOAL_REVIEW_SNOOZE_MS);
    assert.equal(out.plan.due, false);
    assert.equal(
      plans(due + DAY, true).some((p) => p.goalId === g.id),
      false,
    );
    assert.equal(
      k.goalReviewNudge({ principal: A, limit: 9, now: due + DAY }).some((r) => r.goalId === g.id),
      false,
    );
    assert.equal(
      plans(due + 2 * DAY, true).some((p) => p.goalId === g.id),
      true,
    );
    assert.equal(
      k
        .goalReviewNudge({ principal: A, limit: 9, now: due + 2 * DAY })
        .some((r) => r.goalId === g.id),
      true,
    );
  });

  it("acting on a goal with no plan says so", () => {
    assert.equal(set(other.id, null).outcome, "cleared");
    assert.equal(
      k.goalReviewAct({ principal: A, goalId: other.id, action: "done", now: now() }).outcome,
      "no_plan",
    );
  });

  it("the nudge names each due date once, oldest first, and honours the limit", () => {
    const at = now();
    const goals = ["Read more", "Run a 10k", "Learn Rust", "Paint weekly"].map((title) =>
      mustGoal(createViaGrant(A, title).created),
    );
    goals.forEach((g, i) => set(g.id, "weekly", at + i * 1000));
    set(goal.id, null);
    const when = at + 8 * DAY;
    const first = k.goalReviewNudge({ principal: A, limit: 3, now: when });
    assert.deepEqual(
      first.map((r) => r.goalId),
      goals.slice(0, 3).map((g) => g.id),
    );
    assert.equal(first[0]?.title, "Read more");
    const second = k.goalReviewNudge({ principal: A, limit: 3, now: when + 1000 });
    assert.deepEqual(
      second.map((r) => r.goalId),
      [goals[3]?.id],
    );
    assert.equal(k.goalReviewNudge({ principal: A, limit: 3, now: when + 2000 }).length, 0);
  });

  it("reopening a completed goal restarts its count instead of making it due at once", () => {
    const g = mustGoal(createViaGrant(A, "Grow tomatoes on the balcony").created);
    const at = now();
    set(g.id, "biweekly", at);
    assert.equal(
      k.goalComplete({ principal: A, goalId: g.id, maxActive: 20, now: at + DAY }).outcome,
      "done",
    );
    const back = at + 90 * DAY;
    assert.equal(
      k.goalReopen({ principal: A, goalId: g.id, maxActive: 20, now: back }).outcome,
      "done",
    );
    const plan = plans(back).find((p) => p.goalId === g.id);
    assert.equal(plan?.nextDueAt, back + GOAL_REVIEW_PERIOD_MS.biweekly);
    assert.equal(plan?.due, false);
    assert.equal(
      k.goalReviewNudge({ principal: A, limit: 9, now: back }).some((r) => r.goalId === g.id),
      false,
    );
    assert.equal(
      plans(back + 15 * DAY, true).some((p) => p.goalId === g.id),
      true,
    );
    // A goal with no plan is untouched.
    const bare = mustGoal(createViaGrant(A, "Learn to juggle").created);
    k.goalComplete({ principal: A, goalId: bare.id, maxActive: 20, now: at + DAY });
    k.goalReopen({ principal: A, goalId: bare.id, maxActive: 20, now: back });
    assert.equal(
      plans(back).some((p) => p.goalId === bare.id),
      false,
    );
  });

  it("a plan goes with its goal when the goal is purged", () => {
    const g = mustGoal(createViaGrant(A, "Temporary goal for purge").created);
    set(g.id, "weekly");
    assert.equal(count("SELECT COUNT(*) AS c FROM goal_review_plans WHERE goal_id = ?", g.id), 1);
    db.prepare("DELETE FROM goals WHERE owner_id = ? AND id = ?").run("owner-a", g.id);
    assert.equal(count("SELECT COUNT(*) AS c FROM goal_review_plans WHERE goal_id = ?", g.id), 0);
  });
});
