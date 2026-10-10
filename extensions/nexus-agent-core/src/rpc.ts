// Gateway RPC for Tasks (DESIGN section 12, RPC table). Read methods need operator.read, write methods
// operator.write. Every reply carries ownerId so a client can notice a cross-owner mix-up.
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { EventBridge } from "./events.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";
import { TASK_STATUSES, type TaskStatus } from "./store/types.js";
import { normalizeTaskId } from "./tools/task-tools.js";

export type TaskRpcDeps = {
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  resolvePrincipal: () => Principal | undefined;
  now?: () => number;
};

const LIST_LIMIT_MAX = 200;
const RPC_STEP_LIMIT = 100;

type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;
type Respond = GatewayRequestHandlerOptions["respond"];

function reject(respond: Respond, code: string, message: string) {
  respond(false, undefined, { code, message });
}

function readStatuses(raw: unknown): TaskStatus[] | undefined | "invalid" {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    return "invalid";
  }
  const known = new Set<string>(TASK_STATUSES);
  return raw.every((entry) => typeof entry === "string" && known.has(entry))
    ? (raw as TaskStatus[])
    : "invalid";
}

/** Returns [method, handler, scope] triples; the caller registers them. */
export function createTaskRpcHandlers(deps: TaskRpcDeps) {
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
      "nexus.task.list",
      guarded(async ({ principal, store, params, respond }) => {
        const statuses = readStatuses(params.statuses);
        if (statuses === "invalid") {
          reject(respond, "nexus_invalid_params", "statuses must be an array of known statuses");
          return;
        }
        const limit =
          typeof params.limit === "number" && params.limit >= 1
            ? Math.min(Math.floor(params.limit), LIST_LIMIT_MAX)
            : 50;
        const tasks = await store.list({
          principal,
          ...(statuses ? { statuses } : {}),
          includeClosed: params.includeClosed === true,
          limit,
        });
        respond(true, { ownerId: principal.ownerId, tasks });
      }),
      "operator.read",
    ],
    [
      "nexus.task.get",
      guarded(async ({ principal, store, params, respond }) => {
        const taskId = normalizeTaskId(params.taskId);
        if (!taskId) {
          reject(respond, "nexus_invalid_params", "taskId is required");
          return;
        }
        // RPC reads do not bind a session: only tools acting inside a conversation do.
        const detail = await store.get({
          principal,
          taskId,
          now: now(),
          stepLimit: RPC_STEP_LIMIT,
        });
        if (!detail) {
          reject(respond, "nexus_not_found", "task not found");
          return;
        }
        respond(true, { ownerId: principal.ownerId, ...detail });
      }),
      "operator.read",
    ],
    [
      "nexus.task.abort",
      guarded(async ({ principal, store, params, respond }) => {
        const taskId = normalizeTaskId(params.taskId);
        if (!taskId) {
          reject(respond, "nexus_invalid_params", "taskId is required");
          return;
        }
        const result = await store.abort({ principal, taskId, now: now() });
        if (result.outcome === "not_found") {
          reject(respond, "nexus_not_found", "task not found");
          return;
        }
        if (result.outcome === "task_closed") {
          reject(respond, "nexus_task_closed", `task already ${result.task.status}`);
          return;
        }
        if (result.outcome === "aborted") {
          deps.events.taskChanged("aborted", result.task);
        }
        respond(true, { ownerId: principal.ownerId, outcome: result.outcome, task: result.task });
      }),
      "operator.write",
    ],
    [
      "nexus.task.delete",
      guarded(async ({ principal, store, params, respond }) => {
        const taskId = normalizeTaskId(params.taskId);
        if (!taskId) {
          reject(respond, "nexus_invalid_params", "taskId is required");
          return;
        }
        const deletedAt = now();
        const result = await store.softDelete({ principal, taskId, now: deletedAt });
        if (result.outcome === "not_found") {
          reject(respond, "nexus_not_found", "task not found");
          return;
        }
        if (result.outcome === "purging") {
          reject(respond, "nexus_task_purging", "task is being purged");
          return;
        }
        if (result.outcome === "deleted") {
          // Deleted Tasks are hidden from get, so the event is built from the kernel's result.
          deps.events.taskChanged("deleted", {
            ownerId: principal.ownerId,
            id: taskId,
            status: "deleted",
            revision: result.revision,
            updatedAt: deletedAt,
          });
        }
        respond(true, { ownerId: principal.ownerId, outcome: result.outcome, taskId });
      }),
      "operator.write",
    ],
  ] as const;
}
