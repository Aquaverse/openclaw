// Work group types (object-model design sections 4.2 and 5). Pure data shapes shared by the derive functions, the Work ledger
// (inside the SQLite worker) and the RPC / tool layers. Nothing here performs IO.

export const CONTEXT_MODES = ["personal", "executive"] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];

export const WORK_ORIGINS = ["migrated", "user", "agent"] as const;
export type WorkOrigin = (typeof WORK_ORIGINS)[number];

export const WORK_LIFECYCLES = ["live", "archived", "deleted", "purging"] as const;
export type WorkLifecycle = (typeof WORK_LIFECYCLES)[number];

/** PRD 8.1 execution states of a Task; `taskPhase()` maps the stored status onto them (read time, nothing is stored). */
export const TASK_PHASES = [
  "accepted",
  "waiting_input",
  "queued",
  "running",
  "blocked",
  "waiting_approval",
  "completed",
  "partial",
  "failed",
  "cancelled",
] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

export const WORK_PRIMARY_STATES = [
  "done",
  "ended_incomplete",
  "needs_you",
  "blocked",
  "in_progress",
] as const;
export type WorkPrimaryState = (typeof WORK_PRIMARY_STATES)[number];

/** Nine blocking reason codes of R-11 plus the few informational codes the derive rules need. */
export type ReasonCode =
  | "source_auth_expired"
  | "permission_missing"
  | "browser_not_ready"
  | "prerequisite_missing"
  | "dependency_version_pending"
  | "effect_unknown_needs_reconcile"
  | "quota_exhausted"
  | "paused_by_user"
  | "incident_hold"
  | "no_branch"
  | "no_follow_up"
  | "unknown_input"
  | "follow_up_ended"
  | "task_failed";

export type Reason = {
  code: ReasonCode;
  objectKind: "work" | "task" | "commitment" | "schedule" | "prerequisite" | "control" | "effect";
  objectId: string;
  actor: "user" | "system";
  /** Short machine-readable detail (a prerequisite kind, a control reason); never free text from the user. */
  ref?: string;
};

export type NextStep =
  | { kind: "decide"; objectKind: string; objectId: string }
  | { kind: "provide_input"; objectId: string }
  | { kind: "accept_revision"; objectId: string }
  | { kind: "resolve_identity"; objectId: string }
  | { kind: "schedule_follow_up" }
  | { kind: "wait_until"; at: number }
  | { kind: "review_result" }
  | { kind: "none" };

export type WorkFlag =
  | "partial_result"
  | "unknown_effect"
  | "coverage_on_plan"
  | "coverage_degraded"
  | "coverage_unavailable"
  | "other_branch_running"
  | "evidence_gap"
  | "manual_close"
  | "remediation_open"
  | "adoption_pending";

export type WorkState = {
  primary: WorkPrimaryState;
  /** R-34: the fourth class is shown by its real first cause, never as a generic "needs you". */
  blockedKind?: "paused" | "reconciling" | "blocked_reason";
  flags: WorkFlag[];
  reasons: Reason[];
  nextStep: NextStep;
  evaluationVersion: number;
};

export const WORK_EVALUATION_VERSION = 1;

export type OutcomeEventType = "achieved" | "withdrawn" | "reinstated" | "superseded";
export type TerminalReason = "stop" | "accept_partial" | "window_ended" | "unrecoverable";
export type ResultAtClose =
  | "met_all"
  | "partial"
  | "not_met"
  | "stopped_before_completion"
  | "unknown";

export type WorkRecord = {
  ownerId: string;
  id: string;
  title: string;
  requestText: string | null;
  outcomeText: string | null;
  originalResultId: string;
  contextMode: ContextMode;
  primaryContextId: string;
  contextOrigin: "explicit" | "inherited" | "legacy_default";
  contextReview: "none" | "pending" | "confirmed";
  entryKind: string;
  migratedOutcome: "succeeded" | "failed" | "cancelled" | null;
  currentWorkVersion: number;
  origin: WorkOrigin;
  requestRef: string | null;
  lifecycle: WorkLifecycle;
  hidden: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  deletedAt: number | null;
};

/** What a Task-creating caller says about the Work the new Task belongs to (design 12.3: one entrance, createTaskWithWork). */
export type WorkSpec = {
  /** Attach to this existing Work instead of creating one (it must be live and belong to the same owner). */
  workId?: string;
  title: string;
  requestText?: string | null;
  outcomeText?: string | null;
  origin: "user" | "agent";
  /** Dedupe key: a repeated request reuses the Work it created (WK-01). */
  requestRef?: string | null;
  contextMode?: ContextMode;
  entryKind?: string;
};
