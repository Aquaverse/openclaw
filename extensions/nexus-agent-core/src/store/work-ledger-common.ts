// Work kernel, shared part: row mapping, the append-only event writer, context-scope roots and owner-scoped lookups. No
// transaction is opened here; the modules around it (work-ledger.ts, work-backfill-ledger.ts) own theirs. Every statement filters
// on owner_id. Pointers into published tables carry no foreign key (design 4.1), so existence checks live here and in the callers.
import type { ContextMode, WorkRecord } from "../work/types.js";
import type { ClaimLedger } from "./claim-ledger.js";
import type { TransactionRunner } from "./kernel.js";

export type Row = Record<string, unknown>;
export type Sql = (string | number | null)[];

export const WORK_COLUMNS =
  "owner_id, id, title, request_text, outcome_text, original_result_id, context_mode, primary_context_id, " +
  "context_origin, context_review, entry_kind, migrated_outcome, current_work_version, origin, request_ref, lifecycle, " +
  "hidden, revision, created_at, updated_at, archived_at, deleted_at";

const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function toWork(row: Row): WorkRecord {
  return {
    ownerId: String(row.owner_id),
    id: String(row.id),
    title: String(row.title),
    requestText: str(row.request_text),
    outcomeText: str(row.outcome_text),
    originalResultId: String(row.original_result_id),
    contextMode: String(row.context_mode) as WorkRecord["contextMode"],
    primaryContextId: String(row.primary_context_id),
    contextOrigin: String(row.context_origin) as WorkRecord["contextOrigin"],
    contextReview: String(row.context_review) as WorkRecord["contextReview"],
    entryKind: String(row.entry_kind),
    migratedOutcome: str(row.migrated_outcome) as WorkRecord["migratedOutcome"],
    currentWorkVersion: Number(row.current_work_version),
    origin: String(row.origin) as WorkRecord["origin"],
    requestRef: str(row.request_ref),
    lifecycle: String(row.lifecycle) as WorkRecord["lifecycle"],
    hidden: Number(row.hidden) === 1,
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: num(row.archived_at),
    deletedAt: num(row.deleted_at),
  };
}

export const WORK_EVENT_KINDS = [
  "created",
  "retitled",
  "outcome_changed",
  "version_changed",
  "goal_set",
  "goal_cleared",
  "link_added",
  "link_ended",
  "archived",
  "unarchived",
  "deleted",
  "control_applied",
  "control_released",
  "outcome_recorded",
  "terminal_recorded",
  "prerequisite_changed",
  "handoff_out",
  "handoff_in",
  "merged_into",
  "split_from",
  "incident_reported",
  "incident_closed",
] as const;
export type WorkEventKind = (typeof WORK_EVENT_KINDS)[number];
export type WorkActor = "user" | "agent" | "system";

export function createWorkCommon(
  transaction: TransactionRunner,
  internals: ClaimLedger["internals"],
) {
  const { one, all, run, newId } = internals;

  const workRow = (owner: string, id: string): Row | undefined =>
    one(`SELECT ${WORK_COLUMNS} FROM works WHERE owner_id = ? AND id = ?`, owner, id);
  const liveWork = (owner: string, id: string): WorkRecord | undefined => {
    const row = workRow(owner, id);
    return row ? toWork(row) : undefined;
  };
  const hasTable = (name: string): boolean =>
    one("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?", name) !==
    undefined;

  /** Append one timeline entry; `seq` is dense per Work. Returns the new event id. */
  const appendEvent = (
    owner: string,
    workId: string,
    kind: WorkEventKind,
    actor: WorkActor,
    payload: Record<string, unknown>,
    now: number,
  ): string => {
    const seq =
      Number(
        (
          one(
            "SELECT COALESCE(MAX(seq), 0) AS m FROM work_events WHERE owner_id = ? AND work_id = ?",
            owner,
            workId,
          ) as Row
        ).m,
      ) + 1;
    const id = newId("we_");
    run(
      "INSERT INTO work_events (owner_id, id, work_id, seq, kind, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      owner,
      id,
      workId,
      seq,
      kind,
      actor,
      JSON.stringify(payload),
      now,
    );
    return id;
  };

  /** Every mode has exactly one default root scope (design 4.2.10); created on first use. */
  const ensureContextRoot = (owner: string, mode: ContextMode, now: number): string => {
    const existing = one(
      "SELECT id FROM context_scopes WHERE owner_id = ? AND context_mode = ? AND scope_kind = 'mode'",
      owner,
      mode,
    );
    if (existing) {
      return String(existing.id);
    }
    const id = newId("cs_");
    run(
      "INSERT INTO context_scopes (owner_id, id, context_mode, scope_kind, parent_scope_id, label, semantic_version, status, created_at, updated_at) " +
        "VALUES (?, ?, ?, 'mode', NULL, ?, 1, 'active', ?, ?)",
      owner,
      id,
      mode,
      mode === "personal" ? "Personal" : "Executive",
      now,
      now,
    );
    return id;
  };

  const workOfTask = (owner: string, taskId: string): string | undefined => {
    const row = one(
      "SELECT work_id FROM task_work_owner WHERE owner_id = ? AND task_id = ?",
      owner,
      taskId,
    );
    return row ? String(row.work_id) : undefined;
  };

  const touch = (owner: string, workId: string, now: number): void => {
    run("UPDATE works SET updated_at = ? WHERE owner_id = ? AND id = ?", now, owner, workId);
  };

  return {
    transaction,
    one,
    all,
    run,
    newId,
    workRow,
    liveWork,
    hasTable,
    appendEvent,
    ensureContextRoot,
    workOfTask,
    touch,
  };
}

export type WorkCommon = ReturnType<typeof createWorkCommon>;
