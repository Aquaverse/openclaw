// Vault maintenance plain-data types (Vault design 5.2 recovery table, 5.3 reclaim / tombstones, 5.3 hard purge), Stage 5.
// Same rules as vault-types.ts: data only, because everything here crosses the SQLite worker boundary.
import type { Principal } from "./types.js";
import type { VaultReservationState } from "./vault-types.js";

// ---------------------------------------------------------------- hooks (Goals owns the Goal <-> File relation)

/**
 * The Goals module owns the Goal<->File relation. The vault never writes `goal_links`; it calls these hooks inside its own
 * transactions. The hook set is registered by storage presence (the Goals tables exist), not by `goalsEnabled`, so a file
 * purge still detaches goals while the Goals feature is switched off. Without Goals storage both are no-ops.
 */
export type VaultPurgeHooks = {
  detachFile(ownerId: string, fileId: string): void;
  fileHasGoalLinks(ownerId: string, fileId: string): boolean;
};

// ---------------------------------------------------------------- writer quiet proof

/**
 * What the caller can prove about the writer of a reservation. `awaited`: this process's real writer Promise for the
 * reservation settled. `incarnationGoneEnabled`: the operator allows "the writer's process is provably gone" as proof; the
 * kernel still requires the incarnation row to be terminated and its boot id not to be `unavailable`.
 */
export type VaultWriterQuiet = {
  currentIncarnationId: string;
  awaited: boolean;
  incarnationGoneEnabled: boolean;
};

// ---------------------------------------------------------------- reservation recovery

export type VaultRecoverableKind =
  /** reserved / written / promoted and expired, or the writer is provably gone: delete the file(s), then expire. */
  | "expire"
  /** promoted, the object row already exists but the reservation never recorded the result: CAS repair, delete nothing. */
  | "repair_promoted"
  /** committed but the physical file of this reservation lost the dedup race: delete it after the ownership check. */
  | "loser_cleanup";

export type VaultRecoverableItem = {
  reservationId: string;
  newObjectId: string;
  stagingKey: string;
  state: VaultReservationState;
  kind: VaultRecoverableKind;
  writerAttemptId: string;
  writerIncarnation: string;
  expiresAt: number;
  resultObjectId: string | null;
  expectedHash: string | null;
  expectedSize: number | null;
};

export type VaultListRecoverableInput = { principal: Principal; now: number; limit: number };

export type VaultRecoverCheckInput = {
  principal: Principal;
  reservationId: string;
  now: number;
  quiet: VaultWriterQuiet;
};
/** The final, synchronous ownership check before the service deletes physical files. */
export type VaultRecoverCheckOutcome =
  | {
      outcome: "delete";
      kind: "expire" | "loser_cleanup";
      /** Keys relative to the vault root: `staging/<id>` and/or `objects/<aa>/<id>`. The service resolves them. */
      stagingKey: string | null;
      objectKey: string | null;
    }
  | { outcome: "repair"; kind: "repair_promoted" }
  | {
      outcome: "skip";
      reason:
        | "not_found"
        | "not_due"
        | "writer_not_quiet"
        | "state"
        | "object_row_exists"
        | "unexpected";
    };

export type VaultReservationExpireInput = {
  principal: Principal;
  reservationId: string;
  now: number;
  quiet: VaultWriterQuiet;
};
export type VaultReservationExpireOutcome =
  | { outcome: "expired" }
  | { outcome: "noop"; state: VaultReservationState }
  | { outcome: "skip"; reason: "not_found" | "not_due" | "writer_not_quiet" | "object_row_exists" };

export type VaultRepairPromotedInput = { principal: Principal; reservationId: string; now: number };
export type VaultRepairPromotedOutcome =
  | { outcome: "committed" }
  | { outcome: "failed"; reason: "mismatch" | "object_not_live" }
  | { outcome: "noop"; state: VaultReservationState }
  | { outcome: "not_found" };

// ---------------------------------------------------------------- object reclaim

export type VaultReclaimCandidatesInput = {
  principal: Principal;
  now: number;
  /** Objects younger than this are left alone so reclaim never races a reservation that is still finishing. */
  graceMs: number;
  limit: number;
};
export type VaultReclaimCandidate = {
  objectId: string;
  state: "live" | "reclaiming" | "deleted";
  /** deleted without an absence proof: only the proof is missing. */
  needsProof: boolean;
};

export type VaultReclaimClaimInput = {
  principal: Principal;
  objectId: string;
  reclaimAttemptId: string;
  now: number;
  leaseMs: number;
  graceMs: number;
};
export type VaultReclaimClaimOutcome =
  | { outcome: "claimed"; objectId: string; size: number; contentHash: string; takeover: boolean }
  | { outcome: "busy"; leaseUntil: number }
  | { outcome: "already_deleted"; hasProof: boolean }
  | { outcome: "not_eligible"; reason: "referenced" | "grace" | "reservation_open" }
  | { outcome: "not_found" };

export type VaultReclaimPurgeRef = { fileId: string; purgeId: string };
export type VaultReclaimDataInput = {
  principal: Principal;
  objectId: string;
  reclaimAttemptId: string;
  now: number;
  leaseMs: number;
  /** Set by the purge flow of the claimer only: the page count is recorded on that work item (others record 0). */
  purgeRef?: VaultReclaimPurgeRef;
};
export type VaultReclaimDataOutcome =
  | { outcome: "ok"; textPages: number; jobs: number }
  | { outcome: "not_owner" };

export type VaultReclaimSettleInput = {
  principal: Principal;
  objectId: string;
  reclaimAttemptId: string;
  now: number;
};
export type VaultReclaimSettleOutcome =
  | { outcome: "deleted" }
  | { outcome: "referenced" }
  | { outcome: "not_owner" };

export type VaultAbsenceProofInput = {
  principal: Principal;
  objectId: string;
  attemptId: string;
  now: number;
};
export type VaultAbsenceProofOutcome =
  | { outcome: "proved" }
  | { outcome: "noop" }
  | { outcome: "not_found" };

// ---------------------------------------------------------------- tombstones and diagnostic reservations

export type VaultRetireTombstonesInput = {
  principal: Principal;
  now: number;
  retentionMs: number;
  limit: number;
};
export type VaultRetireTombstonesResult = { retired: number };

export type VaultPruneReservationsInput = {
  principal: Principal;
  now: number;
  retentionMs: number;
  limit: number;
};
export type VaultPruneReservationsResult = { pruned: number };

// ---------------------------------------------------------------- due work

export type VaultListDueInput = {
  principal: Principal;
  now: number;
  /** Trashed files older than this are due for hard purge. */
  trashRetentionMs: number;
  limit: number;
};
export type VaultListDueResult = {
  /** Active inbox files whose `expires_at` has passed: the service discards them (soft delete). */
  expiredInbox: string[];
  /** Trashed files past the retention period: the service starts a hard purge. */
  trashedDue: string[];
};

// ---------------------------------------------------------------- hard purge

export type VaultPurgeRunRef = {
  principal: Principal;
  fileId: string;
  purgeId: string;
  workerAttemptId: string;
};
export type VaultPurgeLease = { now: number; leaseMs: number };

export type VaultPurgeBeginInput = {
  principal: Principal;
  fileId: string;
  requestedBy: string;
  workerAttemptId: string;
  now: number;
  leaseMs: number;
};
export type VaultPurgeBeginOutcome =
  | {
      outcome: "started" | "resumed";
      purgeId: string;
      requestedBy: string;
      phase: "sealed" | "items_recorded";
    }
  | { outcome: "worker_active"; purgeId: string; requestedBy: string; leaseUntil: number }
  | { outcome: "not_found" }
  | { outcome: "invalid_state"; state: string };

export type VaultPurgeRecordItemsInput = VaultPurgeRunRef & VaultPurgeLease;
export type VaultPurgeRecordItemsOutcome =
  | { outcome: "recorded"; itemCount: number; versionCount: number }
  | { outcome: "not_owner" };

export type VaultPurgeItemsInput = VaultPurgeRunRef & VaultPurgeLease;
export type VaultPurgeItemsOutcome =
  | { outcome: "ok"; items: { objectId: string; state: VaultPurgeItemState }[] }
  | { outcome: "not_owner" }
  | { outcome: "wrong_phase" };

export type VaultPurgeItemState =
  | "pending"
  | "verified_gone"
  | "retained_shared"
  | "cleanup_pending";

export type VaultPurgeEvaluateInput = VaultPurgeRunRef &
  VaultPurgeLease & {
    objectId: string;
    /** The attempt id used if this evaluation claims the object for reclaim. */
    reclaimAttemptId: string;
  };
export type VaultPurgeEvaluateOutcome =
  | { outcome: "retained_shared" }
  | { outcome: "verified_gone" }
  | { outcome: "cleanup_pending" }
  /** This evaluation (or a takeover) claimed the object: the service now runs data purge, delete bytes, absence, settle. */
  | { outcome: "reclaim_claimed"; reclaimAttemptId: string }
  /** Someone else is reclaiming the object and the lease is live: come back later. */
  | { outcome: "waiting"; leaseUntil: number }
  /** The object is a tombstone without an absence proof: the maintenance flow writes it, then evaluate again. */
  | { outcome: "needs_proof" }
  | { outcome: "not_owner" }
  | { outcome: "wrong_phase" }
  | { outcome: "not_found" };

export type VaultPurgeFinishInput = VaultPurgeRunRef & VaultPurgeLease & { now: number };
export type VaultPurgeFinishOutcome =
  | { outcome: "completed"; receiptId: string }
  | {
      outcome: "not_ready";
      reason:
        | "wrong_phase"
        | "item_count"
        | "versions_remain"
        | "pending"
        | "reevaluate"
        | "goal_links";
    }
  | { outcome: "cleanup_pending"; count: number }
  | { outcome: "not_owner" }
  | { outcome: "wrong_phase" };

export type VaultPurgeReleaseInput = VaultPurgeRunRef;

export type VaultPurgeStatusInput = { principal: Principal; fileId: string };
export type VaultPurgeStatus =
  | {
      outcome: "running";
      purgeId: string;
      requestedBy: string;
      phase: "sealed" | "items_recorded";
      itemCount: number | null;
      versionCount: number | null;
      items: Record<VaultPurgeItemState, number>;
      workerActive: boolean;
    }
  | { outcome: "completed"; receipt: VaultPurgeReceipt }
  | { outcome: "none" };

export type VaultPurgeListRunsInput = { principal: Principal; now: number; limit: number };
/** Runs that nobody drives right now: no holder, or the lease has expired. */
export type VaultPurgeListRunsResult = {
  runs: { fileId: string; purgeId: string; phase: "sealed" | "items_recorded" }[];
};

export type VaultPurgeReceipt = {
  id: string;
  purgeId: string;
  requestedBy: string;
  executedAt: number;
  retainedObjectCount: number;
  versionCount: number;
  textPageCount: number;
  compacted: boolean;
  fileIdHash: string | null;
  contentHashes: string[] | null;
};
export type VaultPurgeReceiptsInput = { principal: Principal; limit?: number; purgeId?: string };
export type VaultPurgeReceiptsResult = { receipts: VaultPurgeReceipt[] };

export type VaultCompactReceiptsInput = { principal: Principal; now: number; retentionMs: number };
export type VaultCompactReceiptsResult = { compacted: number };

// ---------------------------------------------------------------- integrity check ("a file points at a missing object")

export type VaultVerifyBatchInput = {
  principal: Principal;
  /** Resume after this file id (ids sort stably); null starts from the beginning. */
  afterFileId: string | null;
  limit: number;
};
export type VaultVerifyBatchResult = {
  items: { fileId: string; objectId: string; size: number; contentHash: string }[];
  /** Pass this back as `afterFileId`; null when the end was reached. */
  nextCursor: string | null;
};

export type VaultMarkDamagedInput = { principal: Principal; fileId: string; now: number };
export type VaultMarkDamagedOutcome =
  | { outcome: "marked" }
  | { outcome: "noop"; state: string }
  | { outcome: "not_found" };
