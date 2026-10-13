// Gateway RPC for the Claim / Evidence ledger (DESIGN sections 9.5 and 12). Reads need operator.read; retract and
// unlinkEvidence are operator-only writes (the Agent has no tool for either). The digest chain can be re-verified here.
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { EventBridge } from "./events.js";
import { CLAIM_STATES, type ClaimState } from "./store/claim-types.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";
import { normalizeTaskId } from "./tools/task-tools.js";

export type ClaimRpcDeps = {
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  resolvePrincipal: () => Principal | undefined;
  /** Deliver the claim_changed outbox rows a write just produced. */
  kickOutbox?: () => void;
  now?: () => number;
};

type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;
type Respond = GatewayRequestHandlerOptions["respond"];

const LIMIT_MAX = 200;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const OPERATOR_ACTOR = "operator:nexus-console";

function reject(respond: Respond, code: string, message: string, extra?: Record<string, unknown>) {
  respond(false, undefined, { code, message, ...(extra ? { details: extra } : {}) });
}

function readId(raw: unknown): string | undefined {
  return typeof raw === "string" && ID.test(raw) ? raw : undefined;
}

function readReason(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 && raw.length <= 500
    ? raw.trim()
    : undefined;
}

/** Returns [method, handler, scope] triples; the caller registers them. */
export function createClaimRpcHandlers(deps: ClaimRpcDeps) {
  const now = deps.now ?? Date.now;
  const guarded =
    (
      run: (args: {
        principal: Principal;
        store: TaskStore;
        params: Record<string, unknown>;
        taskId: string;
        respond: Respond;
      }) => Promise<void>,
    ): GatewayRequestHandler =>
    async ({ params, respond }) => {
      const principal = deps.resolvePrincipal();
      if (!principal) {
        reject(respond, "nexus_no_principal", "cannot resolve the owner");
        return;
      }
      const source = params ?? {};
      const taskId = normalizeTaskId(source.taskId);
      if (!taskId) {
        reject(respond, "nexus_invalid_params", "taskId is required");
        return;
      }
      try {
        await run({ principal, store: await deps.getStore(), params: source, taskId, respond });
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
      "nexus.claim.list",
      guarded(async ({ principal, store, params, taskId, respond }) => {
        const states = params.states;
        if (
          states !== undefined &&
          (!Array.isArray(states) ||
            !states.every((s) => (CLAIM_STATES as readonly unknown[]).includes(s)))
        ) {
          reject(respond, "nexus_invalid_params", "states must be an array of known claim states");
          return;
        }
        const limit =
          typeof params.limit === "number" && params.limit >= 1
            ? Math.min(Math.floor(params.limit), LIMIT_MAX)
            : 50;
        const claims = await store.listClaims({
          principal,
          taskId,
          ...(states ? { states: states as ClaimState[] } : {}),
          limit,
        });
        const completion = await store.checkCompletion({ principal, taskId });
        respond(true, { ownerId: principal.ownerId, taskId, claims, completion });
      }),
      "operator.read",
    ],
    [
      "nexus.claim.get",
      guarded(async ({ principal, store, params, taskId, respond }) => {
        const claimId = readId(params.claimId);
        if (!claimId) {
          reject(respond, "nexus_invalid_params", "claimId is required");
          return;
        }
        const detail = await store.getClaim({ principal, taskId, claimId });
        if (!detail) {
          reject(respond, "nexus_not_found", "claim not found");
          return;
        }
        respond(true, { ownerId: principal.ownerId, ...detail });
      }),
      "operator.read",
    ],
    [
      "nexus.claim.verifyChain",
      guarded(async ({ principal, store, taskId, respond }) => {
        const chain = await store.verifyChain({ principal, taskId });
        respond(true, { ownerId: principal.ownerId, taskId, ...chain });
      }),
      "operator.read",
    ],
    [
      "nexus.claim.retract",
      guarded(async ({ principal, store, params, taskId, respond }) => {
        const claimId = readId(params.claimId);
        const reason = readReason(params.reason);
        if (!claimId || !reason) {
          reject(respond, "nexus_invalid_params", "claimId and reason are required");
          return;
        }
        const result = await store.retractClaim({
          principal,
          taskId,
          claimId,
          reason,
          actor: OPERATOR_ACTOR,
          now: now(),
        });
        if (result.outcome === "not_found" || result.outcome === "claim_not_found") {
          reject(respond, "nexus_not_found", "claim not found");
          return;
        }
        deps.kickOutbox?.();
        respond(true, { ownerId: principal.ownerId, ...result });
      }),
      "operator.write",
    ],
    [
      "nexus.claim.unlinkEvidence",
      guarded(async ({ principal, store, params, taskId, respond }) => {
        const claimId = readId(params.claimId);
        const evidenceId = readId(params.evidenceId);
        const reason = readReason(params.reason);
        if (!claimId || !evidenceId || !reason) {
          reject(respond, "nexus_invalid_params", "claimId, evidenceId and reason are required");
          return;
        }
        const result = await store.unlinkEvidence({
          principal,
          taskId,
          claimId,
          evidenceId,
          reason,
          actor: OPERATOR_ACTOR,
          now: now(),
        });
        if (result.outcome === "not_found" || result.outcome === "claim_not_found") {
          reject(respond, "nexus_not_found", "claim not found");
          return;
        }
        if (result.outcome === "not_linked") {
          reject(respond, "nexus_not_found", "evidence is not linked to this claim");
          return;
        }
        deps.kickOutbox?.();
        respond(true, { ownerId: principal.ownerId, ...result });
      }),
      "operator.write",
    ],
  ] as const;
}
