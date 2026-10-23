/* oxlint-disable max-lines -- TODO: split this oversized file (one kernel/service unit per file for now). */
// Vault maintenance kernel (Vault design 5.2 recovery table, 5.3 reclaim / tombstones / hard purge), Stage 5. Like
// vault-ledger.ts every method is ONE synchronous transaction that filters on owner_id; file bytes are deleted by the
// service between calls, so the kernel only decides and records:
//   * reclaim: live -> reclaiming (CAS, only when no version row references the object) -> data purge -> bytes gone ->
//     deleted + absence proof. The attempt id owns the object; another claimer needs an expired lease;
//   * reservation recovery: a read-only `vaultRecoverCheck` (the last ownership check) precedes every physical delete;
//   * hard purge: a persistent run (sealed -> items_recorded) with the shared run-lease protocol (claim, own+renew,
//     conditional release), per-object work items, a gate that re-reads everything, and a receipt that is never deleted.
import type { ClaimLedger } from "./claim-ledger.js";
import type { TransactionRunner } from "./kernel.js";
import { vaultReceiptFileHash } from "./vault-ledger.js";
import type {
  VaultAbsenceProofInput,
  VaultAbsenceProofOutcome,
  VaultCompactReceiptsInput,
  VaultCompactReceiptsResult,
  VaultListDueInput,
  VaultListDueResult,
  VaultListRecoverableInput,
  VaultMarkDamagedInput,
  VaultMarkDamagedOutcome,
  VaultVerifyBatchInput,
  VaultVerifyBatchResult,
  VaultPruneReservationsInput,
  VaultPruneReservationsResult,
  VaultPurgeBeginInput,
  VaultPurgeBeginOutcome,
  VaultPurgeEvaluateInput,
  VaultPurgeEvaluateOutcome,
  VaultPurgeFinishInput,
  VaultPurgeFinishOutcome,
  VaultPurgeHooks,
  VaultPurgeItemState,
  VaultPurgeItemsInput,
  VaultPurgeItemsOutcome,
  VaultPurgeListRunsInput,
  VaultPurgeListRunsResult,
  VaultPurgeReceipt,
  VaultPurgeReceiptsInput,
  VaultPurgeReceiptsResult,
  VaultPurgeRecordItemsInput,
  VaultPurgeRecordItemsOutcome,
  VaultPurgeReleaseInput,
  VaultPurgeStatus,
  VaultPurgeStatusInput,
  VaultReclaimCandidate,
  VaultReclaimCandidatesInput,
  VaultReclaimClaimInput,
  VaultReclaimClaimOutcome,
  VaultReclaimDataInput,
  VaultReclaimDataOutcome,
  VaultReclaimSettleInput,
  VaultReclaimSettleOutcome,
  VaultRecoverableItem,
  VaultRecoverCheckInput,
  VaultRecoverCheckOutcome,
  VaultRepairPromotedInput,
  VaultRepairPromotedOutcome,
  VaultReservationExpireInput,
  VaultReservationExpireOutcome,
  VaultRetireTombstonesInput,
  VaultRetireTombstonesResult,
  VaultWriterQuiet,
} from "./vault-maintenance-types.js";
import { vaultObjectKey, vaultStagingKey, type VaultReservationState } from "./vault-types.js";

type Row = Record<string, unknown>;

const NO_HOOKS: VaultPurgeHooks = {
  detachFile: () => undefined,
  fileHasGoalLinks: () => false,
};

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number => Number(value);

export function createVaultMaintenanceLedger(
  transaction: TransactionRunner,
  internals: ClaimLedger["internals"],
  hooks: VaultPurgeHooks = NO_HOOKS,
) {
  const { one, all, run, newId } = internals;

  const objectRow = (owner: string, id: string): Row | undefined =>
    one("SELECT * FROM vault_objects WHERE owner_id = ? AND id = ?", owner, id);
  const reservationRow = (owner: string, id: string): Row | undefined =>
    one("SELECT * FROM vault_reservations WHERE owner_id = ? AND id = ?", owner, id);
  const versionRefs = (owner: string, objectId: string): number =>
    num(
      (
        one(
          "SELECT COUNT(*) AS c FROM vault_versions WHERE owner_id = ? AND object_id = ?",
          owner,
          objectId,
        ) as Row
      ).c,
    );

  // ------------------------------------------------------------------ writer quiet proof

  /**
   * The writer of a reservation has stopped touching its files when (a) this process's real Promise for it settled, or
   * (b) the operator enabled `incarnation_gone` and the writer's incarnation row is terminated with a known boot id.
   * Lease or TTL expiry alone never proves it: those only revoke database authority.
   */
  const writerQuiet = (reservation: Row, quiet: VaultWriterQuiet): boolean => {
    const incarnation = String(reservation.writer_incarnation);
    if (quiet.awaited && incarnation === quiet.currentIncarnationId) {
      return true;
    }
    const row = one(
      "SELECT gone_at, gone_basis, process_boot_id FROM process_incarnations WHERE incarnation_id = ?",
      incarnation,
    );
    if (!row || row.gone_at === null) {
      return false;
    }
    // A clean shutdown is written only after every writer of that process settled, so it proves quiet by itself. The weaker
    // "the process is provably gone" proof (a crash superseded under the gateway lock) needs the operator's opt-in and a
    // readable boot id.
    if (String(row.gone_basis) === "clean_shutdown") {
      return true;
    }
    return quiet.incarnationGoneEnabled && String(row.process_boot_id) !== "unavailable";
  };

  // ------------------------------------------------------------------ reservation recovery

  const vaultListRecoverable = (input: VaultListRecoverableInput): VaultRecoverableItem[] =>
    transaction((): VaultRecoverableItem[] => {
      const owner = input.principal.ownerId;
      const items: VaultRecoverableItem[] = [];
      const push = (row: Row, kind: VaultRecoverableItem["kind"]) =>
        items.push({
          reservationId: String(row.id),
          newObjectId: String(row.new_object_id),
          stagingKey: String(row.staging_path_key),
          state: String(row.state) as VaultReservationState,
          kind,
          writerAttemptId: String(row.writer_attempt_id),
          writerIncarnation: String(row.writer_incarnation),
          expiresAt: num(row.expires_at),
          resultObjectId: str(row.result_object_id),
          expectedHash: str(row.content_hash),
          expectedSize: row.byte_size === null ? null : num(row.byte_size),
        });
      for (const row of all(
        "SELECT r.* FROM vault_reservations r WHERE r.owner_id = ? AND r.state = 'promoted' AND r.result_object_id IS NULL " +
          "AND EXISTS (SELECT 1 FROM vault_objects o WHERE o.owner_id = r.owner_id AND o.id = r.new_object_id) " +
          "ORDER BY r.created_at LIMIT ?",
        owner,
        input.limit,
      )) {
        push(row, "repair_promoted");
      }
      // Every reservation that has not settled is listed; the caller (and `vaultRecoverCheck`) decides whether it is due:
      // expired by TTL, or its writer is provably gone. Reservations of live writers in this process are skipped by the
      // caller (their writer is not quiet), never deleted from under them.
      for (const row of all(
        "SELECT r.* FROM vault_reservations r WHERE r.owner_id = ? AND r.state IN ('reserved','written','promoted') " +
          "AND r.expires_at <= ? AND NOT EXISTS (SELECT 1 FROM vault_objects o WHERE o.owner_id = r.owner_id AND o.id = r.new_object_id) " +
          "ORDER BY r.expires_at LIMIT ?",
        owner,
        input.now,
        input.limit,
      )) {
        push(row, "expire");
      }
      for (const row of all(
        "SELECT r.* FROM vault_reservations r WHERE r.owner_id = ? AND r.state IN ('reserved','written','promoted') " +
          "AND r.expires_at > ? AND NOT EXISTS (SELECT 1 FROM vault_objects o WHERE o.owner_id = r.owner_id AND o.id = r.new_object_id) " +
          "AND EXISTS (SELECT 1 FROM process_incarnations p WHERE p.incarnation_id = r.writer_incarnation AND p.gone_at IS NOT NULL) " +
          "ORDER BY r.created_at LIMIT ?",
        owner,
        input.now,
        input.limit,
      )) {
        push(row, "expire");
      }
      for (const row of all(
        "SELECT r.* FROM vault_reservations r WHERE r.owner_id = ? AND r.state = 'committed' AND r.result_object_id <> r.new_object_id " +
          "ORDER BY r.updated_at DESC LIMIT ?",
        owner,
        input.limit,
      )) {
        push(row, "loser_cleanup");
      }
      return items;
    });

  /**
   * The last synchronous ownership check before any physical delete (design 5.2 recovery table). It deletes nothing and
   * writes nothing; the service deletes the returned keys (a missing file is success) and then calls the settle op.
   */
  const vaultRecoverCheck = (input: VaultRecoverCheckInput): VaultRecoverCheckOutcome =>
    transaction((): VaultRecoverCheckOutcome => {
      const owner = input.principal.ownerId;
      const row = reservationRow(owner, input.reservationId);
      if (!row) {
        return { outcome: "skip", reason: "not_found" };
      }
      const state = String(row.state) as VaultReservationState;
      const newObjectId = String(row.new_object_id);
      const hasObjectRow = objectRow(owner, newObjectId) !== undefined;
      if (state === "committed") {
        // Four conditions, all required: committed, result is a different object, no object row owns the file, writer quiet.
        if (str(row.result_object_id) === newObjectId) {
          return { outcome: "skip", reason: "state" };
        }
        if (hasObjectRow) {
          return { outcome: "skip", reason: "object_row_exists" };
        }
        if (!writerQuiet(row, input.quiet)) {
          return { outcome: "skip", reason: "writer_not_quiet" };
        }
        return {
          outcome: "delete",
          kind: "loser_cleanup",
          stagingKey: vaultStagingKey(String(row.id)),
          objectKey: vaultObjectKey(newObjectId),
        };
      }
      if (state === "promoted" && str(row.result_object_id) === null && hasObjectRow) {
        return { outcome: "repair", kind: "repair_promoted" };
      }
      if (state !== "reserved" && state !== "written" && state !== "promoted") {
        return { outcome: "skip", reason: "state" };
      }
      if (hasObjectRow) {
        return { outcome: "skip", reason: "object_row_exists" };
      }
      const expired = num(row.expires_at) <= input.now;
      if (!expired && !writerQuiet(row, input.quiet)) {
        return { outcome: "skip", reason: "not_due" };
      }
      if (!writerQuiet(row, input.quiet)) {
        return { outcome: "skip", reason: "writer_not_quiet" };
      }
      return {
        outcome: "delete",
        kind: "expire",
        stagingKey: vaultStagingKey(String(row.id)),
        // Always both keys: the rename can land before the state is recorded (crash between P's rename and markPromoted), so a
        // `written` reservation may already own `objects/<new_object_id>`. No object row exists (checked above), so it is ours.
        objectKey: vaultObjectKey(newObjectId),
      };
    });

  /** Second half of expire: the files are gone (or never existed), record it. Re-checks everything in the transaction. */
  const vaultReservationExpire = (
    input: VaultReservationExpireInput,
  ): VaultReservationExpireOutcome =>
    transaction((): VaultReservationExpireOutcome => {
      const owner = input.principal.ownerId;
      const row = reservationRow(owner, input.reservationId);
      if (!row) {
        return { outcome: "skip", reason: "not_found" };
      }
      const state = String(row.state) as VaultReservationState;
      if (state !== "reserved" && state !== "written" && state !== "promoted") {
        return { outcome: "noop", state };
      }
      if (objectRow(owner, String(row.new_object_id))) {
        return { outcome: "skip", reason: "object_row_exists" };
      }
      if (!writerQuiet(row, input.quiet)) {
        return { outcome: "skip", reason: "writer_not_quiet" };
      }
      if (num(row.expires_at) > input.now) {
        // Not expired by TTL: only a writer proven gone may abandon early.
        const gone = one(
          "SELECT 1 AS x FROM process_incarnations WHERE incarnation_id = ? AND gone_at IS NOT NULL",
          String(row.writer_incarnation),
        );
        if (!gone && !input.quiet.awaited) {
          return { outcome: "skip", reason: "not_due" };
        }
      }
      const changed = run(
        "UPDATE vault_reservations SET state = 'expired', updated_at = ? WHERE owner_id = ? AND id = ? AND state = ?",
        input.now,
        owner,
        input.reservationId,
        state,
      );
      return changed === 1 ? { outcome: "expired" } : { outcome: "noop", state };
    });

  /** Table row "promoted, object row exists, result empty": idempotent CAS, never a file delete. */
  const vaultRepairPromoted = (input: VaultRepairPromotedInput): VaultRepairPromotedOutcome =>
    transaction((): VaultRepairPromotedOutcome => {
      const owner = input.principal.ownerId;
      const row = reservationRow(owner, input.reservationId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const state = String(row.state) as VaultReservationState;
      if (state !== "promoted" || str(row.result_object_id) !== null) {
        return { outcome: "noop", state };
      }
      const object = objectRow(owner, String(row.new_object_id));
      if (!object) {
        return { outcome: "noop", state };
      }
      if (String(object.state) !== "live") {
        run(
          "UPDATE vault_reservations SET state = 'failed', updated_at = ? WHERE owner_id = ? AND id = ? AND state = 'promoted'",
          input.now,
          owner,
          input.reservationId,
        );
        return { outcome: "failed", reason: "object_not_live" };
      }
      if (
        String(object.content_hash) !== String(row.content_hash) ||
        num(object.size) !== num(row.byte_size)
      ) {
        run(
          "UPDATE vault_reservations SET state = 'failed', updated_at = ? WHERE owner_id = ? AND id = ? AND state = 'promoted'",
          input.now,
          owner,
          input.reservationId,
        );
        return { outcome: "failed", reason: "mismatch" };
      }
      run(
        "UPDATE vault_reservations SET state = 'committed', result_object_id = ?, updated_at = ? " +
          "WHERE owner_id = ? AND id = ? AND state = 'promoted' AND result_object_id IS NULL",
        String(object.id),
        input.now,
        owner,
        input.reservationId,
      );
      return { outcome: "committed" };
    });

  // ------------------------------------------------------------------ object reclaim

  const vaultReclaimCandidates = (input: VaultReclaimCandidatesInput): VaultReclaimCandidate[] =>
    transaction((): VaultReclaimCandidate[] => {
      const owner = input.principal.ownerId;
      const out: VaultReclaimCandidate[] = [];
      for (const row of all(
        "SELECT o.id, o.state, o.absence_verified_at FROM vault_objects o WHERE o.owner_id = ? AND (" +
          "(o.state = 'live' AND o.created_at <= ? AND NOT EXISTS (SELECT 1 FROM vault_versions v WHERE v.owner_id = o.owner_id AND v.object_id = o.id) " +
          "AND NOT EXISTS (SELECT 1 FROM vault_reservations r WHERE r.owner_id = o.owner_id AND r.id = o.reservation_id AND r.state IN ('reserved','written','promoted'))) " +
          "OR (o.state = 'reclaiming' AND o.reclaim_lease_until <= ?) " +
          "OR (o.state = 'deleted' AND o.absence_verified_at IS NULL)) ORDER BY o.created_at LIMIT ?",
        owner,
        input.now - input.graceMs,
        input.now,
        input.limit,
      )) {
        out.push({
          objectId: String(row.id),
          state: String(row.state) as VaultReclaimCandidate["state"],
          needsProof: String(row.state) === "deleted" && row.absence_verified_at === null,
        });
      }
      return out;
    });

  /** Claim is shared by the maintenance flow (`graceMs` > 0) and the purge flow (`graceMs` = 0). Cancels the object's jobs. */
  const claimReclaim = (
    owner: string,
    objectId: string,
    attemptId: string,
    now: number,
    leaseMs: number,
    graceMs: number,
  ): VaultReclaimClaimOutcome => {
    const object = objectRow(owner, objectId);
    if (!object) {
      return { outcome: "not_found" };
    }
    const state = String(object.state);
    if (state === "deleted") {
      return { outcome: "already_deleted", hasProof: object.absence_verified_at !== null };
    }
    if (versionRefs(owner, objectId) > 0) {
      return { outcome: "not_eligible", reason: "referenced" };
    }
    const claimed = (takeover: boolean): VaultReclaimClaimOutcome => ({
      outcome: "claimed",
      objectId,
      size: num(object.size),
      contentHash: String(object.content_hash),
      takeover,
    });
    if (state === "reclaiming") {
      const until = num(object.reclaim_lease_until);
      if (until > now) {
        return { outcome: "busy", leaseUntil: until };
      }
      const changed = run(
        "UPDATE vault_objects SET reclaim_attempt_id = ?, reclaim_lease_until = ?, updated_at = ? " +
          "WHERE owner_id = ? AND id = ? AND state = 'reclaiming' AND reclaim_attempt_id = ? AND reclaim_lease_until <= ?",
        attemptId,
        now + leaseMs,
        now,
        owner,
        objectId,
        String(object.reclaim_attempt_id),
        now,
      );
      return changed === 1 ? claimed(true) : { outcome: "busy", leaseUntil: now + leaseMs };
    }
    // live
    const reservation = reservationRow(owner, String(object.reservation_id));
    if (reservation && ["reserved", "written", "promoted"].includes(String(reservation.state))) {
      return { outcome: "not_eligible", reason: "reservation_open" };
    }
    if (num(object.created_at) > now - graceMs) {
      return { outcome: "not_eligible", reason: "grace" };
    }
    const changed = run(
      "UPDATE vault_objects SET state = 'reclaiming', reclaim_attempt_id = ?, reclaim_lease_until = ?, updated_at = ? " +
        "WHERE owner_id = ? AND id = ? AND state = 'live' " +
        "AND NOT EXISTS (SELECT 1 FROM vault_versions v WHERE v.owner_id = vault_objects.owner_id AND v.object_id = vault_objects.id)",
      attemptId,
      now + leaseMs,
      now,
      owner,
      objectId,
    );
    if (changed !== 1) {
      return { outcome: "not_eligible", reason: "referenced" };
    }
    // A reclaiming object takes no new work: cancel what is queued or running (the rows themselves go in the data purge).
    run(
      "UPDATE vault_jobs SET state = 'cancelled', updated_at = ? WHERE owner_id = ? AND object_id = ? AND state IN ('pending','running')",
      now,
      owner,
      objectId,
    );
    return claimed(false);
  };

  const vaultReclaimClaim = (input: VaultReclaimClaimInput): VaultReclaimClaimOutcome =>
    transaction(() =>
      claimReclaim(
        input.principal.ownerId,
        input.objectId,
        input.reclaimAttemptId,
        input.now,
        input.leaseMs,
        input.graceMs,
      ),
    );

  const ownsReclaim = (owner: string, objectId: string, attemptId: string): boolean => {
    const object = objectRow(owner, objectId);
    return (
      object !== undefined &&
      String(object.state) === "reclaiming" &&
      String(object.reclaim_attempt_id) === attemptId
    );
  };

  /** Deletes the object's derived text and job rows (text first: it references the jobs) and renews the lease. */
  const vaultReclaimPurgeData = (input: VaultReclaimDataInput): VaultReclaimDataOutcome =>
    transaction((): VaultReclaimDataOutcome => {
      const owner = input.principal.ownerId;
      if (!ownsReclaim(owner, input.objectId, input.reclaimAttemptId)) {
        return { outcome: "not_owner" };
      }
      run(
        "UPDATE vault_objects SET reclaim_lease_until = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND reclaim_attempt_id = ?",
        input.now + input.leaseMs,
        input.now,
        owner,
        input.objectId,
        input.reclaimAttemptId,
      );
      const pages = num(
        (
          one(
            "SELECT COUNT(*) AS c FROM vault_text WHERE owner_id = ? AND object_id = ?",
            owner,
            input.objectId,
          ) as Row
        ).c,
      );
      const jobs = num(
        (
          one(
            "SELECT COUNT(*) AS c FROM vault_jobs WHERE owner_id = ? AND object_id = ?",
            owner,
            input.objectId,
          ) as Row
        ).c,
      );
      run("DELETE FROM vault_text WHERE owner_id = ? AND object_id = ?", owner, input.objectId);
      run("DELETE FROM vault_jobs WHERE owner_id = ? AND object_id = ?", owner, input.objectId);
      if (input.purgeRef && pages > 0) {
        run(
          "UPDATE vault_purge_items SET text_pages = text_pages + ?, updated_at = ? " +
            "WHERE owner_id = ? AND file_id = ? AND purge_id = ? AND object_id = ?",
          pages,
          input.now,
          owner,
          input.purgeRef.fileId,
          input.purgeRef.purgeId,
          input.objectId,
        );
      }
      return { outcome: "ok", textPages: pages, jobs };
    });

  /** The bytes are confirmed absent (the service looked after deleting): reclaiming -> deleted, with the absence proof. */
  const vaultReclaimSettle = (input: VaultReclaimSettleInput): VaultReclaimSettleOutcome =>
    transaction((): VaultReclaimSettleOutcome => {
      const owner = input.principal.ownerId;
      if (!ownsReclaim(owner, input.objectId, input.reclaimAttemptId)) {
        return { outcome: "not_owner" };
      }
      if (versionRefs(owner, input.objectId) > 0) {
        return { outcome: "referenced" };
      }
      // Anything that slipped in meanwhile goes with it; a deleted object must not own text or jobs.
      run("DELETE FROM vault_text WHERE owner_id = ? AND object_id = ?", owner, input.objectId);
      run("DELETE FROM vault_jobs WHERE owner_id = ? AND object_id = ?", owner, input.objectId);
      const changed = run(
        "UPDATE vault_objects SET state = 'deleted', reclaim_attempt_id = NULL, reclaim_lease_until = NULL, " +
          "absence_verified_at = ?, absence_verified_attempt_id = ?, updated_at = ? " +
          "WHERE owner_id = ? AND id = ? AND state = 'reclaiming' AND reclaim_attempt_id = ?",
        input.now,
        input.reclaimAttemptId,
        input.now,
        owner,
        input.objectId,
        input.reclaimAttemptId,
      );
      return changed === 1 ? { outcome: "deleted" } : { outcome: "not_owner" };
    });

  /** Tombstone without a proof (backup restore, manual repair): the service checked the bytes are absent, record it. */
  const vaultAbsenceProof = (input: VaultAbsenceProofInput): VaultAbsenceProofOutcome =>
    transaction((): VaultAbsenceProofOutcome => {
      const owner = input.principal.ownerId;
      if (!objectRow(owner, input.objectId)) {
        return { outcome: "not_found" };
      }
      const changed = run(
        "UPDATE vault_objects SET absence_verified_at = ?, absence_verified_attempt_id = ?, updated_at = ? " +
          "WHERE owner_id = ? AND id = ? AND state = 'deleted' AND absence_verified_at IS NULL",
        input.now,
        input.attemptId,
        input.now,
        owner,
        input.objectId,
      );
      return changed === 1 ? { outcome: "proved" } : { outcome: "noop" };
    });

  // ------------------------------------------------------------------ tombstones and diagnostic reservations

  /**
   * Retire expired tombstones: the object row and every reservation that names it (its own reservation as `new_object_id`,
   * and reuse reservations through `result_object_id`) go in ONE transaction. Both foreign keys are deferred, so the
   * order inside the transaction does not matter; the commit sees no dangling reference.
   */
  const vaultRetireTombstones = (input: VaultRetireTombstonesInput): VaultRetireTombstonesResult =>
    transaction((): VaultRetireTombstonesResult => {
      const owner = input.principal.ownerId;
      let retired = 0;
      for (const row of all(
        "SELECT o.id FROM vault_objects o WHERE o.owner_id = ? AND o.state = 'deleted' AND o.absence_verified_at IS NOT NULL " +
          "AND o.absence_verified_at <= ? " +
          "AND NOT EXISTS (SELECT 1 FROM vault_versions v WHERE v.owner_id = o.owner_id AND v.object_id = o.id) " +
          "AND NOT EXISTS (SELECT 1 FROM vault_jobs j WHERE j.owner_id = o.owner_id AND j.object_id = o.id) " +
          "AND NOT EXISTS (SELECT 1 FROM vault_text t WHERE t.owner_id = o.owner_id AND t.object_id = o.id) " +
          "AND NOT EXISTS (SELECT 1 FROM vault_purge_items i WHERE i.owner_id = o.owner_id AND i.object_id = o.id) " +
          "AND NOT EXISTS (SELECT 1 FROM vault_files f WHERE f.owner_id = o.owner_id AND f.object_id = o.id) " +
          "ORDER BY o.absence_verified_at LIMIT ?",
        owner,
        input.now - input.retentionMs,
        input.limit,
      )) {
        const id = String(row.id);
        run("DELETE FROM vault_objects WHERE owner_id = ? AND id = ?", owner, id);
        run(
          "DELETE FROM vault_reservations WHERE owner_id = ? AND (result_object_id = ? OR new_object_id = ?)",
          owner,
          id,
          id,
        );
        retired += 1;
      }
      return { retired };
    });

  /** Diagnostic reservations (failed, expired, committed-with-reuse) are dropped after the retention period. */
  const vaultPruneReservations = (
    input: VaultPruneReservationsInput,
  ): VaultPruneReservationsResult =>
    transaction((): VaultPruneReservationsResult => {
      const owner = input.principal.ownerId;
      let pruned = 0;
      for (const row of all(
        "SELECT r.id FROM vault_reservations r WHERE r.owner_id = ? AND r.updated_at <= ? AND (" +
          "r.state IN ('failed','expired') OR (r.state = 'committed' AND r.result_object_id <> r.new_object_id)) " +
          "AND NOT EXISTS (SELECT 1 FROM vault_objects o WHERE o.owner_id = r.owner_id AND o.reservation_id = r.id) " +
          "ORDER BY r.updated_at LIMIT ?",
        owner,
        input.now - input.retentionMs,
        input.limit,
      )) {
        pruned += run(
          "DELETE FROM vault_reservations WHERE owner_id = ? AND id = ?",
          owner,
          String(row.id),
        );
      }
      return { pruned };
    });

  // ------------------------------------------------------------------ integrity

  /** Active / trashed files with the object each one points at, in id order, for the service's existence check. */
  const vaultVerifyBatch = (input: VaultVerifyBatchInput): VaultVerifyBatchResult =>
    transaction((): VaultVerifyBatchResult => {
      const owner = input.principal.ownerId;
      const rows = all(
        "SELECT f.id AS file_id, f.object_id, o.size, o.content_hash FROM vault_files f " +
          "JOIN vault_objects o ON o.owner_id = f.owner_id AND o.id = f.object_id " +
          "WHERE f.owner_id = ? AND f.state IN ('active','trashed') AND f.id > ? ORDER BY f.id LIMIT ?",
        owner,
        input.afterFileId ?? "",
        input.limit,
      );
      const items = rows.map((row) => ({
        fileId: String(row.file_id),
        objectId: String(row.object_id),
        size: num(row.size),
        contentHash: String(row.content_hash),
      }));
      return {
        items,
        nextCursor: items.length === input.limit ? (items[items.length - 1]?.fileId ?? null) : null,
      };
    });

  /** Never silent repair (design): a file whose bytes are gone becomes `damaged` and stays visible. */
  const vaultMarkDamaged = (input: VaultMarkDamagedInput): VaultMarkDamagedOutcome =>
    transaction((): VaultMarkDamagedOutcome => {
      const owner = input.principal.ownerId;
      const file = one(
        "SELECT state FROM vault_files WHERE owner_id = ? AND id = ?",
        owner,
        input.fileId,
      );
      if (!file) {
        return { outcome: "not_found" };
      }
      const changed = run(
        "UPDATE vault_files SET state = 'damaged', trashed_at = NULL, updated_at = ? " +
          "WHERE owner_id = ? AND id = ? AND state IN ('active','trashed')",
        input.now,
        owner,
        input.fileId,
      );
      return changed === 1 ? { outcome: "marked" } : { outcome: "noop", state: String(file.state) };
    });

  // ------------------------------------------------------------------ due work

  const vaultListDue = (input: VaultListDueInput): VaultListDueResult =>
    transaction((): VaultListDueResult => {
      const owner = input.principal.ownerId;
      const expiredInbox = all(
        "SELECT id FROM vault_files WHERE owner_id = ? AND collection = 'inbox' AND state = 'active' " +
          "AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?",
        owner,
        input.now,
        input.limit,
      ).map((row) => String(row.id));
      const trashedDue = all(
        "SELECT id FROM vault_files WHERE owner_id = ? AND state = 'trashed' AND trashed_at <= ? ORDER BY trashed_at LIMIT ?",
        owner,
        input.now - input.trashRetentionMs,
        input.limit,
      ).map((row) => String(row.id));
      return { expiredInbox, trashedDue };
    });

  // ------------------------------------------------------------------ hard purge: run lease protocol

  type RunOwnership = { ok: true; run: Row } | { ok: false; outcome: "not_owner" | "wrong_phase" };

  /**
   * Check and renew (design: "validate + renew before every phase and every batch of side effects"). `not_owner` when the
   * run is gone, the purge id differs or the holder is not this pass; `wrong_phase` when the phase is outside `phases`.
   * Everything that records a durable conclusion calls this at the START of its own transaction.
   */
  const ownRun = (
    owner: string,
    fileId: string,
    purgeId: string,
    attemptId: string,
    now: number,
    leaseMs: number,
    phases: readonly string[],
  ): RunOwnership => {
    const row = one(
      "SELECT * FROM vault_purge_runs WHERE owner_id = ? AND file_id = ? AND purge_id = ?",
      owner,
      fileId,
      purgeId,
    );
    if (!row || str(row.worker_attempt_id) !== attemptId) {
      return { ok: false, outcome: "not_owner" };
    }
    if (!phases.includes(String(row.phase))) {
      return { ok: false, outcome: "wrong_phase" };
    }
    run(
      "UPDATE vault_purge_runs SET worker_lease_until = ?, updated_at = ? " +
        "WHERE owner_id = ? AND file_id = ? AND purge_id = ? AND worker_attempt_id = ?",
      now + leaseMs,
      now,
      owner,
      fileId,
      purgeId,
      attemptId,
    );
    return { ok: true, run: row };
  };

  /** A random purge id that appears in neither the runs nor the receipts of this owner (design: purge_id contract). */
  const freshPurgeId = (owner: string): string => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `VPG_${newId("")}`;
      const seen =
        one(
          "SELECT 1 AS x FROM vault_purge_runs WHERE owner_id = ? AND purge_id = ?",
          owner,
          candidate,
        ) ??
        one(
          "SELECT 1 AS x FROM vault_purge_receipts WHERE owner_id = ? AND purge_id = ?",
          owner,
          candidate,
        );
      if (!seen) {
        return candidate;
      }
    }
    throw new Error("could not allocate a unique vault purge id");
  };

  const vaultPurgeBegin = (input: VaultPurgeBeginInput): VaultPurgeBeginOutcome =>
    transaction((): VaultPurgeBeginOutcome => {
      const owner = input.principal.ownerId;
      const file = one(
        "SELECT state FROM vault_files WHERE owner_id = ? AND id = ?",
        owner,
        input.fileId,
      );
      if (!file) {
        return { outcome: "not_found" };
      }
      const state = String(file.state);
      const existing = one(
        "SELECT * FROM vault_purge_runs WHERE owner_id = ? AND file_id = ?",
        owner,
        input.fileId,
      );
      if (existing) {
        const holder = str(existing.worker_attempt_id);
        const until = existing.worker_lease_until === null ? 0 : num(existing.worker_lease_until);
        if (holder !== null && holder !== input.workerAttemptId && until > input.now) {
          return {
            outcome: "worker_active",
            purgeId: String(existing.purge_id),
            requestedBy: String(existing.requested_by),
            leaseUntil: until,
          };
        }
        const changed = run(
          "UPDATE vault_purge_runs SET worker_attempt_id = ?, worker_lease_until = ?, updated_at = ? " +
            "WHERE owner_id = ? AND file_id = ? AND purge_id = ?",
          input.workerAttemptId,
          input.now + input.leaseMs,
          input.now,
          owner,
          input.fileId,
          String(existing.purge_id),
        );
        if (changed !== 1) {
          return {
            outcome: "worker_active",
            purgeId: String(existing.purge_id),
            requestedBy: String(existing.requested_by),
            leaseUntil: input.now + input.leaseMs,
          };
        }
        return {
          outcome: "resumed",
          purgeId: String(existing.purge_id),
          requestedBy: String(existing.requested_by),
          phase: String(existing.phase) as "sealed" | "items_recorded",
        };
      }
      if (state === "purging") {
        // A purging file with no run is an invariant break; refuse rather than invent a requester.
        return { outcome: "invalid_state", state };
      }
      const sealed = run(
        "UPDATE vault_files SET state = 'purging', trashed_at = NULL, expires_at = NULL, updated_at = ? " +
          "WHERE owner_id = ? AND id = ? AND state IN ('active','trashed','damaged')",
        input.now,
        owner,
        input.fileId,
      );
      if (sealed !== 1) {
        return { outcome: "invalid_state", state };
      }
      const purgeId = freshPurgeId(owner);
      run(
        "INSERT INTO vault_purge_runs (owner_id, file_id, purge_id, requested_by, requested_at, phase, item_count, version_count, " +
          "worker_attempt_id, worker_lease_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'sealed', NULL, NULL, ?, ?, ?, ?)",
        owner,
        input.fileId,
        purgeId,
        input.requestedBy,
        input.now,
        input.workerAttemptId,
        input.now + input.leaseMs,
        input.now,
        input.now,
      );
      run("DELETE FROM vault_links WHERE owner_id = ? AND file_id = ?", owner, input.fileId);
      run("DELETE FROM vault_user_state WHERE owner_id = ? AND file_id = ?", owner, input.fileId);
      hooks.detachFile(owner, input.fileId);
      return { outcome: "started", purgeId, requestedBy: input.requestedBy, phase: "sealed" };
    });

  /**
   * Transaction 2: one work item per DISTINCT physical object (versions of one file may share an object), counted before
   * the version rows are released. All-or-nothing, so there is no state with versions gone and items missing.
   */
  const vaultPurgeRecordItems = (input: VaultPurgeRecordItemsInput): VaultPurgeRecordItemsOutcome =>
    transaction((): VaultPurgeRecordItemsOutcome => {
      const owner = input.principal.ownerId;
      const own = ownRun(
        owner,
        input.fileId,
        input.purgeId,
        input.workerAttemptId,
        input.now,
        input.leaseMs,
        ["sealed", "items_recorded"],
      );
      if (!own.ok) {
        return { outcome: "not_owner" };
      }
      if (String(own.run.phase) === "items_recorded") {
        return {
          outcome: "recorded",
          itemCount: num(own.run.item_count),
          versionCount: num(own.run.version_count),
        };
      }
      const versionCount = num(
        (
          one(
            "SELECT COUNT(*) AS c FROM vault_versions WHERE owner_id = ? AND file_id = ?",
            owner,
            input.fileId,
          ) as Row
        ).c,
      );
      run(
        "INSERT INTO vault_purge_items (owner_id, file_id, purge_id, object_id, state, absence_proof_attempt_id, text_pages, created_at, updated_at) " +
          "SELECT ?, ?, ?, object_id, 'pending', NULL, 0, ?, ? FROM (SELECT DISTINCT object_id FROM vault_versions WHERE owner_id = ? AND file_id = ?) WHERE true " +
          "ON CONFLICT (owner_id, file_id, object_id) DO NOTHING",
        owner,
        input.fileId,
        input.purgeId,
        input.now,
        input.now,
        owner,
        input.fileId,
      );
      const itemCount = num(
        (
          one(
            "SELECT COUNT(*) AS c FROM vault_purge_items WHERE owner_id = ? AND file_id = ? AND purge_id = ?",
            owner,
            input.fileId,
            input.purgeId,
          ) as Row
        ).c,
      );
      run("DELETE FROM vault_versions WHERE owner_id = ? AND file_id = ?", owner, input.fileId);
      run(
        "UPDATE vault_purge_runs SET phase = 'items_recorded', item_count = ?, version_count = ?, updated_at = ? " +
          "WHERE owner_id = ? AND file_id = ? AND purge_id = ? AND worker_attempt_id = ?",
        itemCount,
        versionCount,
        input.now,
        owner,
        input.fileId,
        input.purgeId,
        input.workerAttemptId,
      );
      return { outcome: "recorded", itemCount, versionCount };
    });

  const vaultPurgeItems = (input: VaultPurgeItemsInput): VaultPurgeItemsOutcome =>
    transaction((): VaultPurgeItemsOutcome => {
      const owner = input.principal.ownerId;
      const own = ownRun(
        owner,
        input.fileId,
        input.purgeId,
        input.workerAttemptId,
        input.now,
        input.leaseMs,
        ["sealed", "items_recorded"],
      );
      if (!own.ok) {
        return { outcome: own.outcome };
      }
      if (String(own.run.phase) !== "items_recorded") {
        return { outcome: "wrong_phase" };
      }
      return {
        outcome: "ok",
        items: all(
          "SELECT object_id, state FROM vault_purge_items WHERE owner_id = ? AND file_id = ? AND purge_id = ? ORDER BY object_id",
          owner,
          input.fileId,
          input.purgeId,
        ).map((row) => ({
          objectId: String(row.object_id),
          state: String(row.state) as VaultPurgeItemState,
        })),
      };
    });

  /** The complete per-item evaluation table (design 5.3 step 3); any other combination is an invariant break. */
  const vaultPurgeEvaluateItem = (input: VaultPurgeEvaluateInput): VaultPurgeEvaluateOutcome =>
    transaction((): VaultPurgeEvaluateOutcome => {
      const owner = input.principal.ownerId;
      const own = ownRun(
        owner,
        input.fileId,
        input.purgeId,
        input.workerAttemptId,
        input.now,
        input.leaseMs,
        ["sealed", "items_recorded"],
      );
      if (!own.ok) {
        return { outcome: own.outcome };
      }
      if (String(own.run.phase) !== "items_recorded") {
        return { outcome: "wrong_phase" };
      }
      const item = one(
        "SELECT * FROM vault_purge_items WHERE owner_id = ? AND file_id = ? AND purge_id = ? AND object_id = ?",
        owner,
        input.fileId,
        input.purgeId,
        input.objectId,
      );
      const object = objectRow(owner, input.objectId);
      if (!item || !object) {
        return { outcome: "not_found" };
      }
      const setItem = (state: VaultPurgeItemState, proof: string | null): void => {
        run(
          "UPDATE vault_purge_items SET state = ?, absence_proof_attempt_id = ?, updated_at = ? " +
            "WHERE owner_id = ? AND file_id = ? AND purge_id = ? AND object_id = ?",
          state,
          proof,
          input.now,
          owner,
          input.fileId,
          input.purgeId,
          input.objectId,
        );
      };
      const refs = versionRefs(owner, input.objectId);
      const state = String(object.state);
      if (refs > 0) {
        if (state === "live") {
          setItem("retained_shared", null);
          return { outcome: "retained_shared" };
        }
        setItem("cleanup_pending", null);
        return { outcome: "cleanup_pending" };
      }
      if (state === "deleted") {
        if (object.absence_verified_at !== null) {
          setItem("verified_gone", String(object.absence_verified_attempt_id));
          return { outcome: "verified_gone" };
        }
        setItem("pending", null);
        return { outcome: "needs_proof" };
      }
      // refs = 0, live or reclaiming: claim (or take over) the reclaim; the grace period does not apply to a purge.
      const claim = claimReclaim(
        owner,
        input.objectId,
        input.reclaimAttemptId,
        input.now,
        input.leaseMs,
        0,
      );
      setItem("pending", null);
      if (claim.outcome === "claimed") {
        return { outcome: "reclaim_claimed", reclaimAttemptId: input.reclaimAttemptId };
      }
      if (claim.outcome === "busy") {
        return { outcome: "waiting", leaseUntil: claim.leaseUntil };
      }
      return { outcome: "waiting", leaseUntil: input.now + input.leaseMs };
    });

  /** P5: the terminal gate. Re-reads the run, the items, the objects and the Goals relation before it writes a receipt. */
  const vaultPurgeFinish = (input: VaultPurgeFinishInput): VaultPurgeFinishOutcome =>
    transaction((): VaultPurgeFinishOutcome => {
      const owner = input.principal.ownerId;
      const own = ownRun(
        owner,
        input.fileId,
        input.purgeId,
        input.workerAttemptId,
        input.now,
        input.leaseMs,
        ["sealed", "items_recorded"],
      );
      if (!own.ok) {
        return { outcome: own.outcome };
      }
      const runRow = own.run;
      if (String(runRow.phase) !== "items_recorded" || runRow.item_count === null) {
        return { outcome: "not_ready", reason: "wrong_phase" };
      }
      const items = all(
        "SELECT object_id, state, absence_proof_attempt_id FROM vault_purge_items WHERE owner_id = ? AND file_id = ? AND purge_id = ?",
        owner,
        input.fileId,
        input.purgeId,
      );
      if (items.length !== num(runRow.item_count)) {
        return { outcome: "not_ready", reason: "item_count" };
      }
      const leftVersions = num(
        (
          one(
            "SELECT COUNT(*) AS c FROM vault_versions WHERE owner_id = ? AND file_id = ?",
            owner,
            input.fileId,
          ) as Row
        ).c,
      );
      if (leftVersions > 0) {
        return { outcome: "not_ready", reason: "versions_remain" };
      }
      let reevaluate = false;
      let pending = 0;
      let cleanup = 0;
      let retained = 0;
      const gone: string[] = [];
      for (const item of items) {
        const objectId = String(item.object_id);
        const object = objectRow(owner, objectId);
        const itemState = String(item.state);
        const back = (): void => {
          run(
            "UPDATE vault_purge_items SET state = 'pending', absence_proof_attempt_id = NULL, updated_at = ? " +
              "WHERE owner_id = ? AND file_id = ? AND purge_id = ? AND object_id = ?",
            input.now,
            owner,
            input.fileId,
            input.purgeId,
            objectId,
          );
          reevaluate = true;
        };
        if (itemState === "pending") {
          pending += 1;
        } else if (itemState === "cleanup_pending") {
          cleanup += 1;
        } else if (itemState === "retained_shared") {
          if (object && String(object.state) === "live" && versionRefs(owner, objectId) > 0) {
            retained += 1;
          } else {
            back();
          }
        } else if (itemState === "verified_gone") {
          if (
            object &&
            String(object.state) === "deleted" &&
            object.absence_verified_at !== null &&
            String(object.absence_verified_attempt_id) === String(item.absence_proof_attempt_id)
          ) {
            gone.push(String(object.content_hash));
          } else {
            back();
          }
        }
      }
      if (reevaluate) {
        return { outcome: "not_ready", reason: "reevaluate" };
      }
      if (pending > 0) {
        return { outcome: "not_ready", reason: "pending" };
      }
      if (cleanup > 0) {
        return { outcome: "cleanup_pending", count: cleanup };
      }
      if (hooks.fileHasGoalLinks(owner, input.fileId)) {
        return { outcome: "not_ready", reason: "goal_links" };
      }
      const textPages = num(
        (
          one(
            "SELECT COALESCE(SUM(text_pages), 0) AS s FROM vault_purge_items WHERE owner_id = ? AND file_id = ? AND purge_id = ?",
            owner,
            input.fileId,
            input.purgeId,
          ) as Row
        ).s,
      );
      const receiptId = `VPR_${newId("")}`;
      run(
        "INSERT INTO vault_purge_receipts (owner_id, id, purge_id, file_id_hash, content_hashes_json, retained_object_count, version_count, " +
          "text_page_count, requested_by, executed_at, compacted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        owner,
        receiptId,
        input.purgeId,
        vaultReceiptFileHash(owner, input.fileId),
        JSON.stringify([...new Set(gone)].toSorted()),
        retained,
        num(runRow.version_count),
        textPages,
        String(runRow.requested_by),
        input.now,
      );
      run(
        "DELETE FROM vault_purge_items WHERE owner_id = ? AND file_id = ? AND purge_id = ?",
        owner,
        input.fileId,
        input.purgeId,
      );
      run(
        "DELETE FROM vault_purge_runs WHERE owner_id = ? AND file_id = ? AND purge_id = ?",
        owner,
        input.fileId,
        input.purgeId,
      );
      run("DELETE FROM vault_files WHERE owner_id = ? AND id = ?", owner, input.fileId);
      return { outcome: "completed", receiptId };
    });

  /** Conditional release: only the holder of this pass clears the lease. A finished run is already gone with the receipt. */
  const vaultPurgeRelease = (input: VaultPurgeReleaseInput): { released: boolean } =>
    transaction(() => ({
      released:
        run(
          "UPDATE vault_purge_runs SET worker_attempt_id = NULL, worker_lease_until = NULL " +
            "WHERE owner_id = ? AND file_id = ? AND purge_id = ? AND worker_attempt_id = ?",
          input.principal.ownerId,
          input.fileId,
          input.purgeId,
          input.workerAttemptId,
        ) === 1,
    }));

  const toReceipt = (row: Row): VaultPurgeReceipt => {
    const compacted = row.compacted_at !== null;
    return {
      id: String(row.id),
      purgeId: String(row.purge_id),
      requestedBy: String(row.requested_by),
      executedAt: num(row.executed_at),
      retainedObjectCount: num(row.retained_object_count),
      versionCount: num(row.version_count),
      textPageCount: num(row.text_page_count),
      compacted,
      fileIdHash: compacted ? null : String(row.file_id_hash),
      contentHashes: compacted ? null : (JSON.parse(String(row.content_hashes_json)) as string[]),
    };
  };

  /** Read-only: never claims, never advances. A file that is gone is answered from its receipt only by purge id. */
  const vaultPurgeStatus = (input: VaultPurgeStatusInput): VaultPurgeStatus =>
    transaction((): VaultPurgeStatus => {
      const owner = input.principal.ownerId;
      const row = one(
        "SELECT * FROM vault_purge_runs WHERE owner_id = ? AND file_id = ?",
        owner,
        input.fileId,
      );
      if (row) {
        const items: Record<VaultPurgeItemState, number> = {
          pending: 0,
          verified_gone: 0,
          retained_shared: 0,
          cleanup_pending: 0,
        };
        for (const item of all(
          "SELECT state, COUNT(*) AS c FROM vault_purge_items WHERE owner_id = ? AND file_id = ? AND purge_id = ? GROUP BY state",
          owner,
          input.fileId,
          String(row.purge_id),
        )) {
          items[String(item.state) as VaultPurgeItemState] = num(item.c);
        }
        return {
          outcome: "running",
          purgeId: String(row.purge_id),
          requestedBy: String(row.requested_by),
          phase: String(row.phase) as "sealed" | "items_recorded",
          itemCount: row.item_count === null ? null : num(row.item_count),
          versionCount: row.version_count === null ? null : num(row.version_count),
          items,
          workerActive: row.worker_attempt_id !== null,
        };
      }
      const receipt = one(
        "SELECT * FROM vault_purge_receipts WHERE owner_id = ? AND file_id_hash = ?",
        owner,
        vaultReceiptFileHash(owner, input.fileId),
      );
      return receipt ? { outcome: "completed", receipt: toReceipt(receipt) } : { outcome: "none" };
    });

  const vaultPurgeReceipts = (input: VaultPurgeReceiptsInput): VaultPurgeReceiptsResult =>
    transaction((): VaultPurgeReceiptsResult => {
      const owner = input.principal.ownerId;
      const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
      const rows = input.purgeId
        ? all(
            "SELECT * FROM vault_purge_receipts WHERE owner_id = ? AND purge_id = ? ORDER BY executed_at DESC LIMIT ?",
            owner,
            input.purgeId,
            limit,
          )
        : all(
            "SELECT * FROM vault_purge_receipts WHERE owner_id = ? ORDER BY executed_at DESC LIMIT ?",
            owner,
            limit,
          );
      return { receipts: rows.map(toReceipt) };
    });

  /** Runs nobody drives right now: the maintenance task picks these up and goes through `vaultPurgeBegin` (resume). */
  const vaultPurgeListRuns = (input: VaultPurgeListRunsInput): VaultPurgeListRunsResult =>
    transaction((): VaultPurgeListRunsResult => ({
      runs: all(
        "SELECT file_id, purge_id, phase FROM vault_purge_runs WHERE owner_id = ? AND " +
          "(worker_attempt_id IS NULL OR worker_lease_until <= ?) ORDER BY created_at LIMIT ?",
        input.principal.ownerId,
        input.now,
        input.limit,
      ).map((row) => ({
        fileId: String(row.file_id),
        purgeId: String(row.purge_id),
        phase: String(row.phase) as "sealed" | "items_recorded",
      })),
    }));

  /** One UPDATE: only the two hash columns go; the row, its counts and its audit fields stay forever. */
  const vaultCompactReceipts = (input: VaultCompactReceiptsInput): VaultCompactReceiptsResult =>
    transaction(() => ({
      compacted: run(
        "UPDATE vault_purge_receipts SET file_id_hash = NULL, content_hashes_json = NULL, compacted_at = ? " +
          "WHERE owner_id = ? AND compacted_at IS NULL AND executed_at < ?",
        input.now,
        input.principal.ownerId,
        input.now - input.retentionMs,
      ),
    }));

  return {
    vaultListRecoverable,
    vaultRecoverCheck,
    vaultReservationExpire,
    vaultRepairPromoted,
    vaultReclaimCandidates,
    vaultReclaimClaim,
    vaultReclaimPurgeData,
    vaultReclaimSettle,
    vaultAbsenceProof,
    vaultRetireTombstones,
    vaultPruneReservations,
    vaultListDue,
    vaultVerifyBatch,
    vaultMarkDamaged,
    vaultPurgeBegin,
    vaultPurgeRecordItems,
    vaultPurgeItems,
    vaultPurgeEvaluateItem,
    vaultPurgeFinish,
    vaultPurgeRelease,
    vaultPurgeStatus,
    vaultPurgeReceipts,
    vaultPurgeListRuns,
    vaultCompactReceipts,
  };
}

export type VaultMaintenanceLedger = ReturnType<typeof createVaultMaintenanceLedger>;
