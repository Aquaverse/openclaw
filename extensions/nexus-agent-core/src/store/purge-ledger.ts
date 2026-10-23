import { asText } from "../as-text.js";
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
// Purge kernel (DESIGN section 9.4, P1-P5) plus single-evidence deletion and the incarnation_gone settle. Runs inside the
// SQLite worker, so every method is ONE synchronous transaction; the byte I/O between them is done by the service
// (src/purge/purge-service.ts), which only ever passes the plain objects in purge-types.ts / blob-types.ts back and forth.
//
// The run is persistent (`purge_runs`): one Task has exactly one run and one `purge_id` for its whole life, a retry continues
// the same run, and `worker_attempt_id` (who is driving) is a different thing from `purge_id` (which purge this is).
//   P1 purgeBegin               Task -> `purging` + run, in one transaction
//   P2 purgeClaimReservations   claim every unsettled reservation (CAS, same machinery as GC) and record a work item per
//      purgeAdvanceReservations physical object the Task ever touched; advance only when no reservation is open
//   P3 purgeSealWorkset         copy the Task's evidence references into work items, release them, seal the run
//   P4 purgeClassify            re-count references per item, hand out reclaim / tombstone work, record verified items
//   P5 purgeFinalize            re-read EVERYTHING, then destroy the ledger in FK order and write the receipt
import { sha256Hex } from "../canonical.js";
import type { BlobGcItem } from "./blob-types.js";
import type { ClaimLedger } from "./claim-ledger.js";
import type { TransactionRunner } from "./kernel.js";
import type {
  EvidenceDeleteInput,
  EvidenceDeleteOutcome,
  IncarnationSettleInput,
  IncarnationSettleOutcome,
  PurgeAdvanceReservationsOutcome,
  PurgeBeginInput,
  PurgeBeginOutcome,
  PurgeBusyReason,
  PurgeCleanupBlocker,
  PurgeClaimReservationsInput,
  PurgeClaimReservationsOutcome,
  PurgeClassifyInput,
  PurgeClassifyOutcome,
  PurgeFinalizeInput,
  PurgeFinalizeOutcome,
  PurgePhase,
  PurgeRunRef,
  PurgeReceiptRow,
  PurgeRunSummary,
  PurgeSealOutcome,
  PurgeStatus,
  PurgeTombstoneItem,
} from "./purge-types.js";
import type { Principal } from "./types.js";

type Row = Record<string, unknown>;

export function createPurgeLedger(
  transaction: TransactionRunner,
  internals: ClaimLedger["internals"],
) {
  const { one, all, run, newId } = internals;

  const count = (sql: string, ...params: (string | number | null)[]): number =>
    Number((one(sql, ...params) as Row).c);

  /** Authoritative reference count (DESIGN 9.4): evidence.blob_key, never content_hash and never ref_count. */
  const authoritativeRefs = (owner: string, blobKey: string): number =>
    count("SELECT COUNT(*) AS c FROM evidence WHERE owner_id = ? AND blob_key = ?", owner, blobKey);

  const runRow = (owner: string, taskId: string): Row | undefined =>
    one("SELECT * FROM purge_runs WHERE owner_id = ? AND task_id = ?", owner, taskId);

  const phaseOf = (row: Row): PurgePhase => String(row.phase) as PurgePhase;

  /**
   * The run exists, is the same purge, and THIS pass is the one driving it (a pass that lost the lease finds a different
   * `worker_attempt_id` and stops). Extends the lease on success.
   */
  const ownRun = (
    ref: PurgeRunRef,
    phases: PurgePhase[],
  ):
    | { ok: true; run: Row }
    | {
        ok: false;
        fail: { outcome: "not_owner" } | { outcome: "wrong_phase"; phase: PurgePhase };
      } => {
    const owner = ref.principal.ownerId;
    const row = runRow(owner, ref.taskId);
    if (
      !row ||
      String(row.purge_id) !== ref.purgeId ||
      row.worker_attempt_id === null ||
      asText(row.worker_attempt_id) !== ref.workerAttemptId
    ) {
      return { ok: false, fail: { outcome: "not_owner" } };
    }
    if (!phases.includes(phaseOf(row))) {
      return { ok: false, fail: { outcome: "wrong_phase", phase: phaseOf(row) } };
    }
    run(
      "UPDATE purge_runs SET worker_lease_until = ?, updated_at = ? WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND worker_attempt_id = ?",
      ref.now + ref.workerLeaseMs,
      ref.now,
      owner,
      ref.taskId,
      ref.purgeId,
      ref.workerAttemptId,
    );
    return { ok: true, run: row };
  };

  const objectByKey = (owner: string, blobKey: string): Row | undefined =>
    one("SELECT * FROM blob_objects WHERE owner_id = ? AND blob_key = ?", owner, blobKey);

  // ------------------------------------------------------------------ P1

  const busyReasons = (owner: string, taskId: string): PurgeBusyReason[] => {
    const reasons: PurgeBusyReason[] = [];
    const executions = (state: string) =>
      count(
        "SELECT COUNT(*) AS c FROM action_executions WHERE owner_id = ? AND task_id = ? AND state = ?",
        owner,
        taskId,
        state,
      );
    if (executions("executing") > 0) {
      reasons.push("execution_in_flight");
    }
    if (executions("unknown") > 0) {
      reasons.push("execution_unsettled");
    }
    if (executions("prepared") > 0) {
      reasons.push("execution_approved_uncommitted");
    }
    if (
      count(
        "SELECT COUNT(*) AS c FROM decisions WHERE owner_id = ? AND task_id = ? AND status = 'pending'",
        owner,
        taskId,
      ) > 0
    ) {
      reasons.push("decision_pending");
    }
    return reasons;
  };

  const purgeBegin = (input: PurgeBeginInput): PurgeBeginOutcome =>
    transaction((): PurgeBeginOutcome => {
      const owner = input.principal.ownerId;
      const task = one(
        "SELECT id, status FROM nexus_tasks WHERE owner_id = ? AND id = ?",
        owner,
        input.taskId,
      );
      if (!task) {
        return { outcome: "not_found" };
      }
      const existing = runRow(owner, input.taskId);
      if (existing) {
        const holder = existing.worker_attempt_id as string | null;
        const until =
          existing.worker_lease_until === null ? 0 : Number(existing.worker_lease_until);
        if (holder !== null && holder !== input.workerAttemptId && until > input.now) {
          return {
            outcome: "worker_active",
            purgeId: String(existing.purge_id),
            leaseUntil: until,
          };
        }
        // Take the run over: a new attempt continues the SAME purge_id (DESIGN 9.4, v0.12j).
        run(
          "UPDATE purge_runs SET worker_attempt_id = ?, worker_lease_until = ?, updated_at = ? WHERE owner_id = ? AND task_id = ?",
          input.workerAttemptId,
          input.now + input.workerLeaseMs,
          input.now,
          owner,
          input.taskId,
        );
        return { outcome: "resumed", purgeId: String(existing.purge_id), phase: phaseOf(existing) };
      }
      const reasons = busyReasons(owner, input.taskId);
      if (reasons.length > 0) {
        return { outcome: "task_busy", reasons };
      }
      const purgeId = newId("PG");
      run(
        "UPDATE nexus_tasks SET status = 'purging', revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
        input.now,
        owner,
        input.taskId,
      );
      run(
        "INSERT INTO purge_runs (owner_id, task_id, purge_id, phase, worker_attempt_id, worker_lease_until, created_at, updated_at) " +
          "VALUES (?, ?, ?, 'sealed', ?, ?, ?, ?)",
        owner,
        input.taskId,
        purgeId,
        input.workerAttemptId,
        input.now + input.workerLeaseMs,
        input.now,
        input.now,
      );
      return { outcome: "started", purgeId, phase: "sealed" };
    });

  // ------------------------------------------------------------------ P2

  /**
   * One work item per PHYSICAL OBJECT the Task ever reserved (DISTINCT: an object can have several historical reservations
   * while the key is per object). Idempotent, and only ever called while the run is still `sealed`.
   */
  const writeReservationWorkItems = (
    owner: string,
    taskId: string,
    purgeId: string,
    now: number,
  ): number =>
    run(
      "INSERT INTO purge_work_items (owner_id, task_id, purge_id, content_hash, generation, blob_key, source_kind, refs_released, " +
        "disposition, state, created_at, updated_at) " +
        "SELECT DISTINCT r.owner_id, r.task_id, ?, o.content_hash, o.generation, o.blob_key, 'reservation', 0, 'reclaim_pending', 'pending', ?, ? " +
        "FROM blob_reservations r JOIN blob_objects o ON o.owner_id = r.owner_id AND o.content_hash = r.content_hash AND o.generation = r.generation " +
        "WHERE r.owner_id = ? AND r.task_id = ? " +
        "ON CONFLICT(owner_id, task_id, purge_id, blob_key) DO NOTHING",
      purgeId,
      now,
      now,
      owner,
      taskId,
    );

  const purgeClaimReservations = (
    input: PurgeClaimReservationsInput,
  ): PurgeClaimReservationsOutcome =>
    transaction((): PurgeClaimReservationsOutcome => {
      const owner = input.principal.ownerId;
      const own = ownRun(input, ["sealed"]);
      if (!own.ok) {
        return own.fail;
      }
      const items: BlobGcItem[] = [];
      let heldByOthers = 0;
      let sequence = 0;
      const leaseUntil = input.now + input.leases.reclaimLeaseMs;
      for (const reservation of all(
        "SELECT * FROM blob_reservations WHERE owner_id = ? AND task_id = ? AND state IN ('reserved','reclaiming') ORDER BY created_at",
        owner,
        input.taskId,
      )) {
        if (String(reservation.state) === "reclaiming") {
          // Claimed by GC (or by an earlier pass of this purge that crashed): its lease is taken over by maintenance.
          heldByOthers += 1;
          continue;
        }
        const object = one(
          "SELECT * FROM blob_objects WHERE owner_id = ? AND content_hash = ? AND generation = ?",
          owner,
          String(reservation.content_hash),
          Number(reservation.generation),
        ) as Row;
        if (String(object.state) === "deleted") {
          run(
            "UPDATE blob_reservations SET state = 'abandoned', updated_at = ? WHERE owner_id = ? AND id = ? AND state = 'reserved'",
            input.now,
            owner,
            String(reservation.id),
          );
          continue;
        }
        if (String(object.state) !== "writing") {
          continue;
        }
        // Unlike GC there is no expiry to wait for: the Task is being destroyed, so a stage B that is still running must
        // LOSE. The byte delete still waits for the writer to settle before any absence proof is signed (service side).
        const attempt = `${input.workerAttemptId}:r${(sequence += 1)}`;
        if (
          run(
            "UPDATE blob_reservations SET state = 'reclaiming', reclaim_attempt_id = ?, reclaim_lease_until = ?, updated_at = ? " +
              "WHERE owner_id = ? AND id = ? AND state = 'reserved'",
            attempt,
            leaseUntil,
            input.now,
            owner,
            String(reservation.id),
          ) !== 1
        ) {
          continue;
        }
        if (
          run(
            "UPDATE blob_objects SET state = 'reclaiming', reclaim_attempt_id = ?, reclaim_lease_until = ?, " +
              "settled_writer_attempt_id = writer_attempt_id, settled_writer_incarnation = writer_incarnation, " +
              "writer_attempt_id = NULL, writer_lease_until = NULL, writer_incarnation = NULL, updated_at = ? " +
              "WHERE owner_id = ? AND content_hash = ? AND generation = ? AND state = 'writing' AND writer_attempt_id = ?",
            attempt,
            leaseUntil,
            input.now,
            owner,
            String(object.content_hash),
            Number(object.generation),
            String(object.writer_attempt_id),
          ) !== 1
        ) {
          throw new Error("purgeClaimReservations: object CAS lost after the reservation CAS");
        }
        items.push({
          contentHash: String(object.content_hash),
          generation: Number(object.generation),
          blobKey: String(object.blob_key),
          byteSize: Number(object.byte_size),
          objectAttemptId: attempt,
          reservationId: String(reservation.id),
          reservationAttemptId: attempt,
          writerAttemptId: String(object.writer_attempt_id),
          writerIncarnation: String(object.writer_incarnation),
        });
      }
      const workItemsWritten = writeReservationWorkItems(
        owner,
        input.taskId,
        input.purgeId,
        input.now,
      );
      return { outcome: "claimed", items, heldByOthers, workItemsWritten };
    });

  const purgeAdvanceReservations = (input: PurgeRunRef): PurgeAdvanceReservationsOutcome =>
    transaction((): PurgeAdvanceReservationsOutcome => {
      const owner = input.principal.ownerId;
      const own = ownRun(input, ["sealed", "reservations_settled"]);
      if (!own.ok) {
        return own.fail;
      }
      if (phaseOf(own.run) === "reservations_settled") {
        return { outcome: "advanced" };
      }
      // Idempotent: covers reservations GC settled between our claim and now, so no object is missing from the workset.
      writeReservationWorkItems(owner, input.taskId, input.purgeId, input.now);
      const reserved = count(
        "SELECT COUNT(*) AS c FROM blob_reservations WHERE owner_id = ? AND task_id = ? AND state = 'reserved'",
        owner,
        input.taskId,
      );
      const reclaiming = count(
        "SELECT COUNT(*) AS c FROM blob_reservations WHERE owner_id = ? AND task_id = ? AND state = 'reclaiming'",
        owner,
        input.taskId,
      );
      if (reserved + reclaiming > 0) {
        return { outcome: "waiting", reserved, reclaiming };
      }
      run(
        "UPDATE purge_runs SET phase = 'reservations_settled', updated_at = ? WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND phase = 'sealed'",
        input.now,
        owner,
        input.taskId,
        input.purgeId,
      );
      return { outcome: "advanced" };
    });

  // ------------------------------------------------------------------ P3

  const purgeSealWorkset = (input: PurgeRunRef): PurgeSealOutcome =>
    transaction((): PurgeSealOutcome => {
      const owner = input.principal.ownerId;
      const own = ownRun(input, ["reservations_settled", "workset_sealed"]);
      if (!own.ok) {
        return own.fail;
      }
      if (phaseOf(own.run) === "workset_sealed") {
        // Never re-derive the workset from evidence: its blob_key is gone by now.
        return { outcome: "already_sealed", workItemCount: Number(own.run.workset_item_count) };
      }
      const reserved = count(
        "SELECT COUNT(*) AS c FROM blob_reservations WHERE owner_id = ? AND task_id = ? AND state = 'reserved'",
        owner,
        input.taskId,
      );
      const reclaiming = count(
        "SELECT COUNT(*) AS c FROM blob_reservations WHERE owner_id = ? AND task_id = ? AND state = 'reclaiming'",
        owner,
        input.taskId,
      );
      if (reserved + reclaiming > 0) {
        return { outcome: "reservations_open", reserved, reclaiming };
      }
      let refsReleased = 0;
      for (const group of all(
        "SELECT e.blob_key AS blob_key, COUNT(*) AS c FROM evidence e WHERE e.owner_id = ? AND e.task_id = ? AND e.blob_key IS NOT NULL GROUP BY e.blob_key ORDER BY e.blob_key",
        owner,
        input.taskId,
      )) {
        const blobKey = String(group.blob_key);
        const released = Number(group.c);
        const object = objectByKey(owner, blobKey) as Row;
        const others = count(
          "SELECT COUNT(*) AS c FROM evidence WHERE owner_id = ? AND blob_key = ? AND task_id <> ?",
          owner,
          blobKey,
          input.taskId,
        );
        // Record the work item BEFORE the reference is released, in the same transaction (DESIGN 9.4 P3).
        run(
          "INSERT INTO purge_work_items (owner_id, task_id, purge_id, content_hash, generation, blob_key, source_kind, refs_released, " +
            "disposition, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'evidence', ?, ?, 'pending', ?, ?) " +
            "ON CONFLICT(owner_id, task_id, purge_id, blob_key) DO UPDATE SET source_kind = 'evidence', " +
            "refs_released = excluded.refs_released, disposition = excluded.disposition, updated_at = excluded.updated_at " +
            "WHERE purge_work_items.state = 'pending'",
          owner,
          input.taskId,
          input.purgeId,
          String(object.content_hash),
          Number(object.generation),
          blobKey,
          released,
          others === 0 ? "reclaim_pending" : "shared_retained",
          input.now,
          input.now,
        );
        const stored = one(
          "SELECT source_kind FROM purge_work_items WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND blob_key = ?",
          owner,
          input.taskId,
          input.purgeId,
          blobKey,
        ) as Row;
        if (String(stored.source_kind) !== "evidence") {
          throw new Error(`purgeSealWorkset: work item for ${blobKey} was not merged`);
        }
        if (
          run(
            "UPDATE evidence SET blob_key = NULL, redaction_state = 'purged', purged_at = ?, delete_requested_at = COALESCE(delete_requested_at, ?) " +
              "WHERE owner_id = ? AND task_id = ? AND blob_key = ?",
            input.now,
            input.now,
            owner,
            input.taskId,
            blobKey,
          ) !== released
        ) {
          throw new Error(`purgeSealWorkset: evidence release count mismatch for ${blobKey}`);
        }
        if (
          run(
            "UPDATE blob_objects SET ref_count = ref_count - ?, updated_at = ? WHERE owner_id = ? AND blob_key = ? AND ref_count >= ?",
            released,
            input.now,
            owner,
            blobKey,
            released,
          ) !== 1
        ) {
          throw new Error(`purgeSealWorkset: ref_count underflow for ${blobKey}`);
        }
        // Recount immediately: a drifted projection rolls the whole seal back instead of hiding behind "shared".
        const projected = Number((objectByKey(owner, blobKey) as Row).ref_count);
        if (projected !== authoritativeRefs(owner, blobKey)) {
          throw new Error(
            `purgeSealWorkset: ref_count disagrees with evidence.blob_key for ${blobKey}`,
          );
        }
        refsReleased += released;
      }
      const workItemCount = count(
        "SELECT COUNT(*) AS c FROM purge_work_items WHERE owner_id = ? AND task_id = ? AND purge_id = ?",
        owner,
        input.taskId,
        input.purgeId,
      );
      if (
        run(
          "UPDATE purge_runs SET phase = 'workset_sealed', workset_item_count = ?, workset_sealed_at = ?, updated_at = ? " +
            "WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND phase = 'reservations_settled'",
          workItemCount,
          input.now,
          input.now,
          owner,
          input.taskId,
          input.purgeId,
        ) !== 1
      ) {
        throw new Error("purgeSealWorkset: run phase CAS lost");
      }
      return { outcome: "sealed", workItemCount, refsReleased };
    });

  // ------------------------------------------------------------------ P4

  const itemKeyParams = (owner: string, taskId: string, purgeId: string, blobKey: string) =>
    [owner, taskId, purgeId, blobKey] as const;

  const purgeClassify = (input: PurgeClassifyInput): PurgeClassifyOutcome =>
    transaction((): PurgeClassifyOutcome => {
      const owner = input.principal.ownerId;
      const own = ownRun(input, ["workset_sealed"]);
      if (!own.ok) {
        return own.fail;
      }
      // A recorded proof is a snapshot of one moment. If the object's proof was withdrawn or replaced, the item goes back.
      run(
        "UPDATE purge_work_items SET state = 'pending', absence_proof_attempt_id = NULL, updated_at = ? " +
          "WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND state = 'absence_verified' AND NOT EXISTS (" +
          "SELECT 1 FROM blob_objects o WHERE o.owner_id = purge_work_items.owner_id AND o.content_hash = purge_work_items.content_hash " +
          "AND o.generation = purge_work_items.generation AND o.blob_key = purge_work_items.blob_key AND o.state = 'deleted' " +
          "AND o.absence_verified_at IS NOT NULL AND o.absence_verified_attempt_id = purge_work_items.absence_proof_attempt_id)",
        input.now,
        owner,
        input.taskId,
        input.purgeId,
      );
      run(
        `UPDATE purge_work_items SET state = 'pending', updated_at = ? WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND state = 'failed'`,
        input.now,
        owner,
        input.taskId,
        input.purgeId,
      );

      const reclaim: BlobGcItem[] = [];
      const tombstones: PurgeTombstoneItem[] = [];
      const failures: Array<{ blobKey: string; reason: string }> = [];
      let waiting = 0;
      let sequence = 0;
      const leaseUntil = input.now + input.leases.reclaimLeaseMs;
      const fail = (blobKey: string, reason: string) => {
        run(
          "UPDATE purge_work_items SET state = 'failed', last_error = ?, absence_proof_attempt_id = NULL, updated_at = ? " +
            "WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND blob_key = ?",
          reason,
          input.now,
          owner,
          input.taskId,
          input.purgeId,
          blobKey,
        );
        failures.push({ blobKey, reason });
      };

      for (const item of all(
        `SELECT * FROM purge_work_items WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND state = 'pending' ORDER BY blob_key LIMIT ?`,
        owner,
        input.taskId,
        input.purgeId,
        input.limit,
      )) {
        const blobKey = String(item.blob_key);
        const key = itemKeyParams(owner, input.taskId, input.purgeId, blobKey);
        const object = objectByKey(owner, blobKey);
        if (!object) {
          fail(blobKey, "object_missing");
          continue;
        }
        // The grouping from P3 is not trusted: another Task can attach or release the same object in between.
        const refs = authoritativeRefs(owner, blobKey);
        if (refs > 0) {
          run(
            "UPDATE purge_work_items SET disposition = 'shared_retained', state = 'retained_verified', absence_proof_attempt_id = NULL, last_error = NULL, updated_at = ? " +
              "WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND blob_key = ? AND state = 'pending'",
            input.now,
            ...key,
          );
          continue;
        }
        run(
          "UPDATE purge_work_items SET disposition = 'reclaim_pending', updated_at = ? WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND blob_key = ? AND state = 'pending'",
          input.now,
          ...key,
        );
        const state = String(object.state);
        if (state === "live") {
          if (Number(object.ref_count) !== 0) {
            fail(blobKey, "ref_count_drift");
            continue;
          }
          const attempt = `${input.workerAttemptId}:p${(sequence += 1)}`;
          if (
            run(
              "UPDATE blob_objects SET state = 'reclaiming', reclaim_attempt_id = ?, reclaim_lease_until = ?, updated_at = ? " +
                "WHERE owner_id = ? AND content_hash = ? AND generation = ? AND state = 'live' AND ref_count = 0 " +
                "AND NOT EXISTS (SELECT 1 FROM blob_reservations v WHERE v.owner_id = blob_objects.owner_id AND v.content_hash = blob_objects.content_hash AND v.state IN ('reserved','reclaiming'))",
              attempt,
              leaseUntil,
              input.now,
              owner,
              String(object.content_hash),
              Number(object.generation),
            ) !== 1
          ) {
            waiting += 1;
            continue;
          }
          reclaim.push({
            contentHash: String(object.content_hash),
            generation: Number(object.generation),
            blobKey,
            byteSize: Number(object.byte_size),
            objectAttemptId: attempt,
            reservationId: null,
            reservationAttemptId: null,
            writerAttemptId: (object.settled_writer_attempt_id as string | null) ?? null,
            writerIncarnation: (object.settled_writer_incarnation as string | null) ?? null,
          });
          continue;
        }
        if (state === "deleted") {
          if (object.absence_verified_at !== null && object.absence_verified_attempt_id !== null) {
            const token = asText(object.absence_verified_attempt_id);
            // v0.12l: a conditional update that re-checks the object's CURRENT proof, never an unconditional terminal write.
            const changed = run(
              "UPDATE purge_work_items SET state = 'absence_verified', absence_proof_attempt_id = ?, last_error = NULL, updated_at = ? " +
                "WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND blob_key = ? AND state = 'pending' AND disposition = 'reclaim_pending' " +
                "AND EXISTS (SELECT 1 FROM blob_objects o WHERE o.owner_id = ? AND o.content_hash = ? AND o.generation = ? AND o.blob_key = ? " +
                "AND o.state = 'deleted' AND o.absence_verified_at IS NOT NULL AND o.absence_verified_attempt_id = ?)",
              token,
              input.now,
              ...key,
              owner,
              String(object.content_hash),
              Number(object.generation),
              blobKey,
              token,
            );
            if (changed === 0) {
              waiting += 1;
            }
          } else {
            tombstones.push({
              contentHash: String(object.content_hash),
              generation: Number(object.generation),
              blobKey,
              writerSettledReason: (object.writer_settled_reason as string | null) ?? null,
              settledWriterAttemptId: (object.settled_writer_attempt_id as string | null) ?? null,
            });
          }
          continue;
        }
        // writing / reclaiming under someone else's lease: wait for them, maintenance takes expired leases over.
        waiting += 1;
      }

      const tally = (state: string) =>
        count(
          "SELECT COUNT(*) AS c FROM purge_work_items WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND state = ?",
          owner,
          input.taskId,
          input.purgeId,
          state,
        );
      return {
        outcome: "classified",
        reclaim,
        tombstones,
        counts: {
          pending: tally("pending"),
          failed: tally("failed"),
          absenceVerified: tally("absence_verified"),
          retainedVerified: tally("retained_verified"),
          waiting,
        },
        failures,
      };
    });

  // ------------------------------------------------------------------ P5

  const purgeFinalize = (input: PurgeFinalizeInput): PurgeFinalizeOutcome =>
    transaction((): PurgeFinalizeOutcome => {
      const owner = input.principal.ownerId;
      const task = one(
        "SELECT id, title FROM nexus_tasks WHERE owner_id = ? AND id = ?",
        owner,
        input.taskId,
      );
      if (!task) {
        return { outcome: "not_found" };
      }
      const blockers: PurgeCleanupBlocker[] = [];
      const row = runRow(owner, input.taskId);
      if (!row || String(row.purge_id) !== input.purgeId || phaseOf(row) !== "workset_sealed") {
        return { outcome: "cleanup_pending", blockers: ["workset_not_sealed"] };
      }
      const items = all(
        "SELECT * FROM purge_work_items WHERE owner_id = ? AND task_id = ? AND purge_id = ?",
        owner,
        input.taskId,
        input.purgeId,
      );
      // An empty set passes "no open item" vacuously, so the sealed count is compared too (v0.12j).
      if (items.length !== Number(row.workset_item_count)) {
        blockers.push("workset_count_mismatch");
      }
      if (items.some((item) => ["pending", "failed"].includes(String(item.state)))) {
        blockers.push("open_work_items");
      }
      let stale = false;
      let unreferencedRetained = false;
      let objectsDeleted = 0;
      let objectsRetained = 0;
      for (const item of items) {
        const state = String(item.state);
        const blobKey = String(item.blob_key);
        if (state === "absence_verified") {
          // The item is a snapshot; the proof on the object must still be the one it recorded.
          const proven = one(
            "SELECT 1 AS ok FROM blob_objects WHERE owner_id = ? AND content_hash = ? AND generation = ? AND blob_key = ? " +
              "AND state = 'deleted' AND absence_verified_at IS NOT NULL AND absence_verified_attempt_id = ?",
            owner,
            String(item.content_hash),
            Number(item.generation),
            blobKey,
            String(item.absence_proof_attempt_id),
          );
          if (proven) {
            objectsDeleted += 1;
          } else {
            stale = true;
          }
        } else if (state === "retained_verified") {
          // "Someone else still references it" was true when checked; confirm it still is, never trust ref_count.
          if (authoritativeRefs(owner, blobKey) > 0) {
            objectsRetained += 1;
          } else {
            unreferencedRetained = true;
            run(
              "UPDATE purge_work_items SET state = 'pending', disposition = 'reclaim_pending', updated_at = ? " +
                "WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND blob_key = ?",
              input.now,
              owner,
              input.taskId,
              input.purgeId,
              blobKey,
            );
          }
        }
      }
      if (stale) {
        blockers.push("stale_absence_proof");
      }
      if (unreferencedRetained) {
        blockers.push("retained_without_references");
      }
      if (
        count(
          "SELECT COUNT(*) AS c FROM blob_reservations WHERE owner_id = ? AND task_id = ? AND state IN ('reserved','reclaiming')",
          owner,
          input.taskId,
        ) > 0
      ) {
        blockers.push("open_reservations");
      }
      if (blockers.length > 0) {
        return { outcome: "cleanup_pending", blockers };
      }

      const head = one(
        "SELECT digest FROM claim_events WHERE owner_id = ? AND task_id = ? ORDER BY seq DESC LIMIT 1",
        owner,
        input.taskId,
      );
      const claimEventCount = count(
        "SELECT COUNT(*) AS c FROM claim_events WHERE owner_id = ? AND task_id = ?",
        owner,
        input.taskId,
      );
      const evidenceCount = count(
        "SELECT COUNT(*) AS c FROM evidence WHERE owner_id = ? AND task_id = ?",
        owner,
        input.taskId,
      );
      const receiptId = newId("PR");
      const scope = [owner, input.taskId] as const;
      // FK order. The three tables that do NOT cascade from nexus_tasks (claim_events, evidence, blob_reservations) are
      // emptied by hand; everything else (steps, sessions, actions, decisions, grants, executions...) cascades from the Task.
      run("DELETE FROM watches WHERE owner_id = ? AND task_id = ?", ...scope);
      run("DELETE FROM claim_event_evidence WHERE owner_id = ? AND task_id = ?", ...scope);
      run("DELETE FROM claim_evidence_links WHERE owner_id = ? AND task_id = ?", ...scope);
      run("DELETE FROM nexus_task_completion_claims WHERE owner_id = ? AND task_id = ?", ...scope);
      run("DELETE FROM claim_events WHERE owner_id = ? AND task_id = ?", ...scope);
      run("DELETE FROM claims WHERE owner_id = ? AND task_id = ?", ...scope);
      run("DELETE FROM evidence WHERE owner_id = ? AND task_id = ?", ...scope);
      run("DELETE FROM blob_reservations WHERE owner_id = ? AND task_id = ?", ...scope);
      run("DELETE FROM purge_work_items WHERE owner_id = ? AND task_id = ?", ...scope);
      run("DELETE FROM purge_runs WHERE owner_id = ? AND task_id = ?", ...scope);
      run("DELETE FROM nexus_tasks WHERE owner_id = ? AND id = ?", ...scope);
      // The receipt lives outside the purged scope (no FK to nexus_tasks) and keeps hashes and counts only.
      run(
        "INSERT INTO purge_receipts (id, owner_id, subject_kind, task_id, task_title_hash, ledger_head_digest, claim_event_count, " +
          "evidence_count, purged_scope, requested_by, executed_at) VALUES (?, ?, 'task', ?, ?, ?, ?, ?, 'all', ?, ?)",
        receiptId,
        owner,
        input.taskId,
        sha256Hex(String(task.title)),
        head ? String(head.digest) : null,
        claimEventCount,
        evidenceCount,
        input.requestedBy,
        input.now,
      );
      return {
        outcome: "purged",
        receipt: {
          id: receiptId,
          taskId: input.taskId,
          ledgerHeadDigest: head ? String(head.digest) : null,
          claimEventCount,
          evidenceCount,
          purgedScope: "all",
          requestedBy: input.requestedBy,
          executedAt: input.now,
          objectsDeleted,
          objectsRetained,
        },
      };
    });

  // ------------------------------------------------------------------ status

  const purgeStatus = (input: { principal: Principal; taskId: string }): PurgeStatus | null => {
    const owner = input.principal.ownerId;
    const row = runRow(owner, input.taskId);
    if (!row) {
      return null;
    }
    const items: Record<string, number> = {};
    for (const group of all(
      "SELECT state, disposition, COUNT(*) AS c FROM purge_work_items WHERE owner_id = ? AND task_id = ? AND purge_id = ? GROUP BY state, disposition",
      owner,
      input.taskId,
      String(row.purge_id),
    )) {
      items[`${String(group.state)}/${String(group.disposition)}`] = Number(group.c);
    }
    const reservations: Record<string, number> = {};
    for (const group of all(
      "SELECT state, COUNT(*) AS c FROM blob_reservations WHERE owner_id = ? AND task_id = ? GROUP BY state",
      owner,
      input.taskId,
    )) {
      reservations[String(group.state)] = Number(group.c);
    }
    return {
      taskId: input.taskId,
      purgeId: String(row.purge_id),
      phase: phaseOf(row),
      workItemCount: row.workset_item_count === null ? null : Number(row.workset_item_count),
      workerLeaseUntil: row.worker_lease_until === null ? null : Number(row.worker_lease_until),
      items,
      reservations,
      failures: all(
        "SELECT blob_key, last_error FROM purge_work_items WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND state = 'failed'",
        owner,
        input.taskId,
        String(row.purge_id),
      ).map((failed) => ({
        blobKey: String(failed.blob_key),
        reason: asText(failed.last_error ?? "unknown"),
      })),
    };
  };

  /**
   * A pass that ends without a receipt gives the run back at once, so an immediate retry (or the periodic resume) does not
   * have to wait for the lease to run out. Only the holder can release; a crashed pass cannot, and its lease simply expires.
   */
  const purgeRelease = (input: PurgeRunRef): { released: boolean } =>
    transaction(() => ({
      released:
        run(
          "UPDATE purge_runs SET worker_attempt_id = NULL, worker_lease_until = NULL, updated_at = ? WHERE owner_id = ? AND task_id = ? AND purge_id = ? AND worker_attempt_id = ?",
          input.now,
          input.principal.ownerId,
          input.taskId,
          input.purgeId,
          input.workerAttemptId,
        ) === 1,
    }));

  const listPurgeRuns = (input: { principal: Principal; limit: number }): PurgeRunSummary[] =>
    all(
      "SELECT task_id, purge_id, phase, worker_lease_until, updated_at FROM purge_runs WHERE owner_id = ? ORDER BY created_at LIMIT ?",
      input.principal.ownerId,
      input.limit,
    ).map((row) => ({
      taskId: String(row.task_id),
      purgeId: String(row.purge_id),
      phase: phaseOf(row),
      workerLeaseUntil: row.worker_lease_until === null ? null : Number(row.worker_lease_until),
      updatedAt: Number(row.updated_at),
    }));

  const listPurgeReceipts = (input: { principal: Principal; limit: number }): PurgeReceiptRow[] =>
    all(
      "SELECT id, task_id, ledger_head_digest, claim_event_count, evidence_count, requested_by, executed_at FROM purge_receipts " +
        "WHERE owner_id = ? AND subject_kind = 'task' ORDER BY executed_at DESC, id LIMIT ?",
      input.principal.ownerId,
      input.limit,
    ).map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      ledgerHeadDigest: row.ledger_head_digest === null ? null : asText(row.ledger_head_digest),
      claimEventCount: Number(row.claim_event_count),
      evidenceCount: Number(row.evidence_count),
      purgedScope: "all",
      requestedBy: String(row.requested_by),
      executedAt: Number(row.executed_at),
    }));

  // ------------------------------------------------------------------ single evidence deletion (DESIGN 9.4)

  const evidenceDelete = (input: EvidenceDeleteInput): EvidenceDeleteOutcome =>
    transaction((): EvidenceDeleteOutcome => {
      const owner = input.principal.ownerId;
      const task = one(
        "SELECT status FROM nexus_tasks WHERE owner_id = ? AND id = ?",
        owner,
        input.taskId,
      );
      if (!task) {
        return { outcome: "not_found" };
      }
      if (String(task.status) === "purging") {
        return { outcome: "task_purging" };
      }
      const evidence = one(
        "SELECT * FROM evidence WHERE owner_id = ? AND task_id = ? AND id = ?",
        owner,
        input.taskId,
        input.evidenceId,
      );
      if (!evidence) {
        return { outcome: "not_found" };
      }
      if (String(evidence.redaction_state) === "purged") {
        return { outcome: "already_deleted", evidenceId: input.evidenceId };
      }
      if (evidence.blob_key === null) {
        return { outcome: "no_bytes", evidenceId: input.evidenceId };
      }
      const blobKey = asText(evidence.blob_key);
      // blob_key goes to NULL, content_hash STAYS: the chain can still say "a piece of evidence with hash X was here and was
      // deleted on request". The file name in meta_json is personal data too, so it goes with the bytes.
      if (
        run(
          "UPDATE evidence SET blob_key = NULL, redaction_state = 'purged', purged_at = ?, delete_requested_at = COALESCE(delete_requested_at, ?), meta_json = NULL " +
            "WHERE owner_id = ? AND task_id = ? AND id = ? AND blob_key = ?",
          input.now,
          input.now,
          owner,
          input.taskId,
          input.evidenceId,
          blobKey,
        ) !== 1
      ) {
        throw new Error("evidenceDelete: evidence CAS lost");
      }
      if (
        run(
          "UPDATE blob_objects SET ref_count = ref_count - 1, updated_at = ? WHERE owner_id = ? AND blob_key = ? AND ref_count >= 1",
          input.now,
          owner,
          blobKey,
        ) !== 1
      ) {
        throw new Error(`evidenceDelete: ref_count underflow for ${blobKey}`);
      }
      const refs = authoritativeRefs(owner, blobKey);
      if (Number((objectByKey(owner, blobKey) as Row).ref_count) !== refs) {
        throw new Error(
          `evidenceDelete: ref_count disagrees with evidence.blob_key for ${blobKey}`,
        );
      }
      return {
        outcome: "deleted",
        evidenceId: input.evidenceId,
        contentHash: String(evidence.content_hash),
        blobKey,
        orphaned: refs === 0,
      };
    });

  // ------------------------------------------------------------------ incarnation_gone

  /**
   * Mark a writer as quiet because its process is provably gone (DESIGN 9.5.1). The caller only invokes this when the
   * operator enabled `incarnation_gone`; the kernel adds the two conditions that do not depend on configuration: the
   * incarnation row must be terminated, and a row whose boot id is `unavailable` is never accepted.
   * `updated_at` is left alone so the ordinary tombstone scan picks the object up right away.
   */
  const blobIncarnationSettle = (input: IncarnationSettleInput): IncarnationSettleOutcome => {
    return transaction((): IncarnationSettleOutcome => {
      const owner = input.principal.ownerId;
      const settled: string[] = [];
      for (const object of all(
        "SELECT o.content_hash, o.generation, o.blob_key FROM blob_objects o " +
          "JOIN process_incarnations p ON p.incarnation_id = o.settled_writer_incarnation " +
          "WHERE o.owner_id = ? AND o.state IN ('reclaiming','deleted') AND o.writer_settled_reason IS NULL " +
          "AND o.settled_writer_attempt_id IS NOT NULL AND p.gone_at IS NOT NULL AND p.process_boot_id <> 'unavailable' LIMIT ?",
        owner,
        input.limit,
      )) {
        if (
          run(
            "UPDATE blob_objects SET writer_settled_reason = 'incarnation_gone' " +
              "WHERE owner_id = ? AND content_hash = ? AND generation = ? AND writer_settled_reason IS NULL",
            owner,
            String(object.content_hash),
            Number(object.generation),
          ) === 1
        ) {
          settled.push(String(object.blob_key));
        }
      }
      return { settled };
    });
  };

  return {
    purgeBegin,
    purgeClaimReservations,
    purgeAdvanceReservations,
    purgeSealWorkset,
    purgeClassify,
    purgeFinalize,
    purgeStatus,
    purgeRelease,
    listPurgeRuns,
    listPurgeReceipts,
    evidenceDelete,
    blobIncarnationSettle,
  };
}

export type PurgeLedger = ReturnType<typeof createPurgeLedger>;
