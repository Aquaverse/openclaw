// Agent tools for the Preference Store (DESIGN section 11): nexus_preference_get, nexus_preference_set,
// nexus_preference_confirm. A preference is a default or a candidate, never authority (section 11.1).
//   * nexus_preference_set can write `observed` and `task_exception` only. `stated` has no way in from here: it needs the
//     user, either in the preference page (RPC) or by approving the decision nexus_preference_confirm creates.
//   * nexus_preference_confirm asks the user to confirm a value as `stated`. The card is built by the server from the value;
//     nothing is written until the user approves, and approving it signs no grant and creates no execution.
import { Type } from "typebox";
import type { AnyAgentTool } from "../../api.js";
import { canonicalJson } from "../canonical.js";
import type { EventBridge } from "../events.js";
import type { TaskStore } from "../store/host.js";
import {
  isValidPreferenceKey,
  isValidPreferenceScope,
  type PreferenceInvalidCode,
  type PreferenceRecord,
} from "../store/preference-types.js";
import type { Principal } from "../store/types.js";
import { jsonResult, normalizeTaskId } from "./task-tools.js";

export const PREFERENCE_TOOL_NAMES = [
  "nexus_preference_get",
  "nexus_preference_set",
  "nexus_preference_confirm",
] as const;

const NO_SESSION = "(no-session)";

export type PreferenceToolDeps = {
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  resolvePrincipal: (ctx: { agentId?: string; sessionKey?: string }) => Principal | undefined;
  now?: () => number;
  /** Present only when decisions are enabled; without it nexus_preference_confirm is reported as unavailable. */
  decisionsEnabled?: boolean;
  onOutboxWritten?: () => void;
};

type ToolContext = { agentId?: string; sessionKey?: string };

function fail(code: string, message: string, extra: Record<string, unknown> = {}) {
  return {
    ok: false,
    code,
    message,
    ...extra,
    notice:
      "This call FAILED and changed nothing. Tell the user it failed; never say a preference was saved or confirmed.",
  };
}

const INVALID_HINTS: Record<PreferenceInvalidCode, string> = {
  bad_scope:
    "scope can only be global or domain:<name> (lowercase letters, digits, underscore, dot, hyphen; at most 40).",
  bad_key:
    "key uses lowercase letters, digits, underscore, dot and hyphen, at most 64, and starts with a letter or digit.",
  bad_value: "value must be a serializable JSON value.",
  value_too_large:
    "value is too large; a preference should be a short value (at most 4096 bytes serialized).",
  origin_not_allowed:
    "You can only write observed or task_exception. To confirm a value as a user-stated preference, use nexus_preference_confirm so the user confirms it.",
  task_required: "task_exception requires a taskId.",
  task_forbidden: "observed must not carry a taskId (it does not belong to a single Task).",
  bad_confidence:
    "observed needs a confidence between 0 and 1 (excluding 0); task_exception must not carry a confidence.",
  source_note_required:
    "observed must state its basis in sourceNote (which Tasks it was inferred from); an inference with no basis cannot be told apart from a guess.",
  source_note_too_long: "sourceNote is at most 500 characters.",
};

function view(preference: PreferenceRecord) {
  return {
    preferenceId: preference.id,
    scope: preference.scope,
    key: preference.key,
    value: preference.value,
    origin: preference.origin,
    taskId: preference.taskId,
    confidence: preference.confidence,
    revision: preference.revision,
  };
}

const NOT_AUTHORITY =
  "A preference only changes a default or narrows candidates. It is NOT permission: it never lets you act without the user's approval and never lowers an action's risk.";

export function createPreferenceTools(deps: PreferenceToolDeps, ctx: ToolContext): AnyAgentTool[] {
  const now = deps.now ?? Date.now;
  const sessionKey = ctx.sessionKey ?? NO_SESSION;

  const withPrincipal = async (
    run: (principal: Principal, store: TaskStore) => Promise<Record<string, unknown>>,
  ) => {
    const principal = deps.resolvePrincipal(ctx);
    if (!principal) {
      return jsonResult(
        fail(
          "no_principal",
          "Cannot determine the current principal; Nexus is not serving this request.",
        ),
      );
    }
    try {
      return jsonResult(await run(principal, await deps.getStore()));
    } catch (error) {
      return jsonResult(
        fail("store_error", error instanceof Error ? error.message : String(error)),
      );
    }
  };

  const readScopeKey = (params: Record<string, unknown>) => {
    const scope = params.scope === undefined ? "global" : params.scope;
    if (!isValidPreferenceScope(scope)) {
      return fail("invalid_scope", INVALID_HINTS.bad_scope);
    }
    if (!isValidPreferenceKey(params.key)) {
      return fail("invalid_key", INVALID_HINTS.bad_key);
    }
    return { scope, key: params.key };
  };

  const tools = [
    {
      name: "nexus_preference_get",
      label: "Nexus: read a preference",
      description:
        "Read what the user prefers for a key, with the entries it overrides (so you can say why a default is what it is). Pass taskId to also consider a one-off exception for that Task. A preference is a default, never permission to act.",
      parameters: Type.Object({
        key: Type.String(),
        scope: Type.Optional(Type.String({ description: 'Default "global"; or "domain:<name>".' })),
        taskId: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const parsed = readScopeKey(params);
          if ("ok" in parsed) {
            return parsed;
          }
          let taskId: string | undefined;
          if (params.taskId !== undefined) {
            taskId = normalizeTaskId(params.taskId);
            if (!taskId) {
              return fail(
                "invalid_task_id",
                "taskId looks like T0ABC123 (a leading # is allowed).",
              );
            }
          }
          const out = await store.preferenceGet({
            principal,
            scope: parsed.scope,
            key: parsed.key,
            ...(taskId ? { taskId } : {}),
          });
          if (out.outcome === "none") {
            return {
              ok: true,
              found: false,
              scope: parsed.scope,
              key: parsed.key,
              message:
                "No such preference is recorded. Do not assume the user's preference; ask the user if you need it.",
            };
          }
          const found = out.resolution;
          return {
            ok: true,
            found: true,
            scope: found.scope,
            key: found.key,
            value: found.value,
            origin: found.origin,
            eligibleForAutomation: found.eligibleForAutomation,
            shadowed: found.shadowed.map((entry) => ({
              value: entry.value,
              origin: entry.origin,
              reason: entry.reason,
            })),
            ...(found.ignoredTaskException
              ? { ignoredTaskException: found.ignoredTaskException.reason }
              : {}),
            message:
              found.origin === "observed"
                ? "This was inferred from history (observed), not stated by the user; treat it only as a candidate and confirm with the user before using it."
                : "This is the value currently in effect.",
            notice: NOT_AUTHORITY,
          };
        });
      },
    },
    {
      name: "nexus_preference_set",
      label: "Nexus: record an observed preference or a one-off exception",
      description:
        'Record something you OBSERVED about the user across Tasks (origin "observed": needs confidence 0-1 and a sourceNote saying which Tasks it came from), or a one-off exception for one Task (origin "task_exception": needs taskId; it ends with the Task and never becomes a standing preference). You cannot record a stated preference: only the user can, via nexus_preference_confirm.',
      parameters: Type.Object({
        key: Type.String(),
        value: Type.Unknown({ description: "A short JSON value (<= 4096 bytes)." }),
        origin: Type.Union([Type.Literal("observed"), Type.Literal("task_exception")]),
        scope: Type.Optional(Type.String({ description: 'Default "global".' })),
        taskId: Type.Optional(Type.String({ description: "Required for task_exception." })),
        confidence: Type.Optional(Type.Number({ description: "observed only, 0 < c <= 1." })),
        sourceNote: Type.Optional(
          Type.String({ description: "observed only: the Tasks/evidence it was derived from." }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const parsed = readScopeKey(params);
          if ("ok" in parsed) {
            return parsed;
          }
          // Refused before the store is called, and the store refuses it again (structural gate).
          if (params.origin !== "observed" && params.origin !== "task_exception") {
            return fail("origin_not_allowed", INVALID_HINTS.origin_not_allowed);
          }
          let taskId: string | undefined;
          if (params.taskId !== undefined) {
            taskId = normalizeTaskId(params.taskId);
            if (!taskId) {
              return fail(
                "invalid_task_id",
                "taskId looks like T0ABC123 (a leading # is allowed).",
              );
            }
          }
          const out = await store.preferenceAgentSet({
            principal,
            scope: parsed.scope,
            key: parsed.key,
            value: params.value,
            origin: params.origin,
            ...(taskId ? { taskId } : {}),
            ...(typeof params.confidence === "number" ? { confidence: params.confidence } : {}),
            ...(typeof params.sourceNote === "string" ? { sourceNote: params.sourceNote } : {}),
            now: now(),
          });
          switch (out.outcome) {
            case "invalid":
              return fail(`invalid_${out.code}`, INVALID_HINTS[out.code]);
            case "task_not_found":
              return fail("not_found", "Task not found.");
            case "task_closed":
              return fail(
                "task_closed",
                `The Task has ended (${out.status}); exceptions can no longer be recorded.`,
              );
            case "limit_reached":
              return fail(
                "limit_reached",
                `The number of preferences has reached the limit (${out.max}).`,
              );
            default:
              if (out.outcome !== "unchanged") {
                deps.events.preferenceChanged({
                  ownerId: principal.ownerId,
                  scope: out.preference.scope,
                  key: out.preference.key,
                  preferenceId: out.preference.id,
                  origin: out.preference.origin,
                  change: "set",
                });
              }
              return {
                ok: true,
                outcome: out.outcome,
                ...view(out.preference),
                message:
                  out.preference.origin === "observed"
                    ? "Recorded as an observed preference (a candidate, not user-stated, and it takes part in no automatic path)."
                    : "Recorded as a one-off exception for this Task; it lapses when the Task ends.",
                notice: NOT_AUTHORITY,
              };
          }
        });
      },
    },
    {
      name: "nexus_preference_confirm",
      label: "Nexus: ask the user to confirm a preference",
      description:
        "Ask the user to confirm a value as their stated preference (e.g. after you observed it). The server builds the question; nothing is saved until the user approves it on the Nexus decision page, and approving it grants no permission to act. Needs the Task this conversation is about. Returns a pending decision: tell the user to confirm, and do NOT treat the preference as set.",
      parameters: Type.Object({
        taskId: Type.String(),
        key: Type.String(),
        value: Type.Unknown({ description: "A short JSON value (<= 4096 bytes)." }),
        scope: Type.Optional(Type.String({ description: 'Default "global".' })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          if (deps.decisionsEnabled !== true) {
            return fail(
              "unavailable",
              "Preference confirmation needs the decision module (decisionsEnabled).",
            );
          }
          const parsed = readScopeKey(params);
          if ("ok" in parsed) {
            return parsed;
          }
          const taskId = normalizeTaskId(params.taskId);
          if (!taskId) {
            return fail("invalid_task_id", "taskId looks like T0ABC123 (a leading # is allowed).");
          }
          // Already the stated value: nothing to ask. Compared on canonical JSON, so key order does not matter.
          const current = await store.preferenceGet({
            principal,
            scope: parsed.scope,
            key: parsed.key,
          });
          if (
            current.outcome === "found" &&
            current.resolution.origin === "stated" &&
            canonicalJson(current.resolution.value) === canonicalJson(params.value)
          ) {
            return {
              ok: true,
              alreadyStated: true,
              scope: parsed.scope,
              key: parsed.key,
              message: "The user already confirmed this value; no need to ask again.",
            };
          }
          const created = await store.createDecision({
            principal,
            taskId,
            effectKind: "set_preference",
            actionIds: [],
            preference: { op: "set", scope: parsed.scope, key: parsed.key, value: params.value },
            sessionKey: null,
            runId: null,
            toolCallId: null,
            now: now(),
          });
          switch (created.outcome) {
            case "not_found":
              return fail("not_found", "Task not found.");
            case "task_closed":
              return fail("task_closed", `The Task has ended (${created.task.status}).`);
            case "invalid_effect": {
              const invalid = created.invalid;
              if (invalid.code === "bad_preference") {
                const hint = INVALID_HINTS[invalid.reason as PreferenceInvalidCode];
                return fail(`invalid_${invalid.reason}`, hint ?? "Invalid preference.");
              }
              return fail(
                `invalid_effect_${invalid.code}`,
                "This kind of decision is not supported yet.",
              );
            }
            case "fingerprint_conflict":
              return fail("fingerprint_conflict", "The same call maps to different requests.");
            case "already_approved":
              return fail(
                "unexpected",
                "Preference confirmation should not return an approved grant.",
              );
            case "created":
              deps.events.taskChanged("updated", created.task);
              deps.onOutboxWritten?.();
            // falls through
            default: {
              const decision = created.decision;
              return {
                ok: true,
                status: decision.status,
                decisionId: decision.id,
                taskId: decision.taskId,
                question: decision.question,
                deadlineAt: decision.deadlineAt,
                reused: created.outcome !== "created",
                message:
                  "This preference was handed to the user for confirmation (the Nexus decision page). Until the user confirms, it is not saved and must not be treated as set; tell the user to confirm it.",
                notice: NOT_AUTHORITY,
              };
            }
          }
        });
      },
    },
  ];
  void sessionKey;
  return tools as unknown as AnyAgentTool[];
}
