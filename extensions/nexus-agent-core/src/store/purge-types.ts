// Purge plain-data types (DESIGN section 9.4, P1-P5, and section 9.5.1 for the absence proof). Everything here crosses the
// SQLite worker boundary, so it is data only. The sync phases run in the worker (store/purge-ledger.ts); the byte I/O between
// them runs in the service (src/purge/purge-service.ts).
import type { BlobGcItem, EvidenceLeases } from "./blob-types.js";
import type { Principal } from "./types.js";

export type PurgePhase = "sealed" | "reservations_settled" | "workset_sealed";

export type PurgeBusyReason =
  | "execution_in_flight"
  | "execution_unsettled"
  | "execution_approved_uncommitted"
  | "decision_pending";

// ---------------------------------------------------------------- P1

export type PurgeBeginInput = {
  principal: Principal;
  taskId: string;
  /** Who asked (audit string, goes into the receipt). */
  requestedBy: string;
  /** Identity of THIS coordinator pass. Unrelated to the business purge_id, which never changes (DESIGN 9.4). */
  workerAttemptId: string;
  workerLeaseMs: number;
  now: number;
};

export type PurgeBeginOutcome =
  | { outcome: "started" | "resumed"; purgeId: string; phase: PurgePhase }
  | { outcome: "not_found" }
  /** Refused up front: purging would cascade away the reconciliation trail of something still in flight. */
  | { outcome: "task_busy"; reasons: PurgeBusyReason[] }
  /** Another coordinator pass holds the run lease. */
  | { outcome: "worker_active"; purgeId: string; leaseUntil: number };

/** Common coordinates of every later phase. Each phase re-reads the run inside its own transaction. */
export type PurgeRunRef = {
  principal: Principal;
  taskId: string;
  purgeId: string;
  workerAttemptId: string;
  workerLeaseMs: number;
  now: number;
};

export type PurgeNotOwner =
  | { outcome: "not_owner" }
  | { outcome: "wrong_phase"; phase: PurgePhase };

// ---------------------------------------------------------------- P2

export type PurgeClaimReservationsInput = PurgeRunRef & { leases: EvidenceLeases };
export type PurgeClaimReservationsOutcome =
  | {
      outcome: "claimed";
      /** Physical objects this call now owns the right to delete (state `reclaiming`, reservation `reclaiming`). */
      items: BlobGcItem[];
      /** Reservations that were already `reclaiming` under someone else's lease (GC): we wait for them. */
      heldByOthers: number;
      workItemsWritten: number;
    }
  | PurgeNotOwner;

export type PurgeAdvanceReservationsOutcome =
  | { outcome: "advanced" }
  | { outcome: "waiting"; reserved: number; reclaiming: number }
  | PurgeNotOwner;

// ---------------------------------------------------------------- P3

export type PurgeSealOutcome =
  | { outcome: "sealed"; workItemCount: number; refsReleased: number }
  | { outcome: "already_sealed"; workItemCount: number }
  | { outcome: "reservations_open"; reserved: number; reclaiming: number }
  | PurgeNotOwner;

// ---------------------------------------------------------------- P4

export type PurgeClassifyInput = PurgeRunRef & { leases: EvidenceLeases; limit: number };

export type PurgeTombstoneItem = {
  contentHash: string;
  generation: number;
  blobKey: string;
  writerSettledReason: string | null;
  settledWriterAttemptId: string | null;
};

export type PurgeClassifyOutcome =
  | {
      outcome: "classified";
      /** live objects with zero references, now `reclaiming`: delete the bytes, then blobGcSettle. */
      reclaim: BlobGcItem[];
      /** tombstones without a proof yet: delete again by key, check absence, then blobTombstoneChecked. */
      tombstones: PurgeTombstoneItem[];
      counts: {
        pending: number;
        failed: number;
        absenceVerified: number;
        retainedVerified: number;
        /** pending items whose object is `reclaiming` / `writing` under someone else's lease. */
        waiting: number;
      };
      /** Items parked in `failed` with a reason (reference-count drift and the like). They block the receipt. */
      failures: Array<{ blobKey: string; reason: string }>;
    }
  | PurgeNotOwner;

// ---------------------------------------------------------------- P5

export type PurgeCleanupBlocker =
  | "workset_not_sealed"
  | "workset_count_mismatch"
  | "open_work_items"
  | "stale_absence_proof"
  | "retained_without_references"
  | "open_reservations";

export type PurgeFinalizeInput = {
  principal: Principal;
  taskId: string;
  purgeId: string;
  requestedBy: string;
  now: number;
};

export type PurgeReceipt = {
  id: string;
  taskId: string;
  ledgerHeadDigest: string | null;
  claimEventCount: number;
  evidenceCount: number;
  purgedScope: "all";
  requestedBy: string;
  executedAt: number;
  /** Physical objects this purge deleted / left in place because another Task still references them. */
  objectsDeleted: number;
  objectsRetained: number;
};

/** What a receipt row keeps (hashes and counts only). Object counts are only known to the pass that wrote it. */
export type PurgeReceiptRow = {
  id: string;
  taskId: string;
  ledgerHeadDigest: string | null;
  claimEventCount: number;
  evidenceCount: number;
  purgedScope: "all";
  requestedBy: string;
  executedAt: number;
};

export type PurgeFinalizeOutcome =
  | { outcome: "purged"; receipt: PurgeReceipt }
  | { outcome: "cleanup_pending"; blockers: PurgeCleanupBlocker[] }
  | { outcome: "not_found" };

// ---------------------------------------------------------------- status

export type PurgeStatus = {
  taskId: string;
  purgeId: string;
  phase: PurgePhase;
  workItemCount: number | null;
  workerLeaseUntil: number | null;
  items: Record<string, number>;
  reservations: Record<string, number>;
  failures: Array<{ blobKey: string; reason: string }>;
};

export type PurgeRunSummary = {
  taskId: string;
  purgeId: string;
  phase: PurgePhase;
  workerLeaseUntil: number | null;
  updatedAt: number;
};

// ---------------------------------------------------------------- single evidence deletion

export type EvidenceDeleteInput = {
  principal: Principal;
  taskId: string;
  evidenceId: string;
  requestedBy: string;
  now: number;
};

export type EvidenceDeleteOutcome =
  | {
      outcome: "deleted";
      evidenceId: string;
      contentHash: string;
      blobKey: string;
      /** The object has no reference left; the zero-reference scan reclaims it after its grace period. */
      orphaned: boolean;
    }
  | { outcome: "already_deleted"; evidenceId: string }
  | { outcome: "no_bytes"; evidenceId: string }
  | { outcome: "not_found" }
  | { outcome: "task_purging" };

// ---------------------------------------------------------------- incarnation_gone

export type IncarnationSettleInput = {
  principal: Principal;
  limit: number;
  now: number;
};
export type IncarnationSettleOutcome = {
  /** Tombstones / reclaiming objects whose writer was in a process that is provably gone. */
  settled: string[];
};
