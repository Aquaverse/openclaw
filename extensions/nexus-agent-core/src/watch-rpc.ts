// Gateway RPC for the Watcher (DESIGN sections 10 and 12): nexus.watch.list / get (operator.read), nexus.watch.cancel
// (operator.write). Creating a watch is deliberately not an operator method: a watch belongs to a claim an Agent registered.
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { EventBridge } from "./events.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";
import { WATCH_STATUSES, type WatchRecord, type WatchStatus } from "./store/watch-types.js";
import { normalizeTaskId } from "./tools/task-tools.js";

export type WatchRpcDeps = {
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  resolvePrincipal: () => Principal | undefined;
  now?: () => number;
  afterCancel?: (principal: Principal, watch: WatchRecord) => Promise<void>;
};

type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;
type Respond = GatewayRequestHandlerOptions["respond"];

const ID = /^[A-Za-z0-9]{1,64}$/;

function reject(respond: Respond, code: string, message: string) {
  respond(false, undefined, { code, message });
}

export function createWatchRpcHandlers(deps: WatchRpcDeps) {
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
      "nexus.watch.list",
      guarded(async ({ principal, store, params, respond }) => {
        let taskId: string | undefined;
        if (params.taskId !== undefined) {
          taskId = normalizeTaskId(params.taskId);
          if (!taskId) {
            reject(respond, "nexus_invalid_params", "taskId is malformed");
            return;
          }
        }
        let statuses: WatchStatus[] | undefined;
        if (params.statuses !== undefined) {
          if (
            !Array.isArray(params.statuses) ||
            !params.statuses.every((s) => (WATCH_STATUSES as readonly unknown[]).includes(s))
          ) {
            reject(respond, "nexus_invalid_params", "statuses must be a list of watch statuses");
            return;
          }
          statuses = params.statuses as WatchStatus[];
        }
        const limit = Math.min(Math.max(Number(params.limit ?? 50) || 50, 1), 200);
        const watches = await store.watchList({
          principal,
          ...(taskId ? { taskId } : {}),
          ...(statuses ? { statuses } : {}),
          limit,
        });
        respond(true, { ownerId: principal.ownerId, watches });
      }),
      "operator.read",
    ],
    [
      "nexus.watch.get",
      guarded(async ({ principal, store, params, respond }) => {
        const watchId =
          typeof params.watchId === "string" && ID.test(params.watchId)
            ? params.watchId
            : undefined;
        if (!watchId) {
          reject(respond, "nexus_invalid_params", "watchId is required");
          return;
        }
        const watch = await store.watchGet({ principal, watchId });
        if (!watch) {
          reject(respond, "nexus_not_found", "watch not found");
          return;
        }
        respond(true, { ownerId: principal.ownerId, watch });
      }),
      "operator.read",
    ],
    [
      "nexus.watch.cancel",
      guarded(async ({ principal, store, params, respond }) => {
        const watchId =
          typeof params.watchId === "string" && ID.test(params.watchId)
            ? params.watchId
            : undefined;
        if (!watchId) {
          reject(respond, "nexus_invalid_params", "watchId is required");
          return;
        }
        const out = await store.watchCancel({ principal, watchId, now: now() });
        if (out.outcome === "not_found") {
          reject(respond, "nexus_not_found", "watch not found");
          return;
        }
        if (out.outcome === "already_closed") {
          reject(respond, "nexus_conflict", `watch already ${out.status}`);
          return;
        }
        if (out.task) {
          deps.events.taskChanged("updated", out.task);
        }
        deps.events.watchChanged({
          ownerId: principal.ownerId,
          watchId: out.watch.id,
          taskId: out.watch.taskId,
          status: out.watch.status,
          change: "cancelled",
        });
        await deps.afterCancel?.(principal, out.watch).catch(() => undefined);
        respond(true, { ownerId: principal.ownerId, outcome: "cancelled", watch: out.watch });
      }),
      "operator.write",
    ],
  ] as const;
}
