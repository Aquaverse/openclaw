// Commitment layer types (object-model design 4.4, 6): the record a caller sees, the inputs that create and change it, and the
// closed value sets. A Commitment is something ONE person agreed to deliver; it is never the Agent's own to-do. Four lines move
// independently (communication, acceptance, lifecycle, verification); `overdue` is computed at read time and never stored.
import type { ContextMode } from "../work/types.js";

export const COMMUNICATION_STATES = [
  "draft",
  "submitted",
  "confirmed",
  "unknown",
  "failed",
] as const;
export type CommunicationState = (typeof COMMUNICATION_STATES)[number];
export const ACCEPTANCE_STATES = [
  "unknown",
  "accepted",
  "declined",
  "needs_clarification",
] as const;
export type AcceptanceState = (typeof ACCEPTANCE_STATES)[number];
export const COMMITMENT_LIFECYCLES = ["open", "waiting", "resolved", "cancelled"] as const;
export type CommitmentLifecycle = (typeof COMMITMENT_LIFECYCLES)[number];
export type CommitmentVerification =
  | "unverified"
  | "verified_complete"
  | "verified_exception"
  | "conflicting_evidence";
export type DueState = "known" | "pending" | "none";
export type CommitmentActor = "user" | "agent" | "system" | "engine";
export type CommitmentOriginKind = "task_run" | "system_job_run" | "native_record";

/** Plain-text limits the ledger enforces (the database only guards shapes). */
export const COMMITMENT_LIMITS = {
  requirement: 500,
  responsibleRaw: 80,
  reason: 500,
  basis: 500,
  ref: 200,
  nextStep: 300,
  periods: 12,
} as const;

export type CommitmentRecord = {
  ownerId: string;
  id: string;
  requirementText: string;
  responsibleCounterpartId: string | null;
  /** The name the person used ("小王"); the display name of the resolved counterpart is in `responsibleName`. */
  responsibleRaw: string | null;
  responsibleName: string | null;
  /** True when the responsible one is the owner's own identity row ("本人负责"). */
  responsibleSelf: boolean;
  responsibilityVersion: number;
  contextMode: ContextMode;
  contextScopeId: string;
  periodRequestId: string | null;
  periodKey: string | null;
  periodIndex: number | null;
  periodStart: number | null;
  periodEnd: number | null;
  periodTz: string | null;
  originKind: CommitmentOriginKind;
  originRefId: string;
  dueState: DueState;
  dueAt: number | null;
  dueTz: string | null;
  communicationState: CommunicationState;
  communicationActionRef: string | null;
  communicationReceiptLevel: string | null;
  communicationAt: number | null;
  acceptanceState: AcceptanceState;
  acceptanceBasisKind: "counterpart_source" | "user_report" | null;
  acceptanceBasis: string | null;
  acceptanceAt: number | null;
  lifecycle: CommitmentLifecycle;
  verification: CommitmentVerification;
  currentAssessmentId: string | null;
  verificationCommitVersion: number;
  resolutionBasis: "source_verified" | "manual_override" | null;
  resolutionReason: string | null;
  resolvedAt: number | null;
  cancelReason: string | null;
  cancelledAt: number | null;
  nextStep: string | null;
  createdBy: "user" | "agent" | "review_batch";
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Computed: a known due date has passed and the obligation is still open or waiting. */
  overdue: boolean;
};

/** Who is responsible. `name` keeps the person's own word; only `self` and `counterpart` resolve to an identity row. */
export type ResponsibleSpec =
  | { kind: "self" }
  | { kind: "name"; name: string }
  | { kind: "counterpart"; counterpartId: string };

export type DueSpec =
  | { kind: "known"; at: number; tz: string }
  | { kind: "pending" }
  | { kind: "none" };

export type CommitmentSpec = {
  requirementText: string;
  responsible: ResponsibleSpec;
  due?: DueSpec;
  contextMode?: ContextMode;
  nextStep?: string | null;
  /** Where the commitment came from. The user's words for a native record, a Task id for a Task run. */
  origin: { kind: CommitmentOriginKind; refId: string; source?: Record<string, unknown> };
};

export type CommitmentChanges = {
  requirementText?: string;
  responsible?: ResponsibleSpec;
  due?: DueSpec;
  nextStep?: string | null;
};

/** The people a lifecycle change reaches: shown to the user before it is applied (design 6.5). */
export type CommitmentImpact = {
  works: { workId: string; title: string; role: "required" | "reference"; linkId: string }[];
  /** Follow-up plans owned by this commitment that would be wrapped up (design 6.4). Empty until the plan layer exists. */
  plansToWrapUp: { planId: string }[];
};

export type PeriodSpec = {
  key: string;
  index: number;
  start: number;
  end: number;
  tz: string;
  dueAt: number;
};
