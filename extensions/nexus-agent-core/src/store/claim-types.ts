// Claim / Evidence ledger types (DESIGN section 9). Plain data only: everything here crosses the SQLite worker boundary.

export const CLAIM_STATES = ["ASSERTED", "SUPPORTED", "VERIFIED", "REFUTED", "UNKNOWN"] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

/** The only two states an Agent may write (section 9.5.1): everything else is derived by the store. */
export const AGENT_CLAIM_STATES = ["ASSERTED", "UNKNOWN"] as const;
export type AgentClaimState = (typeof AGENT_CLAIM_STATES)[number];

/** What a completion claim may require. ASSERTED / UNKNOWN / REFUTED can never complete a Task. */
export const COMPLETION_STATES = ["SUPPORTED", "VERIFIED"] as const;
export type CompletionState = (typeof COMPLETION_STATES)[number];

/** Slice 1 verifies `execution` refs only; the other two need the Blob store (a later Stage 3 slice). */
export const EVIDENCE_REF_KINDS = ["tool_output", "execution", "blob"] as const;
export type EvidenceRefKind = (typeof EVIDENCE_REF_KINDS)[number];
export type EvidenceRef = { kind: EvidenceRefKind; id: string };

export type ClaimPolicy = {
  /** Glob patterns over source_group (`bank:*`). Absent = every group counts as an independent source. */
  allowedGroups?: string[];
  /** Distinct groups needed for VERIFIED (default 2, never below 2). */
  minGroupsForVerified?: number;
};

export type ClaimRecord = {
  id: string;
  taskId: string;
  subject: string;
  predicate: string;
  value: unknown;
  state: ClaimState;
  policy: ClaimPolicy | null;
  headEventId: string;
  requiredForCompletion: CompletionState | null;
  createdAt: number;
  updatedAt: number;
};

export type ClaimEventRecord = {
  id: string;
  seq: number;
  claimId: string;
  transition: string;
  source: string;
  actor: string;
  digest: string;
  prevDigest: string | null;
  payload: unknown;
  createdAt: number;
};

export type EvidenceSummary = {
  evidenceId: string;
  kind: string;
  sourceRefKind: string;
  sourceRefId: string;
  sourceGroup: string;
  contentHash: string;
  summary: unknown;
  capturedAt: number;
};

export type ClaimLinkRecord = {
  relation: "supports" | "contradicts";
  effective: boolean;
  evidence: EvidenceSummary;
};

export type ClaimDetail = {
  claim: ClaimRecord;
  events: ClaimEventRecord[];
  links: ClaimLinkRecord[];
  /** Distinct, currently effective source groups (section 9.5.4). */
  supportGroups: number;
  contradictGroups: number;
};

export type CompletionItem = {
  claimId: string;
  subject: string;
  predicate: string;
  state: ClaimState;
  requiredState: CompletionState;
  met: boolean;
};
export type CompletionCheck = {
  ok: boolean;
  /** `no_completion_claims` when nothing was registered, `unmet` when something falls short. */
  reason: "ok" | "no_completion_claims" | "unmet";
  items: CompletionItem[];
};
