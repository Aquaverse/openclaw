// Gateway RPC for Goals: the small shared pieces (id and key shapes, list cap, the one error shape, and the single place that
// turns every refusal a goal write can return into an RPC error). The handlers are in goal-rpc.ts.
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { GoalEntryKind, GoalLinkKind } from "./store/goal-types.js";

export type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;
export type Respond = GatewayRequestHandlerOptions["respond"];

export const ID = /^[A-Za-z0-9_-]{1,64}$/u;
export const SESSION_KEY = /^[A-Za-z0-9:_.@-]{1,256}$/u;
export const MAX_LIST = 200;
export const USER_ENTRY_KINDS: ReadonlySet<GoalEntryKind> = new Set(["note", "milestone"]);
export const USER_LINK_KINDS: ReadonlySet<GoalLinkKind> = new Set(["task", "vault_file"]);

export function reject(
  respond: Respond,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  respond(false, undefined, {
    code,
    message,
    ...(Object.keys(extra).length ? { details: extra } : {}),
  });
}

export const readId = (raw: unknown): string | undefined =>
  typeof raw === "string" && ID.test(raw) ? raw : undefined;

/** Maps every refusal a goal write can return to one RPC error; returns true when it answered. */
export function answerRefusal(
  respond: Respond,
  out: { outcome: string; [key: string]: unknown },
): boolean {
  switch (out.outcome) {
    case "not_found":
    case "entry_not_found":
    case "link_not_found":
      reject(respond, "nexus_not_found", `${out.outcome.replace("_", " ")}`);
      return true;
    case "not_live":
      reject(respond, "nexus_conflict", `the goal is ${String(out.lifecycle)}`, {
        lifecycle: out.lifecycle,
      });
      return true;
    case "bad_state":
      reject(respond, "nexus_conflict", `not allowed while the goal is ${String(out.status)}`, {
        status: out.status,
      });
      return true;
    case "stale":
      reject(respond, "nexus_conflict", "the goal changed; reload it", { revision: out.revision });
      return true;
    case "limit_reached":
      reject(
        respond,
        "nexus_limit_reached",
        `limit of ${String(out.max)} ${String(out.kind)} reached`,
        {
          max: out.max,
          kind: out.kind,
        },
      );
      return true;
    case "invalid":
      reject(respond, "nexus_invalid_params", `${String(out.code)} is not valid`, {
        code: out.code,
      });
      return true;
    case "sensitive_value":
      reject(
        respond,
        "nexus_sensitive_value",
        "do not save ID, card or account numbers in a goal",
        { kind: out.kind },
      );
      return true;
    case "parent_invalid":
      reject(
        respond,
        "nexus_conflict",
        `the parent goal cannot take a sub-goal (${String(out.reason)})`,
        {
          reason: out.reason,
        },
      );
      return true;
    case "refused":
      reject(respond, "nexus_conflict", `refused (${String(out.reason)})`, { reason: out.reason });
      return true;
    case "purging":
      reject(respond, "nexus_conflict", "the goal is being purged");
      return true;
    case "parent_deleted":
      reject(respond, "nexus_conflict", "restore the parent goal first");
      return true;
    case "task_not_found":
    case "claim_not_found":
    case "target_not_found":
      reject(respond, "nexus_not_found", out.outcome.replace(/_/gu, " "));
      return true;
    case "target_unavailable":
      reject(respond, "nexus_conflict", `the target cannot be linked (${String(out.reason)})`, {
        reason: out.reason,
      });
      return true;
    case "capability_unavailable":
      reject(respond, "nexus_conflict", "that kind of link is not available");
      return true;
    case "task_linked_elsewhere":
      reject(respond, "nexus_conflict", "the Task already belongs to another goal", {
        goalId: out.goalId,
      });
      return true;
    default:
      return false;
  }
}
