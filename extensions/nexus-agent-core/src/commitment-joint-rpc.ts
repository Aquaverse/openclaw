// Gateway RPC for "who answers when the words named several people" (design 6.8, W3c-2): nexus.commitment.resolveJoint.
// A Commitment whose typed responsible words named several people carries `ambiguity` until the user chooses one of the two legal
// forms: `lead` (one person answers, the others help) or `each` (one Commitment per person). The console is the user, so this
// writes as the user (operator.write); the Agent cannot choose. A change reaches the Works that cite the Commitments through
// `work_changed`. Replies carry ownerId.
import { COMMITMENT_PARTICIPANT_ROLES } from "./commitment/types.js";
import type { CommitmentParticipantRole } from "./commitment/types.js";
import type { EventBridge } from "./events.js";
import { createGuard, reject, type GatewayRequestHandler, type TaskRpcDeps } from "./rpc.js";
import type { JointChoice } from "./store/commitment-joint-ledger.js";

export type CommitmentJointRpcDeps = Pick<TaskRpcDeps, "getStore" | "resolvePrincipal" | "now"> & {
  events: EventBridge;
};

const idOf = (raw: unknown): string | undefined =>
  typeof raw === "string" && /^[A-Za-z0-9_#:.-]{1,200}$/.test(raw) ? raw : undefined;

function idList(raw: unknown): string[] | undefined {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > 40) {
    return undefined;
  }
  const ids = raw.map(idOf);
  return ids.every((id): id is string => id !== undefined) ? ids : undefined;
}

function parseChoice(params: Record<string, unknown>): JointChoice | undefined {
  if (params.choice === "lead") {
    const leadId = idOf(params.leadId);
    const helperIds = idList(params.helperIds);
    const role =
      params.helperRole === undefined
        ? "participant"
        : (COMMITMENT_PARTICIPANT_ROLES as readonly unknown[]).find((r) => r === params.helperRole);
    return leadId && helperIds && role
      ? { kind: "lead", leadId, helperIds, helperRole: role as CommitmentParticipantRole }
      : undefined;
  }
  if (params.choice === "each") {
    const counterpartIds = idList(params.counterpartIds);
    return counterpartIds ? { kind: "each", counterpartIds } : undefined;
  }
  return undefined;
}

/** Returns [method, handler, scope] triples; the caller registers them. */
export function createCommitmentJointRpcHandlers(deps: CommitmentJointRpcDeps) {
  const now = deps.now ?? Date.now;
  const guarded = createGuard(deps);
  const methods: (readonly [string, GatewayRequestHandler, "operator.write"])[] = [
    [
      "nexus.commitment.resolveJoint",
      guarded(async ({ principal, store, params, respond }) => {
        const commitmentId = idOf(params.commitmentId);
        const choice = parseChoice(params);
        if (!commitmentId || !choice) {
          reject(
            respond,
            "nexus_invalid_params",
            "commitmentId and choice are required: choice 'lead' needs leadId (and optional helperIds, helperRole), choice 'each' needs counterpartIds",
          );
          return;
        }
        const result = await store.commitmentResolveJoint({
          principal,
          commitmentId,
          choice,
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
        if (result.outcome === "not_joint") {
          reject(
            respond,
            "nexus_commitment_state",
            "this commitment is not waiting for a choice of who answers",
          );
          return;
        }
        if (result.outcome === "invalid") {
          reject(respond, "nexus_invalid_params", String(result.code));
          return;
        }
        for (const workId of result.workIds) {
          deps.events.workChanged({ ownerId: principal.ownerId, workId, action: "commitment" });
        }
        respond(true, { ownerId: principal.ownerId, ...result });
      }),
      "operator.write",
    ],
    [
      "nexus.commitment.backfillJoint",
      guarded(async ({ principal, store, params, respond }) => {
        // Marks OLD open Commitments whose typed words named several people (made before W3c-2), so the console asks the user
        // to choose. dryRun (default true) only reports; "任一人完成即可" wordings are listed and never changed.
        if (params.dryRun !== undefined && typeof params.dryRun !== "boolean") {
          reject(respond, "nexus_invalid_params", "dryRun must be a boolean");
          return;
        }
        const result = await store.commitmentJointBackfill({
          principal,
          dryRun: params.dryRun !== false,
          now: now(),
        });
        for (const workId of result.workIds) {
          deps.events.workChanged({ ownerId: principal.ownerId, workId, action: "commitment" });
        }
        respond(true, { ownerId: principal.ownerId, ...result });
      }),
      "operator.write",
    ],
  ];
  return methods;
}
