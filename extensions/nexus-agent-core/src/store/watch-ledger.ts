// Watch kernel (DESIGN section 10). Runs inside the SQLite worker; every method is ONE synchronous transaction and every
// statement filters on owner_id. What is specific here:
//   * `watches` is the only place that decides which cron job is ours: `scheduler_job_id` is written when the job is
//     scheduled and is the identity credential of a watcher turn (the authentication-as-claim CAS in `watchClaim`);
//   * a watch is only ever about ONE existing claim and is satisfied only when that claim reached SUPPORTED or VERIFIED
//     through evidence - the Agent saying "done" does not count (section 9.2);
//   * the retry schedule (1h, 6h, 24h, 3 days) and the exhaustion rule live here, so a missed or crashed turn costs an
//     attempt instead of silently re-arming forever.
import { canonicalJson } from "../canonical.js";
import type { ClaimLedger } from "./claim-ledger.js";
import { isClosed, parseJson, toTask, TASK_COLUMNS, type TransactionRunner } from "./kernel.js";
import type { Principal, TaskRecord } from "./types.js";
import {
  ACTIVE_WATCH_STATUSES,
  DEFAULT_FIRST_CHECK_MS,
  DEFAULT_MAX_ATTEMPTS,
  MAX_ACTIVE_WATCHES_PER_OWNER,
  MAX_ACTIVE_WATCHES_PER_TASK,
  MAX_ATTEMPTS_LIMIT,
  MAX_FIRST_CHECK_MS,
  MAX_WATCH_EXPECT_CHARS,
  MIN_FIRST_CHECK_MS,
  WATCH_BACKOFF_MS,
  WATCH_FIRING_STALE_MS,
  WATCH_SCHEDULED_STALE_MS,
  type WatchCancelOutcome,
  type WatchClaimOutcome,
  type WatchCreateInput,
  type WatchCreateOutcome,
  type WatchListInput,
  type WatchMaintainResult,
  type WatchMarkScheduledOutcome,
  type WatchRecord,
  type WatchReportKind,
  type WatchReportOutcome,
  type WatchStatus,
} from "./watch-types.js";

type Row = Record<string, unknown>;

const WATCH_COLUMNS =
  "id, task_id, claim_id, expect_json, revision, scheduler_job_id, scheduler_revision, session_key, cron_tag, " +
  "scheduled_for, next_check_at, attempts, max_attempts, status";

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export function toWatch(row: Row): WatchRecord {
  const expect = parseJson(row.expect_json) as { expect?: unknown } | null;
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    claimId: str(row.claim_id),
    expect: typeof expect?.expect === "string" ? expect.expect : "",
    revision: Number(row.revision),
    schedulerJobId: str(row.scheduler_job_id),
    schedulerRevision: num(row.scheduler_revision),
    sessionKey: String(row.session_key),
    cronTag: String(row.cron_tag),
    scheduledFor: num(row.scheduled_for),
    nextCheckAt: Number(row.next_check_at),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    status: String(row.status) as WatchStatus,
  };
}

export function backoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), WATCH_BACKOFF_MS.length) - 1;
  return WATCH_BACKOFF_MS[index] ?? WATCH_BACKOFF_MS[WATCH_BACKOFF_MS.length - 1]!;
}

const ACTIVE_SQL = ACTIVE_WATCH_STATUSES.map((status) => `'${status}'`).join(",");

export function createWatchLedger(
  transaction: TransactionRunner,
  internals: ClaimLedger["internals"],
) {
  const { one, all, run, newId, claimRow, writableTask } = internals;

  const watchRow = (owner: string, id: string): Row | undefined =>
    one(`SELECT ${WATCH_COLUMNS} FROM watches WHERE owner_id = ? AND id = ?`, owner, id);
  const taskOf = (owner: string, taskId: string): TaskRecord | null => {
    const row = one(
      `SELECT ${TASK_COLUMNS} FROM nexus_tasks WHERE owner_id = ? AND id = ?`,
      owner,
      taskId,
    );
    return row ? toTask(row) : null;
  };
  const activeCount = (owner: string, taskId?: string): number =>
    Number(
      (
        one(
          `SELECT COUNT(*) AS c FROM watches WHERE owner_id = ? AND status IN (${ACTIVE_SQL})` +
            (taskId ? " AND task_id = ?" : ""),
          ...(taskId ? [owner, taskId] : [owner]),
        ) as Row
      ).c,
    );

  /** `watching` follows the watches: no active watch left means the Task goes back to planning. */
  const settleTaskStatus = (owner: string, taskId: string, now: number): TaskRecord | null => {
    const task = taskOf(owner, taskId);
    if (!task || isClosed(task.status) || task.status === "purging") {
      return task;
    }
    if (task.status === "watching" && activeCount(owner, taskId) === 0) {
      run(
        "UPDATE nexus_tasks SET status = 'planning', updated_at = ? WHERE owner_id = ? AND id = ?",
        now,
        owner,
        taskId,
      );
      return taskOf(owner, taskId);
    }
    return task;
  };

  /** One check found nothing (or never reported): the next attempt or exhaustion. Caller owns the transaction. */
  const applyNotMet = (
    owner: string,
    row: Row,
    now: number,
    reason: "attempts" | "blocked",
  ): { outcome: "rescheduled" | "exhausted"; watch: WatchRecord } => {
    const attempts = Number(row.attempts);
    if (reason === "blocked" || attempts >= Number(row.max_attempts)) {
      run(
        "UPDATE watches SET status = 'exhausted', revision = revision + 1, scheduler_revision = NULL WHERE owner_id = ? AND id = ?",
        owner,
        String(row.id),
      );
      return { outcome: "exhausted", watch: toWatch(watchRow(owner, String(row.id)) as Row) };
    }
    run(
      "UPDATE watches SET status = 'pending_schedule', revision = revision + 1, scheduler_job_id = NULL, " +
        "scheduler_revision = NULL, scheduled_for = NULL, next_check_at = ? WHERE owner_id = ? AND id = ?",
      now + backoffMs(attempts),
      owner,
      String(row.id),
    );
    return { outcome: "rescheduled", watch: toWatch(watchRow(owner, String(row.id)) as Row) };
  };

  // ------------------------------------------------------------------ create / read / cancel

  const watchCreate = (input: WatchCreateInput): WatchCreateOutcome =>
    transaction((): WatchCreateOutcome => {
      const owner = input.principal.ownerId;
      const expect = typeof input.expect === "string" ? input.expect.trim() : "";
      if (expect.length === 0 || Array.from(expect).length > MAX_WATCH_EXPECT_CHARS) {
        return { outcome: "invalid", code: "bad_expect" };
      }
      const delay = input.firstCheckInMs ?? DEFAULT_FIRST_CHECK_MS;
      if (!Number.isInteger(delay) || delay < MIN_FIRST_CHECK_MS || delay > MAX_FIRST_CHECK_MS) {
        return { outcome: "invalid", code: "bad_delay" };
      }
      const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS_LIMIT) {
        return { outcome: "invalid", code: "bad_attempts" };
      }
      if (
        typeof input.sessionKey !== "string" ||
        input.sessionKey.length === 0 ||
        input.sessionKey.length > 512
      ) {
        return { outcome: "invalid", code: "bad_session" };
      }
      if (
        typeof input.claimId !== "string" ||
        input.claimId.length === 0 ||
        input.claimId.length > 64
      ) {
        return { outcome: "invalid", code: "bad_claim" };
      }
      const gate = writableTask(owner, input.taskId);
      if (!gate.ok) {
        return gate.outcome === "not_found"
          ? { outcome: "task_not_found" }
          : { outcome: "task_closed", status: gate.status };
      }
      const claim = claimRow(owner, input.taskId, input.claimId);
      if (!claim) {
        return { outcome: "claim_not_found" };
      }
      if (claim.state === "SUPPORTED" || claim.state === "VERIFIED") {
        return { outcome: "invalid", code: "claim_already_met" };
      }
      if (claim.state === "REFUTED") {
        return { outcome: "invalid", code: "claim_refuted" };
      }
      const expectJson = canonicalJson({ expect });
      const same = one(
        `SELECT ${WATCH_COLUMNS} FROM watches WHERE owner_id = ? AND task_id = ? AND claim_id = ? AND expect_json = ? ` +
          `AND status IN (${ACTIVE_SQL})`,
        owner,
        input.taskId,
        input.claimId,
        expectJson,
      );
      if (same) {
        return { outcome: "existing", watch: toWatch(same) };
      }
      if (activeCount(owner, input.taskId) >= MAX_ACTIVE_WATCHES_PER_TASK) {
        return { outcome: "limit_reached", scope: "task", max: MAX_ACTIVE_WATCHES_PER_TASK };
      }
      if (activeCount(owner) >= MAX_ACTIVE_WATCHES_PER_OWNER) {
        return { outcome: "limit_reached", scope: "owner", max: MAX_ACTIVE_WATCHES_PER_OWNER };
      }
      const id = newId("W");
      run(
        "INSERT INTO watches (id, owner_id, task_id, claim_id, expect_json, revision, scheduler_job_id, scheduler_revision, " +
          "session_key, cron_tag, scheduled_for, next_check_at, attempts, max_attempts, status) " +
          "VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?, NULL, ?, 0, ?, 'pending_schedule')",
        id,
        owner,
        input.taskId,
        input.claimId,
        expectJson,
        input.sessionKey,
        `nexus-watch-${id}`,
        input.now + delay,
        maxAttempts,
      );
      const current = taskOf(owner, input.taskId) as TaskRecord;
      if (current.status === "clarifying" || current.status === "planning") {
        run(
          "UPDATE nexus_tasks SET status = 'watching', updated_at = ? WHERE owner_id = ? AND id = ?",
          input.now,
          owner,
          input.taskId,
        );
      }
      return {
        outcome: "created",
        watch: toWatch(watchRow(owner, id) as Row),
        task: taskOf(owner, input.taskId) as TaskRecord,
      };
    });

  const watchGet = (input: {
    principal: Principal;
    watchId?: string;
    jobId?: string;
  }): WatchRecord | null => {
    const owner = input.principal.ownerId;
    const row = input.watchId
      ? watchRow(owner, input.watchId)
      : input.jobId
        ? one(
            `SELECT ${WATCH_COLUMNS} FROM watches WHERE owner_id = ? AND scheduler_job_id = ?`,
            owner,
            input.jobId,
          )
        : undefined;
    return row ? toWatch(row) : null;
  };

  const watchList = (input: WatchListInput): WatchRecord[] => {
    const owner = input.principal.ownerId;
    const clauses = ["w.owner_id = ?"];
    const params: (string | number)[] = [owner];
    if (input.taskId) {
      clauses.push("w.task_id = ?");
      params.push(input.taskId);
    }
    if (input.statuses && input.statuses.length > 0) {
      clauses.push(`w.status IN (${input.statuses.map(() => "?").join(",")})`);
      params.push(...input.statuses);
    }
    if (input.openTasksOnly) {
      clauses.push(
        "t.status NOT IN ('succeeded','failed','cancelled','deleted','purging') AND t.deleted_at IS NULL",
      );
    }
    params.push(Math.max(1, Math.min(200, input.limit)));
    return all(
      `SELECT ${WATCH_COLUMNS.split(", ")
        .map((column) => `w.${column}`)
        .join(
          ", ",
        )} FROM watches w JOIN nexus_tasks t ON t.owner_id = w.owner_id AND t.id = w.task_id ` +
        `WHERE ${clauses.join(" AND ")} ORDER BY w.next_check_at, w.id LIMIT ?`,
      ...params,
    ).map(toWatch);
  };

  const watchCancel = (input: {
    principal: Principal;
    watchId: string;
    now: number;
  }): WatchCancelOutcome =>
    transaction((): WatchCancelOutcome => {
      const owner = input.principal.ownerId;
      const row = watchRow(owner, input.watchId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const status = String(row.status) as WatchStatus;
      if (!(ACTIVE_WATCH_STATUSES as readonly string[]).includes(status)) {
        return { outcome: "already_closed", status };
      }
      run(
        "UPDATE watches SET status = 'cancelled', revision = revision + 1, scheduler_revision = NULL WHERE owner_id = ? AND id = ?",
        owner,
        input.watchId,
      );
      return {
        outcome: "cancelled",
        watch: toWatch(watchRow(owner, input.watchId) as Row),
        task: settleTaskStatus(owner, String(row.task_id), input.now),
      };
    });

  // ------------------------------------------------------------------ scheduling

  /** Watches that still need a cron job: DB intent first, cron second (DESIGN 10.1). */
  const watchListUnscheduled = (input: { principal: Principal; limit: number }): WatchRecord[] =>
    all(
      `SELECT ${WATCH_COLUMNS} FROM watches WHERE owner_id = ? AND status = 'pending_schedule' ORDER BY next_check_at, id LIMIT ?`,
      input.principal.ownerId,
      Math.max(1, Math.min(200, input.limit)),
    ).map(toWatch);

  const watchMarkScheduled = (input: {
    principal: Principal;
    watchId: string;
    revision: number;
    jobId: string;
    now: number;
  }): WatchMarkScheduledOutcome =>
    transaction((): WatchMarkScheduledOutcome => {
      const owner = input.principal.ownerId;
      const taken = one(
        "SELECT id FROM watches WHERE owner_id = ? AND scheduler_job_id = ? AND id <> ?",
        owner,
        input.jobId,
        input.watchId,
      );
      if (taken) {
        return { outcome: "duplicate_job" };
      }
      const changed = run(
        "UPDATE watches SET scheduler_job_id = ?, scheduler_revision = revision, status = 'scheduled', scheduled_for = next_check_at " +
          "WHERE owner_id = ? AND id = ? AND revision = ? AND status = 'pending_schedule'",
        input.jobId,
        owner,
        input.watchId,
        input.revision,
      );
      if (changed !== 1) {
        return { outcome: "stale" };
      }
      return { outcome: "scheduled", watch: toWatch(watchRow(owner, input.watchId) as Row) };
    });

  // ------------------------------------------------------------------ authentication as claim (section 10.2)

  const watchClaim = (input: {
    principal: Principal;
    jobId: string;
    sessionKey: string;
    now: number;
  }): WatchClaimOutcome =>
    transaction((): WatchClaimOutcome => {
      const owner = input.principal.ownerId;
      const existing = one(
        `SELECT ${WATCH_COLUMNS} FROM watches WHERE owner_id = ? AND scheduler_job_id = ?`,
        owner,
        input.jobId,
      );
      if (!existing) {
        return { outcome: "unknown_job" };
      }
      const watch = toWatch(existing);
      const task = taskOf(owner, watch.taskId);
      if (
        !task ||
        isClosed(task.status) ||
        task.status === "purging" ||
        task.status === "deleted"
      ) {
        if ((ACTIVE_WATCH_STATUSES as readonly string[]).includes(watch.status)) {
          run(
            "UPDATE watches SET status = 'cancelled', revision = revision + 1, scheduler_revision = NULL WHERE owner_id = ? AND id = ?",
            owner,
            watch.id,
          );
        }
        return {
          outcome: "stale",
          reason: "task_closed",
          watch: toWatch(watchRow(owner, watch.id) as Row),
        };
      }
      if (watch.sessionKey !== input.sessionKey) {
        return { outcome: "stale", reason: "session", watch };
      }
      const changed = run(
        "UPDATE watches SET status = 'firing', attempts = attempts + 1 " +
          "WHERE owner_id = ? AND id = ? AND scheduler_job_id = ? AND session_key = ? AND scheduler_revision = revision AND status = 'scheduled'",
        owner,
        watch.id,
        input.jobId,
        input.sessionKey,
      );
      if (changed !== 1) {
        return {
          outcome: "stale",
          reason: watch.status === "scheduled" ? "revision" : "status",
          watch,
        };
      }
      return {
        outcome: "claimed",
        watch: toWatch(watchRow(owner, watch.id) as Row),
        task,
      };
    });

  // ------------------------------------------------------------------ the watcher's report

  const watchReport = (input: {
    principal: Principal;
    watchId: string;
    outcome: WatchReportKind;
    now: number;
  }): WatchReportOutcome =>
    transaction((): WatchReportOutcome => {
      const owner = input.principal.ownerId;
      const row = watchRow(owner, input.watchId);
      if (!row) {
        return { outcome: "not_found" };
      }
      if (row.status !== "firing") {
        return { outcome: "not_firing", status: String(row.status) as WatchStatus };
      }
      const taskId = String(row.task_id);
      if (input.outcome === "satisfied") {
        const claim =
          typeof row.claim_id === "string" ? claimRow(owner, taskId, row.claim_id) : undefined;
        const state = claim ? String(claim.state) : null;
        if (state !== "SUPPORTED" && state !== "VERIFIED") {
          return { outcome: "claim_not_met", state };
        }
        run(
          "UPDATE watches SET status = 'satisfied', revision = revision + 1, scheduler_revision = NULL WHERE owner_id = ? AND id = ?",
          owner,
          input.watchId,
        );
        return {
          outcome: "satisfied",
          watch: toWatch(watchRow(owner, input.watchId) as Row),
          task: settleTaskStatus(owner, taskId, input.now),
        };
      }
      const applied = applyNotMet(
        owner,
        row,
        input.now,
        input.outcome === "blocked" ? "blocked" : "attempts",
      );
      if (applied.outcome === "rescheduled") {
        return { outcome: "rescheduled", watch: applied.watch };
      }
      return {
        outcome: "exhausted",
        watch: applied.watch,
        task: settleTaskStatus(owner, taskId, input.now),
        reason: input.outcome === "blocked" ? "blocked" : "attempts",
      };
    });

  /** The cron job finished. A watch still `firing` for it never reported: that check counts as a miss. */
  const watchJobFinished = (input: {
    principal: Principal;
    jobId: string;
    now: number;
  }): { outcome: "noop" } | { outcome: "rescheduled" | "exhausted"; watch: WatchRecord } =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = one(
        `SELECT ${WATCH_COLUMNS} FROM watches WHERE owner_id = ? AND scheduler_job_id = ? AND status = 'firing'`,
        owner,
        input.jobId,
      );
      if (!row) {
        return { outcome: "noop" as const };
      }
      const applied = applyNotMet(owner, row, input.now, "attempts");
      if (applied.outcome === "exhausted") {
        settleTaskStatus(owner, String(row.task_id), input.now);
      }
      return applied;
    });

  const watchMaintain = (input: { principal: Principal; now: number }): WatchMaintainResult =>
    transaction((): WatchMaintainResult => {
      const owner = input.principal.ownerId;
      const result: WatchMaintainResult = { cancelled: [], rescheduled: [], exhausted: [] };
      // 1) Tasks that closed (or are being purged) take their watches with them.
      const orphaned = all(
        `SELECT ${WATCH_COLUMNS.split(", ")
          .map((column) => `w.${column}`)
          .join(
            ", ",
          )} FROM watches w JOIN nexus_tasks t ON t.owner_id = w.owner_id AND t.id = w.task_id ` +
          `WHERE w.owner_id = ? AND w.status IN (${ACTIVE_SQL}) ` +
          "AND (t.status IN ('succeeded','failed','cancelled','deleted','purging') OR t.deleted_at IS NOT NULL)",
        owner,
      );
      for (const row of orphaned) {
        run(
          "UPDATE watches SET status = 'cancelled', revision = revision + 1, scheduler_revision = NULL WHERE owner_id = ? AND id = ?",
          owner,
          String(row.id),
        );
        result.cancelled.push(toWatch(watchRow(owner, String(row.id)) as Row));
      }
      // 2) firing without a report, and scheduled but never fired: a miss each.
      const stale = all(
        `SELECT ${WATCH_COLUMNS} FROM watches WHERE owner_id = ? AND ` +
          "((status = 'firing' AND next_check_at < ?) OR (status = 'scheduled' AND next_check_at < ?))",
        owner,
        input.now - WATCH_FIRING_STALE_MS,
        input.now - WATCH_SCHEDULED_STALE_MS,
      );
      for (const row of stale) {
        const needsAttempt = row.status === "scheduled";
        if (needsAttempt) {
          run(
            "UPDATE watches SET attempts = attempts + 1 WHERE owner_id = ? AND id = ?",
            owner,
            String(row.id),
          );
        }
        const fresh = watchRow(owner, String(row.id)) as Row;
        const applied = applyNotMet(owner, fresh, input.now, "attempts");
        if (applied.outcome === "rescheduled") {
          result.rescheduled.push(applied.watch);
        } else {
          result.exhausted.push(applied.watch);
          settleTaskStatus(owner, String(row.task_id), input.now);
        }
      }
      // 3) Tasks that are still `watching` with nothing active go back to planning.
      for (const row of all(
        "SELECT id FROM nexus_tasks WHERE owner_id = ? AND status = 'watching'",
        owner,
      )) {
        settleTaskStatus(owner, String(row.id), input.now);
      }
      return result;
    });

  return {
    kernel: {
      watchCreate,
      watchGet,
      watchList,
      watchCancel,
      watchListUnscheduled,
      watchMarkScheduled,
      watchClaim,
      watchReport,
      watchJobFinished,
      watchMaintain,
    },
  };
}

export type WatchLedger = ReturnType<typeof createWatchLedger>;
