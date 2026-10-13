// Gateway RPC for decisions, executions and grants (DESIGN sections 8.13 and 12). Read methods need operator.read,
// write methods operator.write. `nexus.decision.resolve` runs the same resolver the core approval callback runs.
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { DecisionRuntime } from "./decision-runtime.js";
import type { EventBridge } from "./events.js";
import type { ExecutionState, ProviderCaps } from "./store/decision-types.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";
import { normalizeTaskId } from "./tools/task-tools.js";

export type DecisionRpcDeps = {
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  runtime: DecisionRuntime;
  resolvePrincipal: () => Principal | undefined;
  providerCaps: () => ProviderCaps;
  now?: () => number;
};

type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;
type Respond = GatewayRequestHandlerOptions["respond"];

const LIMIT_MAX = 200;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const DECISION_STATUSES = new Set([
  "pending",
  "decided",
  "effect_apply_failed",
  "expired",
  "superseded",
]);
const EXECUTION_STATES = new Set<ExecutionState>([
  "prepared",
  "executing",
  "succeeded",
  "failed",
  "unknown",
]);

function reject(respond: Respond, code: string, message: string, extra?: Record<string, unknown>) {
  respond(false, undefined, { code, message, ...(extra ? { details: extra } : {}) });
}

function readId(raw: unknown): string | undefined {
  return typeof raw === "string" && ID.test(raw) ? raw : undefined;
}

function readLimit(raw: unknown, fallback: number): number {
  return typeof raw === "number" && raw >= 1 ? Math.min(Math.floor(raw), LIMIT_MAX) : fallback;
}

/** Returns [method, handler, scope] triples; the caller registers them. */
export function createDecisionRpcHandlers(deps: DecisionRpcDeps) {
  const now = deps.now ?? Date.now;
  const guarded =
    (
      run: (args: {
        principal: Principal;
        store: TaskStore;
        params: Record<string, unknown>;
        respond: Respond;
      }) => Promise<void>,
    ): GatewayRequestHandler =>
    async ({ params, respond }) => {
      const principal = deps.resolvePrincipal();
      if (!principal) {
        reject(respond, "nexus_no_principal", "cannot resolve the owner");
        return;
      }
      try {
        await run({ principal, store: await deps.getStore(), params: params ?? {}, respond });
      } catch (error) {
        reject(
          respond,
          "nexus_store_error",
          error instanceof Error ? error.message : String(error),
        );
      }
    };

  return [
    [
      "nexus.decision.list",
      guarded(async ({ principal, store, params, respond }) => {
        const statuses = params.statuses;
        if (
          statuses !== undefined &&
          (!Array.isArray(statuses) ||
            !statuses.every((s) => typeof s === "string" && DECISION_STATUSES.has(s)))
        ) {
          reject(
            respond,
            "nexus_invalid_params",
            "statuses must be an array of known decision statuses",
          );
          return;
        }
        const taskId = params.taskId === undefined ? undefined : normalizeTaskId(params.taskId);
        if (params.taskId !== undefined && !taskId) {
          reject(respond, "nexus_invalid_params", "taskId is invalid");
          return;
        }
        const decisions = await store.listDecisions({
          principal,
          ...(taskId ? { taskId } : {}),
          ...(statuses ? { statuses: statuses as string[] } : {}),
          openTasksOnly: params.includeClosedTasks !== true,
          limit: readLimit(params.limit, 50),
        });
        respond(true, { ownerId: principal.ownerId, decisions });
      }),
      "operator.read",
    ],
    [
      "nexus.decision.get",
      guarded(async ({ principal, store, params, respond }) => {
        const decisionId = readId(params.decisionId);
        if (!decisionId) {
          reject(respond, "nexus_invalid_params", "decisionId is required");
          return;
        }
        const detail = await store.getDecision({ principal, decisionId });
        if (!detail) {
          reject(respond, "nexus_not_found", "decision not found");
          return;
        }
        respond(true, { ownerId: principal.ownerId, ...detail });
      }),
      "operator.read",
    ],
    [
      "nexus.decision.resolve",
      guarded(async ({ principal, store, params, respond }) => {
        const decisionId = readId(params.decisionId);
        const resolution = params.resolution;
        if (!decisionId || (resolution !== "approved" && resolution !== "denied")) {
          reject(
            respond,
            "nexus_invalid_params",
            "decisionId and resolution (approved|denied) are required",
          );
          return;
        }
        const chosenActionId =
          params.chosenActionId === undefined ? undefined : readId(params.chosenActionId);
        if (params.chosenActionId !== undefined && !chosenActionId) {
          reject(respond, "nexus_invalid_params", "chosenActionId is invalid");
          return;
        }
        const approvalRef =
          typeof params.approvalRef === "string" && params.approvalRef.length <= 128
            ? params.approvalRef
            : undefined;
        // Synchronous: the reply is sent only after the transaction committed (section 8.13).
        const result = await store.resolveDecision({
          principal,
          decisionId,
          resolution,
          ...(chosenActionId ? { chosenActionId } : {}),
          source: "nexus_console",
          resolvedBy: "nexus-console",
          ...(approvalRef ? { approvalRef } : {}),
          providerCaps: deps.providerCaps(),
          now: now(),
        });
        if (result.outcome === "not_found") {
          reject(respond, "nexus_not_found", "decision not found");
          return;
        }
        if (result.outcome === "choice_required" || result.outcome === "invalid_choice") {
          reject(
            respond,
            "nexus_invalid_params",
            "choose one of the candidate actions with chosenActionId",
            {
              candidates: result.decision.actionIds,
            },
          );
          return;
        }
        if ("task" in result && result.task) {
          deps.events.taskChanged("updated", result.task);
        }
        deps.runtime.kickOutbox();
        respond(true, { ownerId: principal.ownerId, ...result });
      }),
      "operator.write",
    ],
    [
      "nexus.execution.list",
      guarded(async ({ principal, store, params, respond }) => {
        const states = params.states;
        if (
          states !== undefined &&
          (!Array.isArray(states) ||
            !states.every(
              (s) => typeof s === "string" && EXECUTION_STATES.has(s as ExecutionState),
            ))
        ) {
          reject(
            respond,
            "nexus_invalid_params",
            "states must be an array of known execution states",
          );
          return;
        }
        const taskId = params.taskId === undefined ? undefined : normalizeTaskId(params.taskId);
        if (params.taskId !== undefined && !taskId) {
          reject(respond, "nexus_invalid_params", "taskId is invalid");
          return;
        }
        const executions = await store.listExecutions({
          principal,
          ...(taskId ? { taskId } : {}),
          ...(states ? { states: states as ExecutionState[] } : {}),
          limit: readLimit(params.limit, 50),
        });
        respond(true, { ownerId: principal.ownerId, executions });
      }),
      "operator.read",
    ],
    [
      "nexus.execution.reconcile",
      guarded(async ({ principal, params, respond }) => {
        const executionId = readId(params.executionId);
        if (!executionId) {
          reject(respond, "nexus_invalid_params", "executionId is required");
          return;
        }
        const result = await deps.runtime.reconcileExecution(principal, executionId);
        if (result.outcome === "not_found") {
          reject(respond, "nexus_not_found", "execution not found");
          return;
        }
        respond(true, { ownerId: principal.ownerId, ...result });
      }),
      "operator.write",
    ],
    [
      "nexus.execution.resolve",
      guarded(async ({ principal, params, respond }) => {
        const executionId = readId(params.executionId);
        if (!executionId) {
          reject(respond, "nexus_invalid_params", "executionId is required");
          return;
        }
        if (params.resolution !== "succeeded" && params.resolution !== "failed") {
          reject(respond, "nexus_invalid_params", "resolution must be succeeded or failed");
          return;
        }
        const note = typeof params.note === "string" ? params.note.trim() : "";
        if (!note || note.length > 500) {
          reject(
            respond,
            "nexus_invalid_params",
            "note is required (1-500 chars): who verified what at the provider",
          );
          return;
        }
        const confirmation =
          typeof params.confirmation === "string" && params.confirmation.trim()
            ? params.confirmation.trim().slice(0, 200)
            : undefined;
        const result = await deps.runtime.resolveExecutionByOperator(principal, {
          executionId,
          resolution: params.resolution,
          note,
          ...(confirmation ? { confirmation } : {}),
        });
        if (result.outcome === "not_found") {
          reject(respond, "nexus_not_found", "execution not found");
          return;
        }
        respond(true, { ownerId: principal.ownerId, ...result });
      }),
      "operator.write",
    ],
    [
      "nexus.grant.list",
      guarded(async ({ principal, store, params, respond }) => {
        const taskId = params.taskId === undefined ? undefined : normalizeTaskId(params.taskId);
        if (params.taskId !== undefined && !taskId) {
          reject(respond, "nexus_invalid_params", "taskId is invalid");
          return;
        }
        const grants = await store.listGrants({
          principal,
          ...(taskId ? { taskId } : {}),
          limit: readLimit(params.limit, 50),
        });
        respond(true, { ownerId: principal.ownerId, ...grants });
      }),
      "operator.read",
    ],
    [
      "nexus.grant.revoke",
      guarded(async ({ principal, store, params, respond }) => {
        const grantId = readId(params.grantId);
        if (!grantId) {
          reject(respond, "nexus_invalid_params", "grantId is required");
          return;
        }
        const result = await store.revokeGrant({ principal, grantId, now: now() });
        if (result.outcome === "not_found") {
          reject(respond, "nexus_not_found", "grant not found");
          return;
        }
        respond(true, { ownerId: principal.ownerId, ...result });
      }),
      "operator.write",
    ],
  ] as const;
}
