// Stage 2 plain-data types (DESIGN section 6.3 / 8). Everything here crosses the SQLite worker boundary.
import type { RiskTier } from "../decision/catalog.js";

export type { RiskTier };

export type EffectKind =
  | "issue_action_grant"
  | "issue_standing_grant"
  | "set_preference"
  | "acknowledge";
export type DecisionStatus =
  | "pending"
  | "decided"
  | "effect_apply_failed"
  | "expired"
  | "superseded";
export type DecisionResolution = "approved" | "denied" | "cancelled" | "timed_out";
export type CoreApprovalState =
  | "not_attempted"
  | "attempted"
  | "resolved"
  | "cancelled"
  | "timed_out";
export type ExecutionState = "prepared" | "executing" | "succeeded" | "failed" | "unknown";

export type ActionRecord = {
  id: string;
  taskId: string;
  toolName: string;
  capability: string;
  riskTier: RiskTier;
  params: unknown;
  paramsCanonical: string;
  actionHash: string;
  amount: string | null;
  currency: string | null;
  merchant: string | null;
  reversible: boolean;
  createdAt: number;
};

/** What a decision will issue if approved, per candidate action. Stored in grant_policy_snapshot (relative TTLs). */
export type GrantPolicy = {
  actionId: string;
  kind: "action_grant" | "standing_grant";
  capability: string;
  toolName: string;
  merchant: string | null;
  currency: string | null;
  maxAmount: string | null;
  ttlMs: number;
  singleUse: boolean;
  maxUses: number | null;
  maxUsesPerDay: number | null;
};

export type DecisionRecord = {
  id: string;
  taskId: string;
  decisionType: string;
  riskTier: string;
  question: string;
  facts: unknown;
  options: unknown;
  unknowns: unknown;
  policies: GrantPolicy[];
  authorityHash: string;
  taskRevision: number;
  requiredDecider: string | null;
  deadlineAt: number | null;
  status: DecisionStatus;
  resolution: DecisionResolution | null;
  resolutionSource: string | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
  coreApprovalState: CoreApprovalState;
  sessionKey: string | null;
  runId: string | null;
  toolCallId: string | null;
  effectKind: EffectKind;
  chosenActionId: string | null;
  actionIds: string[];
};

export type ExecutionRecord = {
  id: string;
  taskId: string;
  actionId: string;
  actionGrantId: string | null;
  standingGrantId: string | null;
  providerIdempotencyKey: string;
  providerIdempotencySupported: boolean;
  state: ExecutionState;
  providerOperationId: string | null;
  result: unknown;
  error: unknown;
  attempts: number;
  nextReconcileAt: number | null;
  preparedAt: number;
  startedAt: number | null;
  completedAt: number | null;
};

export type ActionGrantRecord = {
  id: string;
  taskId: string;
  fromDecisionId: string;
  actionId: string;
  capability: string;
  toolName: string;
  currency: string | null;
  maxAmount: string | null;
  taskRevision: number;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  consumedByExecution: string | null;
  revokedAt: number | null;
  supersededBy: string | null;
};

export type StandingGrantRecord = {
  id: string;
  taskId: string;
  fromDecisionId: string;
  sourceActionId: string;
  capability: string;
  toolName: string | null;
  merchant: string | null;
  maxUses: number | null;
  maxUsesPerDay: number | null;
  taskRevision: number;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  uses: number;
};

export type OutboxRecord = {
  id: string;
  taskId: string;
  eventKey: string;
  kind: string;
  payload: unknown;
  decisionId: string | null;
  attempts: number;
};

export type RunTriggerRecord = {
  runId: string;
  trigger: string;
  sessionKey: string;
  jobId: string | null;
  watchId: string | null;
  recordedAt: number;
  expiresAt: number;
};

/** Provider capabilities the module knows about but the worker cannot: tool name -> supports the idempotency key. */
export type ProviderCaps = Record<string, boolean>;
