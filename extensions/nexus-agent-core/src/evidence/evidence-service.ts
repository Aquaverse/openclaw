/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
// Evidence service (DESIGN sections 9.4 / 9.5.1): the asynchronous half of the four-phase evidence protocol.
//
//   A0  store.blobPrecheck      sync   authorisation + quotas, before a single byte is read or written
//   A1  hash, identity, store.blobPlan   (sync tx) reuse_evidence | attach_live_object | new_object (+ reservation);
//       only new_object stages the bytes
//   A2  production.put          the LAST await. registerIfAbsent cannot be cancelled, so a late write is possible and
//       is made harmless by the key `<hash>.<generation>` (never reused) plus the attempt CAS in phase B
//   B   store.blobAdmit         ONE sync tx that revalidates everything and consumes the reservation
//
// Residue: staging copies are deleted best-effort; a failed B leaves the reservation `reserved`, counting against the quota,
// until `maintain()` reclaims it after expiry. Bytes only ever arrive here from the operator upload RPC or from a blob
// already held by this owner - never from model-supplied parameters.
import { createHash, randomBytes } from "node:crypto";
import type {
  BlobAdmitOutcome,
  BlobGcItem,
  BlobPlan,
  BlobSourceFacts,
  BlobTombstone,
  ContentClassification,
  EvidenceLeases,
  EvidenceLimits,
  OperatorRelation,
  QuotaExceeded,
} from "../store/blob-types.js";
import { USER_UPLOAD_GROUP } from "../store/blob-types.js";
import type { TaskStore } from "../store/host.js";
import type { Principal } from "../store/types.js";
import { EvidenceBytesUnavailableError, type EvidenceBlobStores } from "./blob-store.js";

const MB = 1024 * 1024;

export type EvidenceConfig = {
  limits: EvidenceLimits;
  leases: EvidenceLeases;
  /** Zero-reference live objects younger than this are left to a concurrent attach. */
  zeroRefGraceMs: number;
  /** A tombstone is re-deleted (and re-checked) at most this often. */
  tombstoneIntervalMs: number;
  /**
   * `incarnation_gone` (DESIGN 9.5.1): trust "the writer's process has terminated" as the reason a writer is quiet. Off by
   * default; the operator turns it on only after the enablement checklist holds. Also makes the service terminate other
   * boot ids' incarnation rows when it registers itself.
   */
  incarnationGoneEnabled: boolean;
};

export const DEFAULT_EVIDENCE_CONFIG: EvidenceConfig = {
  limits: { taskQuotaBytes: 200 * MB, ownerQuotaBytes: 400 * MB, maxEntryBytes: 16 * MB },
  leases: { writerLeaseMs: 30_000, reservationTtlMs: 60_000, reclaimLeaseMs: 60_000 },
  zeroRefGraceMs: 60_000,
  tombstoneIntervalMs: 10 * 60_000,
  incarnationGoneEnabled: false,
};

export type EvidenceOutcome =
  | Exclude<BlobAdmitOutcome, { outcome: "quota_exceeded" }>
  | (QuotaExceeded & { noticeDecisionId: string | null })
  | { outcome: "ref_not_found" }
  | { outcome: "ref_not_ready"; state: string }
  | { outcome: "busy"; state: string; retryAfterMs: number }
  | { outcome: "storage_error"; stage: "stage" | "promote" | "read"; message: string }
  | { outcome: "blob_corrupt"; blobKey: string; reason: "missing" | "hash_mismatch" };

export type EvidenceServiceDeps = {
  getStore: () => Promise<TaskStore>;
  blobs: EvidenceBlobStores;
  /**
   * Row in process_incarnations for this process (blob_objects.writer_incarnation references it). A function so the
   * value can follow the registration that actually recorded the row (see task-module.ts `processIncarnation`).
   */
  incarnationId: string | (() => string);
  config?: Partial<Omit<EvidenceConfig, "limits" | "leases">> & {
    limits?: Partial<EvidenceLimits>;
    leases?: Partial<EvidenceLeases>;
  };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Test seam: awaited between the byte write (A2) and phase B. Production wiring never sets it; only the spike module
   * (src/spikes/crash-window.ts, behind `spikesEnabled`) and tests do, to hold a crash probe inside that window.
   */
  afterA2?: () => Promise<void>;
  newId?: (prefix: string) => string;
  /** The service wrote outbox rows (claim_changed / decision_pending): ask the runtime to deliver them. */
  onOutboxWritten?: () => void;
  /** An evidence row was registered without a claim link (claim links notify through the outbox instead). */
  onEvidenceRegistered?: (payload: { ownerId: string; taskId: string; evidenceId: string }) => void;
  logger?: { warn: (message: string) => void; info?: (message: string) => void };
};

// Module-level on purpose, like the store hosts: a service reload creates a new EvidenceService in the same process,
// and the writers the previous one started are still real Promises that cannot be cancelled. The registry is how
// `maintain()` knows a writer has settled (`awaited`, DESIGN 9.5.1) and how stop() knows it may mark a clean shutdown.
const inflightWriters = new Map<string, Promise<void>>();
const inflightByBlobKey = new Map<string, Promise<void>>();

/** Writers whose real Promise we saw settle in this process (bounded). A settled writer is proof its I/O is over. */
const settledWriters = new Set<string>();
const SETTLED_WRITERS_CAP = 2_000;
const rememberSettled = (writerKey: string) => {
  settledWriters.add(writerKey);
  if (settledWriters.size > SETTLED_WRITERS_CAP) {
    const oldest = settledWriters.values().next().value;
    if (oldest !== undefined) {
      settledWriters.delete(oldest);
    }
  }
};

export function inflightWriterCount(): number {
  return inflightWriters.size;
}

function replaceControlChars(value: string, replacement: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? replacement : ch;
  }
  return out;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function normalizeUploadName(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const cleaned = replaceControlChars(raw.normalize("NFC"), "").trim();
  const name = Array.from(cleaned).slice(0, 200).join("");
  return name.length > 0 ? name : undefined;
}

const MAX_WAIT_LOOPS = 6;

/** A read handle is a short-lived capability to read ONE piece of evidence in chunks (DESIGN 9.4): never persisted. */
export const READ_HANDLE_TTL_MS = 60_000;
export const READ_CHUNK_BYTES = 1024 * 1024;
const READ_HANDLE_CAP = 200;

type ReadHandle = {
  ownerId: string;
  taskId: string;
  evidenceId: string;
  expiresAt: number;
};

export type ReadHandleOpen =
  | {
      outcome: "opened";
      handleId: string;
      expiresAt: number;
      evidenceId: string;
      byteSize: number;
      contentHash: string;
      classification: string;
      meta: unknown;
      chunkBytes: number;
    }
  | { outcome: "not_found" }
  | { outcome: "no_bytes"; redactionState: string };

export type ReadHandleRead =
  | {
      outcome: "chunk";
      data: Uint8Array;
      offset: number;
      totalBytes: number;
      eof: boolean;
      contentHash: string;
    }
  | { outcome: "handle_invalid" }
  | { outcome: "gone" }
  | { outcome: "out_of_range"; totalBytes: number }
  | { outcome: "integrity_error"; reason: "missing" | "hash_mismatch" | "size_mismatch" }
  | { outcome: "storage_error"; message: string };

export function createEvidenceService(deps: EvidenceServiceDeps) {
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const newId =
    deps.newId ??
    ((prefix: string) => {
      const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
      return `${prefix}${[...randomBytes(10)].map((byte) => alphabet[byte % 32]).join("")}`;
    });
  const config: EvidenceConfig = {
    ...DEFAULT_EVIDENCE_CONFIG,
    ...deps.config,
    limits: { ...DEFAULT_EVIDENCE_CONFIG.limits, ...deps.config?.limits },
    leases: { ...DEFAULT_EVIDENCE_CONFIG.leases, ...deps.config?.leases },
  };
  // A reservation must outlive the writer lease it was created with: reclaim needs both to be over (DESIGN 9.5.1).
  config.leases.reservationTtlMs = Math.max(
    config.leases.reservationTtlMs,
    config.leases.writerLeaseMs,
  );

  const noticeQuota = async (
    principal: Principal,
    taskId: string,
    exceeded: QuotaExceeded,
  ): Promise<string | null> => {
    if (exceeded.scope === "entry") {
      return null;
    }
    try {
      const store = await deps.getStore();
      const mb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;
      const created = await store.createDecision({
        principal,
        taskId,
        effectKind: "acknowledge",
        actionIds: [],
        sessionKey: null,
        runId: null,
        toolCallId: null,
        notice: {
          decisionType: "evidence_quota",
          question: `证据空间已满，新的证据没有保存（${exceeded.scope === "task" ? "事项" : "账户"}额度 ${mb(exceeded.limit)}，已用 ${mb(exceeded.used)}，这次需要 ${mb(exceeded.requested)}）。`,
          facts: {
            taskId,
            scope: exceeded.scope,
            limitBytes: exceeded.limit,
            usedBytes: exceeded.used,
            requestedBytes: exceeded.requested,
          },
          unknowns: [
            "这条证据没有被保存，也没有挂到任何 claim 上；相关结论仍然只是未经证实的说法。",
            "腾出空间（删除不再需要的证据）或调高额度后，需要重新提交这份证据。",
          ],
        },
        now: now(),
      });
      deps.onOutboxWritten?.();
      return created.outcome === "created" ||
        created.outcome === "replayed" ||
        created.outcome === "reused_pending"
        ? created.decision.id
        : null;
    } catch (error) {
      deps.logger?.warn(
        `nexus-agent-core: could not create the evidence quota notice: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };

  const failedQuota = async (
    principal: Principal,
    taskId: string,
    exceeded: QuotaExceeded,
  ): Promise<EvidenceOutcome> => ({
    ...exceeded,
    noticeDecisionId: await noticeQuota(principal, taskId, exceeded),
  });

  type RegisterArgs = {
    principal: Principal;
    taskId: string;
    claimId?: string;
    expectedHeadEventId?: string;
    operatorRelation?: OperatorRelation;
    actor: string;
    eventSource: "store" | "operator";
    bytes: Uint8Array;
    contentHash: string;
    facts: BlobSourceFacts;
  };

  /** Phase A1 (decision) -> A2 -> B, for one piece of material. Called after A0 passed. */
  const planAndAdmit = async (args: RegisterArgs): Promise<EvidenceOutcome> => {
    const store = await deps.getStore();
    const owner = args.principal.ownerId;
    for (let loop = 0; loop < MAX_WAIT_LOOPS; loop += 1) {
      const attemptId = newId("W");
      const planned = await store.blobPlan({
        principal: args.principal,
        taskId: args.taskId,
        ...(args.claimId ? { claimId: args.claimId } : {}),
        contentHash: args.contentHash,
        byteSize: args.bytes.byteLength,
        facts: args.facts,
        attemptId,
        incarnationId:
          typeof deps.incarnationId === "function" ? deps.incarnationId() : deps.incarnationId,
        limits: config.limits,
        leases: config.leases,
        now: now(),
      });
      if (planned.outcome === "quota_exceeded") {
        return failedQuota(args.principal, args.taskId, planned);
      }
      if (planned.outcome === "wait") {
        // Same content is being written or reclaimed: never assume the result, plan again afterwards.
        const local = inflightByBlobKey.get(planned.blobKey);
        if (local) {
          await local;
          await sleep(25);
        } else if (loop === MAX_WAIT_LOOPS - 1) {
          return { outcome: "busy", state: planned.state, retryAfterMs: planned.retryAfterMs };
        } else {
          await sleep(Math.min(planned.retryAfterMs, 1_500));
        }
        continue;
      }
      if (planned.outcome !== "planned") {
        return planned;
      }
      const admitFor = (plan: BlobPlan) =>
        store.blobAdmit({
          principal: args.principal,
          taskId: args.taskId,
          ...(args.claimId ? { claimId: args.claimId } : {}),
          ...(args.expectedHeadEventId ? { expectedHeadEventId: args.expectedHeadEventId } : {}),
          plan,
          contentHash: args.contentHash,
          byteSize: args.bytes.byteLength,
          facts: args.facts,
          ...(args.operatorRelation ? { operatorRelation: args.operatorRelation } : {}),
          limits: config.limits,
          eventSource: args.eventSource,
          actor: args.actor,
          now: now(),
        });
      const finish = async (outcome: BlobAdmitOutcome): Promise<EvidenceOutcome> => {
        if (outcome.outcome === "quota_exceeded") {
          return failedQuota(args.principal, args.taskId, outcome);
        }
        if (outcome.outcome === "linked") {
          deps.onOutboxWritten?.();
        } else if (outcome.outcome === "registered" && !outcome.reusedEvidence) {
          deps.onEvidenceRegistered?.({
            ownerId: owner,
            taskId: args.taskId,
            evidenceId: outcome.evidenceId,
          });
        }
        return outcome;
      };
      const plan = planned.plan;
      if (plan.branch !== "new_object") {
        // reuse_evidence / attach_live_object: the bytes are already in the production namespace. Straight to B.
        return finish(await admitFor(plan));
      }

      // ---- new_object: stage, promote, admit ----
      const production = await deps.blobs.production(owner);
      const staging = await deps.blobs.staging(owner);
      const dropStaging = async () => {
        try {
          await staging.remove(plan.reservationId);
        } catch {
          // best effort: the staging namespace is evict-oldest with a TTL
        }
      };
      try {
        await staging.put(plan.reservationId, args.bytes);
      } catch (error) {
        return {
          outcome: "storage_error",
          stage: "stage",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      // A2. The real Promise is what the registry tracks: settling (resolve OR reject) is the only evidence that the
      // write is over - the lease expiring is not.
      const write = production.put(plan.blobKey, args.bytes);
      const settled = write.then(
        () => undefined,
        () => undefined,
      );
      const writerKey = `${plan.blobKey}#${plan.attemptId}`;
      inflightWriters.set(writerKey, settled);
      inflightByBlobKey.set(plan.blobKey, settled);
      void settled.finally(() => {
        rememberSettled(writerKey);
        inflightWriters.delete(writerKey);
        if (inflightByBlobKey.get(plan.blobKey) === settled) {
          inflightByBlobKey.delete(plan.blobKey);
        }
      });
      let created: boolean;
      try {
        created = await write;
      } catch (error) {
        await dropStaging();
        return {
          outcome: "storage_error",
          stage: "promote",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (!created) {
        // The key already existed. Keys carry a fresh generation, so this is not ours to trust: fail closed.
        await dropStaging();
        return {
          outcome: "storage_error",
          stage: "promote",
          message: `blob key ${plan.blobKey} already existed`,
        };
      }
      await deps.afterA2?.();
      const admitted = await admitFor(plan);
      await dropStaging();
      return finish(admitted);
    }
    return { outcome: "busy", state: "writing", retryAfterMs: 1_000 };
  };

  const mapPrecheckFailure = async (
    principal: Principal,
    taskId: string,
    failed: Exclude<Awaited<ReturnType<TaskStore["blobPrecheck"]>>, { outcome: "ok" }>,
  ): Promise<EvidenceOutcome> =>
    failed.outcome === "quota_exceeded" ? failedQuota(principal, taskId, failed) : failed;

  /**
   * Delete the bytes of reclaim items that the caller has just CLAIMED, then settle them (object -> `deleted` tombstone,
   * reservation -> abandoned). The writer's real Promise may still be in flight in THIS process: it is awaited first,
   * otherwise its write could land after the delete. Another process's writers are not visible here.
   */
  const reclaimItems = async (
    principal: Principal,
    items: BlobGcItem[],
  ): Promise<{ deleted: number; skipped: Array<{ blobKey: string; reason: string }> }> => {
    if (items.length === 0) {
      return { deleted: 0, skipped: [] };
    }
    const store = await deps.getStore();
    const production = await deps.blobs.production(principal.ownerId);
    const settleItems: Array<BlobGcItem & { absent: boolean; writerSettledReason?: "awaited" }> =
      [];
    for (const item of items) {
      try {
        let reason: "awaited" | undefined;
        if (item.writerAttemptId) {
          const writerKey = `${item.blobKey}#${item.writerAttemptId}`;
          const pending = inflightWriters.get(writerKey);
          if (pending) {
            await pending;
            reason = "awaited";
          } else if (settledWriters.has(writerKey)) {
            reason = "awaited";
          }
        }
        await production.remove(item.blobKey);
        const still = await production.get(item.blobKey);
        settleItems.push({
          ...item,
          absent: still === undefined,
          ...(reason ? { writerSettledReason: reason } : {}),
        });
      } catch (error) {
        // Leave it `reclaiming`: the lease runs out and a later pass takes it over with a new attempt id.
        deps.logger?.warn(
          `nexus-agent-core: evidence reclaim of ${item.blobKey} failed, will retry: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return settleItems.length > 0
      ? await store.blobGcSettle({ principal, items: settleItems, now: now() })
      : { deleted: 0, skipped: [] };
  };

  /**
   * Tombstones: delete again by key (idempotent, keys are never reused) to catch a late write. A writer whose Promise
   * settled in this process AFTER the reclaim is recognised here, so its object can finally get the absence proof.
   * Returns how many had bytes again.
   */
  const recheckTombstones = async (
    principal: Principal,
    tombstones: BlobTombstone[],
  ): Promise<number> => {
    if (tombstones.length === 0) {
      return 0;
    }
    const store = await deps.getStore();
    const production = await deps.blobs.production(principal.ownerId);
    let reappeared = 0;
    for (const tombstone of tombstones) {
      try {
        const writerKey = `${tombstone.blobKey}#${tombstone.settledWriterAttemptId ?? ""}`;
        // Read the registries BEFORE the delete: a writer that is already settled cannot write after it.
        const writerSettled =
          tombstone.writerSettledReason === null &&
          tombstone.settledWriterAttemptId !== null &&
          settledWriters.has(writerKey) &&
          !inflightWriters.has(writerKey);
        const removed = await production.remove(tombstone.blobKey);
        const absent = removed ? false : (await production.get(tombstone.blobKey)) === undefined;
        if (removed) {
          reappeared += 1;
        }
        await store.blobTombstoneChecked({
          principal,
          blobKey: tombstone.blobKey,
          reappeared: removed,
          absent,
          ...(writerSettled ? { writerSettledReason: "awaited" as const } : {}),
          now: now(),
        });
      } catch (error) {
        deps.logger?.warn(
          `nexus-agent-core: tombstone re-delete of ${tombstone.blobKey} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return reappeared;
  };

  // Handles live only in this process: a restart invalidates them, which is fine for a 60 s capability.
  const handles = new Map<string, ReadHandle>();
  const sweepHandles = () => {
    const current = now();
    for (const [id, handle] of handles) {
      if (handle.expiresAt <= current) {
        handles.delete(id);
      }
    }
    while (handles.size >= READ_HANDLE_CAP) {
      const oldest = handles.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      handles.delete(oldest);
    }
  };

  return {
    config,

    /**
     * `nexus.evidence.handle`: a short-lived capability to read ONE piece of evidence, scoped to owner + Task + evidence.
     * It carries no bytes. Reading re-checks the evidence row, so a deletion or purge in between closes it.
     */
    async openReadHandle(
      principal: Principal,
      taskId: string,
      evidenceId: string,
    ): Promise<ReadHandleOpen> {
      const store = await deps.getStore();
      const ref = await store.evidenceReadRef({ principal, taskId, evidenceId });
      if (ref.outcome !== "found") {
        return ref;
      }
      sweepHandles();
      const handleId = newId("EH");
      const expiresAt = now() + READ_HANDLE_TTL_MS;
      handles.set(handleId, { ownerId: principal.ownerId, taskId, evidenceId, expiresAt });
      return {
        outcome: "opened",
        handleId,
        expiresAt,
        evidenceId,
        byteSize: ref.byteSize,
        contentHash: ref.contentHash,
        classification: ref.classification,
        meta: ref.meta,
        chunkBytes: READ_CHUNK_BYTES,
      };
    },

    /**
     * `nexus.evidence.read`: one chunk. The WHOLE object is read and hashed every time and compared with the registered
     * hash: altered or missing bytes are never served, however short the handle lives.
     */
    async readHandle(
      principal: Principal,
      handleId: string,
      offset: number,
      length: number,
    ): Promise<ReadHandleRead> {
      const handle = handles.get(handleId);
      if (!handle || handle.ownerId !== principal.ownerId || handle.expiresAt <= now()) {
        handles.delete(handleId);
        return { outcome: "handle_invalid" };
      }
      const store = await deps.getStore();
      const ref = await store.evidenceReadRef({
        principal,
        taskId: handle.taskId,
        evidenceId: handle.evidenceId,
      });
      if (ref.outcome !== "found") {
        handles.delete(handleId);
        return { outcome: "gone" };
      }
      if (!Number.isInteger(offset) || offset < 0 || offset > ref.byteSize) {
        return { outcome: "out_of_range", totalBytes: ref.byteSize };
      }
      const size = Math.min(Math.max(Math.floor(length), 1), READ_CHUNK_BYTES);
      let bytes: Uint8Array | undefined;
      try {
        bytes = await (await deps.blobs.production(principal.ownerId)).get(ref.blobKey);
      } catch (error) {
        if (error instanceof EvidenceBytesUnavailableError) {
          throw error;
        }
        return {
          outcome: "storage_error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (!bytes) {
        return { outcome: "integrity_error", reason: "missing" };
      }
      if (bytes.byteLength !== ref.byteSize) {
        return { outcome: "integrity_error", reason: "size_mismatch" };
      }
      if (sha256Bytes(bytes) !== ref.contentHash) {
        return { outcome: "integrity_error", reason: "hash_mismatch" };
      }
      const end = Math.min(offset + size, bytes.byteLength);
      return {
        outcome: "chunk",
        data: bytes.slice(offset, end),
        offset,
        totalBytes: bytes.byteLength,
        eof: end >= bytes.byteLength,
        contentHash: ref.contentHash,
      };
    },

    /**
     * Operator upload: the bytes arrive through the RPC, never through the model. With a claimId the evidence is linked in
     * the same phase B (relation must then be declared by the operator); without one it is only registered on the Task and
     * an Agent can attach it later with a `blob` ref.
     */
    async upload(input: {
      principal: Principal;
      taskId: string;
      claimId?: string;
      expectedHeadEventId?: string;
      name: string;
      mediaType?: string;
      note?: string;
      locator?: string;
      version?: string;
      classification: ContentClassification;
      bytes: Uint8Array;
      operatorRelation?: OperatorRelation;
      actor: string;
    }): Promise<EvidenceOutcome> {
      const store = await deps.getStore();
      const precheck = await store.blobPrecheck({
        principal: input.principal,
        taskId: input.taskId,
        ...(input.claimId ? { claimId: input.claimId } : {}),
        ...(input.expectedHeadEventId ? { expectedHeadEventId: input.expectedHeadEventId } : {}),
        source: {
          kind: "upload",
          byteSize: input.bytes.byteLength,
          contentHash: sha256Bytes(input.bytes),
        },
        limits: config.limits,
        now: now(),
      });
      if (precheck.outcome !== "ok") {
        return mapPrecheckFailure(input.principal, input.taskId, precheck);
      }
      const facts: BlobSourceFacts = {
        kind: "uploaded_file",
        locator: input.locator ?? `upload:${input.name}`,
        version: input.version ?? null,
        sourceGroup: USER_UPLOAD_GROUP,
        classification: input.classification,
        meta: {
          name: input.name,
          ...(input.mediaType ? { mediaType: input.mediaType } : {}),
          ...(input.note ? { note: input.note } : {}),
          uploadedBy: input.actor,
        },
      };
      return planAndAdmit({
        principal: input.principal,
        taskId: input.taskId,
        ...(input.claimId ? { claimId: input.claimId } : {}),
        ...(input.expectedHeadEventId ? { expectedHeadEventId: input.expectedHeadEventId } : {}),
        ...(input.operatorRelation ? { operatorRelation: input.operatorRelation } : {}),
        actor: input.actor,
        eventSource: "operator",
        bytes: input.bytes,
        contentHash: sha256Bytes(input.bytes),
        facts,
      });
    },

    /** `blob` ref: a physical object this owner already holds, attached to a claim of this Task. */
    async attachBlob(input: {
      principal: Principal;
      taskId: string;
      claimId: string;
      blobKey: string;
      expectedHeadEventId?: string;
      operatorRelation?: OperatorRelation;
      actor: string;
      eventSource: "store" | "operator";
    }): Promise<EvidenceOutcome> {
      const store = await deps.getStore();
      const precheck = await store.blobPrecheck({
        principal: input.principal,
        taskId: input.taskId,
        claimId: input.claimId,
        ...(input.expectedHeadEventId ? { expectedHeadEventId: input.expectedHeadEventId } : {}),
        source: { kind: "blob", blobKey: input.blobKey },
        limits: config.limits,
        now: now(),
      });
      if (precheck.outcome !== "ok") {
        return mapPrecheckFailure(input.principal, input.taskId, precheck);
      }
      const ref = precheck.ref;
      if (!ref) {
        return { outcome: "ref_not_found" };
      }
      let bytes: Uint8Array | undefined;
      try {
        bytes = await (await deps.blobs.production(input.principal.ownerId)).get(ref.blobKey);
      } catch (error) {
        if (error instanceof EvidenceBytesUnavailableError) {
          throw error;
        }
        return {
          outcome: "storage_error",
          stage: "read",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      // The row says live; the bytes must agree. A missing or altered object is never linked as evidence.
      if (!bytes) {
        return { outcome: "blob_corrupt", blobKey: ref.blobKey, reason: "missing" };
      }
      if (sha256Bytes(bytes) !== ref.contentHash) {
        return { outcome: "blob_corrupt", blobKey: ref.blobKey, reason: "hash_mismatch" };
      }
      return planAndAdmit({
        principal: input.principal,
        taskId: input.taskId,
        claimId: input.claimId,
        ...(input.expectedHeadEventId ? { expectedHeadEventId: input.expectedHeadEventId } : {}),
        ...(input.operatorRelation ? { operatorRelation: input.operatorRelation } : {}),
        actor: input.actor,
        eventSource: input.eventSource,
        bytes,
        contentHash: ref.contentHash,
        facts: ref.facts,
      });
    },

    /**
     * Reclaim pass (DESIGN 9.5.1): expired reservations and orphaned objects first claimed in ONE transaction (so a
     * concurrent phase B and GC can never both win), then bytes deleted outside any transaction, then settled; plus the
     * tombstone re-delete scan. Safe to call at any time and from any trigger.
     */
    async maintain(principal: Principal): Promise<{
      claimed: number;
      deleted: number;
      abandonedWithoutObject: number;
      skipped: Array<{ blobKey: string; reason: string }>;
      tombstonesChecked: number;
      tombstonesReappeared: number;
      incarnationSettled: number;
    }> {
      const store = await deps.getStore();
      const claim = await store.blobGcClaim({
        principal,
        attemptId: newId("G"),
        limit: 25,
        leases: config.leases,
        zeroRefGraceMs: config.zeroRefGraceMs,
        now: now(),
      });
      const settled = await reclaimItems(principal, claim.items);
      // A writer in a process that is provably gone is quiet (DESIGN 9.5.1). Only when the operator enabled it.
      const incarnationSettled = config.incarnationGoneEnabled
        ? (await store.blobIncarnationSettle({ principal, limit: 100, now: now() })).settled.length
        : 0;
      const tombstones = await store.blobTombstones({
        principal,
        olderThanMs: config.tombstoneIntervalMs,
        limit: 25,
        now: now(),
      });
      const reappeared = await recheckTombstones(principal, tombstones);
      return {
        claimed: claim.items.length,
        deleted: settled.deleted,
        abandonedWithoutObject: claim.abandonedWithoutObject,
        skipped: settled.skipped,
        tombstonesChecked: tombstones.length,
        tombstonesReappeared: reappeared,
        incarnationSettled,
      };
    },

    /** Delete the bytes of items the CALLER has claimed (state `reclaiming`) and settle them. Shared with purge. */
    reclaim: reclaimItems,
    /** Delete tombstones again by key and record what the lookup found. Shared with purge. */
    recheckTombstones,

    /** gateway_start scan (DESIGN 9.4): compare the object table with the byte store. Reports; never deletes. */
    async reconcile(principal: Principal): Promise<{
      objects: number;
      storeKeys: number;
      missing: string[];
      sizeMismatch: string[];
      untracked: string[];
    }> {
      const store = await deps.getStore();
      const production = await deps.blobs.production(principal.ownerId);
      const [rows, keys] = await Promise.all([
        store.listBlobObjects({ principal, limit: 5_000 }),
        production.list(),
      ]);
      const inStore = new Map(keys.map((entry) => [entry.key, entry.sizeBytes]));
      const known = new Set(rows.map((row) => row.blobKey));
      const missing: string[] = [];
      const sizeMismatch: string[] = [];
      for (const row of rows) {
        if (row.state !== "live") {
          continue;
        }
        const size = inStore.get(row.blobKey);
        if (size === undefined) {
          missing.push(row.blobKey);
        } else if (size !== row.byteSize) {
          sizeMismatch.push(row.blobKey);
        }
      }
      const untracked = keys.map((entry) => entry.key).filter((key) => !known.has(key));
      return {
        objects: rows.length,
        storeKeys: keys.length,
        missing,
        sizeMismatch,
        untracked,
      };
    },

    /** Wait for this process's own in-flight writers; true when none are left. A clean shutdown may only be recorded then. */
    async drain(timeoutMs: number): Promise<boolean> {
      const deadline = now() + timeoutMs;
      while (inflightWriters.size > 0 && now() < deadline) {
        await Promise.race([Promise.all(inflightWriters.values()), sleep(50)]);
      }
      return inflightWriters.size === 0;
    },
  };
}

export type EvidenceService = ReturnType<typeof createEvidenceService>;
