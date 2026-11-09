import { createGuard, reject, type GatewayRequestHandler, type TaskRpcDeps } from "./rpc.js";
// Gateway RPC for "clear a deleted person" (PRD R-32, FG): nexus.counterpart.purge / nexus.counterpart.purgeReceipts.
// Deleting a person only stops them; this removes their contact methods, other names and relations (the name stays, the
// Commitment history is not touched). It needs operator.admin and the number of people typed again in `confirmCount`, so a stray
// or replayed call cannot clear anyone. `dryRun` says what would be cleared and needs no confirmation.
import { PURGE_BATCH_MAX } from "./store/counterpart-purge-ledger.js";

export type CounterpartPurgeRpcDeps = Pick<TaskRpcDeps, "getStore" | "resolvePrincipal" | "now">;

const idOf = (raw: unknown): string | undefined =>
  typeof raw === "string" && /^[A-Za-z0-9_#:.-]{1,200}$/.test(raw) ? raw : undefined;

const RECEIPT_LIMIT_MAX = 200;

/** Returns [method, handler, scope] triples; the caller registers them. */
export function createCounterpartPurgeRpcHandlers(deps: CounterpartPurgeRpcDeps) {
  const now = deps.now ?? Date.now;
  const guarded = createGuard(deps);
  const need = (respond: Parameters<GatewayRequestHandler>[0]["respond"], message: string): void =>
    reject(respond, "nexus_invalid_params", message);
  const methods: (readonly [string, GatewayRequestHandler, "operator.read" | "operator.admin"])[] =
    [
      [
        "nexus.counterpart.purge",
        guarded(async ({ principal, store, params, respond }) => {
          const raw = params.counterpartIds;
          if (
            !Array.isArray(raw) ||
            raw.length === 0 ||
            raw.length > PURGE_BATCH_MAX ||
            !raw.every((item) => idOf(item) !== undefined)
          ) {
            need(respond, `counterpartIds must list 1 to ${PURGE_BATCH_MAX} person ids`);
            return;
          }
          const ids = [...new Set(raw as string[])];
          const dryRun = params.dryRun === true;
          if (!dryRun && params.confirmCount !== ids.length) {
            reject(
              respond,
              "nexus_confirmation_required",
              "this clears the contact methods, other names and relations for good; repeat the number of people in confirmCount to confirm",
            );
            return;
          }
          const result = await store.counterpartPurge({
            principal,
            counterpartIds: ids,
            ...(dryRun ? { dryRun: true } : {}),
            now: now(),
          });
          if (result.outcome === "invalid") {
            need(respond, String(result.code));
            return;
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.admin",
      ],
      [
        "nexus.counterpart.purgeReceipts",
        guarded(async ({ principal, store, params, respond }) => {
          const limit =
            typeof params.limit === "number" && params.limit >= 1
              ? Math.min(Math.floor(params.limit), RECEIPT_LIMIT_MAX)
              : 50;
          const offset =
            typeof params.offset === "number" && params.offset >= 1
              ? Math.min(Math.floor(params.offset), 100_000)
              : 0;
          const result = await store.counterpartPurgeReceipts({ principal, limit, offset });
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.read",
      ],
    ];
  return methods;
}
