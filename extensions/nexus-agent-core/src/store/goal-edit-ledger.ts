import type { GoalCommon } from "./goal-ledger-common.js";
// Goals kernel, user-side writes: confirm a proposal, edit fields, complete and reopen. Only the operator reaches these.
import { cleanBlock, checkFields, foldText, isGoalCategory, toGoal } from "./goal-rows.js";
import {
  isOpenGoalCategory,
  type GoalConfirmInput,
  type GoalConfirmOutcome,
  type GoalTransitionInput,
  type GoalTransitionOutcome,
  type GoalUpdateInput,
  type GoalUpdateOutcome,
} from "./goal-types.js";

export function createGoalEdits(c: GoalCommon) {
  const { transaction, run, goalRow, mustGoal, activeCount, parentProblem, insertSystemEntry } = c;

  // ------------------------------------------------------------------ user-side writes

  const goalConfirm = (input: GoalConfirmInput): GoalConfirmOutcome =>
    transaction((): GoalConfirmOutcome => {
      const owner = input.principal.ownerId;
      const row = goalRow(owner, input.goalId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const goal = toGoal(row);
      if (goal.lifecycle !== "live") {
        return { outcome: "not_live", lifecycle: goal.lifecycle };
      }
      if (goal.status !== "proposed") {
        return { outcome: "bad_state", status: goal.status };
      }
      const merged = checkFields({
        title: input.edits?.title ?? goal.title,
        summary: input.edits?.summary ?? goal.summary ?? undefined,
        currentState: input.edits?.currentState ?? goal.currentState ?? undefined,
      });
      if (!merged.ok) {
        return { outcome: "invalid", code: merged.code };
      }
      if (goal.parentId !== null) {
        const problem = parentProblem(owner, goal.parentId);
        if (problem) {
          return { outcome: "not_live", lifecycle: "deleted" };
        }
      }
      if (activeCount(owner) >= input.maxActive) {
        return { outcome: "limit_reached", max: input.maxActive, kind: "active" };
      }
      const changed = run(
        "UPDATE goals SET status = 'active', title = ?, summary = ?, current_state = ?, confirmed_at = ?, confirmed_by = ?, " +
          "questions_json = NULL, revision = revision + 1, updated_at = ? " +
          "WHERE owner_id = ? AND id = ? AND status = 'proposed' AND lifecycle = 'live'",
        merged.value.title,
        merged.value.summary,
        merged.value.currentState,
        input.now,
        input.actor,
        input.now,
        owner,
        input.goalId,
      );
      if (changed === 0) {
        return { outcome: "bad_state", status: goal.status };
      }
      insertSystemEntry(
        owner,
        input.goalId,
        merged.value.currentState ?? merged.value.title,
        input.now,
      );
      return { outcome: "confirmed", goal: mustGoal(owner, input.goalId) };
    });

  const goalUpdate = (input: GoalUpdateInput): GoalUpdateOutcome =>
    transaction((): GoalUpdateOutcome => {
      const owner = input.principal.ownerId;
      const row = goalRow(owner, input.goalId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const goal = toGoal(row);
      if (goal.lifecycle !== "live") {
        return { outcome: "not_live", lifecycle: goal.lifecycle };
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== goal.revision) {
        return { outcome: "stale", revision: goal.revision };
      }
      const patch = input.patch;
      const next = {
        title: goal.title,
        summary: goal.summary,
        currentState: goal.currentState,
        category: goal.category as string,
        sensitivity: goal.sensitivity as string,
        sortOrder: goal.sortOrder,
      };
      if (patch.title !== undefined) {
        next.title = foldText(patch.title) ?? "";
      }
      if (patch.summary !== undefined) {
        next.summary = patch.summary === null ? null : (cleanBlock(patch.summary) ?? null);
      }
      if (patch.currentState !== undefined) {
        next.currentState =
          patch.currentState === null ? null : (foldText(patch.currentState) ?? null);
      }
      const checked = checkFields({
        title: next.title,
        summary: next.summary ?? undefined,
        currentState: next.currentState ?? undefined,
      });
      if (!checked.ok) {
        return { outcome: "invalid", code: checked.code };
      }
      if (patch.category !== undefined) {
        if (!isGoalCategory(patch.category) || !isOpenGoalCategory(patch.category)) {
          return { outcome: "invalid", code: "bad_category" };
        }
        next.category = patch.category;
      }
      if (patch.sensitivity !== undefined) {
        if (patch.sensitivity !== "normal" && patch.sensitivity !== "sensitive") {
          return { outcome: "invalid", code: "bad_sensitivity" };
        }
        next.sensitivity = patch.sensitivity;
      }
      if (patch.sortOrder !== undefined) {
        if (typeof patch.sortOrder !== "number" || !Number.isFinite(patch.sortOrder)) {
          return { outcome: "invalid", code: "bad_sort_order" };
        }
        next.sortOrder = patch.sortOrder;
      }
      const same =
        checked.value.title === goal.title &&
        checked.value.summary === goal.summary &&
        checked.value.currentState === goal.currentState &&
        next.category === goal.category &&
        next.sensitivity === goal.sensitivity &&
        next.sortOrder === goal.sortOrder;
      if (same) {
        return { outcome: "unchanged", goal };
      }
      run(
        "UPDATE goals SET title = ?, summary = ?, current_state = ?, category = ?, sensitivity = ?, sort_order = ?, " +
          "revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ? AND lifecycle = 'live'",
        checked.value.title,
        checked.value.summary,
        checked.value.currentState,
        next.category,
        next.sensitivity,
        next.sortOrder,
        input.now,
        owner,
        input.goalId,
      );
      return { outcome: "updated", goal: mustGoal(owner, input.goalId) };
    });

  /** `active -> completed` and back. Only the operator reaches these (design 5.2: the Agent can only suggest). */
  const goalComplete = (input: GoalTransitionInput): GoalTransitionOutcome =>
    transaction((): GoalTransitionOutcome => {
      const owner = input.principal.ownerId;
      const row = goalRow(owner, input.goalId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const goal = toGoal(row);
      if (goal.lifecycle !== "live") {
        return { outcome: "not_live", lifecycle: goal.lifecycle };
      }
      if (goal.status === "completed") {
        return { outcome: "unchanged", goal };
      }
      if (goal.status !== "active") {
        return { outcome: "bad_state", status: goal.status };
      }
      run(
        "UPDATE goals SET status = 'completed', completed_at = ?, revision = revision + 1, updated_at = ? " +
          "WHERE owner_id = ? AND id = ? AND status = 'active' AND lifecycle = 'live'",
        input.now,
        input.now,
        owner,
        input.goalId,
      );
      return { outcome: "done", goal: mustGoal(owner, input.goalId) };
    });

  const goalReopen = (input: GoalTransitionInput): GoalTransitionOutcome =>
    transaction((): GoalTransitionOutcome => {
      const owner = input.principal.ownerId;
      const row = goalRow(owner, input.goalId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const goal = toGoal(row);
      if (goal.lifecycle !== "live") {
        return { outcome: "not_live", lifecycle: goal.lifecycle };
      }
      if (goal.status === "active") {
        return { outcome: "unchanged", goal };
      }
      if (goal.status !== "completed") {
        return { outcome: "bad_state", status: goal.status };
      }
      if (activeCount(owner) >= input.maxActive) {
        return { outcome: "limit_reached", max: input.maxActive, kind: "active" };
      }
      run(
        "UPDATE goals SET status = 'active', completed_at = NULL, revision = revision + 1, updated_at = ? " +
          "WHERE owner_id = ? AND id = ? AND status = 'completed' AND lifecycle = 'live'",
        input.now,
        owner,
        input.goalId,
      );
      return { outcome: "done", goal: mustGoal(owner, input.goalId) };
    });

  return {
    goalConfirm,
    goalUpdate,
    goalComplete,
    goalReopen,
  };
}
