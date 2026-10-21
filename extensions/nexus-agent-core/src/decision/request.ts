// Parsing of nexus_decision_request parameters, shared by the tool handler and the before_tool_call hook so both
// derive the same request from the same text (DESIGN section 8.8.3: the handler re-derives what the hook saw).
import type { EffectKind } from "../store/decision-types.js";

export type DecisionRequestParams = {
  taskId: string;
  effectKind?: EffectKind;
  actionIds: string[];
};

const TASK_ID = /^#?(T[0-9A-Z]{4,16})$/;
const ACTION_ID = /^[A-Za-z0-9_-]{1,40}$/;
const KINDS = new Set<string>([
  "issue_action_grant",
  "issue_standing_grant",
  "acknowledge",
  "set_preference",
]);

export function parseDecisionRequest(raw: unknown): DecisionRequestParams | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "params must be an object: { taskId, effect: { actionIds: [...] } }";
  }
  const params = raw as Record<string, unknown>;
  const taskId =
    typeof params.taskId === "string" ? TASK_ID.exec(params.taskId.trim())?.[1] : undefined;
  if (!taskId) {
    return "taskId looks like T0ABC123 (a leading # is allowed).";
  }
  const effect = params.effect;
  if (typeof effect !== "object" || effect === null || Array.isArray(effect)) {
    return "effect must be an object: { actionIds: [...] } (kind may be omitted; the server derives it from the risk tier).";
  }
  const { kind, actionIds } = effect as Record<string, unknown>;
  // `kind` is optional and the server derives it from the risk tier. Models fill it with free text ("booking"),
  // so an unrecognised value is ignored instead of failing the whole request; a recognised one is still validated
  // downstream (e.g. set_preference is rejected as unsupported, a tier mismatch is rejected by the kernel).
  const knownKind = typeof kind === "string" && KINDS.has(kind) ? kind : undefined;
  const ids = actionIds === undefined ? [] : actionIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !ACTION_ID.test(id))) {
    return "effect.actionIds must be an array of actionId strings.";
  }
  return {
    taskId,
    ...(knownKind !== undefined ? { effectKind: knownKind as EffectKind } : {}),
    actionIds: [...new Set(ids as string[])],
  };
}
