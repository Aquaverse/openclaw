// Gateway RPC for "the people who help with a Commitment" (design 6.8, W3c-1): nexus.commitment.assistAdd / assistRemove.
// A helper has a role (participant, approver or recipient); they do not answer for the Commitment and are not a sending
// authorization. The console is the user, so these write as the user (operator.write); the Agent has no tool for this yet.
// The list of helpers comes back with `nexus.commitment.get` (`helpers`). A change reaches the Works that cite the Commitment
// through `work_changed`, and the commitment count on each card through the next read. Replies carry ownerId.
import { COMMITMENT_LIMITS, COMMITMENT_PARTICIPANT_ROLES } from "./commitment/types.js";
import type { CommitmentParticipantRole } from "./commitment/types.js";
import type { EventBridge } from "./events.js";
import { createGuard, reject, type GatewayRequestHandler, type TaskRpcDeps } from "./rpc.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";

export type CommitmentAssistRpcDeps = Pick<TaskRpcDeps, "getStore" | "resolvePrincipal" | "now"> & {
  events: EventBridge;
};

const idOf = (raw: unknown): string | undefined =>
  typeof raw === "string" && /^[A-Za-z0-9_#:.-]{1,200}$/.test(raw) ? raw : undefined;

/** Returns [method, handler, scope] triples; the caller registers them. */
export function createCommitmentAssistRpcHandlers(deps: CommitmentAssistRpcDeps) {
  const now = deps.now ?? Date.now;
  const guarded = createGuard(deps);
  const announce = async (store: TaskStore, principal: Principal, commitmentId: string) => {
    try {
      const out = await store.commitmentImpact({ principal, commitmentId });
      if (out.outcome === "ok") {
        for (const work of out.impact.works) {
          deps.events.workChanged({
            ownerId: principal.ownerId,
            workId: work.workId,
            action: "commitment",
          });
        }
      }
    } catch {
      // best effort after the commit
    }
  };
  const methods: (readonly [string, GatewayRequestHandler, "operator.write"])[] = [
    [
      "nexus.commitment.assistAdd",
      guarded(async ({ principal, store, params, respond }) => {
        const commitmentId = idOf(params.commitmentId);
        const counterpartId = idOf(params.counterpartId);
        const role = (COMMITMENT_PARTICIPANT_ROLES as readonly unknown[]).find(
          (r) => r === params.role,
        ) as CommitmentParticipantRole | undefined;
        const purpose =
          params.purpose === undefined || params.purpose === null
            ? ""
            : typeof params.purpose === "string" &&
                params.purpose.length <= COMMITMENT_LIMITS.purpose
              ? params.purpose
              : null;
        if (!commitmentId || !counterpartId || !role || purpose === null) {
          reject(
            respond,
            "nexus_invalid_params",
            "commitmentId, counterpartId and a role (participant, approver, recipient) are required; purpose is optional text",
          );
          return;
        }
        const result = await store.commitmentAssistAdd({
          principal,
          commitmentId,
          counterpartId,
          role,
          ...(purpose ? { purpose } : {}),
          now: now(),
        });
        if (result.outcome === "not_found") {
          reject(respond, "nexus_not_found", "not found");
          return;
        }
        if (result.outcome === "closed") {
          reject(respond, "nexus_commitment_state", `the commitment is ${result.lifecycle}`);
          return;
        }
        if (result.outcome === "invalid") {
          reject(respond, "nexus_invalid_params", String(result.code));
          return;
        }
        if (result.outcome === "added") {
          await announce(store, principal, commitmentId);
        }
        respond(true, { ownerId: principal.ownerId, ...result });
      }),
      "operator.write",
    ],
    [
      "nexus.commitment.assistRemove",
      guarded(async ({ principal, store, params, respond }) => {
        const commitmentId = idOf(params.commitmentId);
        const linkId = idOf(params.linkId);
        if (!commitmentId || !linkId) {
          reject(respond, "nexus_invalid_params", "commitmentId and linkId are required");
          return;
        }
        const result = await store.commitmentAssistRemove({
          principal,
          commitmentId,
          linkId,
          now: now(),
        });
        if (result.outcome === "not_found") {
          reject(respond, "nexus_not_found", "not found");
          return;
        }
        await announce(store, principal, commitmentId);
        respond(true, { ownerId: principal.ownerId, ...result });
      }),
      "operator.write",
    ],
  ];
  return methods;
}
