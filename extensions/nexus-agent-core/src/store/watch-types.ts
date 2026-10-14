// Watcher types and limits (DESIGN section 10). Plain data only: everything here crosses the SQLite worker boundary.
import type { Principal, TaskRecord } from "./types.js";

export const WATCH_STATUSES = [
  "pending_schedule",
  "scheduled",
  "firing",
  "satisfied",
  "exhausted",
  "cancelled",
] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];
export const ACTIVE_WATCH_STATUSES: readonly WatchStatus[] = [
  "pending_schedule",
  "scheduled",
  "firing",
];

export const MAX_ACTIVE_WATCHES_PER_TASK = 3;
export const MAX_ACTIVE_WATCHES_PER_OWNER = 50;
export const MAX_WATCH_EXPECT_CHARS = 500;
export const MAX_WATCH_NOTE_CHARS = 500;
export const MIN_FIRST_CHECK_MS = 60_000;
export const MAX_FIRST_CHECK_MS = 30 * 24 * 3_600_000;
export const DEFAULT_FIRST_CHECK_MS = 3_600_000;
export const DEFAULT_MAX_ATTEMPTS = 4;
export const MAX_ATTEMPTS_LIMIT = 8;
/** Delay before the next check after the n-th check found nothing: 1h, 6h, 24h, then 3 days (DESIGN 10.1). */
export const WATCH_BACKOFF_MS = [3_600_000, 6 * 3_600_000, 24 * 3_600_000, 72 * 3_600_000] as const;
/** A firing watch whose planned time is this old never got a report: the next maintenance pass counts it as a miss. */
export const WATCH_FIRING_STALE_MS = 30 * 60_000;
/** A scheduled watch this far past its planned time never fired (job lost, hook missed): rebuild it. */
export const WATCH_SCHEDULED_STALE_MS = 15 * 60_000;

export type WatchRecord = {
  id: string;
  taskId: string;
  claimId: string | null;
  expect: string;
  revision: number;
  schedulerJobId: string | null;
  schedulerRevision: number | null;
  sessionKey: string;
  cronTag: string;
  scheduledFor: number | null;
  nextCheckAt: number;
  attempts: number;
  maxAttempts: number;
  status: WatchStatus;
};

export type WatchInvalidCode =
  | "bad_expect"
  | "bad_delay"
  | "bad_attempts"
  | "bad_session"
  | "bad_claim"
  | "claim_already_met"
  | "claim_refuted";

export type WatchCreateInput = {
  principal: Principal;
  taskId: string;
  claimId: string;
  expect: string;
  firstCheckInMs?: number;
  maxAttempts?: number;
  sessionKey: string;
  now: number;
};
export type WatchCreateOutcome =
  | { outcome: "created"; watch: WatchRecord; task: TaskRecord }
  | { outcome: "existing"; watch: WatchRecord }
  | { outcome: "invalid"; code: WatchInvalidCode }
  | { outcome: "task_not_found" }
  | { outcome: "task_closed"; status: string }
  | { outcome: "claim_not_found" }
  | { outcome: "limit_reached"; scope: "task" | "owner"; max: number };

export type WatchListInput = {
  principal: Principal;
  taskId?: string;
  statuses?: readonly WatchStatus[];
  /** Only watches whose Task is still open (used to replay the exhausted decision). */
  openTasksOnly?: boolean;
  limit: number;
};

export type WatchCancelOutcome =
  | { outcome: "cancelled"; watch: WatchRecord; task: TaskRecord | null }
  | { outcome: "not_found" }
  | { outcome: "already_closed"; status: WatchStatus };

export type WatchMarkScheduledOutcome =
  | { outcome: "scheduled"; watch: WatchRecord }
  | { outcome: "stale" }
  | { outcome: "duplicate_job" };

export type WatchClaimOutcome =
  | { outcome: "claimed"; watch: WatchRecord; task: TaskRecord }
  | { outcome: "unknown_job" }
  | {
      outcome: "stale";
      reason: "status" | "revision" | "session" | "task_closed";
      watch: WatchRecord;
    };

export type WatchReportKind = "satisfied" | "not_yet" | "blocked";
export type WatchReportOutcome =
  | { outcome: "satisfied"; watch: WatchRecord; task: TaskRecord | null }
  | { outcome: "rescheduled"; watch: WatchRecord }
  | {
      outcome: "exhausted";
      watch: WatchRecord;
      task: TaskRecord | null;
      reason: "blocked" | "attempts";
    }
  | { outcome: "not_found" }
  | { outcome: "not_firing"; status: WatchStatus }
  | { outcome: "claim_not_met"; state: string | null };

export type WatchMaintainResult = {
  /** Watches cancelled because their Task is closed or being purged: the caller removes their cron job by tag. */
  cancelled: WatchRecord[];
  /** Watches that must be rebuilt (stale scheduled / firing): back to pending_schedule or exhausted. */
  rescheduled: WatchRecord[];
  exhausted: WatchRecord[];
};
