// Text extraction queue and content search kernel (Vault design 9.1-9.4), Stage 5 / F2. Runs inside the SQLite worker; every
// method is ONE synchronous transaction and every statement filters on owner_id. What is specific here:
//   * the queue lives in `vault_jobs` (stage `extract`); the extractor itself runs in the service between `vaultJobClaim` and
//     `vaultJobComplete` / `vaultJobFail`, so no transaction ever spans file I/O or parsing;
//   * an object is ELIGIBLE for text only while it is live, referenced by an active or trashed file, and NOT referenced by any
//     sensitive file (invariants 4 and 6). Eligibility is re-checked when a job is claimed and again when its text is stored, so
//     a file that turns sensitive while the extractor runs never gets text;
//   * the full-text index (`vault_text_fts`, FTS5 trigram) is created here at start, NOT by a migration, because a migration
//     cannot be conditional on the SQLite build. Without FTS5 the same queries run as a substring scan (`like` mode);
//   * search returns files, never text: the agent learns WHICH files match, not what they say.
import type { DatabaseSync } from "node:sqlite";
import type { ClaimLedger } from "./claim-ledger.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import { FILE_SELECT, toVaultFile } from "./vault-ledger.js";
import {
  VAULT_TEXT_MAX_PAGE_CHARS,
  VAULT_TEXT_MAX_QUERY_CHARS,
  VAULT_TEXT_MAX_QUERY_TERMS,
  type VaultExtractionState,
  type VaultExtractionStatus,
  type VaultExtractionStatusInput,
  type VaultExtractionStatusResult,
  type VaultJobClaimInput,
  type VaultJobClaimOutcome,
  type VaultJobCompleteInput,
  type VaultJobCompleteOutcome,
  type VaultJobFailInput,
  type VaultJobFailOutcome,
  type VaultJobListInput,
  type VaultJobListResult,
  type VaultJobRetryInput,
  type VaultJobRetryOutcome,
  type VaultJobState,
  type VaultJobSweepInput,
  type VaultJobSweepResult,
  type VaultTextReadInput,
  type VaultTextReadOutcome,
  type VaultTextSearchInput,
  type VaultTextSearchResult,
  type VaultTextStatsResult,
} from "./vault-text-types.js";
import { MAX_VAULT_LIST_LIMIT, normalizeVaultFolder } from "./vault-types.js";

type Row = Record<string, unknown>;

// Nullable TEXT columns arrive as `string | null`; anything else is treated as absent instead of being stringified.
const optionalText = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Rows of every file that references an object, given the SQL expressions for its owner and id (directly or through a version). */
const REFS = (ownerExpr: string, idExpr: string): string =>
  `SELECT 1 FROM vault_files rf WHERE rf.owner_id = ${ownerExpr} AND (rf.object_id = ${idExpr} OR EXISTS ` +
  `(SELECT 1 FROM vault_versions rv WHERE rv.owner_id = rf.owner_id AND rv.file_id = rf.id AND rv.object_id = ${idExpr}))`;

/** No file that references the object is sensitive (invariants 4 and 6). */
const NO_SENSITIVE_REF = (ownerExpr: string, idExpr: string): string =>
  `NOT EXISTS (${REFS(ownerExpr, idExpr)} AND rf.sensitivity = 'sensitive')`;

/** Text may exist for the object alias `o`: live, referenced by an active/trashed file, referenced by NO sensitive file. */
const ELIGIBLE = (o: string): string =>
  `${o}.state = 'live' AND EXISTS (${REFS(`${o}.owner_id`, `${o}.id`)} AND rf.state IN ('active','trashed')) ` +
  `AND ${NO_SENSITIVE_REF(`${o}.owner_id`, `${o}.id`)}`;

const FTS_TABLE = "vault_text_fts";

export function createVaultTextLedger(
  db: DatabaseSync,
  transaction: TransactionRunner,
  internals: ClaimLedger["internals"],
) {
  const { one, all, run, newId } = internals;

  // ------------------------------------------------------------------ FTS5 index (runtime DDL, feature detected)

  let fts = false;
  let secureDelete = false;
  const initIndex = (): void => {
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(text, owner_id UNINDEXED, object_id UNINDEXED, page UNINDEXED, tokenize = 'trigram')`,
      );
    } catch {
      // No FTS5 (or no trigram tokenizer) in this SQLite build: search falls back to a substring scan. Triggers that name
      // a missing module would break every vault_text write, so make sure none are left over from another runtime.
      for (const name of ["ai", "ad", "au"]) {
        try {
          db.exec(`DROP TRIGGER IF EXISTS ${FTS_TABLE}_${name}`);
        } catch {
          // best effort
        }
      }
      return;
    }
    fts = true;
    try {
      db.exec(`INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rank) VALUES ('secure-delete', 1)`);
      secureDelete = true;
    } catch {
      secureDelete = false;
    }
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${FTS_TABLE}_ai AFTER INSERT ON vault_text BEGIN ` +
        `INSERT INTO ${FTS_TABLE}(rowid, text, owner_id, object_id, page) VALUES (new.rowid, new.text, new.owner_id, new.object_id, new.page); END`,
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${FTS_TABLE}_ad AFTER DELETE ON vault_text BEGIN ` +
        `DELETE FROM ${FTS_TABLE} WHERE rowid = old.rowid; END`,
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${FTS_TABLE}_au AFTER UPDATE OF text ON vault_text BEGIN ` +
        `DELETE FROM ${FTS_TABLE} WHERE rowid = old.rowid; ` +
        `INSERT INTO ${FTS_TABLE}(rowid, text, owner_id, object_id, page) VALUES (new.rowid, new.text, new.owner_id, new.object_id, new.page); END`,
    );
    // Backfill / repair: the index must hold exactly one row per vault_text row (rowids can move on VACUUM).
    transaction(() => {
      const indexed = Number((one(`SELECT COUNT(*) AS c FROM ${FTS_TABLE}`) as Row).c);
      const stored = Number((one("SELECT COUNT(*) AS c FROM vault_text") as Row).c);
      if (indexed !== stored) {
        run(`DELETE FROM ${FTS_TABLE}`);
        run(
          `INSERT INTO ${FTS_TABLE}(rowid, text, owner_id, object_id, page) SELECT rowid, text, owner_id, object_id, page FROM vault_text`,
        );
      }
    });
  };
  initIndex();

  // ------------------------------------------------------------------ queue

  const latestJob = (owner: string, objectId: string): Row | undefined =>
    one(
      "SELECT * FROM vault_jobs WHERE owner_id = ? AND object_id = ? AND stage = 'extract' ORDER BY updated_at DESC, created_at DESC LIMIT 1",
      owner,
      objectId,
    );

  const objectEligible = (owner: string, objectId: string): boolean =>
    one(
      `SELECT 1 AS ok FROM vault_objects o WHERE o.owner_id = ? AND o.id = ? AND ${ELIGIBLE("o")}`,
      owner,
      objectId,
    ) !== undefined;

  /** Queue missing extract jobs (and wake cancelled ones whose object is eligible again). Idempotent. */
  const vaultJobSweep = (input: VaultJobSweepInput): VaultJobSweepResult =>
    transaction((): VaultJobSweepResult => {
      const owner = input.principal.ownerId;
      const requeued = run(
        "UPDATE vault_jobs SET state = 'pending', next_run_at = ?, attempts = 0, failure_code = NULL, failure_message = NULL, updated_at = ? " +
          "WHERE owner_id = ? AND stage = 'extract' AND extractor = ? AND extractor_version = ? AND state = 'cancelled' " +
          `AND EXISTS (SELECT 1 FROM vault_objects o WHERE o.owner_id = vault_jobs.owner_id AND o.id = vault_jobs.object_id AND ${ELIGIBLE("o")})`,
        input.now,
        input.now,
        owner,
        input.extractor,
        input.extractorVersion,
      );
      const candidates = all(
        `SELECT o.id FROM vault_objects o WHERE o.owner_id = ? AND ${ELIGIBLE("o")} ` +
          "AND NOT EXISTS (SELECT 1 FROM vault_jobs j WHERE j.owner_id = o.owner_id AND j.object_id = o.id AND j.stage = 'extract' " +
          "AND j.extractor = ? AND j.extractor_version = ?) ORDER BY o.created_at, o.id LIMIT ?",
        owner,
        input.extractor,
        input.extractorVersion,
        Math.max(1, Math.floor(input.limit)),
      );
      for (const row of candidates) {
        run(
          "INSERT INTO vault_jobs (owner_id, id, object_id, stage, state, attempts, next_run_at, extractor, extractor_version, created_at, updated_at) " +
            "VALUES (?, ?, ?, 'extract', 'pending', 0, ?, ?, ?, ?, ?)",
          owner,
          newId("VJ"),
          String(row.id),
          input.now,
          input.extractor,
          input.extractorVersion,
          input.now,
          input.now,
        );
      }
      return { queued: candidates.length, requeued };
    });

  const vaultJobClaim = (input: VaultJobClaimInput): VaultJobClaimOutcome =>
    transaction((): VaultJobClaimOutcome => {
      const owner = input.principal.ownerId;
      for (let guard = 0; guard < 50; guard += 1) {
        const job = one(
          "SELECT j.id, j.object_id, j.attempts, o.size, o.mime FROM vault_jobs j JOIN vault_objects o ON o.owner_id = j.owner_id AND o.id = j.object_id " +
            "WHERE j.owner_id = ? AND j.stage = 'extract' AND ((j.state = 'pending' AND j.next_run_at <= ?) OR (j.state = 'running' AND j.updated_at <= ?)) " +
            "ORDER BY COALESCE(j.next_run_at, j.updated_at), j.id LIMIT 1",
          owner,
          input.now,
          input.now - input.runningTimeoutMs,
        );
        if (!job) {
          return { outcome: "none" };
        }
        const objectId = String(job.object_id);
        if (!objectEligible(owner, objectId)) {
          run(
            "UPDATE vault_jobs SET state = 'cancelled', next_run_at = NULL, updated_at = ? WHERE owner_id = ? AND id = ?",
            input.now,
            owner,
            String(job.id),
          );
          continue;
        }
        const name = one(
          "SELECT rf.display_name FROM vault_files rf WHERE rf.owner_id = ? AND rf.state IN ('active','trashed') AND rf.sensitivity = 'normal' " +
            "AND (rf.object_id = ? OR EXISTS (SELECT 1 FROM vault_versions rv WHERE rv.owner_id = rf.owner_id AND rv.file_id = rf.id AND rv.object_id = ?)) " +
            "ORDER BY rf.created_at, rf.id LIMIT 1",
          owner,
          objectId,
          objectId,
        );
        const attempts = Number(job.attempts) + 1;
        run(
          "UPDATE vault_jobs SET state = 'running', attempts = ?, next_run_at = NULL, updated_at = ? WHERE owner_id = ? AND id = ?",
          attempts,
          input.now,
          owner,
          String(job.id),
        );
        return {
          outcome: "claimed",
          jobId: String(job.id),
          objectId,
          attempts,
          size: Number(job.size),
          mime: String(job.mime),
          displayName: name ? String(name.display_name) : "",
        };
      }
      return { outcome: "none" };
    });

  const runningJob = (owner: string, jobId: string, objectId: string): Row | undefined =>
    one(
      "SELECT * FROM vault_jobs WHERE owner_id = ? AND id = ? AND object_id = ? AND state = 'running'",
      owner,
      jobId,
      objectId,
    );

  const vaultJobComplete = (input: VaultJobCompleteInput): VaultJobCompleteOutcome =>
    transaction((): VaultJobCompleteOutcome => {
      const owner = input.principal.ownerId;
      if (!runningJob(owner, input.jobId, input.objectId)) {
        return { outcome: "not_running" };
      }
      if (!objectEligible(owner, input.objectId)) {
        run(
          "UPDATE vault_jobs SET state = 'cancelled', next_run_at = NULL, updated_at = ? WHERE owner_id = ? AND id = ?",
          input.now,
          owner,
          input.jobId,
        );
        return { outcome: "dropped" };
      }
      // One current text per object: replace, never accumulate across extractor versions.
      run("DELETE FROM vault_text WHERE owner_id = ? AND object_id = ?", owner, input.objectId);
      let chars = 0;
      input.pages.forEach((text, page) => {
        chars += text.length;
        run(
          "INSERT INTO vault_text (owner_id, object_id, page, extractor, extractor_version, job_id, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
          owner,
          input.objectId,
          page,
          input.extractor,
          input.extractorVersion,
          input.jobId,
          text,
        );
      });
      run(
        "UPDATE vault_jobs SET state = 'ready', next_run_at = NULL, failure_code = ?, failure_message = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
        input.note?.code ?? null,
        input.note?.message.slice(0, 500) ?? null,
        input.now,
        owner,
        input.jobId,
      );
      return { outcome: "ready", pages: input.pages.length, chars };
    });

  const vaultJobFail = (input: VaultJobFailInput): VaultJobFailOutcome =>
    transaction((): VaultJobFailOutcome => {
      const owner = input.principal.ownerId;
      const job = runningJob(owner, input.jobId, input.objectId);
      if (!job) {
        return { outcome: "not_running" };
      }
      const message = input.message.slice(0, 500);
      if (input.kind === "rejected") {
        run(
          "UPDATE vault_jobs SET state = 'rejected', next_run_at = NULL, failure_code = ?, failure_message = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
          input.code,
          message,
          input.now,
          owner,
          input.jobId,
        );
        return { outcome: "rejected" };
      }
      const attempts = Number(job.attempts);
      if (attempts >= input.maxAttempts) {
        run(
          "UPDATE vault_jobs SET state = 'failed', next_run_at = NULL, failure_code = ?, failure_message = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
          input.code,
          message,
          input.now,
          owner,
          input.jobId,
        );
        return { outcome: "failed" };
      }
      const delays = input.backoffMs.length > 0 ? input.backoffMs : [60_000];
      const delay = delays[Math.min(attempts - 1, delays.length - 1)] ?? 60_000;
      const nextRunAt = input.now + Math.max(0, delay);
      run(
        "UPDATE vault_jobs SET state = 'pending', next_run_at = ?, failure_code = ?, failure_message = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
        nextRunAt,
        input.code,
        message,
        input.now,
        owner,
        input.jobId,
      );
      return { outcome: "pending", nextRunAt };
    });

  /** The user asks for another attempt on a failed (or cancelled) job. `rejected` is final for that extractor version. */
  const vaultJobRetry = (input: VaultJobRetryInput): VaultJobRetryOutcome =>
    transaction((): VaultJobRetryOutcome => {
      const owner = input.principal.ownerId;
      const file = one(
        "SELECT object_id, sensitivity, state FROM vault_files WHERE owner_id = ? AND id = ?",
        owner,
        input.fileId,
      );
      if (!file) {
        return { outcome: "not_found" };
      }
      const objectId = String(file.object_id);
      const job = latestJob(owner, objectId);
      if (!job) {
        return { outcome: "not_retryable", state: "none" };
      }
      const state = String(job.state) as VaultJobState;
      if (
        !objectEligible(owner, objectId) ||
        (state !== "failed" && state !== "cancelled" && state !== "rejected")
      ) {
        return {
          outcome: "not_retryable",
          state: objectEligible(owner, objectId) ? state : "skipped",
        };
      }
      run(
        "UPDATE vault_jobs SET state = 'pending', next_run_at = ?, attempts = 0, failure_code = NULL, failure_message = NULL, updated_at = ? WHERE owner_id = ? AND id = ?",
        input.now,
        input.now,
        owner,
        String(job.id),
      );
      return { outcome: "queued" };
    });

  const vaultJobList = (input: VaultJobListInput): VaultJobListResult => {
    const owner = input.principal.ownerId;
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), MAX_VAULT_LIST_LIMIT);
    const rows = all(
      "SELECT j.id, j.object_id, j.state, j.attempts, j.extractor, j.failure_code, j.failure_message, j.next_run_at, j.updated_at, " +
        "(SELECT f.id FROM vault_files f WHERE f.owner_id = j.owner_id AND f.object_id = j.object_id AND f.state IN ('active','trashed') AND f.sensitivity = 'normal' ORDER BY f.created_at LIMIT 1) AS file_id, " +
        "(SELECT f.display_name FROM vault_files f WHERE f.owner_id = j.owner_id AND f.object_id = j.object_id AND f.state IN ('active','trashed') AND f.sensitivity = 'normal' ORDER BY f.created_at LIMIT 1) AS display_name " +
        "FROM vault_jobs j WHERE j.owner_id = ? AND j.stage = 'extract' " +
        (input.state ? "AND j.state = ? " : "") +
        `AND ${NO_SENSITIVE_REF("j.owner_id", "j.object_id")} ` +
        "ORDER BY j.updated_at DESC, j.id LIMIT ?",
      owner,
      ...(input.state ? [input.state] : []),
      limit,
    );
    return {
      items: rows
        .filter((row) => row.file_id !== null)
        .map((row) => ({
          jobId: String(row.id),
          objectId: String(row.object_id),
          fileId: optionalText(row.file_id),
          displayName: optionalText(row.display_name),
          state: String(row.state) as VaultJobState,
          attempts: Number(row.attempts),
          extractor: String(row.extractor),
          failureCode: optionalText(row.failure_code),
          failureMessage: optionalText(row.failure_message),
          nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at),
          updatedAt: Number(row.updated_at),
        })),
    };
  };

  // ------------------------------------------------------------------ status / reads

  const statusOf = (owner: string, objectId: string): VaultExtractionStatus => {
    const empty = (state: VaultExtractionState): VaultExtractionStatus => ({
      state,
      extractor: "",
      failureCode: null,
      failureMessage: null,
      attempts: 0,
      pages: 0,
      chars: 0,
      updatedAt: null,
    });
    const object = one(
      `SELECT 1 AS ok FROM vault_objects o WHERE o.owner_id = ? AND o.id = ? AND ${ELIGIBLE("o")}`,
      owner,
      objectId,
    );
    if (!object) {
      return empty("skipped");
    }
    const job = latestJob(owner, objectId);
    if (!job) {
      return empty("none");
    }
    const text = one(
      "SELECT COUNT(*) AS pages, COALESCE(SUM(length(text)), 0) AS chars FROM vault_text WHERE owner_id = ? AND object_id = ?",
      owner,
      objectId,
    ) as Row;
    const state = String(job.state) as VaultJobState;
    return {
      // An eligible cancelled job is waiting for the next sweep.
      state: state === "cancelled" ? "pending" : state,
      extractor: String(job.extractor),
      failureCode: optionalText(job.failure_code),
      failureMessage: optionalText(job.failure_message),
      attempts: Number(job.attempts),
      pages: Number(text.pages),
      chars: Number(text.chars),
      updatedAt: Number(job.updated_at),
    };
  };

  const vaultExtractionStatus = (
    input: VaultExtractionStatusInput,
  ): VaultExtractionStatusResult => {
    const byObject: Record<string, VaultExtractionStatus> = {};
    for (const objectId of input.objectIds.slice(0, 500)) {
      byObject[objectId] = statusOf(input.principal.ownerId, objectId);
    }
    return { byObject };
  };

  const vaultTextRead = (input: VaultTextReadInput): VaultTextReadOutcome => {
    const owner = input.principal.ownerId;
    const file = one(
      "SELECT object_id, state, sensitivity FROM vault_files WHERE owner_id = ? AND id = ?",
      owner,
      input.fileId,
    );
    if (!file) {
      return { outcome: "not_found" };
    }
    const readable =
      String(file.state) === "active" ||
      (input.allowTrashed === true && String(file.state) === "trashed");
    if (!readable) {
      return { outcome: "not_found" };
    }
    const objectId = String(file.object_id);
    const status = statusOf(owner, objectId);
    if (status.state !== "ready" || status.pages === 0) {
      return { outcome: "no_text", state: status.state };
    }
    const page = Math.max(0, Math.floor(input.page ?? 0));
    const row = one(
      "SELECT text, extractor FROM vault_text WHERE owner_id = ? AND object_id = ? AND page = ?",
      owner,
      objectId,
      page,
    );
    if (!row) {
      return { outcome: "no_text", state: status.state };
    }
    const cap = Math.min(
      Math.max(Math.floor(input.maxChars ?? 20_000), 1),
      VAULT_TEXT_MAX_PAGE_CHARS,
    );
    const text = String(row.text);
    return {
      outcome: "ok",
      fileId: input.fileId,
      page,
      pageCount: status.pages,
      text: text.length > cap ? text.slice(0, cap) : text,
      truncated: text.length > cap,
      chars: status.chars,
      extractor: String(row.extractor),
    };
  };

  // ------------------------------------------------------------------ search

  const termsOf = (query: string): string[] =>
    query
      .normalize("NFC")
      .slice(0, VAULT_TEXT_MAX_QUERY_CHARS)
      .split(/\s+/)
      .filter((term) => term !== "")
      .slice(0, VAULT_TEXT_MAX_QUERY_TERMS);

  const ftsPhrase = (term: string): string => `"${term.replaceAll('"', '""')}"`;

  const vaultTextSearch = (input: VaultTextSearchInput): VaultTextSearchResult => {
    const owner = input.principal.ownerId;
    const terms = termsOf(input.query);
    const useFts = fts && input.forceLike !== true && terms.every((t) => Array.from(t).length >= 3);
    const mode: "fts" | "like" = useFts ? "fts" : "like";
    const scope: string[] = [
      "f.owner_id = ?",
      "f.state = 'active'",
      "f.sensitivity = 'normal'",
      NO_SENSITIVE_REF("f.owner_id", "f.object_id"),
    ];
    const params: (string | number)[] = [owner];
    if (input.collection) {
      scope.push("f.collection = ?");
      params.push(input.collection);
    }
    if (input.folder !== undefined) {
      const folder = normalizeVaultFolder(input.folder);
      if (folder === null) {
        return { items: [], total: 0, mode, unindexed: { pending: 0, failed: 0, unsupported: 0 } };
      }
      scope.push("f.folder = ?");
      params.push(folder);
    }
    const unindexedRows = all(
      "SELECT COALESCE((SELECT j.state FROM vault_jobs j WHERE j.owner_id = f.owner_id AND j.object_id = f.object_id AND j.stage = 'extract' " +
        "ORDER BY j.updated_at DESC LIMIT 1), 'none') AS st, COUNT(*) AS c FROM vault_files f " +
        `WHERE ${scope.join(" AND ")} AND NOT EXISTS (SELECT 1 FROM vault_text t WHERE t.owner_id = f.owner_id AND t.object_id = f.object_id) GROUP BY st`,
      ...params,
    );
    const unindexed = { pending: 0, failed: 0, unsupported: 0 };
    for (const row of unindexedRows) {
      const st = String(row.st);
      const count = Number(row.c);
      if (st === "failed") {
        unindexed.failed += count;
      } else if (st === "rejected") {
        unindexed.unsupported += count;
      } else if (st !== "ready") {
        unindexed.pending += count;
      }
    }
    if (terms.length === 0) {
      return { items: [], total: 0, mode, unindexed };
    }
    const where = [...scope];
    const searchParams = [...params];
    for (const term of terms) {
      if (useFts) {
        where.push(
          `f.object_id IN (SELECT t.object_id FROM vault_text t WHERE t.owner_id = ? AND t.rowid IN (SELECT rowid FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ?))`,
        );
        searchParams.push(owner, ftsPhrase(term));
      } else {
        where.push(
          "f.object_id IN (SELECT t.object_id FROM vault_text t WHERE t.owner_id = ? AND instr(lower(t.text), lower(?)) > 0)",
        );
        searchParams.push(owner, term);
      }
    }
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 20), 1), MAX_VAULT_LIST_LIMIT);
    const offset = Math.max(Math.floor(input.offset ?? 0), 0);
    const total = Number(
      (
        one(
          `SELECT COUNT(*) AS c FROM vault_files f WHERE ${where.join(" AND ")}`,
          ...searchParams,
        ) as Row
      ).c,
    );
    const rows = all(
      `${FILE_SELECT} WHERE ${where.join(" AND ")} ORDER BY f.updated_at DESC, f.id LIMIT ? OFFSET ?`,
      ...searchParams,
      limit,
      offset,
    );
    return { items: rows.map(toVaultFile), total, mode, unindexed };
  };

  const vaultTextStats = (input: { principal: Principal }): VaultTextStatsResult => {
    const owner = input.principal.ownerId;
    const jobs: Record<string, number> = {};
    for (const row of all(
      "SELECT state, COUNT(*) AS c FROM vault_jobs WHERE owner_id = ? AND stage = 'extract' GROUP BY state",
      owner,
    )) {
      jobs[String(row.state)] = Number(row.c);
    }
    const text = one(
      "SELECT COUNT(DISTINCT object_id) AS objects, COALESCE(SUM(length(text)), 0) AS chars FROM vault_text WHERE owner_id = ?",
      owner,
    ) as Row;
    return {
      fts,
      secureDelete,
      jobs,
      indexedObjects: Number(text.objects),
      textChars: Number(text.chars),
    };
  };

  return {
    vaultJobSweep,
    vaultJobClaim,
    vaultJobComplete,
    vaultJobFail,
    vaultJobRetry,
    vaultJobList,
    vaultExtractionStatus,
    vaultTextRead,
    vaultTextSearch,
    vaultTextStats,
  };
}

export type VaultTextLedger = ReturnType<typeof createVaultTextLedger>;
