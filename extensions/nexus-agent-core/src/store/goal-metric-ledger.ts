// Goals kernel, metrics (Goals design 6.2): an optional named figure on a goal, filled in by hand or read from one claim.
//   * the Agent has no entrance here (the service exposes it to the console RPC only);
//   * `manual` figures are the user's own words ("self-reported"); a `claim` metric stores no figure at all, the figure is read
//     from the claim at get time, so it follows the claim's state;
//   * finance goals accept `manual` only until the finance record model exists (design 12.2, item 7);
//   * reaching the target writes ONE system entry per crossing and never completes or otherwise acts on the goal.
import type { GoalCommon } from "./goal-ledger-common.js";
import { foldText, metricReached, toGoal, toMetric, type Row } from "./goal-rows.js";
import {
  GOAL_LIMITS,
  type GoalMetricDirection,
  type GoalMetricRemoveInput,
  type GoalMetricRemoveOutcome,
  type GoalMetricSetInput,
  type GoalMetricSetOutcome,
} from "./goal-types.js";

const charLength = (text: string): number => Array.from(text).length;
const isFigure = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= GOAL_LIMITS.metricValue;

export function createGoalMetrics(c: GoalCommon) {
  const { transaction, one, run, newId, goalRow, insertSystemEntry } = c;

  const goalMetricSet = (input: GoalMetricSetInput): GoalMetricSetOutcome =>
    transaction((): GoalMetricSetOutcome => {
      const owner = input.principal.ownerId;
      const row = goalRow(owner, input.goalId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const goal = toGoal(row);
      if (goal.lifecycle !== "live") {
        return { outcome: "not_live", lifecycle: goal.lifecycle };
      }
      if (goal.status === "proposed") {
        return { outcome: "bad_state", status: goal.status };
      }
      const existingRow =
        input.metricId === undefined
          ? undefined
          : one(
              "SELECT * FROM goal_metrics WHERE owner_id = ? AND goal_id = ? AND id = ?",
              owner,
              input.goalId,
              input.metricId,
            );
      if (input.metricId !== undefined && !existingRow) {
        return { outcome: "metric_not_found" };
      }
      const existing = existingRow ? toMetric(existingRow) : undefined;

      const name = input.name === undefined ? existing?.name : foldText(input.name);
      if (name === undefined || charLength(name) > GOAL_LIMITS.metricName) {
        return { outcome: "invalid", code: "bad_metric_name" };
      }
      const unitRaw = input.unit === undefined ? existing?.unit : input.unit;
      const unit = unitRaw === undefined ? "" : (foldText(unitRaw) ?? "");
      if (charLength(unit) > GOAL_LIMITS.metricUnit) {
        return { outcome: "invalid", code: "bad_metric_unit" };
      }
      const direction: GoalMetricDirection = input.direction ?? existing?.direction ?? "up";
      if (direction !== "up" && direction !== "down") {
        return { outcome: "invalid", code: "bad_metric_value" };
      }
      const source = existing?.source ?? input.source ?? "manual";
      if (source !== "manual" && source !== "claim") {
        return { outcome: "invalid", code: "bad_metric_source" };
      }
      if (existing && input.source !== undefined && input.source !== existing.source) {
        return { outcome: "invalid", code: "bad_metric_source" };
      }
      const target = input.target === undefined ? (existing?.target ?? null) : input.target;
      if (target !== null && !isFigure(target)) {
        return { outcome: "invalid", code: "bad_metric_value" };
      }
      let current: number | null = null;
      let taskId: string | null = existing?.taskId ?? null;
      let claimId: string | null = existing?.claimId ?? null;
      if (source === "manual") {
        if (input.taskId !== undefined || input.claimId !== undefined) {
          return { outcome: "invalid", code: "bad_metric_source" };
        }
        current = input.current === undefined ? (existing?.current ?? null) : input.current;
        if (current !== null && !isFigure(current)) {
          return { outcome: "invalid", code: "bad_metric_value" };
        }
      } else {
        if (input.current !== undefined && input.current !== null) {
          return { outcome: "invalid", code: "bad_metric_source" };
        }
        if (goal.category === "finance") {
          return { outcome: "refused", reason: "finance_manual_only" };
        }
        if (!existing) {
          if (input.taskId === undefined || input.claimId === undefined) {
            return { outcome: "invalid", code: "bad_metric_source" };
          }
          const task = one(
            "SELECT 1 AS found FROM nexus_tasks WHERE owner_id = ? AND id = ? AND purged_at IS NULL",
            owner,
            input.taskId,
          );
          if (!task) {
            return { outcome: "task_not_found" };
          }
          const claim = one(
            "SELECT 1 AS found FROM claims WHERE owner_id = ? AND task_id = ? AND id = ?",
            owner,
            input.taskId,
            input.claimId,
          );
          if (!claim) {
            return { outcome: "claim_not_found" };
          }
          taskId = input.taskId;
          claimId = input.claimId;
        } else if (input.taskId !== undefined || input.claimId !== undefined) {
          return { outcome: "invalid", code: "bad_metric_source" };
        }
      }

      const clash = one(
        "SELECT id FROM goal_metrics WHERE owner_id = ? AND goal_id = ? AND name = ? AND id <> ?",
        owner,
        input.goalId,
        name,
        existing?.id ?? "",
      );
      if (clash) {
        return { outcome: "name_taken", metricId: String(clash.id) };
      }

      let id: string;
      let reachedAt: number | null = existing?.reachedAt ?? null;
      const reached = source === "manual" && metricReached({ direction, target, current });
      let reachedNow = false;
      if (reached && reachedAt === null) {
        reachedAt = input.now;
        reachedNow = true;
      } else if (!reached && source === "manual") {
        reachedAt = null;
      }
      const asOf = source === "manual" && current !== null ? input.now : null;
      if (existing) {
        id = existing.id;
        run(
          "UPDATE goal_metrics SET name = ?, unit = ?, direction = ?, target = ?, current = ?, as_of = ?, reached_at = ?, updated_at = ? " +
            "WHERE owner_id = ? AND id = ?",
          name,
          unit,
          direction,
          target,
          current,
          asOf ?? existing.asOf,
          reachedAt,
          input.now,
          owner,
          id,
        );
      } else {
        const count = Number(
          (
            one(
              "SELECT COUNT(*) AS c FROM goal_metrics WHERE owner_id = ? AND goal_id = ?",
              owner,
              input.goalId,
            ) as Row
          ).c,
        );
        if (count >= GOAL_LIMITS.metricsPerGoal) {
          return { outcome: "limit_reached", max: GOAL_LIMITS.metricsPerGoal, kind: "metrics" };
        }
        id = newId("GM");
        run(
          "INSERT INTO goal_metrics (owner_id, id, goal_id, name, unit, direction, target, current, as_of, source, task_id, claim_id, " +
            "reached_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          owner,
          id,
          input.goalId,
          name,
          unit,
          direction,
          target,
          current,
          asOf,
          source,
          taskId,
          claimId,
          reachedAt,
          input.now,
          input.now,
        );
      }
      if (reachedNow) {
        const figure = unit === "" ? String(current) : `${String(current)} ${unit}`;
        insertSystemEntry(
          owner,
          input.goalId,
          input.reachedText.replace("{name}", name).replace("{value}", figure),
          input.now,
        );
      }
      run(
        "UPDATE goals SET updated_at = ? WHERE owner_id = ? AND id = ?",
        input.now,
        owner,
        input.goalId,
      );
      return {
        outcome: existing ? "updated" : "created",
        metric: toMetric(
          one("SELECT * FROM goal_metrics WHERE owner_id = ? AND id = ?", owner, id) as Row,
        ),
        reachedNow,
      };
    });

  const goalMetricRemove = (input: GoalMetricRemoveInput): GoalMetricRemoveOutcome =>
    transaction((): GoalMetricRemoveOutcome => {
      const owner = input.principal.ownerId;
      const row = goalRow(owner, input.goalId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const goal = toGoal(row);
      if (goal.lifecycle !== "live") {
        return { outcome: "not_live", lifecycle: goal.lifecycle };
      }
      const removed = run(
        "DELETE FROM goal_metrics WHERE owner_id = ? AND goal_id = ? AND id = ?",
        owner,
        input.goalId,
        input.metricId,
      );
      if (removed === 0) {
        return { outcome: "metric_not_found" };
      }
      run(
        "UPDATE goals SET updated_at = ? WHERE owner_id = ? AND id = ?",
        input.now,
        owner,
        input.goalId,
      );
      return { outcome: "removed" };
    });

  return { goalMetricSet, goalMetricRemove };
}
