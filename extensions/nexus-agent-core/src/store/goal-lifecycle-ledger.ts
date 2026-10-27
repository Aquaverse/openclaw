// Goals kernel, part 2 (Goals design 5.1 "deletion and purge" and "the Goal <-> File relation"): soft delete, restore, the hard
// purge protocol with its durable run and permanent receipt, and the hooks the file vault calls. Every lifecycle transition is a
// single conditional statement with a COMPLETE assignment (lifecycle and deleted_at move together, so the CHECK holds).
//
// Purge, G1 scope: a goal moves to `purging` (children too) in ONE transaction that also writes `goal_purge_runs` with a stable
// purge_id and the ORIGINAL requester. Finalising a goal (children first) is one transaction: holder check, counts, receipt,
// run row, goal row (entries and links cascade). Reviews and metrics do not exist yet (G2/G3), so their counts are 0 and there is
// no review gate; the run row and the lease protocol are the ones the later phases extend.
import { sha256Hex } from "../canonical.js";
import type { ClaimLedger } from "./claim-ledger.js";
import { GOAL_COLUMNS, toGoal, type Row } from "./goal-rows.js";
import type {
  GoalDeleteOutcome,
  GoalForFile,
  GoalPurgeBeginInput,
  GoalPurgeBeginOutcome,
  GoalPurgeFinalizeInput,
  GoalPurgeFinalizeOutcome,
  GoalPurgeReceiptRow,
  GoalPurgeReleaseInput,
  GoalPurgeResumableInput,
  GoalPurgeResumableRow,
  GoalPurgeRunRecord,
  GoalPurgeStatusOutcome,
  GoalRecord,
  GoalRestoreOutcome,
  GoalsForFileInput,
  GoalStatus,
} from "./goal-types.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { VaultPurgeHooks } from "./vault-maintenance-types.js";

const PURGE_ID_ATTEMPTS = 8;

function toRun(row: Row, leased: boolean): GoalPurgeRunRecord {
  return {
    goalId: String(row.goal_id),
    parentId: typeof row.parent_id === "string" ? row.parent_id : null,
    purgeId: String(row.purge_id),
    requestedBy: String(row.requested_by),
    requestedAt: Number(row.requested_at),
    leased,
  };
}

function toReceipt(row: Row): GoalPurgeReceiptRow {
  return {
    id: String(row.id),
    purgeId: String(row.purge_id),
    goalIdHash: String(row.goal_id_hash),
    titleHash: String(row.title_hash),
    entryCount: Number(row.entry_count),
    linkCount: Number(row.link_count),
    metricCount: Number(row.metric_count),
    reviewCount: Number(row.review_count),
    requestedBy: String(row.requested_by),
    executedAt: Number(row.executed_at),
  };
}

export function createGoalLifecycleLedger(
  transaction: TransactionRunner,
  internals: ClaimLedger["internals"],
) {
  const { one, all, run, newId } = internals;

  const goalRow = (owner: string, id: string): Row | undefined =>
    one(`SELECT ${GOAL_COLUMNS} FROM goals WHERE owner_id = ? AND id = ?`, owner, id);
  const mustGoal = (owner: string, id: string): GoalRecord => toGoal(goalRow(owner, id) as Row);
  const activeCount = (owner: string): number =>
    Number(
      (
        one(
          "SELECT COUNT(*) AS c FROM goals WHERE owner_id = ? AND status = 'active' AND lifecycle = 'live'",
          owner,
        ) as Row
      ).c,
    );

  // ------------------------------------------------------------------ soft delete and restore

  const goalDelete = (input: {
    principal: Principal;
    goalId: string;
    now: number;
  }): GoalDeleteOutcome =>
    transaction((): GoalDeleteOutcome => {
      const owner = input.principal.ownerId;
      const row = goalRow(owner, input.goalId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const goal = toGoal(row);
      if (goal.lifecycle === "purging") {
        return { outcome: "purging" };
      }
      if (goal.lifecycle === "deleted") {
        return { outcome: "already_deleted", goal, affected: 0 };
      }
      // The goal and its live sub-goals move together; the idempotency key is released so the same matter can be proposed again.
      const affected = run(
        "UPDATE goals SET lifecycle = 'deleted', deleted_at = ?, idempotency_key = NULL, revision = revision + 1, updated_at = ? " +
          "WHERE owner_id = ? AND lifecycle = 'live' AND (id = ? OR parent_id = ?)",
        input.now,
        input.now,
        owner,
        input.goalId,
        input.goalId,
      );
      return { outcome: "deleted", goal: mustGoal(owner, input.goalId), affected };
    });

  const goalRestore = (input: {
    principal: Principal;
    goalId: string;
    maxActive: number;
    now: number;
  }): GoalRestoreOutcome =>
    transaction((): GoalRestoreOutcome => {
      const owner = input.principal.ownerId;
      const row = goalRow(owner, input.goalId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const goal = toGoal(row);
      if (goal.lifecycle !== "deleted" || goal.deletedAt === null) {
        return { outcome: "not_deleted", lifecycle: goal.lifecycle };
      }
      if (goal.parentId !== null) {
        const parent = goalRow(owner, goal.parentId);
        if (!parent || String(parent.lifecycle) !== "live") {
          return { outcome: "parent_deleted" };
        }
      }
      // Sub-goals that were deleted at the same instant came down with this goal; they come back with it.
      const together = all(
        "SELECT status FROM goals WHERE owner_id = ? AND lifecycle = 'deleted' AND (id = ? OR (parent_id = ? AND deleted_at = ?))",
        owner,
        input.goalId,
        input.goalId,
        goal.deletedAt,
      );
      const returningActive = together.filter((r) => String(r.status) === "active").length;
      if (activeCount(owner) + returningActive > input.maxActive) {
        return { outcome: "limit_reached", max: input.maxActive, kind: "active" };
      }
      const affected = run(
        "UPDATE goals SET lifecycle = 'live', deleted_at = NULL, revision = revision + 1, updated_at = ? " +
          "WHERE owner_id = ? AND lifecycle = 'deleted' AND (id = ? OR (parent_id = ? AND deleted_at = ?))",
        input.now,
        owner,
        input.goalId,
        input.goalId,
        goal.deletedAt,
      );
      return { outcome: "restored", goal: mustGoal(owner, input.goalId), affected };
    });

  // ------------------------------------------------------------------ purge: G1 (begin / resume)

  const runRows = (owner: string, goalIds: readonly string[]): Row[] =>
    goalIds.flatMap((id) =>
      all(
        "SELECT r.*, g.parent_id AS parent_id FROM goal_purge_runs r JOIN goals g ON g.owner_id = r.owner_id AND g.id = r.goal_id " +
          "WHERE r.owner_id = ? AND r.goal_id = ?",
        owner,
        id,
      ),
    );

  /** Children first, then the goal: the order finalisation needs. */
  const family = (owner: string, goalId: string): string[] => {
    const children = all(
      "SELECT id FROM goals WHERE owner_id = ? AND parent_id = ? ORDER BY created_at, id",
      owner,
      goalId,
    ).map((row) => String(row.id));
    return [...children, goalId];
  };

  const freshPurgeId = (owner: string): string => {
    for (let attempt = 0; attempt < PURGE_ID_ATTEMPTS; attempt += 1) {
      const candidate = newId("GPG_");
      const taken =
        one(
          "SELECT 1 AS found FROM goal_purge_runs WHERE owner_id = ? AND purge_id = ?",
          owner,
          candidate,
        ) ||
        one(
          "SELECT 1 AS found FROM goal_purge_receipts WHERE owner_id = ? AND purge_id = ?",
          owner,
          candidate,
        );
      if (!taken) {
        return candidate;
      }
    }
    throw new Error("nexus-agent-core: could not generate a unique goal purge id");
  };

  const goalPurgeBegin = (input: GoalPurgeBeginInput): GoalPurgeBeginOutcome =>
    transaction((): GoalPurgeBeginOutcome => {
      const owner = input.principal.ownerId;
      const row = goalRow(owner, input.goalId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const goal = toGoal(row);
      const ids = family(owner, input.goalId);
      if (goal.lifecycle === "purging") {
        // Re-entry: the run exists. Active holder -> report it; free or expired lease -> take it over, same purge_id and requester.
        const runs = runRows(owner, ids);
        const holder = runs.find(
          (r) =>
            r.worker_attempt_id !== null &&
            String(r.worker_attempt_id) !== input.attemptId &&
            Number(r.worker_lease_until) > input.now,
        );
        if (holder) {
          return {
            outcome: "worker_active",
            purgeId: String(holder.purge_id),
            requestedBy: String(holder.requested_by),
          };
        }
        for (const r of runs) {
          run(
            "UPDATE goal_purge_runs SET worker_attempt_id = ?, worker_lease_until = ?, updated_at = ? WHERE owner_id = ? AND goal_id = ?",
            input.attemptId,
            input.now + input.leaseMs,
            input.now,
            owner,
            String(r.goal_id),
          );
        }
        return {
          outcome: "resumed",
          attemptId: input.attemptId,
          runs: runRows(owner, ids).map((r) => toRun(r, true)),
        };
      }
      // First request: the goal and every sub-goal (live or deleted) enter `purging` together with their run rows.
      const moved = run(
        "UPDATE goals SET lifecycle = 'purging', deleted_at = COALESCE(deleted_at, ?), idempotency_key = NULL, " +
          "revision = revision + 1, updated_at = ? WHERE owner_id = ? AND lifecycle IN ('live','deleted') AND (id = ? OR parent_id = ?)",
        input.now,
        input.now,
        owner,
        input.goalId,
        input.goalId,
      );
      if (moved === 0) {
        return { outcome: "not_found" };
      }
      for (const id of ids) {
        const state = one("SELECT lifecycle FROM goals WHERE owner_id = ? AND id = ?", owner, id);
        if (!state || String(state.lifecycle) !== "purging") {
          continue;
        }
        run(
          "INSERT INTO goal_purge_runs (owner_id, goal_id, purge_id, requested_by, requested_at, worker_attempt_id, worker_lease_until, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          owner,
          id,
          freshPurgeId(owner),
          input.requestedBy,
          input.now,
          input.attemptId,
          input.now + input.leaseMs,
          input.now,
          input.now,
        );
      }
      return {
        outcome: "started",
        attemptId: input.attemptId,
        runs: runRows(owner, ids).map((r) => toRun(r, true)),
      };
    });

  // ------------------------------------------------------------------ purge: G3 (finalise one goal)

  const goalPurgeFinalize = (input: GoalPurgeFinalizeInput): GoalPurgeFinalizeOutcome =>
    transaction((): GoalPurgeFinalizeOutcome => {
      const owner = input.ownerId;
      const runRow = one(
        "SELECT * FROM goal_purge_runs WHERE owner_id = ? AND goal_id = ?",
        owner,
        input.goalId,
      );
      const row = goalRow(owner, input.goalId);
      if (!runRow || !row || String(row.lifecycle) !== "purging") {
        return { outcome: "not_found" };
      }
      // The holder check is redone inside the deleting transaction: a stale worker whose run was taken over does nothing.
      if (
        runRow.worker_attempt_id === null ||
        String(runRow.worker_attempt_id) !== input.attemptId
      ) {
        return { outcome: "not_holder" };
      }
      const children = Number(
        (
          one(
            "SELECT COUNT(*) AS c FROM goals WHERE owner_id = ? AND parent_id = ?",
            owner,
            input.goalId,
          ) as Row
        ).c,
      );
      if (children > 0) {
        return { outcome: "children_remain" };
      }
      const count = (table: string): number =>
        Number(
          (
            one(
              `SELECT COUNT(*) AS c FROM ${table} WHERE owner_id = ? AND goal_id = ?`,
              owner,
              input.goalId,
            ) as Row
          ).c,
        );
      const receiptId = newId("GR");
      run(
        "INSERT INTO goal_purge_receipts (owner_id, id, purge_id, goal_id_hash, title_hash, entry_count, link_count, metric_count, " +
          "review_count, requested_by, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)",
        owner,
        receiptId,
        String(runRow.purge_id),
        sha256Hex(input.goalId),
        sha256Hex(String(row.title)),
        count("goal_entries"),
        count("goal_links"),
        String(runRow.requested_by),
        input.now,
      );
      run(
        "DELETE FROM goal_creation_grants WHERE owner_id = ? AND goal_id = ?",
        owner,
        input.goalId,
      );
      run("DELETE FROM goal_purge_runs WHERE owner_id = ? AND goal_id = ?", owner, input.goalId);
      run(
        "DELETE FROM goals WHERE owner_id = ? AND id = ? AND lifecycle = 'purging'",
        owner,
        input.goalId,
      );
      return {
        outcome: "purged",
        receipt: toReceipt(
          one(
            "SELECT * FROM goal_purge_receipts WHERE owner_id = ? AND id = ?",
            owner,
            receiptId,
          ) as Row,
        ),
      };
    });

  const goalPurgeRelease = (input: GoalPurgeReleaseInput): number =>
    transaction(() => {
      let released = 0;
      for (const goalId of input.goalIds) {
        released += run(
          "UPDATE goal_purge_runs SET worker_attempt_id = NULL, worker_lease_until = NULL WHERE owner_id = ? AND goal_id = ? AND worker_attempt_id = ?",
          input.ownerId,
          goalId,
          input.attemptId,
        );
      }
      return released;
    });

  const goalPurgeStatus = (input: {
    principal: Principal;
    goalId: string;
    now: number;
  }): GoalPurgeStatusOutcome => {
    const owner = input.principal.ownerId;
    const runs = runRows(owner, family(owner, input.goalId));
    return runs.length === 0
      ? { outcome: "none" }
      : {
          outcome: "purging",
          runs: runs.map((r) =>
            toRun(r, r.worker_lease_until !== null && Number(r.worker_lease_until) > input.now),
          ),
        };
  };

  const goalPurgeReceipts = (input: {
    principal: Principal;
    limit: number;
  }): GoalPurgeReceiptRow[] =>
    all(
      "SELECT * FROM goal_purge_receipts WHERE owner_id = ? ORDER BY executed_at DESC, id DESC LIMIT ?",
      input.principal.ownerId,
      input.limit,
    ).map(toReceipt);

  /** Goals stuck in `purging` whose run is free or whose lease ran out: the service resumes them at start and on a timer. */
  const goalPurgeResumable = (input: GoalPurgeResumableInput): GoalPurgeResumableRow[] =>
    all(
      "SELECT r.owner_id AS owner_id, r.goal_id AS goal_id FROM goal_purge_runs r " +
        "WHERE r.worker_attempt_id IS NULL OR r.worker_lease_until <= ? ORDER BY r.requested_at LIMIT ?",
      input.now,
      input.limit,
    ).map((row) => ({ ownerId: String(row.owner_id), goalId: String(row.goal_id) }));

  // ------------------------------------------------------------------ the Goal <-> File relation

  const goalsForFile = (input: GoalsForFileInput): GoalForFile[] =>
    all(
      "SELECT g.id AS id, g.title AS title, g.status AS status, g.category AS category FROM goal_links l " +
        "JOIN goals g ON g.owner_id = l.owner_id AND g.id = l.goal_id " +
        "WHERE l.owner_id = ? AND l.kind = 'vault_file' AND l.ref_id = ? AND g.lifecycle = 'live' ORDER BY g.sort_order, g.id",
      input.principal.ownerId,
      input.fileId,
    ).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      status: String(row.status) as GoalStatus,
      category: String(row.category) as GoalForFile["category"],
    }));

  /** Called by the vault inside ITS transaction when a file is purged. Registered by storage presence, not by `goalsEnabled`. */
  const hooks: VaultPurgeHooks = {
    detachFile(ownerId, fileId) {
      run(
        "DELETE FROM goal_links WHERE owner_id = ? AND kind = 'vault_file' AND ref_id = ?",
        ownerId,
        fileId,
      );
    },
    fileHasGoalLinks(ownerId, fileId) {
      return (
        one(
          "SELECT 1 AS found FROM goal_links WHERE owner_id = ? AND kind = 'vault_file' AND ref_id = ? LIMIT 1",
          ownerId,
          fileId,
        ) !== undefined
      );
    },
  };

  return {
    kernel: {
      goalDelete,
      goalRestore,
      goalPurgeBegin,
      goalPurgeFinalize,
      goalPurgeRelease,
      goalPurgeStatus,
      goalPurgeReceipts,
      goalPurgeResumable,
      goalsForFile,
    },
    hooks,
  };
}

export type GoalLifecycleLedger = ReturnType<typeof createGoalLifecycleLedger>;
