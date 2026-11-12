// Schedule layer types (object-model design 4.5): the follow-up plan a user accepts, the schedules that plan binds, and the trigger
// records that keep a due time from creating a check twice. Plain data only: everything here crosses the SQLite worker boundary.
import type { Cadence } from "./cadence.js";

export const PLAN_OWNER_TYPES = ["work", "personal_goal", "commitment"] as const;
export type PlanOwnerType = (typeof PLAN_OWNER_TYPES)[number];
export const PLAN_STATUSES = ["draft", "accepted", "ended", "revoked"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const START_INTENTS = ["none", "when_ready", "now"] as const;
export type StartIntent = (typeof START_INTENTS)[number];

export const SCHEDULE_OWNER_TYPES = [...PLAN_OWNER_TYPES, "legacy_watch"] as const;
export type ScheduleOwnerType = (typeof SCHEDULE_OWNER_TYPES)[number];
export const SCHEDULE_STATUSES = ["active", "paused", "blocked", "ended", "cancelled"] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];
export type PauseSource = "user" | "work_control" | "system";
export type CoverageState = "on_plan" | "degraded" | "unavailable";
export type ExecutorKind = "watch" | "check_task";

/** The nine reasons a schedule can be blocked (design 5.2, R-11); the same closed set the Work view uses. */
export const BLOCK_CODES = [
  "source_auth_expired",
  "permission_missing",
  "browser_not_ready",
  "prerequisite_missing",
  "dependency_version_pending",
  "effect_unknown_needs_reconcile",
  "quota_exhausted",
  "paused_by_user",
  "incident_hold",
] as const;
export type BlockCode = (typeof BLOCK_CODES)[number];
export type BlockReason = { code: BlockCode; ref?: string; actor: "user" | "system" };

/** One schedule the plan creates when it is accepted. */
export type ScheduleSpec = {
  scheduleKind: "once" | "recurring";
  purpose: string;
  cadence: unknown;
  tz: string;
  expectedEvidence?: unknown;
  dispatchWindowMs?: number;
  stop?: unknown;
  notify?: unknown;
  sessionKey?: string;
  executorKind?: ExecutorKind;
  executorRef?: string;
};

/** What the user accepts when they accept a plan: only these observations and private outputs, nothing external (CD-04). */
export type StopCondition =
  | { kind: "goal_event"; goalId: string; events: ("completed" | "deleted")[] }
  | { kind: "commitment_resolved" }
  | { kind: "until"; at: number };

export type PlanBody = {
  /** What will be saved as schedules when the plan is accepted: the user reviews exactly these (at least one, at most five). */
  schedules?: ScheduleSpec[];
  /** What to look at, where, how often, until when, who is told, and what will NOT be done. */
  sources?: string[];
  frequencyText?: string;
  notifyText?: string;
  wontDo?: string[];
  limits?: string[];
  stopConditions?: StopCondition[];
  tz?: string;
  reviewOrEndAt?: number;
};

export type PlanGap = { code: string; ref?: string };

export type DelegationPlanRecord = {
  ownerId: string;
  id: string;
  workId: string;
  workVersion: number;
  planOwnerType: PlanOwnerType;
  planOwnerId: string;
  purpose: string;
  planVersion: number;
  status: PlanStatus;
  plan: PlanBody;
  gaps: PlanGap[];
  startIntent: StartIntent;
  acceptedResponsibilityVersion: number | null;
  acceptedContractVersion: number | null;
  replacesPlanId: string | null;
  endReason: string | null;
  /** Set when the plan's owner (a commitment) ended: the plan is "wrapping up" until `wrapupUntil` (design 6.4, CD-04). */
  endRequestedAt: number | null;
  wrapupUntil: number | null;
  createdBy: "user" | "agent";
  createdAt: number;
  acceptedAt: number | null;
  endedAt: number | null;
};

export type ScheduleRecord = {
  ownerId: string;
  id: string;
  workId: string;
  ownerType: ScheduleOwnerType;
  ownerRef: string;
  planId: string | null;
  planVersion: number | null;
  scheduleKind: "once" | "recurring";
  purpose: string;
  cadence: Cadence;
  tz: string;
  nextDueAt: number | null;
  dispatchWindowMs: number | null;
  executorKind: ExecutorKind;
  executorRef: string | null;
  status: ScheduleStatus;
  pauseSource: PauseSource | null;
  blockReasons: BlockReason[];
  lastManualTriggerAt: number | null;
  stopReason: string | null;
  endedAt: number | null;
  coverageState: CoverageState;
  coverageNote: string | null;
  replacesScheduleId: string | null;
  createdVia: "plan" | "migration";
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export const TRIGGER_SOURCES = ["scheduled", "manual", "catch_up"] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];
export const TRIGGER_OUTCOMES = ["created", "skipped", "merged", "missed", "quarantined"] as const;
export type TriggerOutcome = (typeof TRIGGER_OUTCOMES)[number];

export const TURN_STATES = [
  "none",
  "pending",
  "scheduled",
  "claimed",
  "reported",
  "failed",
] as const;
export type TurnState = (typeof TURN_STATES)[number];

/** What a check turn says when it finishes: only observations, never a decision (the check is read-only). */
export const CHECK_OUTCOMES = ["no_change", "changed", "cannot_check"] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];
export type CheckReport = { outcome: CheckOutcome; summary: string };

export type TriggerRecord = {
  id: string;
  scheduleId: string;
  scheduleRevision: number;
  occurrenceKey: string;
  planVersion: number;
  source: TriggerSource;
  plannedAt: number;
  outcome: TriggerOutcome;
  skipReason: string | null;
  mergedOccurrenceKeys: string[];
  taskId: string | null;
  slotOpen: boolean;
  firedAt: number | null;
  /** Where the check turn of a fired trigger stands (W4b); `none` for triggers that fired no check. */
  turnState: TurnState;
  turnJobId: string | null;
  turnSessionKey: string | null;
  failReason: string | null;
  report: CheckReport | null;
  createdAt: number;
};

/** Two accepted manual triggers of one schedule are at least this far apart (R-16). */
export const MANUAL_TRIGGER_COOLDOWN_MS = 5 * 60_000;
/** After a commitment ends, checks already running may finish for at most this long before the plan ends (design 6.4). */
export const PLAN_WRAPUP_MS = 30 * 60_000;
export const SCHEDULE_LIMITS = {
  purpose: 300,
  ref: 200,
  schedulesPerPlan: 5,
  planJson: 8000,
  reportSummary: 600,
} as const;
