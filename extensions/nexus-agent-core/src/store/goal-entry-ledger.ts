import type { GoalCommon } from "./goal-ledger-common.js";
// Goals kernel, append-only entries and the links from a goal to tasks, files, preferences and watches.
import { cleanBlock, toEntry, toGoal, toLink, type Row } from "./goal-rows.js";
import {
  GOAL_LIMITS,
  type GoalEntryAddInput,
  type GoalEntryAddOutcome,
  type GoalEntryRetractInput,
  type GoalEntryRetractOutcome,
  type GoalLinkAddInput,
  type GoalLinkAddOutcome,
  type GoalLinkRemoveInput,
  type GoalLinkRemoveOutcome,
} from "./goal-types.js";
import { isClosed } from "./kernel.js";

const ENTRY_KINDS = ["note", "milestone", "review", "break", "system"] as const;
const ENTRY_AUTHORS = ["user", "agent", "system"] as const;
const LINK_KINDS = ["task", "vault_file", "preference", "watch"] as const;
export function createGoalEntries(c: GoalCommon) {
  const { transaction, one, run, newId, goalRow, hasTable, targetExists } = c;

  // ------------------------------------------------------------------ entries

  const goalEntryAdd = (input: GoalEntryAddInput): GoalEntryAddOutcome =>
    transaction((): GoalEntryAddOutcome => {
      const owner = input.principal.ownerId;
      if (!(ENTRY_KINDS as readonly string[]).includes(input.kind) || input.kind === "system") {
        return { outcome: "invalid", code: "bad_kind" };
      }
      if (
        !(ENTRY_AUTHORS as readonly string[]).includes(input.author) ||
        input.author === "system"
      ) {
        return { outcome: "invalid", code: "bad_author" };
      }
      const text = cleanBlock(input.text);
      if (text === undefined) {
        return { outcome: "invalid", code: "bad_text" };
      }
      if (Array.from(text).length > GOAL_LIMITS.entryText) {
        return { outcome: "invalid", code: "text_too_long" };
      }
      const row = goalRow(owner, input.goalId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const goal = toGoal(row);
      if (goal.lifecycle !== "live") {
        return { outcome: "not_live", lifecycle: goal.lifecycle };
      }
      if (goal.status === "proposed" || (goal.status === "completed" && !input.allowCompleted)) {
        return { outcome: "bad_state", status: goal.status };
      }
      let taskId: string | null = null;
      let claimId: string | null = null;
      if (input.taskId !== undefined) {
        const task = one(
          "SELECT status FROM nexus_tasks WHERE owner_id = ? AND id = ? AND purged_at IS NULL",
          owner,
          input.taskId,
        );
        if (!task) {
          return { outcome: "task_not_found" };
        }
        taskId = input.taskId;
        if (input.claimId !== undefined) {
          const claim = one(
            "SELECT 1 AS found FROM claims WHERE owner_id = ? AND task_id = ? AND id = ?",
            owner,
            input.taskId,
            input.claimId,
          );
          if (!claim) {
            return { outcome: "claim_not_found" };
          }
          claimId = input.claimId;
        }
      } else if (input.claimId !== undefined) {
        return { outcome: "claim_not_found" };
      }
      const count = Number(
        (
          one(
            "SELECT COUNT(*) AS c FROM goal_entries WHERE owner_id = ? AND goal_id = ?",
            owner,
            input.goalId,
          ) as Row
        ).c,
      );
      if (count >= GOAL_LIMITS.entriesPerGoal) {
        return { outcome: "limit_reached", max: GOAL_LIMITS.entriesPerGoal, kind: "entries" };
      }
      const id = newId("GE");
      run(
        "INSERT INTO goal_entries (owner_id, id, goal_id, kind, text, author, effective_at, created_at, task_id, claim_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        owner,
        id,
        input.goalId,
        input.kind,
        text,
        input.author,
        input.effectiveAt ?? input.now,
        input.now,
        taskId,
        claimId,
      );
      run(
        "UPDATE goals SET updated_at = ? WHERE owner_id = ? AND id = ?",
        input.now,
        owner,
        input.goalId,
      );
      return {
        outcome: "added",
        entry: toEntry(
          one("SELECT * FROM goal_entries WHERE owner_id = ? AND id = ?", owner, id) as Row,
        ),
      };
    });

  const goalEntryRetract = (input: GoalEntryRetractInput): GoalEntryRetractOutcome =>
    transaction((): GoalEntryRetractOutcome => {
      const owner = input.principal.ownerId;
      const row = goalRow(owner, input.goalId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const goal = toGoal(row);
      if (goal.lifecycle !== "live") {
        return { outcome: "not_live", lifecycle: goal.lifecycle };
      }
      const entryRow = one(
        "SELECT * FROM goal_entries WHERE owner_id = ? AND goal_id = ? AND id = ?",
        owner,
        input.goalId,
        input.entryId,
      );
      if (!entryRow) {
        return { outcome: "entry_not_found" };
      }
      const entry = toEntry(entryRow);
      if (entry.kind === "system") {
        return { outcome: "refused", reason: "system_entry" };
      }
      if (entry.retractedAt !== null) {
        return { outcome: "already_retracted", entry };
      }
      run(
        "UPDATE goal_entries SET retracted_at = ? WHERE owner_id = ? AND id = ? AND retracted_at IS NULL",
        input.now,
        owner,
        input.entryId,
      );
      return {
        outcome: "retracted",
        entry: toEntry(
          one(
            "SELECT * FROM goal_entries WHERE owner_id = ? AND id = ?",
            owner,
            input.entryId,
          ) as Row,
        ),
      };
    });

  // ------------------------------------------------------------------ links

  const goalLinkAdd = (input: GoalLinkAddInput): GoalLinkAddOutcome =>
    transaction((): GoalLinkAddOutcome => {
      const owner = input.principal.ownerId;
      if (!(LINK_KINDS as readonly string[]).includes(input.kind)) {
        return { outcome: "invalid", code: "bad_kind" };
      }
      if (typeof input.refId !== "string" || input.refId.length === 0 || input.refId.length > 128) {
        return { outcome: "invalid", code: "bad_ref" };
      }
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
      if (input.kind === "vault_file" && !hasTable("vault_files")) {
        return { outcome: "capability_unavailable" };
      }
      if (input.kind === "task") {
        const task = one(
          "SELECT status FROM nexus_tasks WHERE owner_id = ? AND id = ? AND purged_at IS NULL",
          owner,
          input.refId,
        );
        if (!task) {
          return { outcome: "target_not_found" };
        }
        if (String(task.status) === "purging") {
          return { outcome: "target_unavailable", reason: "purging" };
        }
        if (isClosed(String(task.status)) && String(task.status) !== "succeeded") {
          return { outcome: "target_unavailable", reason: "closed" };
        }
        const elsewhere = one(
          "SELECT goal_id FROM goal_links WHERE owner_id = ? AND kind = 'task' AND ref_id = ? AND goal_id <> ?",
          owner,
          input.refId,
          input.goalId,
        );
        if (elsewhere) {
          return { outcome: "task_linked_elsewhere", goalId: String(elsewhere.goal_id) };
        }
      } else if (input.kind === "vault_file") {
        const file = one(
          "SELECT state FROM vault_files WHERE owner_id = ? AND id = ?",
          owner,
          input.refId,
        );
        if (!file) {
          return { outcome: "target_not_found" };
        }
        if (String(file.state) === "purging") {
          return { outcome: "target_unavailable", reason: "purging" };
        }
      } else if (!targetExists(owner, input.kind, input.refId)) {
        return { outcome: "target_not_found" };
      }
      const existing = one(
        "SELECT * FROM goal_links WHERE owner_id = ? AND goal_id = ? AND kind = ? AND ref_id = ?",
        owner,
        input.goalId,
        input.kind,
        input.refId,
      );
      if (existing) {
        return { outcome: "unchanged", link: toLink(existing, false) };
      }
      const count = Number(
        (
          one(
            "SELECT COUNT(*) AS c FROM goal_links WHERE owner_id = ? AND goal_id = ?",
            owner,
            input.goalId,
          ) as Row
        ).c,
      );
      if (count >= GOAL_LIMITS.linksPerGoal) {
        return { outcome: "limit_reached", max: GOAL_LIMITS.linksPerGoal, kind: "links" };
      }
      const id = newId("GK");
      run(
        "INSERT INTO goal_links (owner_id, id, goal_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        owner,
        id,
        input.goalId,
        input.kind,
        input.refId,
        input.now,
      );
      run(
        "UPDATE goals SET updated_at = ? WHERE owner_id = ? AND id = ?",
        input.now,
        owner,
        input.goalId,
      );
      return {
        outcome: "linked",
        link: toLink(
          one("SELECT * FROM goal_links WHERE owner_id = ? AND id = ?", owner, id) as Row,
          false,
        ),
      };
    });

  const goalLinkRemove = (input: GoalLinkRemoveInput): GoalLinkRemoveOutcome =>
    transaction((): GoalLinkRemoveOutcome => {
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
        "DELETE FROM goal_links WHERE owner_id = ? AND goal_id = ? AND id = ?",
        owner,
        input.goalId,
        input.linkId,
      );
      if (removed === 0) {
        return { outcome: "link_not_found" };
      }
      run(
        "UPDATE goals SET updated_at = ? WHERE owner_id = ? AND id = ?",
        input.now,
        owner,
        input.goalId,
      );
      return { outcome: "removed" };
    });

  return {
    goalEntryAdd,
    goalEntryRetract,
    goalLinkAdd,
    goalLinkRemove,
  };
}
