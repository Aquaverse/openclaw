// Goals kernel, shared part: the statement helpers every goal module uses (owner-scoped row reads, active / proposed counts, the
// one-level nesting check, similar-title lookup, system entries, and "does the pointed-at object still exist"). No transaction
// is opened here; the modules around it (goal-create-ledger.ts, goal-edit-ledger.ts, goal-read-ledger.ts, goal-entry-ledger.ts)
// own their own ones. Every statement filters on owner_id.
import type { ClaimLedger } from "./claim-ledger.js";
import { GOAL_COLUMNS, similarTitles, toGoal, toLink, type GoalDb, type Row } from "./goal-rows.js";
import type { GoalLinkKind, GoalRecord } from "./goal-types.js";
import type { TransactionRunner } from "./kernel.js";

export type ParentProblem = "not_found" | "not_top_level" | "not_active" | "not_live";

export function createGoalCommon(
  transaction: TransactionRunner,
  internals: ClaimLedger["internals"],
) {
  const db: GoalDb = {
    one: internals.one,
    all: internals.all,
    run: internals.run,
    newId: internals.newId,
  };
  const { one, all, run, newId } = db;

  const goalRow = (owner: string, id: string): Row | undefined =>
    one(`SELECT ${GOAL_COLUMNS} FROM goals WHERE owner_id = ? AND id = ?`, owner, id);
  const mustGoal = (owner: string, id: string): GoalRecord => toGoal(goalRow(owner, id) as Row);

  const countWhere = (owner: string, where: string, ...params: (string | number)[]): number =>
    Number(
      (
        one(
          `SELECT COUNT(*) AS c FROM goals WHERE owner_id = ? AND ${where}`,
          owner,
          ...params,
        ) as Row
      ).c,
    );
  const activeCount = (owner: string) =>
    countWhere(owner, "status = 'active' AND lifecycle = 'live'");
  const proposedCount = (owner: string) =>
    countWhere(owner, "status = 'proposed' AND lifecycle = 'live'");

  /** One level of nesting: the parent must be a live, active, top-level goal (design invariant 1). */
  const parentProblem = (owner: string, parentId: string): ParentProblem | undefined => {
    const row = goalRow(owner, parentId);
    if (!row) {
      return "not_found";
    }
    if (String(row.lifecycle) !== "live") {
      return "not_live";
    }
    if (row.parent_id !== null) {
      return "not_top_level";
    }
    return String(row.status) === "active" ? undefined : "not_active";
  };

  const nextSortOrder = (owner: string, parentId: string | null): number => {
    const row = one(
      "SELECT COALESCE(MAX(sort_order), 0) AS m FROM goals WHERE owner_id = ? AND lifecycle = 'live' AND " +
        (parentId === null ? "parent_id IS NULL" : "parent_id = ?"),
      ...(parentId === null ? [owner] : [owner, parentId]),
    ) as Row;
    return Number(row.m) + 1;
  };

  /** A live active or proposed goal in the same category whose title reads as the same matter. */
  const similarGoal = (
    owner: string,
    category: string,
    title: string,
    exceptId?: string,
  ): GoalRecord | undefined => {
    const rows = all(
      `SELECT ${GOAL_COLUMNS} FROM goals WHERE owner_id = ? AND lifecycle = 'live' AND status IN ('active','proposed') ` +
        "AND category = ? ORDER BY updated_at DESC LIMIT 200",
      owner,
      category,
    );
    const hit = rows.find(
      (row) => String(row.id) !== exceptId && similarTitles(String(row.title), title),
    );
    return hit ? toGoal(hit) : undefined;
  };

  const insertSystemEntry = (owner: string, goalId: string, text: string, now: number): void => {
    run(
      "INSERT INTO goal_entries (owner_id, id, goal_id, kind, text, author, effective_at, created_at) " +
        "VALUES (?, ?, ?, 'system', ?, 'system', ?, ?)",
      owner,
      newId("GE"),
      goalId,
      text,
      now,
      now,
    );
  };

  const hasTable = (name: string): boolean =>
    one("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?", name) !==
    undefined;

  /** Does the pointed-at object still exist? Pointers are not foreign keys, so a purged target shows as "gone". */
  const targetExists = (owner: string, kind: GoalLinkKind, refId: string): boolean => {
    switch (kind) {
      case "task":
        return (
          one(
            "SELECT 1 AS found FROM nexus_tasks WHERE owner_id = ? AND id = ? AND purged_at IS NULL",
            owner,
            refId,
          ) !== undefined
        );
      case "vault_file":
        return (
          hasTable("vault_files") &&
          one(
            "SELECT 1 AS found FROM vault_files WHERE owner_id = ? AND id = ? AND state <> 'purging'",
            owner,
            refId,
          ) !== undefined
        );
      case "preference":
        return (
          one(
            "SELECT 1 AS found FROM preferences WHERE owner_id = ? AND id = ? AND purged_at IS NULL",
            owner,
            refId,
          ) !== undefined
        );
      case "watch":
        return (
          one("SELECT 1 AS found FROM watches WHERE owner_id = ? AND id = ?", owner, refId) !==
          undefined
        );
    }
  };

  const linksOf = (owner: string, goalId: string) =>
    all(
      "SELECT * FROM goal_links WHERE owner_id = ? AND goal_id = ? ORDER BY created_at, id",
      owner,
      goalId,
    ).map((row) =>
      toLink(row, !targetExists(owner, String(row.kind) as GoalLinkKind, String(row.ref_id))),
    );

  return {
    transaction,
    one,
    all,
    run,
    newId,
    goalRow,
    mustGoal,
    countWhere,
    activeCount,
    proposedCount,
    parentProblem,
    nextSortOrder,
    similarGoal,
    insertSystemEntry,
    hasTable,
    targetExists,
    linksOf,
  };
}

export type GoalCommon = ReturnType<typeof createGoalCommon>;
