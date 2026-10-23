// Purge service (DESIGN section 9.4, P1-P5): the asynchronous half of the hard purge. The kernel (store/purge-ledger.ts) does
// the synchronous transactions; this coordinator only drives them in order and does the byte I/O between them, by
// reusing the evidence service's reclaim and tombstone helpers (the very same machinery GC uses).
//
// One Task, one run, one purge_id: a retry - by the operator, by the periodic resume, or after a crash - continues the SAME
// run. A pass that loses the run lease finds a different worker_attempt_id and stops. The result is never "done" unless
// P5 wrote the receipt, which in turn needs a verified absence proof for every object that was reclaimed.
import { randomBytes } from "node:crypto";
import type { EvidenceService } from "../evidence/evidence-service.js";
import type { EvidenceLeases } from "../store/blob-types.js";
import type { TaskStore } from "../store/host.js";
import type {
  EvidenceDeleteOutcome,
  PurgeBusyReason,
  PurgePhase,
  PurgeReceipt,
  PurgeStatus,
} from "../store/purge-types.js";
import type { Principal } from "../store/types.js";
import { DEFAULT_PURGE_RUN_LEASE_MS } from "./purge-lease.js";

export type PurgeOutcome =
  | { outcome: "purged"; receipt: PurgeReceipt }
  | {
      outcome: "cleanup_pending";
      purgeId: string;
      phase: PurgePhase;
      /** Machine-readable reasons the receipt cannot be written yet. The run stays `purging` and is resumed. */
      blockers: string[];
      status: PurgeStatus | null;
    }
  | { outcome: "task_busy"; reasons: PurgeBusyReason[] }
  | { outcome: "worker_active"; purgeId: string; leaseUntil: number }
  | { outcome: "lost_lease"; purgeId: string }
  | { outcome: "not_found" };

export type PurgeServiceDeps = {
  getStore: () => Promise<TaskStore>;
  evidence: EvidenceService;
  leases: EvidenceLeases;
  incarnationGoneEnabled: boolean;
  /** How long one pass may hold the run before another can take it over. */
  workerLeaseMs?: number;
  /** Wall-clock budget of one `purge()` call; after it the call answers `cleanup_pending` and the run is resumed later. */
  budgetMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: (prefix: string) => string;
  /** The Task's ledger is gone: let the console know. */
  onPurged?: (payload: {
    ownerId: string;
    taskId: string;
    receiptId: string;
    executedAt: number;
  }) => void;
  logger?: { warn: (message: string) => void; info?: (message: string) => void };
};

const MAX_ROUNDS = 400;

export function createPurgeService(deps: PurgeServiceDeps) {
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
  const workerLeaseMs = deps.workerLeaseMs ?? DEFAULT_PURGE_RUN_LEASE_MS;
  const budgetMs = deps.budgetMs ?? 20_000;
  const POLL_MS = 250;

  // In-process serialisation only avoids two passes of the SAME process fighting; the run lease is what protects across
  // processes and crashes.
  const active = new Map<string, Promise<PurgeOutcome>>();

  async function drive(
    principal: Principal,
    taskId: string,
    requestedBy: string,
    budget: number,
  ): Promise<PurgeOutcome> {
    const store = await deps.getStore();
    const workerAttemptId = newId("PW");
    const begin = await store.purgeBegin({
      principal,
      taskId,
      requestedBy,
      workerAttemptId,
      workerLeaseMs,
      now: now(),
    });
    if (begin.outcome === "not_found") {
      return { outcome: "not_found" };
    }
    if (begin.outcome === "task_busy") {
      return { outcome: "task_busy", reasons: begin.reasons };
    }
    if (begin.outcome === "worker_active") {
      return { outcome: "worker_active", purgeId: begin.purgeId, leaseUntil: begin.leaseUntil };
    }
    const purgeId = begin.purgeId;
    const ref = () => ({
      principal,
      taskId,
      purgeId,
      workerAttemptId,
      workerLeaseMs,
      now: now(),
    });
    const deadline = now() + budget;
    let phase: PurgePhase = begin.phase;
    let blockers: string[] = [];
    const pending = async (): Promise<PurgeOutcome> => {
      // The run continues elsewhere (the next call, the periodic resume): give it back instead of holding the lease.
      await store.purgeRelease(ref());
      return {
        outcome: "cleanup_pending",
        purgeId,
        phase,
        blockers,
        status: await store.purgeStatus({ principal, taskId }),
      };
    };

    for (let round = 0; round < MAX_ROUNDS && now() <= deadline; round += 1) {
      blockers = [];
      if (phase === "sealed") {
        const claimed = await store.purgeClaimReservations({ ...ref(), leases: deps.leases });
        if (claimed.outcome !== "claimed") {
          return claimed.outcome === "not_owner"
            ? { outcome: "lost_lease", purgeId }
            : await pending();
        }
        // P2 (2): the bytes of what we claimed. Same machinery as GC; waits for this process's own writers first.
        await deps.evidence.reclaim(principal, claimed.items);
        if (claimed.heldByOthers > 0) {
          // Reservations that GC (or a crashed pass) holds: maintenance takes expired leases over, so drive it.
          await deps.evidence.maintain(principal);
        }
        const advanced = await store.purgeAdvanceReservations(ref());
        if (advanced.outcome === "advanced") {
          phase = "reservations_settled";
          continue;
        }
        if (advanced.outcome === "waiting") {
          blockers = [`reservations_open:${advanced.reserved}+${advanced.reclaiming}`];
          await sleep(POLL_MS);
          continue;
        }
        return advanced.outcome === "not_owner"
          ? { outcome: "lost_lease", purgeId }
          : await pending();
      }
      if (phase === "reservations_settled") {
        const sealed = await store.purgeSealWorkset(ref());
        if (sealed.outcome === "sealed" || sealed.outcome === "already_sealed") {
          phase = "workset_sealed";
          continue;
        }
        if (sealed.outcome === "reservations_open") {
          phase = "sealed";
          continue;
        }
        return sealed.outcome === "not_owner"
          ? { outcome: "lost_lease", purgeId }
          : await pending();
      }

      // phase === "workset_sealed": P4 until every item is terminal, then P5.
      if (deps.incarnationGoneEnabled) {
        await store.blobIncarnationSettle({ principal, limit: 100, now: now() });
      }
      const classified = await store.purgeClassify({ ...ref(), leases: deps.leases, limit: 50 });
      if (classified.outcome !== "classified") {
        return classified.outcome === "not_owner"
          ? { outcome: "lost_lease", purgeId }
          : await pending();
      }
      const reclaimed = await deps.evidence.reclaim(principal, classified.reclaim);
      const reappeared = await deps.evidence.recheckTombstones(principal, classified.tombstones);
      const unsettled = classified.tombstones.filter(
        (tombstone) => tombstone.writerSettledReason === null,
      );
      for (const failure of classified.failures) {
        blockers.push(`failed:${failure.blobKey}:${failure.reason}`);
      }
      const open = classified.counts.pending + classified.counts.failed;
      // Only real movement counts: a tombstone whose writer is not known to be quiet stays that way however often it is
      // re-deleted, so polling it must not turn the loop into a busy wait.
      const progressed =
        classified.reclaim.length > 0 ||
        reclaimed.deleted > 0 ||
        reappeared > 0 ||
        classified.tombstones.some((tombstone) => tombstone.writerSettledReason !== null);
      if (open === 0) {
        const finalized = await store.purgeFinalize({
          principal,
          taskId,
          purgeId,
          requestedBy,
          now: now(),
        });
        if (finalized.outcome === "purged") {
          deps.onPurged?.({
            ownerId: principal.ownerId,
            taskId,
            receiptId: finalized.receipt.id,
            executedAt: finalized.receipt.executedAt,
          });
          return { outcome: "purged", receipt: finalized.receipt };
        }
        if (finalized.outcome === "not_found") {
          return { outcome: "not_found" };
        }
        blockers = [...blockers, ...finalized.blockers];
        await sleep(POLL_MS);
        continue;
      }
      if (unsettled.length > 0 && !progressed) {
        // The writer of these bytes is not known to be quiet. In this process it settles by itself; in a crashed one only
        // `incarnation_gone` (when enabled) can say so, and without it the run waits for a human (DESIGN 9.5.1).
        for (const tombstone of unsettled) {
          blockers.push(`writer_not_settled:${tombstone.blobKey}`);
        }
      }
      if (classified.counts.waiting > 0) {
        blockers.push(`waiting_on_other_reclaim:${classified.counts.waiting}`);
        // Expired reclaim leases are taken over by maintenance.
        await deps.evidence.maintain(principal);
      }
      if (!progressed) {
        await sleep(POLL_MS);
      }
    }
    return await pending();
  }

  /**
   * Hard purge of one Task (`nexus.task.purge`). Starts the run or continues the existing one. Returns `purged` only after
   * the receipt exists; anything else leaves the Task in `purging` and is resumed by `resume()` or by calling again.
   */
  const purge = async (
    principal: Principal,
    taskId: string,
    requestedBy: string,
    options: { budgetMs?: number } = {},
  ): Promise<PurgeOutcome> => {
    const key = `${principal.ownerId}:${taskId}`;
    const running = active.get(key);
    if (running) {
      return running;
    }
    const promise = drive(principal, taskId, requestedBy, options.budgetMs ?? budgetMs).finally(
      () => {
        active.delete(key);
      },
    );
    active.set(key, promise);
    return promise;
  };

  /** Continue every run whose worker lease is free or expired (gateway start and the periodic tick). */
  const resume = async (principal: Principal): Promise<number> => {
    const store = await deps.getStore();
    const runs = await store.listPurgeRuns({ principal, limit: 50 });
    let resumed = 0;
    for (const run of runs) {
      if (run.workerLeaseUntil !== null && run.workerLeaseUntil > now()) {
        continue;
      }
      resumed += 1;
      try {
        await purge(principal, run.taskId, "system:resume", { budgetMs: 10_000 });
      } catch (error) {
        deps.logger?.warn(
          `nexus-agent-core: resuming purge of ${run.taskId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return resumed;
  };

  return {
    purge,
    resume,

    async status(principal: Principal, taskId: string): Promise<PurgeStatus | null> {
      return (await deps.getStore()).purgeStatus({ principal, taskId });
    },

    /** Single-evidence deletion (DESIGN 9.4): the reference is released now, the object is reclaimed by the zero-ref scan. */
    async deleteEvidence(
      principal: Principal,
      taskId: string,
      evidenceId: string,
      requestedBy: string,
    ): Promise<EvidenceDeleteOutcome> {
      return (await deps.getStore()).evidenceDelete({
        principal,
        taskId,
        evidenceId,
        requestedBy,
        now: now(),
      });
    },
  };
}

export type PurgeService = ReturnType<typeof createPurgeService>;
