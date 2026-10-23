import { asText } from "../as-text.js";
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
// Blob evidence kernel (DESIGN sections 9.4 and 9.5.1), Stage 3 slice 2. Runs inside the SQLite worker.
// The worker only does the SYNCHRONOUS phases of the four-phase protocol; every byte of I/O is awaited by the service
// (src/evidence/evidence-service.ts) between these calls, so no write transaction ever spans an await:
//   A0  blobPrecheck   ownership, Task / claim open, quotas - before any byte is read
//   A1  blobPlan       one small transaction that picks reuse_evidence / attach_live_object / new_object (+ reservation)
//   A2  (service)      registerIfAbsent into the production namespace under key `<hash>.<generation>`
//   B   blobAdmit      one transaction that revalidates everything, CASes the reservation and the object, writes evidence
// plus the reclaim side: blobGcClaim / blobGcSettle (two-layer CAS, so B and GC can never both win), the tombstone scan
// and read helpers. Every statement filters on owner_id; every write is ONE synchronous transaction.
import { canonicalJson, sha256Hex } from "../canonical.js";
import type {
  BlobAdmitInput,
  BlobAdmitOutcome,
  BlobGcClaimOutcome,
  BlobGcInput,
  BlobGcItem,
  BlobGcSettleInput,
  BlobGcSettleOutcome,
  BlobPlanInput,
  BlobPlanOutcome,
  BlobPrecheckInput,
  BlobPrecheckOutcome,
  BlobSourceFacts,
  BlobStats,
  BlobTombstone,
  BlobTombstoneCheckedInput,
  BlobTombstonesInput,
  ContentClassification,
  EvidenceBlobView,
  EvidenceLimits,
  EvidenceReadRef,
  QuotaExceeded,
} from "./blob-types.js";
import {
  OPERATOR_RELATION_RULE_VERSION,
  RELATION_RULE_VERSION,
  SOURCE_GROUP_RULE_VERSION,
  type ClaimLedger,
} from "./claim-ledger.js";
import { parseJson, type TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";

type Row = Record<string, unknown>;
const HASH = /^[0-9a-f]{64}$/;
const LIVE_STATES = "('writing','live','reclaiming')";

export function createBlobLedger(
  transaction: TransactionRunner,
  internals: ClaimLedger["internals"],
) {
  const { one, all, run, newId, claimRow, writableTask, priorLink, linkEvidenceRow } = internals;

  // ------------------------------------------------------------------ shared reads

  /** owner level: physical objects, so a blob shared by several Tasks is counted once (DESIGN 9.4). */
  const ownerUsedBytes = (owner: string): number =>
    Number(
      (
        one(
          `SELECT COALESCE(SUM(byte_size), 0) AS b FROM blob_objects WHERE owner_id = ? AND state IN ${LIVE_STATES}`,
          owner,
        ) as Row
      ).b,
    );

  /** Task level: its evidence that still owns bytes + its reservations that have not been settled yet. */
  const taskUsedBytes = (owner: string, taskId: string): number => {
    const evidence = Number(
      (
        one(
          "SELECT COALESCE(SUM(byte_size), 0) AS b FROM evidence WHERE owner_id = ? AND task_id = ? AND blob_key IS NOT NULL",
          owner,
          taskId,
        ) as Row
      ).b,
    );
    const reserved = Number(
      (
        one(
          "SELECT COALESCE(SUM(byte_size), 0) AS b FROM blob_reservations WHERE owner_id = ? AND task_id = ? AND state IN ('reserved','reclaiming')",
          owner,
          taskId,
        ) as Row
      ).b,
    );
    return evidence + reserved;
  };

  const quotaCheck = (
    owner: string,
    taskId: string,
    limits: EvidenceLimits,
    bytes: number,
    opts: { newPhysicalBytes: boolean; newTaskBytes: boolean },
  ): QuotaExceeded | null => {
    if (bytes > limits.maxEntryBytes) {
      return {
        outcome: "quota_exceeded",
        scope: "entry",
        limit: limits.maxEntryBytes,
        used: 0,
        requested: bytes,
      };
    }
    if (opts.newTaskBytes) {
      const used = taskUsedBytes(owner, taskId);
      if (used + bytes > limits.taskQuotaBytes) {
        return {
          outcome: "quota_exceeded",
          scope: "task",
          limit: limits.taskQuotaBytes,
          used,
          requested: bytes,
        };
      }
    }
    if (opts.newPhysicalBytes) {
      const used = ownerUsedBytes(owner);
      if (used + bytes > limits.ownerQuotaBytes) {
        return {
          outcome: "quota_exceeded",
          scope: "owner",
          limit: limits.ownerQuotaBytes,
          used,
          requested: bytes,
        };
      }
    }
    return null;
  };

  const identityOf = (facts: BlobSourceFacts, contentHash: string): string =>
    sha256Hex(
      canonicalJson({
        locator: facts.locator,
        version: facts.version ?? `content:${contentHash}`,
        contentHash,
      }),
    );

  const objectByKey = (owner: string, blobKey: string): Row | undefined =>
    one("SELECT * FROM blob_objects WHERE owner_id = ? AND blob_key = ?", owner, blobKey);

  /** The authoritative reference count (DESIGN 9.4): evidence.blob_key, never content_hash and never ref_count. */
  const authoritativeRefs = (owner: string, blobKey: string): number =>
    Number(
      (
        one(
          "SELECT COUNT(*) AS c FROM evidence WHERE owner_id = ? AND blob_key = ?",
          owner,
          blobKey,
        ) as Row
      ).c,
    );

  type GateFail =
    | { outcome: "not_found" }
    | { outcome: "task_closed"; status: string }
    | { outcome: "claim_not_found" }
    | { outcome: "stale_head"; headEventId: string };

  /** Task writable + (optional) claim exists + (optional) optimistic head. Reads only. */
  const gate = (
    owner: string,
    taskId: string,
    claimId: string | undefined,
    expectedHead: string | undefined,
  ): GateFail | null => {
    const writable = writableTask(owner, taskId);
    if (!writable.ok) {
      return writable.outcome === "task_closed"
        ? { outcome: "task_closed", status: writable.status }
        : { outcome: "not_found" };
    }
    if (claimId !== undefined) {
      const row = claimRow(owner, taskId, claimId);
      if (!row) {
        return { outcome: "claim_not_found" };
      }
      if (expectedHead !== undefined && expectedHead !== String(row.head_event_id)) {
        return { outcome: "stale_head", headEventId: String(row.head_event_id) };
      }
    }
    return null;
  };

  // ------------------------------------------------------------------ A0

  const blobPrecheck = (input: BlobPrecheckInput): BlobPrecheckOutcome =>
    transaction((): BlobPrecheckOutcome => {
      const owner = input.principal.ownerId;
      const failed = gate(owner, input.taskId, input.claimId, input.expectedHeadEventId);
      if (failed) {
        return failed;
      }
      if (input.source.kind === "upload") {
        // Bytes the owner already holds (same hash) cost no new physical space, and bytes this Task already references
        // cost it nothing either: a quota that is full must not turn a harmless re-upload into a failure.
        const hash = input.source.contentHash;
        const held =
          hash !== undefined && HASH.test(hash)
            ? one(
                "SELECT blob_key FROM blob_objects WHERE owner_id = ? AND content_hash = ? AND state = 'live'",
                owner,
                hash,
              )
            : undefined;
        const taskHolds =
          held !== undefined &&
          one(
            "SELECT 1 AS x FROM evidence WHERE owner_id = ? AND task_id = ? AND blob_key = ? LIMIT 1",
            owner,
            input.taskId,
            String(held.blob_key),
          ) !== undefined;
        const exceeded = quotaCheck(owner, input.taskId, input.limits, input.source.byteSize, {
          newPhysicalBytes: held === undefined,
          newTaskBytes: !taskHolds,
        });
        return exceeded ?? { outcome: "ok", ref: null };
      }
      // A blob ref names a physical object this owner already holds. Its source facts are inherited from the FIRST
      // registration (same Task preferred), so a model cannot relabel material by pointing at it again.
      const object = objectByKey(owner, input.source.blobKey);
      if (!object) {
        return { outcome: "ref_not_found" };
      }
      if (String(object.state) !== "live") {
        return { outcome: "ref_not_ready", state: String(object.state) };
      }
      const origin = one(
        "SELECT kind, source_locator_canonical, source_version, source_group, content_classification, meta_json, byte_size " +
          "FROM evidence WHERE owner_id = ? AND blob_key = ? ORDER BY (task_id = ?) DESC, captured_at ASC LIMIT 1",
        owner,
        input.source.blobKey,
        input.taskId,
      );
      if (!origin) {
        return { outcome: "ref_not_found" };
      }
      const byteSize = Number(object.byte_size);
      const sameTask = one(
        "SELECT 1 AS x FROM evidence WHERE owner_id = ? AND task_id = ? AND blob_key = ? LIMIT 1",
        owner,
        input.taskId,
        input.source.blobKey,
      );
      const exceeded = quotaCheck(owner, input.taskId, input.limits, byteSize, {
        newPhysicalBytes: false,
        newTaskBytes: sameTask === undefined,
      });
      if (exceeded) {
        return exceeded;
      }
      const version = String(origin.source_version);
      return {
        outcome: "ok",
        ref: {
          blobKey: input.source.blobKey,
          contentHash: String(object.content_hash),
          byteSize,
          facts: {
            kind: String(origin.kind),
            locator: String(origin.source_locator_canonical),
            version: version.startsWith("content:") ? null : version,
            sourceGroup: String(origin.source_group),
            classification: String(origin.content_classification) as ContentClassification,
            meta:
              origin.meta_json === null
                ? {}
                : ((parseJson(origin.meta_json) as Record<string, unknown> | null) ?? {}),
          },
        },
      };
    });

  // ------------------------------------------------------------------ A1

  const blobPlan = (input: BlobPlanInput): BlobPlanOutcome =>
    transaction((): BlobPlanOutcome => {
      const owner = input.principal.ownerId;
      if (!HASH.test(input.contentHash) || !(input.byteSize > 0)) {
        throw new Error("blobPlan: contentHash must be a sha256 hex and byteSize positive");
      }
      const failed = gate(owner, input.taskId, input.claimId, undefined);
      if (failed && failed.outcome !== "stale_head") {
        return failed;
      }
      const identity = identityOf(input.facts, input.contentHash);
      const existing = one(
        "SELECT id, blob_key, content_hash FROM evidence WHERE owner_id = ? AND task_id = ? AND source_identity_hash = ?",
        owner,
        input.taskId,
        identity,
      );
      if (existing) {
        if (existing.blob_key === null) {
          // Deleted on the user's request (DESIGN 9.4): not a readable reuse, and never silently restored.
          return { outcome: "evidence_purged", evidenceId: String(existing.id) };
        }
        const object = objectByKey(owner, asText(existing.blob_key));
        if (object && String(object.state) === "live") {
          return {
            outcome: "planned",
            plan: {
              branch: "reuse_evidence",
              evidenceId: String(existing.id),
              blobKey: asText(existing.blob_key),
            },
          };
        }
        return {
          outcome: "wait",
          state: "reclaiming",
          blobKey: asText(existing.blob_key),
          retryAfterMs: 1_000,
        };
      }
      const held = one(
        `SELECT * FROM blob_objects WHERE owner_id = ? AND content_hash = ? AND state IN ${LIVE_STATES}`,
        owner,
        input.contentHash,
      );
      if (held) {
        const state = String(held.state);
        if (state === "writing") {
          const left = Number(held.writer_lease_until) - input.now;
          return {
            outcome: "wait",
            state: "writing",
            blobKey: String(held.blob_key),
            retryAfterMs: Math.max(250, Math.min(left, 2_000)),
          };
        }
        if (state === "reclaiming") {
          return {
            outcome: "wait",
            state: "reclaiming",
            blobKey: String(held.blob_key),
            retryAfterMs: 1_000,
          };
        }
        const exceeded = quotaCheck(owner, input.taskId, input.limits, input.byteSize, {
          newPhysicalBytes: false,
          newTaskBytes: true,
        });
        if (exceeded) {
          return exceeded;
        }
        return {
          outcome: "planned",
          plan: {
            branch: "attach_live_object",
            blobKey: String(held.blob_key),
            generation: Number(held.generation),
          },
        };
      }
      // new_object. A leftover reservation on the same hash would trip blob_reservations_hash_live: wait for it instead.
      const leftover = one(
        "SELECT state FROM blob_reservations WHERE owner_id = ? AND content_hash = ? AND state IN ('reserved','reclaiming')",
        owner,
        input.contentHash,
      );
      if (leftover) {
        return {
          outcome: "wait",
          state: "reclaiming",
          blobKey: `${input.contentHash}.?`,
          retryAfterMs: 1_000,
        };
      }
      const exceeded = quotaCheck(owner, input.taskId, input.limits, input.byteSize, {
        newPhysicalBytes: true,
        newTaskBytes: true,
      });
      if (exceeded) {
        return exceeded;
      }
      const generation =
        Number(
          (
            one(
              "SELECT COALESCE(MAX(generation), 0) AS g FROM blob_objects WHERE owner_id = ? AND content_hash = ?",
              owner,
              input.contentHash,
            ) as Row
          ).g,
        ) + 1;
      const blobKey = `${input.contentHash}.${generation}`;
      run(
        "INSERT INTO blob_objects (owner_id, content_hash, generation, blob_key, byte_size, state, ref_count, writer_attempt_id, " +
          "writer_lease_until, writer_incarnation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'writing', 0, ?, ?, ?, ?, ?)",
        owner,
        input.contentHash,
        generation,
        blobKey,
        input.byteSize,
        input.attemptId,
        input.now + input.leases.writerLeaseMs,
        input.incarnationId,
        input.now,
        input.now,
      );
      const reservationId = newId("BR");
      const expiresAt = input.now + input.leases.reservationTtlMs;
      run(
        "INSERT INTO blob_reservations (id, owner_id, task_id, content_hash, generation, byte_size, state, expires_at, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)",
        reservationId,
        owner,
        input.taskId,
        input.contentHash,
        generation,
        input.byteSize,
        expiresAt,
        input.now,
        input.now,
      );
      return {
        outcome: "planned",
        plan: {
          branch: "new_object",
          blobKey,
          generation,
          reservationId,
          attemptId: input.attemptId,
          expiresAt,
        },
      };
    });

  // ------------------------------------------------------------------ B

  const insertEvidence = (
    owner: string,
    taskId: string,
    blobKey: string,
    input: BlobAdmitInput,
    identity: string,
  ): string => {
    const evidenceId = newId("EV");
    run(
      "INSERT INTO evidence (id, owner_id, task_id, kind, blob_key, content_hash, byte_size, source_ref_kind, source_ref_id, " +
        "source_locator_canonical, source_version, source_identity_hash, source_run_id, source_session_key, source_group, " +
        "source_group_rule_version, content_classification, retention_policy, meta_json, captured_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'blob', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'task', ?, ?)",
      evidenceId,
      owner,
      taskId,
      input.facts.kind,
      blobKey,
      input.contentHash,
      input.byteSize,
      blobKey,
      input.facts.locator,
      input.facts.version ?? `content:${input.contentHash}`,
      identity,
      input.facts.sourceGroup,
      SOURCE_GROUP_RULE_VERSION,
      input.facts.classification,
      canonicalJson(input.facts.meta),
      input.now,
    );
    return evidenceId;
  };

  const blobAdmit = (input: BlobAdmitInput): BlobAdmitOutcome =>
    transaction((): BlobAdmitOutcome => {
      const owner = input.principal.ownerId;
      const taskId = input.taskId;
      // Revalidate EVERYTHING after the last await (AGENTS.md "Revalidate after awaited work"): tokens and ids are not
      // live authority. All checks come before the first write, so a refusal changes nothing.
      const failed = gate(owner, taskId, input.claimId, input.expectedHeadEventId);
      if (failed) {
        return failed;
      }
      const identity = identityOf(input.facts, input.contentHash);
      const plan = input.plan;
      let evidenceId: string | undefined;
      let reusedEvidence = false;

      if (plan.branch === "reuse_evidence") {
        const ev = one(
          "SELECT id, blob_key, content_hash, source_identity_hash FROM evidence WHERE owner_id = ? AND task_id = ? AND id = ?",
          owner,
          taskId,
          plan.evidenceId,
        );
        if (
          !ev ||
          String(ev.source_identity_hash) !== identity ||
          String(ev.content_hash) !== input.contentHash
        ) {
          return { outcome: "reservation_lost", reason: "reused_evidence_changed" };
        }
        if (ev.blob_key === null) {
          return { outcome: "evidence_purged", evidenceId: String(ev.id) };
        }
        const object = objectByKey(owner, asText(ev.blob_key));
        if (!object || String(object.state) !== "live" || asText(ev.blob_key) !== plan.blobKey) {
          return { outcome: "object_not_live", blobKey: asText(ev.blob_key) };
        }
        evidenceId = String(ev.id);
        reusedEvidence = true;
      } else if (plan.branch === "attach_live_object") {
        const object = objectByKey(owner, plan.blobKey);
        if (
          !object ||
          String(object.state) !== "live" ||
          String(object.content_hash) !== input.contentHash
        ) {
          return { outcome: "object_not_live", blobKey: plan.blobKey };
        }
        const raced = one(
          "SELECT id FROM evidence WHERE owner_id = ? AND task_id = ? AND source_identity_hash = ?",
          owner,
          taskId,
          identity,
        );
        if (raced) {
          evidenceId = String(raced.id);
          reusedEvidence = true;
        } else {
          const exceeded = quotaCheck(owner, taskId, input.limits, input.byteSize, {
            newPhysicalBytes: false,
            newTaskBytes: true,
          });
          if (exceeded) {
            return exceeded;
          }
          evidenceId = insertEvidence(owner, taskId, plan.blobKey, input, identity);
          if (
            run(
              "UPDATE blob_objects SET ref_count = ref_count + 1, updated_at = ? WHERE owner_id = ? AND blob_key = ? AND state = 'live'",
              input.now,
              owner,
              plan.blobKey,
            ) !== 1
          ) {
            throw new Error("blobAdmit: ref_count update lost its row");
          }
        }
      } else {
        const reservation = one(
          "SELECT id, state, content_hash, generation, task_id FROM blob_reservations WHERE owner_id = ? AND id = ?",
          owner,
          plan.reservationId,
        );
        if (!reservation || String(reservation.task_id) !== taskId) {
          return { outcome: "reservation_lost", reason: "reservation_missing" };
        }
        if (String(reservation.state) !== "reserved") {
          return {
            outcome: "reservation_lost",
            reason: `reservation_${String(reservation.state)}`,
          };
        }
        const object = objectByKey(owner, plan.blobKey);
        if (
          !object ||
          String(object.state) !== "writing" ||
          String(object.writer_attempt_id) !== plan.attemptId ||
          String(object.content_hash) !== input.contentHash ||
          Number(object.generation) !== plan.generation ||
          String(reservation.content_hash) !== input.contentHash ||
          Number(reservation.generation) !== plan.generation
        ) {
          return { outcome: "reservation_lost", reason: "object_not_ours" };
        }
        if (
          run(
            "UPDATE blob_reservations SET state = 'consumed', updated_at = ? WHERE owner_id = ? AND id = ? AND state = 'reserved'",
            input.now,
            owner,
            plan.reservationId,
          ) !== 1
        ) {
          throw new Error("blobAdmit: reservation CAS lost");
        }
        // writing -> live. The CHECK (state='writing') = (writer_* IS NOT NULL) forces all three writer columns to be
        // cleared in the same statement; the writer identity moves to settled_writer_* with reason `committed`.
        if (
          run(
            "UPDATE blob_objects SET state = 'live', ref_count = 1, settled_writer_attempt_id = writer_attempt_id, " +
              "settled_writer_incarnation = writer_incarnation, writer_settled_reason = 'committed', writer_attempt_id = NULL, " +
              "writer_lease_until = NULL, writer_incarnation = NULL, updated_at = ? " +
              "WHERE owner_id = ? AND content_hash = ? AND generation = ? AND state = 'writing' AND writer_attempt_id = ?",
            input.now,
            owner,
            input.contentHash,
            plan.generation,
            plan.attemptId,
          ) !== 1
        ) {
          throw new Error("blobAdmit: object CAS lost");
        }
        evidenceId = insertEvidence(owner, taskId, plan.blobKey, input, identity);
      }
      const blobKey = plan.blobKey;

      if (input.claimId === undefined) {
        return { outcome: "registered", evidenceId, blobKey, branch: plan.branch, reusedEvidence };
      }
      const prior = priorLink(owner, taskId, input.claimId, evidenceId);
      // An operator declaration may upgrade an earlier `unclassified` link (the Agent attached it first); anything else
      // already linked stays as it is, and a detached piece of evidence is never re-attached.
      if (
        prior &&
        (prior.relation === "detach" ||
          !(prior.relation === "unclassified" && input.operatorRelation))
      ) {
        if (prior.relation === "detach") {
          return { outcome: "detached_by_operator", evidenceId };
        }
        return {
          outcome: "already_linked",
          claim: internals.toClaim(owner, claimRow(owner, taskId, input.claimId) as Row),
          evidenceId,
          blobKey,
        };
      }
      // Relation: never the model's call (DESIGN 9.5.5). No verifier rule judges blob CONTENT yet, so without an operator
      // declaration the answer is `unclassified`, which never counts for or against anything.
      const verdict = input.operatorRelation
        ? {
            relation: input.operatorRelation.relation,
            reason: `operator declared: ${input.operatorRelation.reason}`,
          }
        : {
            relation: "unclassified" as const,
            reason:
              "no verifier rule judges blob content for this claim; only an operator-declared relation counts (rule v2)",
          };
      const linked = linkEvidenceRow({
        owner,
        taskId,
        claimId: input.claimId,
        evidenceId,
        sourceGroup: input.facts.sourceGroup,
        verdict,
        ruleVersion: input.operatorRelation
          ? OPERATOR_RELATION_RULE_VERSION
          : RELATION_RULE_VERSION,
        source: input.eventSource,
        actor: input.actor,
        now: input.now,
        reusedEvidence,
        extraPayload: { blobKey, branch: plan.branch },
      });
      return { ...linked, blobKey, branch: plan.branch };
    });

  // ------------------------------------------------------------------ reclaim (two layers, DESIGN 9.5.1)

  const blobGcClaim = (input: BlobGcInput): BlobGcClaimOutcome =>
    transaction((): BlobGcClaimOutcome => {
      const owner = input.principal.ownerId;
      const items: BlobGcItem[] = [];
      let abandonedWithoutObject = 0;
      let sequence = 0;
      const nextAttempt = () => `${input.attemptId}:${(sequence += 1)}`;
      const leaseUntil = input.now + input.leases.reclaimLeaseMs;
      const room = () => input.limit - items.length;
      const itemOf = (
        object: Row,
        attempt: string,
        reservation: { id: string; attempt: string } | null,
        writer: { attemptId: string | null; incarnation: string | null },
      ): BlobGcItem => ({
        contentHash: String(object.content_hash),
        generation: Number(object.generation),
        blobKey: String(object.blob_key),
        byteSize: Number(object.byte_size),
        objectAttemptId: attempt,
        reservationId: reservation?.id ?? null,
        reservationAttemptId: reservation?.attempt ?? null,
        writerAttemptId: writer.attemptId,
        writerIncarnation: writer.incarnation,
      });

      // 1. reservation layer: reserved + expired -> reclaiming (CAS; stage B can only win reserved -> consumed).
      for (const reservation of all(
        "SELECT * FROM blob_reservations WHERE owner_id = ? AND state = 'reserved' AND expires_at < ? ORDER BY expires_at LIMIT ?",
        owner,
        input.now,
        Math.max(1, room()),
      )) {
        if (room() <= 0) {
          break;
        }
        const object = one(
          "SELECT * FROM blob_objects WHERE owner_id = ? AND content_hash = ? AND generation = ?",
          owner,
          String(reservation.content_hash),
          Number(reservation.generation),
        ) as Row;
        const state = String(object.state);
        if (state === "deleted") {
          abandonedWithoutObject +=
            run(
              "UPDATE blob_reservations SET state = 'abandoned', updated_at = ? WHERE owner_id = ? AND id = ? AND state = 'reserved'",
              input.now,
              owner,
              String(reservation.id),
            ) > 0
              ? 1
              : 0;
          continue;
        }
        // Expiry of the reservation is not proof that the writer stopped: the writer lease must also be over.
        if (state !== "writing" || Number(object.writer_lease_until) >= input.now) {
          continue;
        }
        const attempt = nextAttempt();
        if (
          run(
            "UPDATE blob_reservations SET state = 'reclaiming', reclaim_attempt_id = ?, reclaim_lease_until = ?, updated_at = ? " +
              "WHERE owner_id = ? AND id = ? AND state = 'reserved' AND expires_at < ?",
            attempt,
            leaseUntil,
            input.now,
            owner,
            String(reservation.id),
            input.now,
          ) !== 1
        ) {
          continue;
        }
        // Same transaction: writing -> reclaiming, keyed by the writer attempt we just read.
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
          throw new Error("blobGcClaim: object CAS lost after the reservation CAS");
        }
        items.push(
          itemOf(
            object,
            attempt,
            { id: String(reservation.id), attempt },
            {
              attemptId: String(object.writer_attempt_id),
              incarnation: String(object.writer_incarnation),
            },
          ),
        );
      }

      // 2. take over reclaiming reservations whose lease ran out (crash during a reclaim).
      if (room() > 0) {
        for (const reservation of all(
          "SELECT * FROM blob_reservations WHERE owner_id = ? AND state = 'reclaiming' AND reclaim_lease_until < ? LIMIT ?",
          owner,
          input.now,
          room(),
        )) {
          const object = one(
            "SELECT * FROM blob_objects WHERE owner_id = ? AND content_hash = ? AND generation = ?",
            owner,
            String(reservation.content_hash),
            Number(reservation.generation),
          ) as Row;
          const attempt = nextAttempt();
          if (String(object.state) === "deleted") {
            run(
              "UPDATE blob_reservations SET state = 'abandoned', reclaim_attempt_id = NULL, reclaim_lease_until = NULL, updated_at = ? " +
                "WHERE owner_id = ? AND id = ? AND state = 'reclaiming' AND reclaim_attempt_id = ?",
              input.now,
              owner,
              String(reservation.id),
              String(reservation.reclaim_attempt_id),
            );
            abandonedWithoutObject += 1;
            continue;
          }
          if (String(object.state) !== "reclaiming") {
            continue;
          }
          if (
            run(
              "UPDATE blob_reservations SET reclaim_attempt_id = ?, reclaim_lease_until = ?, updated_at = ? " +
                "WHERE owner_id = ? AND id = ? AND state = 'reclaiming' AND reclaim_attempt_id = ?",
              attempt,
              leaseUntil,
              input.now,
              owner,
              String(reservation.id),
              String(reservation.reclaim_attempt_id),
            ) !== 1
          ) {
            continue;
          }
          if (
            run(
              "UPDATE blob_objects SET reclaim_attempt_id = ?, reclaim_lease_until = ?, updated_at = ? " +
                "WHERE owner_id = ? AND content_hash = ? AND generation = ? AND state = 'reclaiming' AND reclaim_attempt_id = ?",
              attempt,
              leaseUntil,
              input.now,
              owner,
              String(object.content_hash),
              Number(object.generation),
              String(object.reclaim_attempt_id),
            ) !== 1
          ) {
            throw new Error("blobGcClaim: takeover object CAS lost after the reservation CAS");
          }
          items.push(
            itemOf(
              object,
              attempt,
              { id: String(reservation.id), attempt },
              {
                attemptId: object.settled_writer_attempt_id as string | null,
                incarnation: object.settled_writer_incarnation as string | null,
              },
            ),
          );
        }
      }

      // 3. objects stuck in reclaiming with no reclaiming reservation (zero-reference path, or a reservation that finished).
      if (room() > 0) {
        for (const object of all(
          "SELECT o.* FROM blob_objects o WHERE o.owner_id = ? AND o.state = 'reclaiming' AND o.reclaim_lease_until < ? " +
            "AND NOT EXISTS (SELECT 1 FROM blob_reservations v WHERE v.owner_id = o.owner_id AND v.content_hash = o.content_hash " +
            "AND v.generation = o.generation AND v.state = 'reclaiming') LIMIT ?",
          owner,
          input.now,
          room(),
        )) {
          const attempt = nextAttempt();
          if (
            run(
              "UPDATE blob_objects SET reclaim_attempt_id = ?, reclaim_lease_until = ?, updated_at = ? " +
                "WHERE owner_id = ? AND content_hash = ? AND generation = ? AND state = 'reclaiming' AND reclaim_attempt_id = ?",
              attempt,
              leaseUntil,
              input.now,
              owner,
              String(object.content_hash),
              Number(object.generation),
              String(object.reclaim_attempt_id),
            ) !== 1
          ) {
            continue;
          }
          items.push(
            itemOf(object, attempt, null, {
              attemptId: object.settled_writer_attempt_id as string | null,
              incarnation: object.settled_writer_incarnation as string | null,
            }),
          );
        }
      }

      // 4. live objects nobody references any more (authoritative count from evidence.blob_key, not from ref_count).
      if (room() > 0) {
        for (const object of all(
          "SELECT o.* FROM blob_objects o WHERE o.owner_id = ? AND o.state = 'live' AND o.ref_count = 0 AND o.updated_at < ? " +
            "AND NOT EXISTS (SELECT 1 FROM blob_reservations v WHERE v.owner_id = o.owner_id AND v.content_hash = o.content_hash " +
            "AND v.state IN ('reserved','reclaiming')) " +
            "AND (SELECT COUNT(*) FROM evidence e WHERE e.owner_id = o.owner_id AND e.blob_key = o.blob_key) = 0 LIMIT ?",
          owner,
          input.now - input.zeroRefGraceMs,
          room(),
        )) {
          const attempt = nextAttempt();
          if (
            run(
              "UPDATE blob_objects SET state = 'reclaiming', reclaim_attempt_id = ?, reclaim_lease_until = ?, updated_at = ? " +
                "WHERE owner_id = ? AND content_hash = ? AND generation = ? AND state = 'live' AND ref_count = 0",
              attempt,
              leaseUntil,
              input.now,
              owner,
              String(object.content_hash),
              Number(object.generation),
            ) !== 1
          ) {
            continue;
          }
          items.push(
            itemOf(object, attempt, null, {
              attemptId: object.settled_writer_attempt_id as string | null,
              incarnation: object.settled_writer_incarnation as string | null,
            }),
          );
        }
      }
      return { items, abandonedWithoutObject };
    });

  const blobGcSettle = (input: BlobGcSettleInput): BlobGcSettleOutcome =>
    transaction((): BlobGcSettleOutcome => {
      const owner = input.principal.ownerId;
      let deleted = 0;
      const skipped: Array<{ blobKey: string; reason: string }> = [];
      for (const item of input.items) {
        const object = one(
          "SELECT * FROM blob_objects WHERE owner_id = ? AND content_hash = ? AND generation = ?",
          owner,
          item.contentHash,
          item.generation,
        );
        if (
          !object ||
          String(object.state) !== "reclaiming" ||
          String(object.reclaim_attempt_id) !== item.objectAttemptId
        ) {
          skipped.push({ blobKey: item.blobKey, reason: "attempt_superseded" });
          continue;
        }
        // Re-count from the authoritative column. ref_count is a projection: a drifted value is NOT permission to delete.
        if (authoritativeRefs(owner, item.blobKey) !== 0 || Number(object.ref_count) !== 0) {
          skipped.push({ blobKey: item.blobKey, reason: "still_referenced" });
          continue;
        }
        const haveSettledWriter =
          object.settled_writer_attempt_id !== null && object.settled_writer_incarnation !== null;
        const reason =
          (object.writer_settled_reason as string | null) ??
          (haveSettledWriter ? (item.writerSettledReason ?? null) : null);
        const proven = item.absent && reason !== null && haveSettledWriter;
        if (
          run(
            "UPDATE blob_objects SET state = 'deleted', reclaim_attempt_id = NULL, reclaim_lease_until = NULL, " +
              "writer_settled_reason = ?, absence_verified_at = ?, absence_verified_attempt_id = ?, updated_at = ? " +
              "WHERE owner_id = ? AND content_hash = ? AND generation = ? AND state = 'reclaiming' AND reclaim_attempt_id = ?",
            reason,
            proven ? input.now : null,
            proven ? item.objectAttemptId : null,
            input.now,
            owner,
            item.contentHash,
            item.generation,
            item.objectAttemptId,
          ) !== 1
        ) {
          throw new Error("blobGcSettle: object CAS lost");
        }
        if (item.reservationId !== null && item.reservationAttemptId !== null) {
          run(
            "UPDATE blob_reservations SET state = 'abandoned', reclaim_attempt_id = NULL, reclaim_lease_until = NULL, updated_at = ? " +
              "WHERE owner_id = ? AND id = ? AND state = 'reclaiming' AND reclaim_attempt_id = ?",
            input.now,
            owner,
            item.reservationId,
            item.reservationAttemptId,
          );
        }
        deleted += 1;
      }
      return { deleted, skipped };
    });

  const blobTombstones = (input: BlobTombstonesInput): BlobTombstone[] =>
    all(
      "SELECT content_hash, generation, blob_key, writer_settled_reason, settled_writer_attempt_id FROM blob_objects " +
        "WHERE owner_id = ? AND state = 'deleted' AND absence_verified_at IS NULL AND updated_at < ? ORDER BY updated_at LIMIT ?",
      input.principal.ownerId,
      input.now - input.olderThanMs,
      input.limit,
    ).map((row) => ({
      contentHash: String(row.content_hash),
      generation: Number(row.generation),
      blobKey: asText(row.blob_key),
      writerSettledReason: (row.writer_settled_reason as string | null) ?? null,
      settledWriterAttemptId: (row.settled_writer_attempt_id as string | null) ?? null,
    }));

  const blobTombstoneChecked = (
    input: BlobTombstoneCheckedInput,
  ): { updated: boolean; proven: boolean } =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const object = one(
        "SELECT * FROM blob_objects WHERE owner_id = ? AND blob_key = ? AND state = 'deleted'",
        owner,
        input.blobKey,
      );
      if (!object) {
        return { updated: false, proven: false };
      }
      if (input.reappeared) {
        // A late write brought the bytes back. Only the CURRENT proof is withdrawn; the writer facts stay (DESIGN 9.5.1).
        run(
          "UPDATE blob_objects SET absence_verified_at = NULL, absence_verified_attempt_id = NULL, " +
            "absence_invalidated_count = absence_invalidated_count + 1, updated_at = ? WHERE owner_id = ? AND blob_key = ?",
          input.now,
          owner,
          input.blobKey,
        );
        // Same transaction (DESIGN 9.4 P4, v0.12k): a purge work item must not keep a proof that no longer exists, or
        // nothing would drive it again.
        run(
          "UPDATE purge_work_items SET state = 'pending', absence_proof_attempt_id = NULL, updated_at = ? " +
            "WHERE owner_id = ? AND blob_key = ? AND state = 'absence_verified'",
          input.now,
          owner,
          input.blobKey,
        );
        return { updated: true, proven: false };
      }
      const haveSettledWriter =
        object.settled_writer_attempt_id !== null && object.settled_writer_incarnation !== null;
      // The reason is a lifecycle fact: it can be learned later (the writer's Promise settled after the reclaim) but is
      // never overwritten once set.
      const reason =
        (object.writer_settled_reason as string | null) ??
        (haveSettledWriter ? (input.writerSettledReason ?? null) : null);
      const canProve = input.absent && reason !== null && haveSettledWriter;
      run(
        "UPDATE blob_objects SET absence_verified_at = ?, absence_verified_attempt_id = ?, " +
          "writer_settled_reason = COALESCE(writer_settled_reason, ?), updated_at = ? WHERE owner_id = ? AND blob_key = ? AND state = 'deleted'",
        canProve ? input.now : null,
        canProve ? `tombstone:${input.now}` : null,
        reason,
        input.now,
        owner,
        input.blobKey,
      );
      return { updated: true, proven: canProve };
    });

  // ------------------------------------------------------------------ reads

  const blobStats = (input: { principal: Principal }): BlobStats => {
    const owner = input.principal.ownerId;
    const objects: Record<string, number> = {};
    for (const row of all(
      "SELECT state, COUNT(*) AS c FROM blob_objects WHERE owner_id = ? GROUP BY state",
      owner,
    )) {
      objects[String(row.state)] = Number(row.c);
    }
    const reservations: Record<string, number> = {};
    for (const row of all(
      "SELECT state, COUNT(*) AS c FROM blob_reservations WHERE owner_id = ? GROUP BY state",
      owner,
    )) {
      reservations[String(row.state)] = Number(row.c);
    }
    return {
      ownerBytes: ownerUsedBytes(owner),
      objects,
      reservations,
      evidenceWithBlob: Number(
        (
          one(
            "SELECT COUNT(*) AS c FROM evidence WHERE owner_id = ? AND blob_key IS NOT NULL",
            owner,
          ) as Row
        ).c,
      ),
      tombstonesWithoutProof: Number(
        (
          one(
            "SELECT COUNT(*) AS c FROM blob_objects WHERE owner_id = ? AND state = 'deleted' AND absence_verified_at IS NULL",
            owner,
          ) as Row
        ).c,
      ),
    };
  };

  const listBlobObjects = (input: {
    principal: Principal;
    limit: number;
  }): Array<{ blobKey: string; state: string; byteSize: number; refCount: number }> =>
    all(
      "SELECT blob_key, state, byte_size, ref_count FROM blob_objects WHERE owner_id = ? " +
        "AND (state <> 'deleted' OR absence_verified_at IS NULL) ORDER BY created_at, blob_key LIMIT ?",
      input.principal.ownerId,
      input.limit,
    ).map((row) => ({
      blobKey: asText(row.blob_key),
      state: String(row.state),
      byteSize: Number(row.byte_size),
      refCount: Number(row.ref_count),
    }));

  const listEvidence = (input: {
    principal: Principal;
    taskId: string;
    onlyUnlinked?: boolean;
    limit: number;
  }): EvidenceBlobView[] => {
    const owner = input.principal.ownerId;
    return all(
      "SELECT e.* FROM evidence e WHERE e.owner_id = ? AND e.task_id = ? " +
        (input.onlyUnlinked
          ? "AND NOT EXISTS (SELECT 1 FROM claim_evidence_links l WHERE l.owner_id = e.owner_id AND l.task_id = e.task_id AND l.evidence_id = e.id AND l.effective = 1) "
          : "") +
        "ORDER BY e.captured_at DESC, e.id DESC LIMIT ?",
      owner,
      input.taskId,
      input.limit,
    ).map((row) => ({
      evidenceId: String(row.id),
      taskId: String(row.task_id),
      kind: String(row.kind),
      blobKey: (row.blob_key as string | null) ?? null,
      contentHash: String(row.content_hash),
      byteSize: row.byte_size === null ? null : Number(row.byte_size),
      sourceGroup: String(row.source_group),
      classification: String(row.content_classification),
      redactionState: String(row.redaction_state),
      meta: row.meta_json === null ? null : parseJson(row.meta_json),
      capturedAt: Number(row.captured_at),
      linkedClaimIds: all(
        "SELECT claim_id FROM claim_evidence_links WHERE owner_id = ? AND task_id = ? AND evidence_id = ? AND effective = 1 ORDER BY claim_id",
        owner,
        input.taskId,
        String(row.id),
      ).map((link) => String(link.claim_id)),
    }));
  };

  /** Read-only lookup for the read-handle path: scoped to owner AND task, never returns bytes. */
  const evidenceReadRef = (input: {
    principal: Principal;
    taskId: string;
    evidenceId: string;
  }): EvidenceReadRef => {
    const row = one(
      "SELECT id, task_id, blob_key, content_hash, byte_size, content_classification, redaction_state, meta_json FROM evidence " +
        "WHERE owner_id = ? AND task_id = ? AND id = ?",
      input.principal.ownerId,
      input.taskId,
      input.evidenceId,
    );
    if (!row) {
      return { outcome: "not_found" };
    }
    if (
      row.blob_key === null ||
      row.byte_size === null ||
      String(row.redaction_state) === "purged"
    ) {
      return { outcome: "no_bytes", redactionState: String(row.redaction_state) };
    }
    return {
      outcome: "found",
      evidenceId: String(row.id),
      taskId: String(row.task_id),
      blobKey: asText(row.blob_key),
      contentHash: String(row.content_hash),
      byteSize: Number(row.byte_size),
      classification: String(row.content_classification),
      meta: row.meta_json === null ? null : parseJson(row.meta_json),
    };
  };

  return {
    blobPrecheck,
    evidenceReadRef,
    blobPlan,
    blobAdmit,
    blobGcClaim,
    blobGcSettle,
    blobTombstones,
    blobTombstoneChecked,
    blobStats,
    listBlobObjects,
    listEvidence,
  };
}

export type BlobLedger = ReturnType<typeof createBlobLedger>;
