// Synchronous Task store kernel: all SQL for Stage 1 lives here and runs inside the SQLite worker.
// Every method takes ONE input object whose `principal` is mandatory, and every statement filters on owner_id
// (DESIGN section 5: there is no overload without a principal). Write paths run in a single sync transaction.
import type { DatabaseSync } from "node:sqlite";
import { compareTasks, flattenLeaves, isDuplicate, queryRecall, tokenize } from "../similarity.js";
import type { CompletionCheck } from "./claim-types.js";
import { MIGRATIONS, type Migration } from "./schema.js";
import {
  CLOSED_STATUSES,
  MODEL_SETTABLE_STATUSES,
  type Principal,
  type ScoredTask,
  type TaskDetail,
  type TaskRecord,
  type TaskSessionRecord,
  type TaskStatus,
  type TaskStepRecord,
} from "./types.js";

export type TransactionRunner = <T>(run: () => T) => T;

type Row = Record<string, unknown>;

export const TASK_COLUMNS =
  "id, owner_id, kind, title, status, goal_json, entities_json, risk_ceiling, summary, revision, " +
  "origin_session_key, last_session_key, created_at, updated_at, ended_at, deleted_at";

export function parseJson(text: unknown): unknown {
  if (typeof text !== "string") {
    return null;
  }
  return JSON.parse(text) as unknown;
}

export function toTask(row: Row): TaskRecord {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    kind: String(row.kind),
    title: String(row.title),
    status: String(row.status) as TaskStatus,
    goal: parseJson(row.goal_json),
    entities: parseJson(row.entities_json),
    riskCeiling: String(row.risk_ceiling),
    summary: typeof row.summary === "string" ? row.summary : null,
    revision: Number(row.revision),
    originSessionKey: String(row.origin_session_key),
    lastSessionKey: typeof row.last_session_key === "string" ? row.last_session_key : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    deletedAt:
      row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
  };
}

function toStep(row: Row): TaskStepRecord {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    kind: String(row.kind),
    status: String(row.status),
    title: String(row.title),
    detail: parseJson(row.detail_json),
    flowId: typeof row.flow_id === "string" ? row.flow_id : null,
    startedAt:
      row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
  };
}

export function isClosed(status: string): boolean {
  return (CLOSED_STATUSES as readonly string[]).includes(status);
}

/** Apply pending migrations in order; each runs in its own transaction and ends with a foreign key check. */
export function applyMigrations(
  db: DatabaseSync,
  transaction: TransactionRunner,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => number = Date.now,
): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT NOT NULL PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  const applied: string[] = [];
  for (const migration of migrations) {
    const done = db
      .prepare("SELECT 1 AS found FROM schema_migrations WHERE id = ?")
      .get(migration.id);
    if (done) {
      continue;
    }
    transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
        migration.id,
        now(),
      );
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) {
        throw new Error(`migration ${migration.id} left foreign key violations`);
      }
    });
    applied.push(migration.id);
  }
  return applied;
}

export type CreateInput = {
  principal: Principal;
  id: string;
  kind: string;
  title: string;
  goal: unknown;
  entities: unknown;
  idempotencyKey: string;
  fingerprint: string;
  sessionKey: string;
  now: number;
};
export type CreateOutcome =
  | { outcome: "created"; task: TaskRecord }
  | { outcome: "replayed"; task: TaskRecord }
  | { outcome: "fingerprint_conflict"; task: TaskRecord };

export type UpdatePatch = {
  title?: string;
  goal?: unknown;
  entities?: unknown;
  summary?: string | null;
  status?: TaskStatus;
};
export type UpdateInput = {
  principal: Principal;
  taskId: string;
  patch: UpdatePatch;
  expectedRevision?: number;
  sessionKey: string;
  now: number;
  /** Stage 3: when true, `status: "succeeded"` is allowed and checked against the Task's completion claims (section 9.3). */
  completionGate?: boolean;
};
export type UpdateOutcome =
  | { outcome: "updated"; task: TaskRecord; revisionBumped: boolean }
  | { outcome: "unchanged"; task: TaskRecord; revisionBumped: false }
  | { outcome: "not_found" }
  | { outcome: "task_closed"; task: TaskRecord }
  | { outcome: "status_not_allowed"; allowed: TaskStatus[] }
  | { outcome: "completion_unmet"; check: CompletionCheck }
  | { outcome: "revision_conflict"; task: TaskRecord };

export type TaskKernelHooks = {
  /** Runs inside the update transaction; supplied by the claim ledger (Stage 3). */
  checkCompletion?: (owner: string, taskId: string) => CompletionCheck;
};

export function createTaskKernel(
  db: DatabaseSync,
  transaction: TransactionRunner,
  hooks: TaskKernelHooks = {},
) {
  const getRow = (owner: string, taskId: string): Row | undefined =>
    db
      .prepare(`SELECT ${TASK_COLUMNS} FROM nexus_tasks WHERE owner_id = ? AND id = ?`)
      .get(owner, taskId) as Row | undefined;

  const getLive = (owner: string, taskId: string): TaskRecord | undefined => {
    const row = getRow(owner, taskId);
    if (!row || row.deleted_at !== null) {
      return undefined;
    }
    return toTask(row);
  };

  const bindSession = (owner: string, taskId: string, sessionKey: string, now: number) => {
    db.prepare(
      "INSERT INTO nexus_task_sessions (owner_id, task_id, session_key, first_seen, last_seen) " +
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT (task_id, session_key) DO UPDATE SET last_seen = excluded.last_seen",
    ).run(owner, taskId, sessionKey, now, now);
  };

  /** Owner-scoped WHERE for the Task list; `queryTasks` adds its search and time filters on top. */
  const listWhere = (input: {
    principal: Principal;
    statuses?: TaskStatus[];
    includeClosed: boolean;
  }) => {
    const where = ["owner_id = ?", "deleted_at IS NULL", "status NOT IN ('deleted','purging')"];
    const params: (string | number)[] = [input.principal.ownerId];
    if (input.statuses && input.statuses.length > 0) {
      where.push(`status IN (${input.statuses.map(() => "?").join(",")})`);
      params.push(...input.statuses);
    } else if (!input.includeClosed) {
      where.push("status NOT IN ('succeeded','failed','cancelled')");
    }
    return { where, params };
  };

  const list = (input: {
    principal: Principal;
    statuses?: TaskStatus[];
    includeClosed: boolean;
    limit: number;
  }): TaskRecord[] => {
    const { where, params } = listWhere(input);
    params.push(input.limit);
    const rows = db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM nexus_tasks WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id LIMIT ?`,
      )
      .all(...params) as Row[];
    return rows.map(toTask);
  };

  /** Paged, filtered Task list with the total match count (the console's list page). */
  const queryTasks = (input: {
    principal: Principal;
    statuses?: TaskStatus[];
    includeClosed: boolean;
    limit: number;
    offset: number;
    /** Contains-match on the Task id. */
    idQuery?: string;
    /** Contains-match on the title. */
    titleQuery?: string;
    /** Whitespace-separated terms; every term must appear in the title, goal, summary or entities. */
    keyword?: string;
    /** created_at >= createdFrom (ms). */
    createdFrom?: number;
    /** created_at < createdTo (ms). */
    createdTo?: number;
  }): { tasks: TaskRecord[]; total: number } => {
    const { where, params } = listWhere(input);
    const like = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
    const idQuery = input.idQuery?.trim();
    if (idQuery) {
      where.push("id LIKE ? ESCAPE '\\'");
      params.push(like(idQuery));
    }
    const titleQuery = input.titleQuery?.trim();
    if (titleQuery) {
      where.push("title LIKE ? ESCAPE '\\'");
      params.push(like(titleQuery));
    }
    for (const term of (input.keyword ?? "").split(/\s+/).filter((part) => part !== "")) {
      where.push(
        "(title LIKE ? ESCAPE '\\' OR goal_json LIKE ? ESCAPE '\\' " +
          "OR summary LIKE ? ESCAPE '\\' OR entities_json LIKE ? ESCAPE '\\')",
      );
      const pattern = like(term);
      params.push(pattern, pattern, pattern, pattern);
    }
    if (input.createdFrom !== undefined) {
      where.push("created_at >= ?");
      params.push(input.createdFrom);
    }
    if (input.createdTo !== undefined) {
      where.push("created_at < ?");
      params.push(input.createdTo);
    }
    const clause = where.join(" AND ");
    const total = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM nexus_tasks WHERE ${clause}`).get(...params) as Row).n,
    );
    const rows = db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM nexus_tasks WHERE ${clause} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(...params, input.limit, input.offset) as Row[];
    return { tasks: rows.map(toTask), total };
  };

  return {
    info() {
      const one = (sql: string) => db.prepare(sql).get() as Row;
      return {
        foreignKeys: Number(one("PRAGMA foreign_keys").foreign_keys),
        journalMode: String(one("PRAGMA journal_mode").journal_mode),
        sqliteVersion: String(one("SELECT sqlite_version() AS v").v),
        migrations: (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Row[]).map(
          (row) => String(row.id),
        ),
      };
    },

    lookupByKey(input: { principal: Principal; idempotencyKey: string }) {
      const row = db
        .prepare(
          `SELECT ${TASK_COLUMNS}, request_fingerprint FROM nexus_tasks WHERE owner_id = ? AND idempotency_key = ?`,
        )
        .get(input.principal.ownerId, input.idempotencyKey) as Row | undefined;
      return row
        ? {
            task: toTask(row),
            fingerprint:
              typeof row.request_fingerprint === "string" ? row.request_fingerprint : null,
          }
        : null;
    },

    create(input: CreateInput): CreateOutcome {
      const owner = input.principal.ownerId;
      return transaction(() => {
        const existing = db
          .prepare(
            `SELECT ${TASK_COLUMNS}, request_fingerprint FROM nexus_tasks WHERE owner_id = ? AND idempotency_key = ?`,
          )
          .get(owner, input.idempotencyKey) as Row | undefined;
        if (existing) {
          const task = toTask(existing);
          return existing.request_fingerprint === input.fingerprint
            ? { outcome: "replayed" as const, task }
            : { outcome: "fingerprint_conflict" as const, task };
        }
        db.prepare(
          "INSERT INTO nexus_tasks (id, owner_id, kind, title, status, goal_json, entities_json, " +
            "idempotency_key, request_fingerprint, origin_session_key, last_session_key, revision, " +
            "created_at, updated_at) VALUES (?, ?, ?, ?, 'clarifying', ?, ?, ?, ?, ?, ?, 1, ?, ?)",
        ).run(
          input.id,
          owner,
          input.kind,
          input.title,
          JSON.stringify(input.goal),
          input.entities === null || input.entities === undefined
            ? null
            : JSON.stringify(input.entities),
          input.idempotencyKey,
          input.fingerprint,
          input.sessionKey,
          input.sessionKey,
          input.now,
          input.now,
        );
        bindSession(owner, input.id, input.sessionKey, input.now);
        return { outcome: "created" as const, task: toTask(getRow(owner, input.id) as Row) };
      });
    },

    /** Same-kind Tasks created within the window (or still open) whose similarity reaches the threshold. */
    findSimilar(input: {
      principal: Principal;
      kind: string;
      title: string;
      entities: unknown;
      sinceMs: number;
      limit: number;
    }): ScoredTask[] {
      const rows = db
        .prepare(
          `SELECT ${TASK_COLUMNS} FROM nexus_tasks WHERE owner_id = ? AND kind = ? AND deleted_at IS NULL ` +
            "AND status NOT IN ('deleted','purging') AND (created_at >= ? OR status NOT IN ('succeeded','failed','cancelled')) " +
            "ORDER BY updated_at DESC LIMIT 200",
        )
        .all(input.principal.ownerId, input.kind, input.sinceMs) as Row[];
      return rows
        .map(toTask)
        .map((task) => ({
          task,
          comparison: compareTasks({ title: input.title, entities: input.entities }, task),
        }))
        .filter((entry) => isDuplicate(entry.comparison))
        .map((entry) => ({
          task: entry.task,
          score: entry.comparison.score,
          matchedOn: ["similarity"],
        }))
        .toSorted((a, b) => b.score - a.score)
        .slice(0, input.limit);
    },

    get(input: {
      principal: Principal;
      taskId: string;
      bindSessionKey?: string;
      now: number;
      stepLimit: number;
    }): TaskDetail | null {
      const owner = input.principal.ownerId;
      const read = (): TaskDetail | null => {
        const task = getLive(owner, input.taskId);
        if (!task || task.status === "purging") {
          return null;
        }
        if (input.bindSessionKey) {
          bindSession(owner, task.id, input.bindSessionKey, input.now);
        }
        const steps = (
          db
            .prepare(
              "SELECT id, seq, kind, status, title, detail_json, flow_id, started_at, ended_at FROM nexus_task_steps " +
                "WHERE owner_id = ? AND task_id = ? ORDER BY seq DESC LIMIT ?",
            )
            .all(owner, task.id, input.stepLimit) as Row[]
        )
          .map(toStep)
          .toReversed();
        const sessions = (
          db
            .prepare(
              "SELECT session_key, first_seen, last_seen FROM nexus_task_sessions WHERE owner_id = ? AND task_id = ? ORDER BY last_seen DESC",
            )
            .all(owner, task.id) as Row[]
        ).map((row): TaskSessionRecord => ({
          sessionKey: String(row.session_key),
          firstSeen: Number(row.first_seen),
          lastSeen: Number(row.last_seen),
        }));
        return { task: getLive(owner, task.id) as TaskRecord, steps, sessions };
      };
      return input.bindSessionKey ? transaction(read) : read();
    },

    list,
    queryTasks,

    update(input: UpdateInput): UpdateOutcome {
      const owner = input.principal.ownerId;
      return transaction((): UpdateOutcome => {
        const task = getLive(owner, input.taskId);
        if (!task) {
          return { outcome: "not_found" };
        }
        if (isClosed(task.status)) {
          return { outcome: "task_closed", task };
        }
        const patch = input.patch;
        const gated =
          patch.status === "succeeded" &&
          input.completionGate === true &&
          hooks.checkCompletion !== undefined;
        if (
          patch.status !== undefined &&
          !gated &&
          !(MODEL_SETTABLE_STATUSES as readonly string[]).includes(patch.status)
        ) {
          return {
            outcome: "status_not_allowed",
            allowed:
              input.completionGate === true
                ? [...MODEL_SETTABLE_STATUSES, "succeeded"]
                : [...MODEL_SETTABLE_STATUSES],
          };
        }
        if (input.expectedRevision !== undefined && input.expectedRevision !== task.revision) {
          return { outcome: "revision_conflict", task };
        }
        // Section 9.3: "succeeded" is the store's decision, not the model's. Every completion claim must have reached its
        // required state (and there must be at least one) or the update is refused with the reasons.
        if (gated && hooks.checkCompletion) {
          const check = hooks.checkCompletion(owner, task.id);
          if (!check.ok) {
            return { outcome: "completion_unmet", check };
          }
        }
        const sets: string[] = [];
        const params: (string | number | null)[] = [];
        let semanticChange = false;
        const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
        if (patch.title !== undefined && patch.title !== task.title) {
          sets.push("title = ?");
          params.push(patch.title);
          semanticChange = true;
        }
        if (patch.goal !== undefined && !same(patch.goal, task.goal)) {
          sets.push("goal_json = ?");
          params.push(JSON.stringify(patch.goal));
          semanticChange = true;
        }
        if (patch.entities !== undefined && !same(patch.entities, task.entities)) {
          sets.push("entities_json = ?");
          params.push(patch.entities === null ? null : JSON.stringify(patch.entities));
          semanticChange = true;
        }
        if (patch.summary !== undefined && patch.summary !== task.summary) {
          sets.push("summary = ?");
          params.push(patch.summary);
        }
        if (patch.status !== undefined && patch.status !== task.status) {
          sets.push("status = ?");
          params.push(patch.status);
          if (patch.status === "succeeded") {
            sets.push("ended_at = ?");
            params.push(input.now);
          }
        }
        if (sets.length === 0) {
          bindSession(owner, task.id, input.sessionKey, input.now);
          return { outcome: "unchanged", task, revisionBumped: false };
        }
        // Revision binds grants to the Task's meaning (DESIGN section 6.2): bump it only when title, goal or
        // entities change, never for status, summary or notes.
        if (semanticChange) {
          sets.push("revision = revision + 1");
        }
        sets.push("updated_at = ?", "last_session_key = ?");
        params.push(input.now, input.sessionKey);
        db.prepare(`UPDATE nexus_tasks SET ${sets.join(", ")} WHERE owner_id = ? AND id = ?`).run(
          ...params,
          owner,
          task.id,
        );
        bindSession(owner, task.id, input.sessionKey, input.now);
        return {
          outcome: "updated",
          task: getLive(owner, task.id) as TaskRecord,
          revisionBumped: semanticChange,
        };
      });
    },

    note(input: {
      principal: Principal;
      taskId: string;
      text: string;
      stepId: string;
      sessionKey: string;
      now: number;
    }):
      | { outcome: "added"; task: TaskRecord; step: TaskStepRecord }
      | { outcome: "not_found" }
      | { outcome: "task_closed"; task: TaskRecord } {
      const owner = input.principal.ownerId;
      return transaction(() => {
        const task = getLive(owner, input.taskId);
        if (!task) {
          return { outcome: "not_found" as const };
        }
        if (isClosed(task.status)) {
          return { outcome: "task_closed" as const, task };
        }
        const seqRow = db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM nexus_task_steps WHERE task_id = ?",
          )
          .get(task.id) as Row;
        const seq = Number(seqRow.next);
        const title = Array.from(input.text).slice(0, 80).join("");
        db.prepare(
          "INSERT INTO nexus_task_steps (id, owner_id, task_id, seq, kind, status, title, detail_json, started_at, ended_at) " +
            "VALUES (?, ?, ?, ?, 'note', 'done', ?, ?, ?, ?)",
        ).run(
          input.stepId,
          owner,
          task.id,
          seq,
          title,
          JSON.stringify({ text: input.text }),
          input.now,
          input.now,
        );
        db.prepare(
          "UPDATE nexus_tasks SET updated_at = ?, last_session_key = ? WHERE owner_id = ? AND id = ?",
        ).run(input.now, input.sessionKey, owner, task.id);
        bindSession(owner, task.id, input.sessionKey, input.now);
        const step = db
          .prepare(
            "SELECT id, seq, kind, status, title, detail_json, flow_id, started_at, ended_at FROM nexus_task_steps WHERE id = ?",
          )
          .get(input.stepId) as Row;
        return {
          outcome: "added" as const,
          task: getLive(owner, task.id) as TaskRecord,
          step: toStep(step),
        };
      });
    },

    /** Operator abort: any open Task becomes `cancelled`. Idempotent for already-cancelled Tasks. */
    abort(input: {
      principal: Principal;
      taskId: string;
      now: number;
    }):
      | { outcome: "aborted"; task: TaskRecord }
      | { outcome: "already_cancelled"; task: TaskRecord }
      | { outcome: "not_found" }
      | { outcome: "task_closed"; task: TaskRecord } {
      const owner = input.principal.ownerId;
      return transaction(() => {
        const task = getLive(owner, input.taskId);
        if (!task) {
          return { outcome: "not_found" as const };
        }
        if (task.status === "cancelled") {
          return { outcome: "already_cancelled" as const, task };
        }
        if (isClosed(task.status)) {
          return { outcome: "task_closed" as const, task };
        }
        db.prepare(
          "UPDATE nexus_tasks SET status = 'cancelled', ended_at = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
        ).run(input.now, input.now, owner, task.id);
        return { outcome: "aborted" as const, task: getLive(owner, task.id) as TaskRecord };
      });
    },

    /** Soft delete (tombstone): hidden from lists, search and prompt injection; rows stay (DESIGN section 9.4). */
    softDelete(input: {
      principal: Principal;
      taskId: string;
      now: number;
    }):
      | { outcome: "deleted"; revision: number }
      | { outcome: "already_deleted" }
      | { outcome: "not_found" }
      | { outcome: "purging" } {
      const owner = input.principal.ownerId;
      return transaction(() => {
        const row = getRow(owner, input.taskId);
        if (!row) {
          return { outcome: "not_found" as const };
        }
        if (row.deleted_at !== null) {
          return { outcome: "already_deleted" as const };
        }
        if (row.status === "purging") {
          return { outcome: "purging" as const };
        }
        db.prepare(
          "UPDATE nexus_tasks SET status = 'deleted', deleted_at = ?, ended_at = COALESCE(ended_at, ?), updated_at = ? " +
            "WHERE owner_id = ? AND id = ?",
        ).run(input.now, input.now, input.now, owner, input.taskId);
        // revision is unchanged by a soft delete; report it so the event carries the real value.
        return { outcome: "deleted" as const, revision: Number(row.revision) };
      });
    },

    /** Open Tasks for the prompt list (newest activity first). */
    listOpen(input: { principal: Principal; limit: number }): TaskRecord[] {
      return list({ principal: input.principal, includeClosed: false, limit: input.limit });
    },

    search(input: { principal: Principal; query: string; limit: number }): ScoredTask[] {
      const queryTokens = tokenize(input.query);
      if (queryTokens.length === 0) {
        return [];
      }
      const rows = db
        .prepare(
          `SELECT ${TASK_COLUMNS} FROM nexus_tasks WHERE owner_id = ? AND deleted_at IS NULL ` +
            "AND status NOT IN ('deleted','purging') ORDER BY updated_at DESC LIMIT 500",
        )
        .all(input.principal.ownerId) as Row[];
      const scored: ScoredTask[] = [];
      for (const task of rows.map(toTask)) {
        const fields: Record<string, string[]> = {
          title: tokenize(task.title),
          goal: tokenize(JSON.stringify(task.goal ?? "")),
          entities: tokenize(flattenLeaves(task.entities).join(" ")),
          summary: tokenize(task.summary ?? ""),
        };
        const all = Object.values(fields).flat();
        const score = queryRecall(queryTokens, all);
        if (score <= 0) {
          continue;
        }
        const matchedOn = Object.entries(fields)
          .filter(([, tokens]) => queryRecall(queryTokens, tokens) > 0)
          .map(([name]) => name);
        scored.push({ task, score, matchedOn });
      }
      return scored
        .toSorted((a, b) => b.score - a.score || b.task.updatedAt - a.task.updatedAt)
        .slice(0, input.limit);
    },
  };
}

export type TaskKernel = ReturnType<typeof createTaskKernel>;
