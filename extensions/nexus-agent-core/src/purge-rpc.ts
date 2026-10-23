// Gateway RPC for hard purge and single-evidence deletion (DESIGN sections 9.4, 12). Purge destroys a Task's ledger, so it is
// the one call here that needs `operator.admin` and an explicit confirmation of the Task id. Reads need operator.read.
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { EventBridge } from "./events.js";
import { EvidenceBytesUnavailableError } from "./evidence/blob-store.js";
import type { PurgeOutcome, PurgeService } from "./purge/purge-service.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";
import { normalizeTaskId } from "./tools/task-tools.js";

export type PurgeRpcDeps = {
  getStore: () => Promise<TaskStore>;
  purge: PurgeService;
  events: EventBridge;
  resolvePrincipal: () => Principal | undefined;
};

type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;
type Respond = GatewayRequestHandlerOptions["respond"];

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const OPERATOR_ACTOR = "operator:nexus-console";

function reject(respond: Respond, code: string, message: string, extra?: Record<string, unknown>) {
  respond(false, undefined, { code, message, ...(extra ? { details: extra } : {}) });
}

/** The statement the operator sees with every successful purge: the audit trail it destroyed is not recoverable. */
export const PURGE_NOTICE =
  "The Task's ledger (claims, evidence, decisions, executions, steps) was destroyed and can no longer be audited. " +
  "Only the receipt remains. Objects other Tasks still reference were kept.";

function respondPurge(respond: Respond, ownerId: string, result: PurgeOutcome): void {
  switch (result.outcome) {
    case "purged":
      respond(true, { ownerId, outcome: "purged", receipt: result.receipt, notice: PURGE_NOTICE });
      return;
    case "cleanup_pending":
      // Not a failure: the run is persisted and continues. The receipt does not exist yet, so nothing may be claimed.
      respond(true, {
        ownerId,
        outcome: "cleanup_pending",
        purgeId: result.purgeId,
        phase: result.phase,
        blockers: result.blockers,
        status: result.status,
        notice:
          "The purge is not complete: no receipt was written and the Task is still `purging`. Call again to continue.",
      });
      return;
    case "task_busy":
      reject(
        respond,
        "nexus_task_busy",
        "the Task has work in flight; settle or cancel it before purging",
        { reasons: result.reasons },
      );
      return;
    case "worker_active":
      reject(respond, "nexus_busy", "another pass is driving this purge", {
        purgeId: result.purgeId,
        leaseUntil: result.leaseUntil,
      });
      return;
    case "lost_lease":
      reject(respond, "nexus_busy", "another pass took this purge over; call again", {
        purgeId: result.purgeId,
      });
      return;
    case "not_found":
      reject(respond, "nexus_not_found", "task not found");
  }
}

type GuardedRun = (args: {
  principal: Principal;
  params: Record<string, unknown>;
  respond: Respond;
}) => Promise<void>;

function guardedWith(resolvePrincipal: () => Principal | undefined) {
  return (run: GuardedRun): GatewayRequestHandler =>
    async ({ params, respond }) => {
      const principal = resolvePrincipal();
      if (!principal) {
        reject(respond, "nexus_no_principal", "cannot resolve the owner");
        return;
      }
      try {
        await run({ principal, params: params ?? {}, respond });
      } catch (error) {
        if (error instanceof EvidenceBytesUnavailableError) {
          reject(respond, "nexus_evidence_unavailable", error.message, { reason: error.reason });
          return;
        }
        reject(
          respond,
          "nexus_store_error",
          error instanceof Error ? error.message : String(error),
        );
      }
    };
}

function purgeReceiptsHandler(
  guarded: ReturnType<typeof guardedWith>,
  getStore: () => Promise<TaskStore>,
) {
  return guarded(async ({ principal, params, respond }) => {
    const limit = Math.min(Math.max(Number(params.limit ?? 50) || 50, 1), 200);
    const receipts = await (await getStore()).listPurgeReceipts({ principal, limit });
    respond(true, { ownerId: principal.ownerId, receipts });
  });
}

/**
 * The receipts list only reads the store, so it is registered even when the purge service is absent (installs without
 * evidence bytes). Without it the console's receipts tab would fail with "unknown method" on those installs.
 */
export function createPurgeReceiptsRpcHandlers(deps: {
  getStore: () => Promise<TaskStore>;
  resolvePrincipal: () => Principal | undefined;
}) {
  return [
    [
      "nexus.task.purgeReceipts",
      purgeReceiptsHandler(guardedWith(deps.resolvePrincipal), deps.getStore),
      "operator.read",
    ],
  ] as const;
}

/** Returns [method, handler, scope] triples; the caller registers them. */
export function createPurgeRpcHandlers(deps: PurgeRpcDeps) {
  const guarded = guardedWith(deps.resolvePrincipal);

  return [
    [
      "nexus.task.purge",
      guarded(async ({ principal, params, respond }) => {
        const taskId = normalizeTaskId(params.taskId);
        if (!taskId) {
          reject(respond, "nexus_invalid_params", "taskId is required");
          return;
        }
        // Second confirmation: the caller must type the id again. A stray call or a replayed request cannot satisfy it.
        if (params.confirmTaskId !== taskId) {
          reject(
            respond,
            "nexus_confirmation_required",
            "this destroys the Task's ledger; repeat the taskId in confirmTaskId to confirm",
          );
          return;
        }
        respondPurge(
          respond,
          principal.ownerId,
          await deps.purge.purge(principal, taskId, OPERATOR_ACTOR),
        );
      }),
      "operator.admin",
    ],
    [
      "nexus.task.purgeStatus",
      guarded(async ({ principal, params, respond }) => {
        const taskId = normalizeTaskId(params.taskId);
        if (!taskId) {
          reject(respond, "nexus_invalid_params", "taskId is required");
          return;
        }
        const status = await deps.purge.status(principal, taskId);
        if (!status) {
          reject(respond, "nexus_not_found", "no purge run for this task");
          return;
        }
        respond(true, { ownerId: principal.ownerId, status });
      }),
      "operator.read",
    ],
    ["nexus.task.purgeReceipts", purgeReceiptsHandler(guarded, deps.getStore), "operator.read"],
    [
      "nexus.evidence.delete",
      guarded(async ({ principal, params, respond }) => {
        const taskId = normalizeTaskId(params.taskId);
        const evidenceId =
          typeof params.evidenceId === "string" && ID.test(params.evidenceId)
            ? params.evidenceId
            : undefined;
        if (!taskId || !evidenceId) {
          reject(respond, "nexus_invalid_params", "taskId and evidenceId are required");
          return;
        }
        if (params.confirmEvidenceId !== evidenceId) {
          reject(
            respond,
            "nexus_confirmation_required",
            "this deletes the stored bytes; repeat the evidenceId in confirmEvidenceId to confirm",
          );
          return;
        }
        const result = await deps.purge.deleteEvidence(
          principal,
          taskId,
          evidenceId,
          OPERATOR_ACTOR,
        );
        switch (result.outcome) {
          case "deleted":
            deps.events.evidenceChanged({
              ownerId: principal.ownerId,
              taskId,
              evidenceId,
              change: "deleted",
            });
            respond(true, { ownerId: principal.ownerId, ...result });
            return;
          case "already_deleted":
          case "no_bytes":
            reject(respond, "nexus_conflict", result.outcome, { evidenceId });
            return;
          case "task_purging":
            reject(respond, "nexus_task_closed", "task is being purged");
            return;
          case "not_found":
            reject(respond, "nexus_not_found", "task or evidence not found");
        }
      }),
      "operator.write",
    ],
  ] as const;
}
