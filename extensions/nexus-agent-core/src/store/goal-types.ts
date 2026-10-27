// Goals plain-data types (Goals design section 5). Everything here crosses the SQLite worker boundary.
import type { ClaimState } from "./claim-types.js";
import type { Principal } from "./types.js";

/** The seven category values (Muse's names; `money` is `finance`). v1 only opens three of them (design section 0, row 2). */
export const GOAL_CATEGORIES = [
  "health",
  "relationships",
  "finance",
  "career",
  "interests",
  "productivity",
  "something_else",
] as const;
export type GoalCategory = (typeof GOAL_CATEGORIES)[number];

/** The categories the write entrances accept in v1. The database CHECK allows all seven so opening more needs no migration. */
export const GOAL_OPEN_CATEGORIES: readonly GoalCategory[] = [
  "finance",
  "interests",
  "something_else",
];
export function isOpenGoalCategory(value: unknown): value is GoalCategory {
  return typeof value === "string" && (GOAL_OPEN_CATEGORIES as readonly string[]).includes(value);
}

export type GoalStatus = "proposed" | "active" | "completed";
export type GoalLifecycle = "live" | "deleted" | "purging";
export type GoalOrigin = "user" | "agent";
export type GoalCreatedVia = "console" | "creation_chat" | "agent_proposal";
export type GoalSensitivity = "normal" | "sensitive";
export type GoalNotifyPolicy = "off" | "digest" | "on";
export type GoalEntryKind = "note" | "milestone" | "review" | "break" | "system";
export type GoalEntryAuthor = "user" | "agent" | "system";
export type GoalLinkKind = "task" | "vault_file" | "preference" | "watch";

/** Hard limits. Text fields are short on purpose: a goal is a statement, not a document. */
export const GOAL_LIMITS = {
  title: 200,
  userWords: 2000,
  summary: 1000,
  currentState: 200,
  entryText: 2000,
  question: 200,
  questions: 3,
  /** Active goals one owner may hold (design 9.4 `goalMaxActivePerOwner`). */
  maxActiveDefault: 20,
  /** Proposed goals waiting for confirmation; keeps a runaway Agent from filling the page. */
  maxProposed: 20,
  entriesPerGoal: 1000,
  linksPerGoal: 200,
  metricsPerGoal: 10,
  metricName: 60,
  metricUnit: 20,
  /** Largest magnitude a metric figure may have; keeps REAL arithmetic exact enough and refuses pasted ids. */
  metricValue: 1e12,
  /** User replies kept on a creation grant, and the size of the string that becomes `user_words`. */
  grantReplies: 12,
  grantTtlMs: 2 * 60 * 60 * 1000,
} as const;

export type GoalRecord = {
  id: string;
  parentId: string | null;
  category: GoalCategory;
  title: string;
  userWords: string | null;
  summary: string | null;
  currentState: string | null;
  status: GoalStatus;
  lifecycle: GoalLifecycle;
  origin: GoalOrigin;
  createdVia: GoalCreatedVia;
  confirmedAt: number | null;
  confirmedBy: string | null;
  sensitivity: GoalSensitivity;
  notifyPolicy: GoalNotifyPolicy;
  sortOrder: number;
  /** Questions an Agent proposal wants the user to answer on the confirmation card (design 9.6). */
  questions: string[];
  revision: number;
  completedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** What a pointer's Task / claim looks like right now (read at get time, never stored; design 6.1). */
export type GoalPointerState = {
  /** The Task is purged or missing. Its status is then unknown. */
  taskGone: boolean;
  taskStatus: string | null;
  taskTitle: string | null;
  /** Only when the entry or metric carries a claim. */
  claimState: ClaimState | null;
  claimGone: boolean;
};

export type GoalEntryRecord = {
  id: string;
  goalId: string;
  kind: GoalEntryKind;
  text: string;
  author: GoalEntryAuthor;
  effectiveAt: number;
  createdAt: number;
  taskId: string | null;
  claimId: string | null;
  retractedAt: number | null;
  /** Live state of the pointed-at Task / claim; set by goalGet only. */
  pointer?: GoalPointerState;
};

export type GoalLinkRecord = {
  id: string;
  goalId: string;
  kind: GoalLinkKind;
  refId: string;
  createdAt: number;
  /** Computed at read time: the pointed-at Task / file / preference / watch no longer exists. */
  targetGone: boolean;
  /** Live Task status and title for `task` links; set by goalGet only. */
  task?: { status: string; title: string };
};

export type GoalMetricSource = "manual" | "claim";
export type GoalMetricDirection = "up" | "down";

export type GoalMetricRecord = {
  id: string;
  goalId: string;
  name: string;
  unit: string;
  direction: GoalMetricDirection;
  target: number | null;
  /** `manual`: what the user typed. `claim`: read from the claim's value at get time (null when it is not a number). */
  current: number | null;
  asOf: number | null;
  source: GoalMetricSource;
  taskId: string | null;
  claimId: string | null;
  reachedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Live state of the claim behind a `claim` metric; set by goalGet only. */
  pointer?: GoalPointerState;
};

export type GoalCreationGrantRecord = {
  id: string;
  sessionKey: string;
  category: GoalCategory;
  parentId: string | null;
  issuedBy: string;
  expiresAt: number;
  createdAt: number;
};

/** What a goal's list row carries on top of the record. */
export type GoalSummaryRecord = GoalRecord & {
  childCount: number;
  linkCount: number;
  entryCount: number;
  lastEntryAt: number | null;
};

export type GoalDetailRecord = {
  goal: GoalRecord;
  parent: Pick<GoalRecord, "id" | "title" | "category"> | null;
  children: GoalRecord[];
  entries: GoalEntryRecord[];
  entriesTruncated: boolean;
  links: GoalLinkRecord[];
  metrics: GoalMetricRecord[];
};

// ---------------------------------------------------------------- inputs and outcomes

export type GoalCapacity = { max: number };

/** The tail every goal-writing outcome shares. */
export type GoalWriteRefusal =
  | { outcome: "not_found" }
  | { outcome: "not_live"; lifecycle: GoalLifecycle }
  | { outcome: "bad_state"; status: GoalStatus }
  | { outcome: "stale"; revision: number }
  | { outcome: "limit_reached"; max: number; kind: "active" | "proposed" };

export type GoalGrantIssueInput = {
  principal: Principal;
  sessionKey: string;
  category: GoalCategory;
  parentId?: string;
  issuedBy: string;
  maxActive: number;
  ttlMs: number;
  now: number;
};
export type GoalGrantIssueOutcome =
  | { outcome: "issued"; grant: GoalCreationGrantRecord }
  | { outcome: "limit_reached"; max: number; kind: "active" }
  | { outcome: "bad_category" }
  | { outcome: "parent_invalid"; reason: "not_found" | "not_top_level" | "not_active" | "not_live" }
  | { outcome: "bad_session" };

export type GoalGrantLookupInput = { ownerId: string; sessionKey: string; now: number };
export type GoalGrantLookupOutcome =
  | { outcome: "active"; grant: GoalCreationGrantRecord }
  | { outcome: "none" };

export type GoalGrantCaptureInput = {
  ownerId: string;
  sessionKey: string;
  /** Stable id of the user message (hooks re-run on retries and compaction); the same key is stored once. */
  messageKey: string;
  text: string;
  now: number;
};
export type GoalGrantCaptureOutcome = { outcome: "captured" | "duplicate" | "none" | "full" };

export type GoalFields = {
  title: string;
  summary?: string;
  currentState?: string;
};

export type GoalCreateInput = {
  principal: Principal;
  sessionKey: string;
  fields: GoalFields;
  /** Computed by the service (finance defaults to sensitive; the value scan may raise it). */
  sensitivity: GoalSensitivity;
  idempotencyKey: string;
  maxActive: number;
  now: number;
};
export type GoalCreateOutcome =
  | { outcome: "created"; goal: GoalRecord }
  | { outcome: "exists"; goal: GoalRecord }
  | { outcome: "similar"; goal: GoalRecord }
  | { outcome: "no_grant" }
  | { outcome: "invalid"; code: GoalInvalidCode }
  | { outcome: "limit_reached"; max: number; kind: "active" }
  | {
      outcome: "parent_invalid";
      reason: "not_found" | "not_top_level" | "not_active" | "not_live";
    };

export type GoalProposeInput = {
  principal: Principal;
  category: GoalCategory;
  fields: GoalFields;
  questions?: readonly string[];
  parentId?: string;
  sensitivity: GoalSensitivity;
  idempotencyKey: string;
  now: number;
};
export type GoalProposeOutcome =
  | { outcome: "proposed"; goal: GoalRecord }
  | { outcome: "exists"; goal: GoalRecord }
  | { outcome: "similar"; goal: GoalRecord }
  | { outcome: "invalid"; code: GoalInvalidCode }
  | { outcome: "limit_reached"; max: number; kind: "proposed" }
  | {
      outcome: "parent_invalid";
      reason: "not_found" | "not_top_level" | "not_active" | "not_live";
    };

export type GoalInvalidCode =
  | "bad_category"
  | "bad_title"
  | "title_too_long"
  | "summary_too_long"
  | "current_state_too_long"
  | "user_words_too_long"
  | "bad_question"
  | "too_many_questions"
  | "bad_text"
  | "text_too_long"
  | "bad_kind"
  | "bad_author"
  | "bad_ref"
  | "bad_metric_name"
  | "bad_metric_unit"
  | "bad_metric_value"
  | "bad_metric_source"
  | "bad_patch"
  | "bad_sort_order"
  | "bad_sensitivity";

export type GoalConfirmInput = {
  principal: Principal;
  goalId: string;
  actor: string;
  /** Edits the user made on the confirmation card; applied in the same transaction. */
  edits?: { title?: string; summary?: string; currentState?: string };
  maxActive: number;
  now: number;
};
export type GoalConfirmOutcome =
  | { outcome: "confirmed"; goal: GoalRecord }
  | { outcome: "invalid"; code: GoalInvalidCode }
  | GoalWriteRefusal;

export type GoalUpdateInput = {
  principal: Principal;
  goalId: string;
  patch: {
    title?: string;
    summary?: string | null;
    currentState?: string | null;
    category?: GoalCategory;
    sensitivity?: GoalSensitivity;
    sortOrder?: number;
  };
  expectedRevision?: number;
  now: number;
};
export type GoalUpdateOutcome =
  | { outcome: "updated" | "unchanged"; goal: GoalRecord }
  | { outcome: "invalid"; code: GoalInvalidCode }
  | GoalWriteRefusal;

export type GoalTransitionInput = {
  principal: Principal;
  goalId: string;
  maxActive: number;
  now: number;
};
export type GoalTransitionOutcome =
  | { outcome: "done" | "unchanged"; goal: GoalRecord }
  | GoalWriteRefusal;

export type GoalDeleteOutcome =
  | { outcome: "deleted" | "already_deleted"; goal: GoalRecord; affected: number }
  | { outcome: "not_found" }
  | { outcome: "purging" };
export type GoalRestoreOutcome =
  | { outcome: "restored"; goal: GoalRecord; affected: number }
  | { outcome: "not_found" }
  | { outcome: "not_deleted"; lifecycle: GoalLifecycle }
  | { outcome: "parent_deleted" }
  | { outcome: "limit_reached"; max: number; kind: "active" };

export type GoalListInput = {
  principal: Principal;
  status?: GoalStatus | "open";
  lifecycle?: "live" | "deleted";
  parentId?: string | null;
  category?: GoalCategory;
  /** Whitespace-separated terms; every term must appear in the title, summary or current state. */
  query?: string;
  /** `manual` (default): the user's order, then newest first. `recent`: last touched first (the page's "sort automatically"). */
  orderBy?: "manual" | "recent";
  limit: number;
  offset?: number;
};
export type GoalListOutcome = { goals: GoalSummaryRecord[]; total: number };

export type GoalGetInput = { principal: Principal; goalId: string; entryLimit?: number };

export type GoalEntryAddInput = {
  principal: Principal;
  goalId: string;
  kind: GoalEntryKind;
  text: string;
  author: GoalEntryAuthor;
  taskId?: string;
  claimId?: string;
  effectiveAt?: number;
  /** Agents write to `active` goals only; the operator may also add to a completed goal. */
  allowCompleted: boolean;
  now: number;
};
export type GoalEntryAddOutcome =
  | { outcome: "added"; entry: GoalEntryRecord }
  | { outcome: "invalid"; code: GoalInvalidCode }
  | { outcome: "task_not_found" }
  | { outcome: "claim_not_found" }
  | { outcome: "limit_reached"; max: number; kind: "entries" }
  | GoalWriteRefusal;

export type GoalEntryRetractInput = {
  principal: Principal;
  goalId: string;
  entryId: string;
  now: number;
};
export type GoalEntryRetractOutcome =
  | { outcome: "retracted" | "already_retracted"; entry: GoalEntryRecord }
  | { outcome: "entry_not_found" }
  | { outcome: "refused"; reason: "system_entry" }
  | GoalWriteRefusal;

export type GoalLinkAddInput = {
  principal: Principal;
  goalId: string;
  kind: GoalLinkKind;
  refId: string;
  now: number;
};
export type GoalLinkAddOutcome =
  | { outcome: "linked" | "unchanged"; link: GoalLinkRecord }
  | { outcome: "invalid"; code: GoalInvalidCode }
  | { outcome: "target_not_found" }
  | { outcome: "target_unavailable"; reason: "purging" | "closed" }
  | { outcome: "capability_unavailable" }
  | { outcome: "task_linked_elsewhere"; goalId: string }
  | { outcome: "limit_reached"; max: number; kind: "links" }
  | GoalWriteRefusal;

export type GoalLinkRemoveInput = {
  principal: Principal;
  goalId: string;
  linkId: string;
  now: number;
};
export type GoalLinkRemoveOutcome =
  | { outcome: "removed" }
  | { outcome: "link_not_found" }
  | GoalWriteRefusal;

export type GoalMetricSetInput = {
  principal: Principal;
  goalId: string;
  /** Present: update that metric (name, unit, direction, target, manual current; the source and claim never change). */
  metricId?: string;
  name?: string;
  unit?: string;
  direction?: GoalMetricDirection;
  /** `undefined` keeps the stored value on update; `null` clears it. */
  target?: number | null;
  current?: number | null;
  source?: GoalMetricSource;
  taskId?: string;
  claimId?: string;
  /** The system-entry sentence for "target reached", with `{name}` and `{value}` placeholders (the service localises it). */
  reachedText: string;
  now: number;
};
export type GoalMetricSetOutcome =
  | { outcome: "created" | "updated"; metric: GoalMetricRecord; reachedNow: boolean }
  | { outcome: "invalid"; code: GoalInvalidCode }
  | { outcome: "metric_not_found" }
  | { outcome: "name_taken"; metricId: string }
  | { outcome: "task_not_found" }
  | { outcome: "claim_not_found" }
  | { outcome: "refused"; reason: "finance_manual_only" }
  | { outcome: "limit_reached"; max: number; kind: "metrics" }
  | GoalWriteRefusal;

export type GoalMetricRemoveInput = {
  principal: Principal;
  goalId: string;
  metricId: string;
  now: number;
};
export type GoalMetricRemoveOutcome =
  | { outcome: "removed" }
  | { outcome: "metric_not_found" }
  | GoalWriteRefusal;

// ---------------------------------------------------------------- purge

export type GoalPurgeBeginInput = {
  principal: Principal;
  goalId: string;
  requestedBy: string;
  attemptId: string;
  leaseMs: number;
  now: number;
};
export type GoalPurgeRunRecord = {
  goalId: string;
  parentId: string | null;
  purgeId: string;
  requestedBy: string;
  requestedAt: number;
  leased: boolean;
};
export type GoalPurgeBeginOutcome =
  /** `started`: a new run (children first in `runs`). `resumed`: the run existed and its lease was free or expired. */
  | { outcome: "started" | "resumed"; runs: GoalPurgeRunRecord[]; attemptId: string }
  | { outcome: "worker_active"; purgeId: string; requestedBy: string }
  | { outcome: "not_found" };

export type GoalPurgeFinalizeInput = {
  ownerId: string;
  goalId: string;
  attemptId: string;
  leaseMs: number;
  now: number;
};
export type GoalPurgeFinalizeOutcome =
  | { outcome: "purged"; receipt: GoalPurgeReceiptRow }
  | { outcome: "not_holder" }
  | { outcome: "children_remain" }
  | { outcome: "not_found" };

export type GoalPurgeReleaseInput = { ownerId: string; attemptId: string; goalIds: string[] };

/** Hashes and counts only (design 8.3): never a title or any text. */
export type GoalPurgeReceiptRow = {
  id: string;
  purgeId: string;
  goalIdHash: string;
  titleHash: string;
  entryCount: number;
  linkCount: number;
  metricCount: number;
  reviewCount: number;
  requestedBy: string;
  executedAt: number;
};

export type GoalPurgeStatusOutcome =
  | { outcome: "purging"; runs: GoalPurgeRunRecord[] }
  | { outcome: "none" };

export type GoalPurgeResumableInput = { now: number; limit: number };
export type GoalPurgeResumableRow = { ownerId: string; goalId: string };

// ---------------------------------------------------------------- the Goal <-> File relation (design 5.1, "owner of the relation")

export type GoalsForFileInput = { principal: Principal; fileId: string };
export type GoalForFile = { id: string; title: string; status: GoalStatus; category: GoalCategory };
