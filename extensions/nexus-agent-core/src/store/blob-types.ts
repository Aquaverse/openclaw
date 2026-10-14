// Blob evidence plain-data types (DESIGN sections 9.4 / 9.5.1). Everything here crosses the SQLite worker boundary, so it is
// data only. The sync phases (A0 / A1 branch decision / B) run in the worker; the async phases (byte I/O) run in the
// service (src/evidence/evidence-service.ts), which only ever passes these plain objects back and forth.
import type { ClaimRecord, ClaimState } from "./claim-types.js";
import type { Principal } from "./types.js";

export const CONTENT_CLASSIFICATIONS = ["personal", "financial", "sensitive"] as const;
export type ContentClassification = (typeof CONTENT_CLASSIFICATIONS)[number];

/** Server-side upload source group (source group rule table v2). */
export const USER_UPLOAD_GROUP = "user_upload";

/** What the server knows about one piece of material BEFORE any bytes are compared: derived, never model-supplied. */
export type BlobSourceFacts = {
  /** evidence.kind, e.g. `uploaded_file`. */
  kind: string;
  /** Canonical location (`upload:<name>`, or inherited from the first registration for a blob ref). */
  locator: string;
  /** Version the source gave; null means "content:<hash>" (DESIGN 9.5.3, never the capture time). */
  version: string | null;
  sourceGroup: string;
  classification: ContentClassification;
  /** Small descriptive facts for audit and UI (name, media type). Never used for a decision. */
  meta: Record<string, unknown>;
};

export type EvidenceLimits = {
  /** Soft quota per Task: its evidence bytes + its unsettled reservations (DESIGN 9.4). */
  taskQuotaBytes: number;
  /** Soft quota per owner: physical objects in writing / live / reclaiming. */
  ownerQuotaBytes: number;
  /** Largest single piece of material (the SDK allows 100 MB per entry). */
  maxEntryBytes: number;
};

export type EvidenceLeases = {
  /** writer_lease_until = now + this. Revokes DB authority only; it never proves the I/O stopped. */
  writerLeaseMs: number;
  /** blob_reservations.expires_at = now + this; GC may only claim a reservation after it. */
  reservationTtlMs: number;
  /** reclaim lease for GC claims. */
  reclaimLeaseMs: number;
};

export type QuotaScope = "task" | "owner" | "entry";
export type QuotaExceeded = {
  outcome: "quota_exceeded";
  scope: QuotaScope;
  limit: number;
  used: number;
  requested: number;
};

// ---------------------------------------------------------------- A0

export type BlobSourceSpec =
  /** `contentHash` lets A0 see that identical bytes are already held (no new physical bytes, maybe no new Task bytes). */
  { kind: "upload"; byteSize: number; contentHash?: string } | { kind: "blob"; blobKey: string };

export type BlobPrecheckInput = {
  principal: Principal;
  taskId: string;
  claimId?: string;
  expectedHeadEventId?: string;
  source: BlobSourceSpec;
  limits: EvidenceLimits;
  now: number;
};

export type ResolvedBlobRef = {
  blobKey: string;
  contentHash: string;
  byteSize: number;
  facts: BlobSourceFacts;
};

export type BlobPrecheckOutcome =
  | { outcome: "ok"; ref: ResolvedBlobRef | null }
  | { outcome: "not_found" }
  | { outcome: "claim_not_found" }
  | { outcome: "task_closed"; status: string }
  | { outcome: "stale_head"; headEventId: string }
  | { outcome: "ref_not_found" }
  | { outcome: "ref_not_ready"; state: string }
  | QuotaExceeded;

// ---------------------------------------------------------------- A1

export type BlobPlanInput = {
  principal: Principal;
  taskId: string;
  claimId?: string;
  contentHash: string;
  byteSize: number;
  facts: BlobSourceFacts;
  /** Unique per call; becomes writer_attempt_id when the plan is `new_object`. */
  attemptId: string;
  incarnationId: string;
  limits: EvidenceLimits;
  leases: EvidenceLeases;
  now: number;
};

export type BlobPlan =
  | { branch: "reuse_evidence"; evidenceId: string; blobKey: string }
  | { branch: "attach_live_object"; blobKey: string; generation: number }
  | {
      branch: "new_object";
      blobKey: string;
      generation: number;
      reservationId: string;
      attemptId: string;
      expiresAt: number;
    };

export type BlobPlanOutcome =
  | { outcome: "planned"; plan: BlobPlan }
  /** The same content is being written / reclaimed right now: wait, then plan again (never assume the result). */
  | { outcome: "wait"; state: "writing" | "reclaiming"; blobKey: string; retryAfterMs: number }
  | { outcome: "evidence_purged"; evidenceId: string }
  | { outcome: "not_found" }
  | { outcome: "claim_not_found" }
  | { outcome: "task_closed"; status: string }
  | QuotaExceeded;

// ---------------------------------------------------------------- B

export type OperatorRelation = {
  relation: "supports" | "contradicts";
  reason: string;
};

export type BlobAdmitInput = {
  principal: Principal;
  taskId: string;
  claimId?: string;
  expectedHeadEventId?: string;
  plan: BlobPlan;
  contentHash: string;
  byteSize: number;
  facts: BlobSourceFacts;
  /** Only the operator RPCs may pass this. The Agent tool path never does, so it cannot choose a relation. */
  operatorRelation?: OperatorRelation;
  limits: EvidenceLimits;
  eventSource: "store" | "operator";
  actor: string;
  now: number;
};

export type BlobAdmitOutcome =
  | {
      outcome: "linked";
      claim: ClaimRecord;
      evidenceId: string;
      blobKey: string;
      branch: BlobPlan["branch"];
      reusedEvidence: boolean;
      relation: "supports" | "contradicts" | "unclassified";
      reason: string;
      stateBefore: ClaimState;
      stateAfter: ClaimState;
      eventId: string;
    }
  /** No claim was named: the evidence row exists (or already did) and nothing was linked. */
  | {
      outcome: "registered";
      evidenceId: string;
      blobKey: string;
      branch: BlobPlan["branch"];
      reusedEvidence: boolean;
    }
  | { outcome: "already_linked"; claim: ClaimRecord; evidenceId: string; blobKey: string }
  | { outcome: "detached_by_operator"; evidenceId: string }
  | { outcome: "stale_head"; headEventId: string }
  | { outcome: "not_found" }
  | { outcome: "claim_not_found" }
  | { outcome: "task_closed"; status: string }
  /** The reservation or the object was claimed / reclaimed while the bytes were being written: nothing was admitted. */
  | { outcome: "reservation_lost"; reason: string }
  | { outcome: "object_not_live"; blobKey: string }
  | { outcome: "evidence_purged"; evidenceId: string }
  | QuotaExceeded;

// ---------------------------------------------------------------- GC

export type BlobGcInput = {
  principal: Principal;
  attemptId: string;
  limit: number;
  leases: EvidenceLeases;
  /** Zero-reference live objects younger than this are left alone (a concurrent attach may be about to use them). */
  zeroRefGraceMs: number;
  now: number;
};

/** One physical object the service now owns the right to delete (state `reclaiming`, attempt = `objectAttemptId`). */
export type BlobGcItem = {
  contentHash: string;
  generation: number;
  blobKey: string;
  byteSize: number;
  objectAttemptId: string;
  reservationId: string | null;
  reservationAttemptId: string | null;
  /** The writer whose I/O may still be in flight (writing-origin only). */
  writerAttemptId: string | null;
  writerIncarnation: string | null;
};

export type BlobGcClaimOutcome = {
  items: BlobGcItem[];
  /** Reservations that had no live physical object left and were closed directly. */
  abandonedWithoutObject: number;
};

export type BlobGcSettleInput = {
  principal: Principal;
  items: Array<
    BlobGcItem & {
      /** The byte delete returned and a following lookup found nothing. */
      absent: boolean;
      /** Set only when the writer's real Promise settled in this process (`awaited`). */
      writerSettledReason?: "awaited";
    }
  >;
  now: number;
};
export type BlobGcSettleOutcome = {
  deleted: number;
  /** Items left `reclaiming` (evidence still referenced them, or the attempt was superseded). They are retried later. */
  skipped: Array<{ blobKey: string; reason: string }>;
};

export type BlobTombstone = {
  contentHash: string;
  generation: number;
  blobKey: string;
  writerSettledReason: string | null;
  /** The writer whose I/O the absence proof has to wait for (copied from writer_* when the object left `writing`). */
  settledWriterAttemptId: string | null;
};
export type BlobTombstonesInput = {
  principal: Principal;
  olderThanMs: number;
  limit: number;
  now: number;
};
export type BlobTombstoneCheckedInput = {
  principal: Principal;
  blobKey: string;
  /** The delete found bytes again (a late write landed after the tombstone). */
  reappeared: boolean;
  /** A lookup after the delete found nothing. */
  absent: boolean;
  /** The settled writer's real Promise settled in THIS process since the object was reclaimed (`awaited`). */
  writerSettledReason?: "awaited";
  now: number;
};

export type BlobStats = {
  ownerBytes: number;
  objects: Record<string, number>;
  reservations: Record<string, number>;
  evidenceWithBlob: number;
  tombstonesWithoutProof: number;
};

/** Everything `nexus.evidence.*` shows about one registered piece of material. */
export type EvidenceBlobView = {
  evidenceId: string;
  taskId: string;
  kind: string;
  blobKey: string | null;
  contentHash: string;
  byteSize: number | null;
  sourceGroup: string;
  classification: string;
  redactionState: string;
  meta: unknown;
  capturedAt: number;
  linkedClaimIds: string[];
};
