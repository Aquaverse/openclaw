// Gateway RPC for "these two records are not the same person" (W3c-4): nexus.counterpart.notSame / nexus.counterpart.notSameRestore.
// The console is the user, so these write as the user (operator.write). A mark only silences the "may be the same person" hint
// between the two records; it changes no name, contact or commitment. Taking it back brings the hint back. Replies carry ownerId.
import { createGuard, reject, type GatewayRequestHandler, type TaskRpcDeps } from "./rpc.js";

export type CounterpartSameRpcDeps = Pick<TaskRpcDeps, "getStore" | "resolvePrincipal" | "now">;

const idOf = (raw: unknown): string | undefined =>
  typeof raw === "string" && /^[A-Za-z0-9_#:.-]{1,200}$/.test(raw) ? raw : undefined;

/** Returns [method, handler, scope] triples; the caller registers them. */
export function createCounterpartSameRpcHandlers(deps: CounterpartSameRpcDeps) {
  const now = deps.now ?? Date.now;
  const guarded = createGuard(deps);
  const handler = (method: "counterpartNotSame" | "counterpartNotSameRestore") =>
    guarded(async ({ principal, store, params, respond }) => {
      const counterpartId = idOf(params.counterpartId);
      const otherId = idOf(params.otherId);
      if (!counterpartId || !otherId) {
        reject(respond, "nexus_invalid_params", "counterpartId and otherId are required");
        return;
      }
      const result = await store[method]({ principal, counterpartId, otherId, now: now() });
      switch (result.outcome) {
        case "not_found":
          reject(respond, "nexus_not_found", "not found");
          return;
        case "invalid":
          reject(respond, "nexus_invalid_params", String(result.code));
          return;
        case "forbidden":
          reject(respond, "nexus_forbidden", String(result.code));
          return;
        case "closed":
          reject(respond, "nexus_counterpart_state", `the person is ${String(result.lifecycle)}`);
          return;
        default:
          respond(true, { ownerId: principal.ownerId, ...result });
      }
    });
  const methods: (readonly [string, GatewayRequestHandler, "operator.write"])[] = [
    ["nexus.counterpart.notSame", handler("counterpartNotSame"), "operator.write"],
    ["nexus.counterpart.notSameRestore", handler("counterpartNotSameRestore"), "operator.write"],
  ];
  return methods;
}
