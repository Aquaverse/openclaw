// Request parsing and outcome-refusal helpers shared by the schedule RPC handlers (design 10.2).
// Kept in a sibling module so the handler table stays within the line cap; behaviour is unchanged.
import { reject, type GatewayRequestHandler } from "./rpc.js";
import type { PlanGap } from "./schedule/types.js";

export type Respond = Parameters<GatewayRequestHandler>[0]["respond"];

export const idOf = (raw: unknown): string | undefined =>
  typeof raw === "string" && /^[A-Za-z0-9_#:.@-]{1,200}$/.test(raw) ? raw : undefined;
export const intOf = (raw: unknown): number | undefined =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
export const isObject = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw);

/** The answers every call can give besides its success; true when it has answered. */
export function refuse(
  respond: Respond,
  result: { outcome: string } & Record<string, unknown>,
): boolean {
  switch (result.outcome) {
    case "not_found":
    case "work_not_found":
    case "owner_missing":
      reject(respond, "nexus_not_found", result.outcome.replace(/_/g, " "));
      return true;
    case "conflict":
    case "current_changed":
      reject(respond, "nexus_revision_conflict", "it changed; reload it");
      return true;
    case "invalid":
      reject(respond, "nexus_invalid_params", String(result.code));
      return true;
    case "owner_closed":
    case "executive_work":
    case "work_changed":
    case "not_draft":
    case "not_accepted":
    case "plan_exists":
    case "gaps":
    case "already_final":
    case "not_paused":
    case "is_blocked":
    case "manual_pause_kept":
    case "work_paused":
    case "wrapping_up":
    case "not_blocked":
    case "not_final":
    case "not_restorable":
    case "plan_not_accepted":
    case "once_passed":
    case "commitment_closed":
    case "carrier_changed":
    case "work_not_candidate":
      reject(respond, "nexus_schedule_state", result.outcome.replace(/_/g, " "));
      return true;
    default:
      return false;
  }
}

export function parseGaps(raw: unknown): PlanGap[] | undefined | "invalid" {
  if (raw === undefined) {
    return undefined;
  }
  return Array.isArray(raw) ? (raw as PlanGap[]) : "invalid";
}
