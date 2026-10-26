/* oxlint-disable max-lines -- TODO: split this oversized file (one kernel/service unit per file for now). */
// Personal file vault service (Vault design 5.2 write protocol, 5.3 reclaim / tombstones / hard purge, 5.6 local import).
// The kernel (src/store/vault-ledger.ts, vault-maintenance-ledger.ts) does every synchronous transaction; this service
// does the asynchronous half: the bytes between R / W / P / C, the deletes behind reclaim and purge, and the maintenance
// loop. Rules it keeps:
//   * no write transaction ever spans an await - each kernel call is its own transaction, bytes move in between;
//   * every physical delete is preceded by a kernel ownership check (`vaultRecoverCheck`, `vaultReclaimClaim`), and a
//     delete of an absent key is success, so every step can be repeated after a crash;
//   * a reservation owned by a writer that is still running in THIS process (`inflight`) is never recovered from under it;
//   * the vault never registers a process incarnation: the plugin service does that once at start and hands the id in.
import { randomBytes, createHash } from "node:crypto";
import { DEFAULT_PURGE_RUN_LEASE_MS } from "../purge/purge-lease.js";
import type { StoreOperationName, StoreOperations } from "../store/contract.js";
import type { Principal } from "../store/types.js";
import type { VaultPurgeReceipt, VaultWriterQuiet } from "../store/vault-maintenance-types.js";
import {
  normalizeVaultFolder,
  normalizeVaultName,
  vaultObjectKey,
  vaultStagingKey,
  type VaultCollection,
  type VaultFileDraft,
  type VaultFileRecord,
  type VaultLimits,
  type VaultQuotaScope,
  type VaultSensitivity,
  type VaultSource,
} from "../store/vault-types.js";
import { createVaultExtractor, type VaultExtractConfig } from "./vault-extract.js";
import type { VaultFileStore } from "./vault-file-store.js";
import {
  ImportChangedError,
  openImportSource,
  type ImportGuardConfig,
  type ImportRefusal,
} from "./vault-import.js";
import { classifyVaultName, sniffVaultMime } from "./vault-rules.js";

type VaultOperationName = Extract<StoreOperationName, `vault${string}`>;
/** Exactly the vault slice of the store host; `TaskStore` is assignable to it. */
export type VaultStore = {
  [K in VaultOperationName]: (
    input: StoreOperations[K]["input"],
  ) => Promise<Awaited<StoreOperations[K]["output"]>>;
};

export type VaultConfig = {
  limits: VaultLimits;
  inboxRetentionMs: number;
  trashRetentionMs: number;
  reservationTtlMs: number;
  /** Refuse a write when the volume would drop below this many free bytes (the disk is shared with the user). */
  minFreeBytes: number;
  reservationRetentionMs: number;
  tombstoneRetentionMs: number;
  receiptHashRetentionMs: number;
  /** Objects younger than this are not reclaimed by maintenance (reclaim must not race a finishing reservation). */
  reclaimGraceMs: number;
  import: ImportGuardConfig;
  /** Text extraction (F2). Absent or `enabled: false`: no jobs are queued or run and nothing is ever searchable by content. */
  extract?: VaultExtractConfig;
};

export type VaultChangeEvent = {
  ownerId: string;
  fileId: string;
  action: "imported" | "discarded" | "purged" | "damaged" | "extracted";
  collection?: VaultCollection;
};

export type VaultServiceDeps = {
  getStore: () => Promise<VaultStore>;
  files: VaultFileStore;
  /** The incarnation the plugin service registered at start. */
  incarnationId: () => string;
  incarnationGoneEnabled: boolean;
  config: () => VaultConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: (prefix: string) => string;
  workerLeaseMs?: number;
  onChanged?: (event: VaultChangeEvent) => void;
  logger?: { warn: (message: string) => void; info?: (message: string) => void };
};

export type VaultBytes = Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

export type VaultIngestInput = {
  displayName: string;
  bytes: VaultBytes;
  /** Known size (upload, stat before import); lets R refuse early. */
  expectedSize?: number | null;
  source: VaultSource;
  sourceRef?: string | null;
  collection?: VaultCollection;
  folder?: string;
  importedBy: string;
};

export type VaultIngestOutcome =
  | {
      outcome: "ok";
      file: VaultFileRecord;
      /** true: the bytes already existed in this owner's vault and an existing object was reused (a new entry was still made). */
      deduplicated: boolean;
    }
  | { outcome: "invalid"; reason: "name" | "folder" | "collection" }
  | {
      outcome: "quota_exceeded";
      scope: VaultQuotaScope;
      limit: number;
      used: number;
      requested: number;
    }
  | { outcome: "disk_low"; freeBytes: number; requiredBytes: number }
  | { outcome: "writer_unregistered" }
  | { outcome: "write_failed"; message: string };

export type VaultImportOutcome =
  | VaultIngestOutcome
  | { outcome: "refused"; reason: ImportRefusal | "changed_during_read" };

export type VaultReadOutcome =
  | {
      outcome: "ok";
      bytes: Uint8Array;
      size: number;
      mime: string;
      displayName: string;
      sensitivity: VaultSensitivity;
      contentHash: string;
      eof: boolean;
    }
  | { outcome: "not_found" }
  | { outcome: "not_readable"; state: string }
  | { outcome: "bytes_missing" };

export type VaultPurgeOutcome =
  | { outcome: "purged"; receipt: VaultPurgeReceipt }
  | { outcome: "cleanup_pending"; purgeId: string; blockers: string[] }
  | { outcome: "worker_active"; purgeId: string; leaseUntil: number }
  | { outcome: "lost_lease"; purgeId: string }
  | { outcome: "invalid_state"; state: string }
  | { outcome: "not_found" };

export type VaultMaintainReport = {
  recovered: { expired: number; repaired: number; losersDeleted: number };
  reclaimed: number;
  proofsWritten: number;
  purgesResumed: number;
  inboxDiscarded: number;
  trashPurged: number;
  tombstonesRetired: number;
  reservationsPruned: number;
  receiptsCompacted: number;
  /** Files whose text was extracted during this pass. */
  extracted: number;
  checked: number;
  damaged: number;
  errors: string[];
};

const MAX_READ_BYTES = 4 * 1024 * 1024;
const HEAD_BYTES = 4096;
const COMMIT_ATTEMPTS = 4;
const MAINTAIN_BATCH = 100;
const VERIFY_BATCH = 200;

class TooLargeError extends Error {
  constructor(readonly seen: number) {
    super("file is larger than the single-file limit");
  }
}

const isAsyncIterable = (value: unknown): value is AsyncIterable<Uint8Array> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value;

export function createVaultService(deps: VaultServiceDeps) {
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
  const leaseMs = deps.workerLeaseMs ?? DEFAULT_PURGE_RUN_LEASE_MS;
  const warn = (message: string) => deps.logger?.warn(message);
  const extractor = createVaultExtractor({
    getStore: () => deps.getStore(),
    files: deps.files,
    config: () => deps.config().extract,
    now,
    warn,
    onProgress: (principal) => {
      deps.onChanged?.({ ownerId: principal.ownerId, fileId: "", action: "extracted" });
    },
  });

  /** A failed byte operation must not abort the whole pass: report "not confirmed" and let the next pass retry. */
  const confirmed = async (what: string, run: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await run();
    } catch (error) {
      warn(
        `vault: ${what} not confirmed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };

  /** Reservations whose writer is running in this process right now: recovery must leave them alone. */
  const inflight = new Set<string>();
  const verifyCursor = new Map<string, string | null>();

  /** `writerDone`: the caller IS the writer and has finished with the files (it is cleaning up after itself). */
  const quietFor = (reservationId: string, writerDone = false): VaultWriterQuiet => ({
    currentIncarnationId: deps.incarnationId(),
    awaited: writerDone || !inflight.has(reservationId),
    incarnationGoneEnabled: deps.incarnationGoneEnabled,
  });

  // ------------------------------------------------------------------ W: bytes to staging

  async function* chunksOf(bytes: VaultBytes): AsyncGenerator<Uint8Array> {
    if (bytes instanceof Uint8Array) {
      yield bytes;
    } else if (isAsyncIterable(bytes)) {
      for await (const chunk of bytes) {
        yield chunk;
      }
    } else {
      for (const chunk of bytes) {
        yield chunk;
      }
    }
  }

  async function writeStaging(
    stagingKey: string,
    bytes: VaultBytes,
    maxBytes: number,
  ): Promise<{ hash: string; size: number; head: Uint8Array }> {
    const writer = await deps.files.createStaging(stagingKey);
    const digest = createHash("sha256");
    const head = Buffer.alloc(HEAD_BYTES);
    let headLength = 0;
    let size = 0;
    try {
      for await (const chunk of chunksOf(bytes)) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          throw new TooLargeError(size);
        }
        if (headLength < HEAD_BYTES) {
          const take = Math.min(HEAD_BYTES - headLength, chunk.byteLength);
          head.set(chunk.subarray(0, take), headLength);
          headLength += take;
        }
        digest.update(chunk);
        await writer.write(chunk);
      }
      await writer.finish();
    } catch (error) {
      await writer.abort();
      throw error;
    }
    return { hash: digest.digest("hex"), size, head: new Uint8Array(head.subarray(0, headLength)) };
  }

  // ------------------------------------------------------------------ recovery helpers

  /**
   * Check, delete, record (design 5.2 recovery table). The check runs in the kernel right before the delete, the delete of
   * an absent key is success, and `vaultReservationExpire` re-checks everything in its own transaction.
   */
  async function abandonReservation(
    principal: Principal,
    reservationId: string,
    writerDone = false,
  ): Promise<boolean> {
    const store = await deps.getStore();
    const quiet = quietFor(reservationId, writerDone);
    const check = await store.vaultRecoverCheck({ principal, reservationId, now: now(), quiet });
    if (check.outcome !== "delete" || check.kind !== "expire") {
      return false;
    }
    for (const key of [check.stagingKey, check.objectKey]) {
      if (key) {
        await deps.files.remove(key);
      }
    }
    const done = await store.vaultReservationExpire({
      principal,
      reservationId,
      now: now(),
      quiet,
    });
    return done.outcome === "expired";
  }

  /** The failed side of a dedup race (or a reuse reservation's unneeded staging copy): delete after the 4-condition check. */
  async function deleteLoserFiles(
    principal: Principal,
    reservationId: string,
    writerDone = false,
  ): Promise<boolean> {
    const store = await deps.getStore();
    const check = await store.vaultRecoverCheck({
      principal,
      reservationId,
      now: now(),
      quiet: quietFor(reservationId, writerDone),
    });
    if (check.outcome !== "delete" || check.kind !== "loser_cleanup") {
      if (check.outcome === "skip" && check.reason === "object_row_exists") {
        warn(
          `vault: reservation ${reservationId} lost a race but an object row owns its file; nothing deleted`,
        );
      }
      return false;
    }
    for (const key of [check.stagingKey, check.objectKey]) {
      if (key) {
        await deps.files.remove(key);
      }
    }
    return true;
  }

  // ------------------------------------------------------------------ ingest: R, W, P, C

  async function ingest(
    principal: Principal,
    input: VaultIngestInput,
  ): Promise<VaultIngestOutcome> {
    const cfg = deps.config();
    const displayName = normalizeVaultName(input.displayName);
    if (displayName === null) {
      return { outcome: "invalid", reason: "name" };
    }
    const folder = normalizeVaultFolder(input.folder ?? "");
    if (folder === null) {
      return { outcome: "invalid", reason: "folder" };
    }
    const collection = input.collection ?? defaultCollection(input.source);
    const expected =
      input.expectedSize === undefined || input.expectedSize === null
        ? null
        : Math.max(0, input.expectedSize);
    const free = await deps.files.freeBytes();
    const required = (expected ?? 0) + cfg.minFreeBytes;
    if (free !== undefined && free < required) {
      return { outcome: "disk_low", freeBytes: free, requiredBytes: required };
    }
    const store = await deps.getStore();
    const reserved = await store.vaultReserve({
      principal,
      now: now(),
      expectedSize: expected,
      limits: cfg.limits,
      ttlMs: cfg.reservationTtlMs,
      writerAttemptId: newId("VW"),
      incarnationId: deps.incarnationId(),
    });
    if (reserved.outcome === "writer_unregistered") {
      return { outcome: "writer_unregistered" };
    }
    if (reserved.outcome === "quota_exceeded") {
      return {
        outcome: "quota_exceeded",
        scope: reserved.scope,
        limit: reserved.limit,
        used: reserved.used,
        requested: reserved.requested,
      };
    }
    const reservation = reserved.reservation;
    inflight.add(reservation.id);
    try {
      const outcome = await runWriteProtocol(principal, input, cfg, reservation, {
        displayName,
        folder,
        collection,
      });
      if (outcome.outcome === "ok" && cfg.extract?.enabled) {
        // Fire and forget: the caller never waits for parsing, and a failed pass is retried by the next maintenance tick.
        void kickExtract(principal);
      }
      return outcome;
    } finally {
      inflight.delete(reservation.id);
    }
  }

  const defaultCollection = (source: VaultSource): VaultCollection =>
    source === "task_output"
      ? "deliverable"
      : source === "upload" || source === "local_import"
        ? "vault"
        : "inbox";

  async function runWriteProtocol(
    principal: Principal,
    input: VaultIngestInput,
    cfg: VaultConfig,
    reservation: { id: string; newObjectId: string; stagingKey: string },
    resolved: { displayName: string; folder: string; collection: VaultCollection },
  ): Promise<VaultIngestOutcome> {
    const store = await deps.getStore();
    const fail = async (reason: "write_failed" | "rejected"): Promise<void> => {
      await store.vaultFailReservation({
        principal,
        reservationId: reservation.id,
        now: now(),
        reason,
      });
      await deps.files.remove(vaultStagingKey(reservation.id)).catch(() => undefined);
    };

    // W: bytes to staging, hashed on the way
    let written: { hash: string; size: number; head: Uint8Array };
    try {
      written = await writeStaging(
        vaultStagingKey(reservation.id),
        input.bytes,
        cfg.limits.maxFileBytes,
      );
    } catch (error) {
      await fail(error instanceof TooLargeError ? "rejected" : "write_failed");
      if (error instanceof TooLargeError) {
        return {
          outcome: "quota_exceeded",
          scope: "file",
          limit: cfg.limits.maxFileBytes,
          used: 0,
          requested: error.seen,
        };
      }
      if (error instanceof ImportChangedError) {
        return { outcome: "write_failed", message: "the source changed while it was being read" };
      }
      return {
        outcome: "write_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const marked = await store.vaultMarkWritten({
      principal,
      reservationId: reservation.id,
      contentHash: written.hash,
      byteSize: written.size,
      now: now(),
      limits: cfg.limits,
    });
    if (marked.outcome === "quota_exceeded") {
      await fail("rejected");
      return {
        outcome: "quota_exceeded",
        scope: marked.scope,
        limit: marked.limit,
        used: marked.used,
        requested: marked.requested,
      };
    }
    if (marked.outcome !== "written") {
      await fail("write_failed");
      return { outcome: "write_failed", message: `reservation not writable (${marked.outcome})` };
    }

    // P: reuse the winner or rename; C re-queries the winner anyway, so P's answer is only an optimisation
    const promote = async (): Promise<boolean> => {
      const plan = await store.vaultPlanPromote({ principal, reservationId: reservation.id });
      if (plan.outcome === "reuse") {
        return true;
      }
      if (plan.outcome !== "promote") {
        return false;
      }
      try {
        await deps.files.promote(
          vaultStagingKey(plan.stagingKey),
          vaultObjectKey(plan.newObjectId),
        );
      } catch (error) {
        warn(`vault: promote failed for ${reservation.id}: ${String(error)}`);
        return false;
      }
      const done = await store.vaultMarkPromoted({
        principal,
        reservationId: reservation.id,
        now: now(),
      });
      return done.outcome === "promoted";
    };
    if (!(await promote())) {
      await fail("write_failed");
      await abandonReservation(principal, reservation.id, true).catch(() => undefined);
      return { outcome: "write_failed", message: "could not move the file into the vault" };
    }

    const sensitive = classifyVaultName(resolved.displayName) === "sensitive";
    const draft: VaultFileDraft = {
      displayName: resolved.displayName,
      folder: resolved.folder,
      collection: resolved.collection,
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      importedBy: input.importedBy,
      ...(sensitive ? { sensitivity: "sensitive" as const, sensitivityBy: "rule" as const } : {}),
    };
    const mime = sniffVaultMime(written.head, resolved.displayName);

    // C: the only transaction that makes the file visible; may ask for P again when the winner it reused is gone
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt += 1) {
      const out = await store.vaultCommit({
        principal,
        reservationId: reservation.id,
        now: now(),
        mime,
        file: draft,
        inboxRetentionMs: cfg.inboxRetentionMs,
      });
      if (out.outcome === "need_promote") {
        if (!(await promote())) {
          break;
        }
        continue;
      }
      if (out.outcome === "committed") {
        if (!out.newObject) {
          // Our own bytes were not needed: delete them once the kernel confirms the reservation really lost.
          await deleteLoserFiles(principal, reservation.id, true).catch((error: unknown) =>
            warn(`vault: loser cleanup deferred for ${reservation.id}: ${String(error)}`),
          );
        }
        const got = await store.vaultGet({ principal, fileId: out.fileId });
        if (got.outcome !== "ok") {
          return { outcome: "write_failed", message: "committed file vanished" };
        }
        deps.onChanged?.({
          ownerId: principal.ownerId,
          fileId: out.fileId,
          action: "imported",
          collection: got.file.collection,
        });
        return { outcome: "ok", file: got.file, deduplicated: !out.newObject };
      }
      if (out.outcome === "invalid") {
        await abandonReservation(principal, reservation.id, true).catch(() => undefined);
        return { outcome: "invalid", reason: out.reason };
      }
      break; // noop / not_found: someone else settled it (an expiry); nothing is committed
    }
    await abandonReservation(principal, reservation.id, true).catch(() => undefined);
    return { outcome: "write_failed", message: "the reservation could not be committed" };
  }

  // ------------------------------------------------------------------ local path import

  async function importPath(
    principal: Principal,
    input: {
      path: string;
      importedBy: string;
      collection?: VaultCollection;
      folder?: string;
      displayName?: string;
    },
  ): Promise<VaultImportOutcome> {
    const cfg = deps.config();
    const opened = await openImportSource(input.path, {
      ...cfg.import,
      maxBytes: Math.min(cfg.import.maxBytes, cfg.limits.maxFileBytes),
    });
    if (!opened.ok) {
      return { outcome: "refused", reason: opened.reason };
    }
    const { source } = opened;
    try {
      return await ingest(principal, {
        displayName: input.displayName ?? source.displayName,
        bytes: source.chunks,
        expectedSize: source.size,
        source: "local_import",
        // Only the source TYPE is recorded: the full original path carries a user name and a directory structure.
        sourceRef: null,
        ...(input.collection ? { collection: input.collection } : {}),
        ...(input.folder !== undefined ? { folder: input.folder } : {}),
        importedBy: input.importedBy,
      });
    } finally {
      await source.close();
    }
  }

  // ------------------------------------------------------------------ read

  async function read(
    principal: Principal,
    input: {
      fileId: string;
      /** An older version; absent reads the current one. */
      seq?: number;
      offset?: number;
      length?: number;
      allowTrashed?: boolean;
    },
  ): Promise<VaultReadOutcome> {
    const store = await deps.getStore();
    const ref = await store.vaultReadRef({
      principal,
      fileId: input.fileId,
      ...(input.seq !== undefined ? { seq: input.seq } : {}),
      ...(input.allowTrashed ? { allowTrashed: true } : {}),
      touchAt: now(),
    });
    if (ref.outcome === "not_found") {
      return { outcome: "not_found" };
    }
    if (ref.outcome === "not_readable") {
      return { outcome: "not_readable", state: ref.state };
    }
    const key = vaultObjectKey(ref.objectId);
    if (!(await deps.files.stat(key))) {
      return { outcome: "bytes_missing" };
    }
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const length = Math.min(
      MAX_READ_BYTES,
      Math.max(0, Math.floor(input.length ?? MAX_READ_BYTES)),
    );
    const bytes = await deps.files.readRange(key, offset, length);
    return {
      outcome: "ok",
      bytes,
      size: ref.size,
      mime: ref.mime,
      displayName: ref.displayName,
      sensitivity: ref.sensitivity,
      contentHash: ref.contentHash,
      eof: offset + bytes.byteLength >= ref.size,
    };
  }

  // ------------------------------------------------------------------ reclaim

  /**
   * Steps after an object was claimed for reclaim: purge its derived rows, delete bytes and derivatives, look again, and
   * only then settle (the absence proof). Any step that cannot be confirmed leaves the object `reclaiming`; its lease
   * expires and the next pass takes over.
   */
  async function finishReclaim(
    principal: Principal,
    objectId: string,
    reclaimAttemptId: string,
    purgeRef?: { fileId: string; purgeId: string },
  ): Promise<boolean> {
    const store = await deps.getStore();
    const data = await store.vaultReclaimPurgeData({
      principal,
      objectId,
      reclaimAttemptId,
      now: now(),
      leaseMs,
      ...(purgeRef ? { purgeRef } : {}),
    });
    if (data.outcome !== "ok") {
      return false;
    }
    await deps.files.remove(vaultObjectKey(objectId));
    await deps.files.removeDerived(objectId);
    if (await deps.files.stat(vaultObjectKey(objectId))) {
      return false;
    }
    const settled = await store.vaultReclaimSettle({
      principal,
      objectId,
      reclaimAttemptId,
      now: now(),
    });
    return settled.outcome === "deleted";
  }

  async function proveAbsence(principal: Principal, objectId: string): Promise<boolean> {
    const store = await deps.getStore();
    await deps.files.remove(vaultObjectKey(objectId));
    await deps.files.removeDerived(objectId);
    if (await deps.files.stat(vaultObjectKey(objectId))) {
      return false;
    }
    const proof = await store.vaultAbsenceProof({
      principal,
      objectId,
      attemptId: newId("VA"),
      now: now(),
    });
    return proof.outcome === "proved";
  }

  // ------------------------------------------------------------------ hard purge

  async function purge(
    principal: Principal,
    fileId: string,
    requestedBy: string,
    options: { budgetMs?: number } = {},
  ): Promise<VaultPurgeOutcome> {
    const store = await deps.getStore();
    const workerAttemptId = newId("VPW");
    const begin = await store.vaultPurgeBegin({
      principal,
      fileId,
      requestedBy,
      workerAttemptId,
      now: now(),
      leaseMs,
    });
    if (begin.outcome === "not_found") {
      return { outcome: "not_found" };
    }
    if (begin.outcome === "invalid_state") {
      return { outcome: "invalid_state", state: begin.state };
    }
    if (begin.outcome === "worker_active") {
      return { outcome: "worker_active", purgeId: begin.purgeId, leaseUntil: begin.leaseUntil };
    }
    const purgeId = begin.purgeId;
    const ref = { principal, fileId, purgeId, workerAttemptId };
    const lease = () => ({ now: now(), leaseMs });
    const deadline = now() + (options.budgetMs ?? 20_000);
    const lost = async (): Promise<VaultPurgeOutcome> => ({ outcome: "lost_lease", purgeId });
    const pause = async (blockers: string[]): Promise<VaultPurgeOutcome> => {
      // The run continues elsewhere (next call, maintenance): hand the lease back instead of sitting on it.
      await store.vaultPurgeRelease(ref);
      return { outcome: "cleanup_pending", purgeId, blockers };
    };

    if (begin.phase === "sealed") {
      const recorded = await store.vaultPurgeRecordItems({ ...ref, ...lease() });
      if (recorded.outcome !== "recorded") {
        return lost();
      }
    }
    for (let round = 0; round < 400; round += 1) {
      const listed = await store.vaultPurgeItems({ ...ref, ...lease() });
      if (listed.outcome === "not_owner") {
        return lost();
      }
      if (listed.outcome === "wrong_phase") {
        const recorded = await store.vaultPurgeRecordItems({ ...ref, ...lease() });
        if (recorded.outcome !== "recorded") {
          return lost();
        }
        continue;
      }
      const pending = listed.items.filter((item) => item.state === "pending");
      if (pending.length === 0) {
        const finished = await store.vaultPurgeFinish({ ...ref, ...lease() });
        if (finished.outcome === "completed") {
          const receipts = await store.vaultPurgeReceipts({ principal, purgeId });
          const receipt = receipts.receipts[0];
          deps.onChanged?.({ ownerId: principal.ownerId, fileId, action: "purged" });
          if (!receipt) {
            return pause(["receipt_unreadable"]);
          }
          return { outcome: "purged", receipt };
        }
        if (finished.outcome === "not_owner") {
          return lost();
        }
        if (finished.outcome === "cleanup_pending") {
          return pause([`cleanup_pending:${finished.count}`]);
        }
        if (finished.outcome === "not_ready" && finished.reason === "goal_links") {
          return pause(["goal_links_remain"]);
        }
        if (finished.outcome === "not_ready" && finished.reason !== "reevaluate") {
          return pause([`not_ready:${finished.reason}`]);
        }
        continue; // reevaluate: some items went back to pending
      }
      let progressed = false;
      const blockers = new Set<string>();
      for (const item of pending) {
        const result = await store.vaultPurgeEvaluateItem({
          ...ref,
          ...lease(),
          objectId: item.objectId,
          reclaimAttemptId: newId("VRC"),
        });
        if (result.outcome === "not_owner") {
          return lost();
        }
        if (result.outcome === "reclaim_claimed") {
          const done = await confirmed("reclaim", () =>
            finishReclaim(principal, item.objectId, result.reclaimAttemptId, { fileId, purgeId }),
          );
          progressed = progressed || done;
          if (!done) {
            blockers.add("reclaim_unconfirmed");
          }
        } else if (result.outcome === "needs_proof") {
          const proved = await confirmed("absence proof", () =>
            proveAbsence(principal, item.objectId),
          );
          progressed = progressed || proved;
          if (!proved) {
            blockers.add("absence_unconfirmed");
          }
        } else if (result.outcome === "waiting") {
          blockers.add("reclaim_in_progress_elsewhere");
        } else {
          progressed = true; // retained_shared / verified_gone / cleanup_pending changed the item
        }
      }
      if (!progressed) {
        if (now() >= deadline) {
          return pause([...blockers]);
        }
        await sleep(250);
      } else if (now() >= deadline) {
        return pause(["budget_exhausted"]);
      }
    }
    return pause(["round_limit"]);
  }

  // ------------------------------------------------------------------ maintenance

  async function maintain(principal: Principal): Promise<VaultMaintainReport> {
    const cfg = deps.config();
    const store = await deps.getStore();
    const report: VaultMaintainReport = {
      recovered: { expired: 0, repaired: 0, losersDeleted: 0 },
      reclaimed: 0,
      proofsWritten: 0,
      purgesResumed: 0,
      inboxDiscarded: 0,
      trashPurged: 0,
      tombstonesRetired: 0,
      reservationsPruned: 0,
      receiptsCompacted: 0,
      extracted: 0,
      checked: 0,
      damaged: 0,
      errors: [],
    };
    const step = async (name: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        report.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    await step("recovery", async () => {
      const items = await store.vaultListRecoverable({
        principal,
        now: now(),
        limit: MAINTAIN_BATCH,
      });
      for (const item of items) {
        if (inflight.has(item.reservationId)) {
          continue; // its writer is alive in this process
        }
        try {
          if (item.kind === "repair_promoted") {
            const out = await store.vaultRepairPromoted({
              principal,
              reservationId: item.reservationId,
              now: now(),
            });
            if (out.outcome === "committed") {
              report.recovered.repaired += 1;
            } else if (out.outcome === "failed") {
              warn(
                `vault: promoted reservation ${item.reservationId} did not match its object (${out.reason})`,
              );
            }
          } else if (item.kind === "expire") {
            if (await abandonReservation(principal, item.reservationId)) {
              report.recovered.expired += 1;
            }
          } else if (await deleteLoserFiles(principal, item.reservationId)) {
            report.recovered.losersDeleted += 1;
          }
        } catch (error) {
          report.errors.push(
            `recovery ${item.reservationId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });

    await step("reclaim", async () => {
      const candidates = await store.vaultReclaimCandidates({
        principal,
        now: now(),
        graceMs: cfg.reclaimGraceMs,
        limit: MAINTAIN_BATCH,
      });
      for (const candidate of candidates) {
        if (candidate.needsProof) {
          if (await confirmed("absence proof", () => proveAbsence(principal, candidate.objectId))) {
            report.proofsWritten += 1;
          }
          continue;
        }
        const attempt = newId("VRC");
        const claim = await store.vaultReclaimClaim({
          principal,
          objectId: candidate.objectId,
          reclaimAttemptId: attempt,
          now: now(),
          leaseMs,
          graceMs: cfg.reclaimGraceMs,
        });
        if (
          claim.outcome === "claimed" &&
          (await confirmed("reclaim", () => finishReclaim(principal, candidate.objectId, attempt)))
        ) {
          report.reclaimed += 1;
        }
      }
    });

    await step("purge-resume", async () => {
      const runs = await store.vaultPurgeListRuns({ principal, now: now(), limit: MAINTAIN_BATCH });
      for (const run of runs.runs) {
        // The original requester is kept by the run; this value is only used when the call creates nothing.
        const out = await purge(principal, run.fileId, "system:maintenance");
        if (out.outcome === "purged") {
          report.purgesResumed += 1;
        }
      }
    });

    await step("due", async () => {
      const due = await store.vaultListDue({
        principal,
        now: now(),
        trashRetentionMs: cfg.trashRetentionMs,
        limit: MAINTAIN_BATCH,
      });
      for (const fileId of due.expiredInbox) {
        const out = await store.vaultDiscard({ principal, fileId, now: now() });
        if (out.outcome === "ok") {
          report.inboxDiscarded += 1;
          deps.onChanged?.({
            ownerId: principal.ownerId,
            fileId,
            action: "discarded",
            collection: "inbox",
          });
        }
      }
      for (const fileId of due.trashedDue) {
        const out = await purge(principal, fileId, "system:trash-retention");
        if (out.outcome === "purged") {
          report.trashPurged += 1;
        }
      }
    });

    await step("housekeeping", async () => {
      report.tombstonesRetired = (
        await store.vaultRetireTombstones({
          principal,
          now: now(),
          retentionMs: cfg.tombstoneRetentionMs,
          limit: MAINTAIN_BATCH,
        })
      ).retired;
      report.reservationsPruned = (
        await store.vaultPruneReservations({
          principal,
          now: now(),
          retentionMs: cfg.reservationRetentionMs,
          limit: MAINTAIN_BATCH,
        })
      ).pruned;
      report.receiptsCompacted = (
        await store.vaultCompactReceipts({
          principal,
          now: now(),
          retentionMs: cfg.receiptHashRetentionMs,
        })
      ).compacted;
    });

    await step("extract", async () => {
      report.extracted = (await extractTracked(principal)).ready;
    });

    await step("integrity", async () => {
      const batch = await store.vaultVerifyBatch({
        principal,
        afterFileId: verifyCursor.get(principal.ownerId) ?? null,
        limit: VERIFY_BATCH,
      });
      verifyCursor.set(principal.ownerId, batch.nextCursor);
      for (const item of batch.items) {
        report.checked += 1;
        const found = await deps.files.stat(vaultObjectKey(item.objectId));
        if (found && found.size === item.size) {
          continue;
        }
        const marked = await store.vaultMarkDamaged({ principal, fileId: item.fileId, now: now() });
        if (marked.outcome === "marked") {
          report.damaged += 1;
          warn(
            `vault: file ${item.fileId} points at ${found ? "an object of the wrong size" : "a missing object"}`,
          );
          deps.onChanged?.({ ownerId: principal.ownerId, fileId: item.fileId, action: "damaged" });
        }
      }
    });
    return report;
  }

  // Everything that can hold a reservation or a purge lease is tracked so the plugin can wait for it before it closes the
  // incarnation: a clean shutdown is only a proof that the writer is quiet if the writer really finished.
  const running = new Set<Promise<unknown>>();
  const tracked =
    <Args extends unknown[], R>(run: (...args: Args) => Promise<R>) =>
    (...args: Args): Promise<R> => {
      const promise = run(...args);
      running.add(promise);
      const forget = () => running.delete(promise);
      promise.then(forget, forget);
      return promise;
    };

  /** Resolves when no ingest / import / purge / maintenance pass is running; false when `timeoutMs` ran out first. */
  async function drain(timeoutMs = 10_000): Promise<boolean> {
    const started = Date.now();
    while (running.size > 0) {
      if (Date.now() - started > timeoutMs) {
        return false;
      }
      await Promise.race([
        Promise.allSettled(running),
        new Promise((resolve) => {
          setTimeout(resolve, 50);
        }),
      ]);
    }
    return true;
  }

  const extractTracked = tracked((principal: Principal) => extractor.pass(principal));
  const kickExtract = async (principal: Principal): Promise<void> => {
    try {
      await extractTracked(principal);
    } catch (error) {
      warn(
        `vault: extraction pass failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return {
    ingest: tracked(ingest),
    extract: extractTracked,
    importPath: tracked(importPath),
    read,
    purge: tracked(purge),
    maintain: tracked(maintain),
    drain,
  };
}

export type VaultService = ReturnType<typeof createVaultService>;
