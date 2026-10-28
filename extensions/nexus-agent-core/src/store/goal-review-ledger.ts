// Goals kernel, review reminders (G3a). One optional plan per goal: a cadence, the next due time and two quiet-down marks.
//   * the plan is a reminder and nothing else: it starts no cron job and no model turn, and it never changes the goal itself;
//   * a plan counts only for a live, active goal: completing, deleting or purging a goal silences it without touching the row;
//   * "due" = `next_due_at` has passed and the user has not snoozed it; it is computed at read time and never stored;
//   * the chat reminder (`goalReviewNudge`) names each due date once: marking `nudged_at` is part of the same transaction that
//     reads the goals, so two chats starting together cannot both mention the same goal;
//   * "reviewed" writes ONE system entry (the service localises it) and moves the next due time one period on from now.
import type { GoalCommon } from "./goal-ledger-common.js";
import { toGoal, type Row } from "./goal-rows.js";
import {
  GOAL_REVIEW_PERIOD_MS,
  GOAL_REVIEW_SNOOZE_MS,
  type GoalReviewActInput,
  type GoalReviewActOutcome,
  type GoalReviewCadence,
  type GoalReviewListInput,
  type GoalReviewNudgeInput,
  type GoalReviewNudgeRow,
  type GoalReviewPlan,
  type GoalReviewSetInput,
  type GoalReviewSetOutcome,
} from "./goal-types.js";

const optionalNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** A due plan: the date has passed and no "later" is in force. */
export const reviewDue = (nextDueAt: number, snoozedUntil: number | null, now: number): boolean =>
  nextDueAt <= now && (snoozedUntil === null || snoozedUntil <= now);

function toPlan(row: Row, active: boolean, now: number): GoalReviewPlan {
  const nextDueAt = Number(row.next_due_at);
  const snoozedUntil = optionalNumber(row.snoozed_until);
  return {
    goalId: String(row.goal_id),
    cadence: String(row.cadence) as GoalReviewCadence,
    nextDueAt,
    lastReviewedAt: optionalNumber(row.last_reviewed_at),
    snoozedUntil,
    nudgedAt: optionalNumber(row.nudged_at),
    due: active && reviewDue(nextDueAt, snoozedUntil, now),
  };
}

export function createGoalReviews(c: GoalCommon) {
  const { transaction, one, all, run, goalRow, insertSystemEntry } = c;

  const planRow = (owner: string, goalId: string): Row | undefined =>
    one("SELECT * FROM goal_review_plans WHERE owner_id = ? AND goal_id = ?", owner, goalId);

  /** The goal must exist, be live and be active; the refusal otherwise. */
  const usableGoal = (owner: string, goalId: string) => {
    const row = goalRow(owner, goalId);
    if (!row) {
      return { refusal: { outcome: "not_found" } as const };
    }
    const goal = toGoal(row);
    if (goal.lifecycle !== "live") {
      return { refusal: { outcome: "not_live", lifecycle: goal.lifecycle } as const };
    }
    if (goal.status !== "active") {
      return { refusal: { outcome: "bad_state", status: goal.status } as const };
    }
    return { goal };
  };

  const goalReviewSet = (input: GoalReviewSetInput): GoalReviewSetOutcome =>
    transaction((): GoalReviewSetOutcome => {
      const owner = input.principal.ownerId;
      const used = usableGoal(owner, input.goalId);
      if (used.refusal) {
        return used.refusal;
      }
      if (input.cadence === null) {
        run(
          "DELETE FROM goal_review_plans WHERE owner_id = ? AND goal_id = ?",
          owner,
          input.goalId,
        );
        return { outcome: "cleared" };
      }
      const existing = planRow(owner, input.goalId);
      if (existing && String(existing.cadence) === input.cadence) {
        return { outcome: "set", plan: toPlan(existing, true, input.now) };
      }
      // A new cadence starts counting from now: the first reminder is one full period away.
      const nextDueAt = input.now + GOAL_REVIEW_PERIOD_MS[input.cadence];
      if (existing) {
        run(
          "UPDATE goal_review_plans SET cadence = ?, next_due_at = ?, snoozed_until = NULL, nudged_at = NULL, updated_at = ? " +
            "WHERE owner_id = ? AND goal_id = ?",
          input.cadence,
          nextDueAt,
          input.now,
          owner,
          input.goalId,
        );
      } else {
        run(
          "INSERT INTO goal_review_plans (owner_id, goal_id, cadence, next_due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          owner,
          input.goalId,
          input.cadence,
          nextDueAt,
          input.now,
          input.now,
        );
      }
      return {
        outcome: "set",
        plan: toPlan(planRow(owner, input.goalId) as Row, true, input.now),
      };
    });

  const goalReviewAct = (input: GoalReviewActInput): GoalReviewActOutcome =>
    transaction((): GoalReviewActOutcome => {
      const owner = input.principal.ownerId;
      const used = usableGoal(owner, input.goalId);
      if (used.refusal) {
        return used.refusal;
      }
      const row = planRow(owner, input.goalId);
      if (!row) {
        return { outcome: "no_plan" };
      }
      if (input.action === "snooze") {
        run(
          "UPDATE goal_review_plans SET snoozed_until = ?, nudged_at = NULL, updated_at = ? WHERE owner_id = ? AND goal_id = ?",
          input.now + GOAL_REVIEW_SNOOZE_MS,
          input.now,
          owner,
          input.goalId,
        );
        return {
          outcome: "snoozed",
          plan: toPlan(planRow(owner, input.goalId) as Row, true, input.now),
        };
      }
      const period = GOAL_REVIEW_PERIOD_MS[String(row.cadence) as GoalReviewCadence];
      run(
        "UPDATE goal_review_plans SET last_reviewed_at = ?, next_due_at = ?, snoozed_until = NULL, nudged_at = NULL, updated_at = ? " +
          "WHERE owner_id = ? AND goal_id = ?",
        input.now,
        input.now + period,
        input.now,
        owner,
        input.goalId,
      );
      if (input.entryText) {
        insertSystemEntry(owner, input.goalId, input.entryText, input.now);
      }
      return {
        outcome: "done",
        plan: toPlan(planRow(owner, input.goalId) as Row, true, input.now),
      };
    });

  /** Plans of the owner (all, or the named goals), already filtered to goals that can be reminded about. */
  const goalReviewList = (input: GoalReviewListInput): GoalReviewPlan[] => {
    const owner = input.principal.ownerId;
    const rows = all(
      "SELECT p.*, (g.status = 'active' AND g.lifecycle = 'live') AS active FROM goal_review_plans p " +
        "JOIN goals g ON g.owner_id = p.owner_id AND g.id = p.goal_id WHERE p.owner_id = ? ORDER BY p.next_due_at, p.goal_id LIMIT 500",
      owner,
    );
    const wanted = input.goalIds === undefined ? undefined : new Set(input.goalIds);
    return rows
      .filter((row) => wanted === undefined || wanted.has(String(row.goal_id)))
      .map((row) => toPlan(row, Number(row.active) === 1, input.now))
      .filter((plan) => !input.dueOnly || plan.due);
  };

  const goalReviewNudge = (input: GoalReviewNudgeInput): GoalReviewNudgeRow[] =>
    transaction((): GoalReviewNudgeRow[] => {
      const owner = input.principal.ownerId;
      const rows = all(
        "SELECT p.goal_id, p.next_due_at, p.snoozed_until, g.title, g.category FROM goal_review_plans p " +
          "JOIN goals g ON g.owner_id = p.owner_id AND g.id = p.goal_id " +
          "WHERE p.owner_id = ? AND g.status = 'active' AND g.lifecycle = 'live' AND p.next_due_at <= ? " +
          "AND (p.snoozed_until IS NULL OR p.snoozed_until <= ?) AND p.nudged_at IS NULL " +
          "ORDER BY p.next_due_at, p.goal_id LIMIT ?",
        owner,
        input.now,
        input.now,
        input.limit,
      );
      for (const row of rows) {
        run(
          "UPDATE goal_review_plans SET nudged_at = ? WHERE owner_id = ? AND goal_id = ?",
          input.now,
          owner,
          String(row.goal_id),
        );
      }
      return rows.map((row) => ({
        goalId: String(row.goal_id),
        title: String(row.title),
        category: String(row.category) as GoalReviewNudgeRow["category"],
      }));
    });

  return { goalReviewSet, goalReviewAct, goalReviewList, goalReviewNudge };
}
