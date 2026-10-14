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
    "scope 只能是 global 或 domain:<名字>（小写字母、数字、下划线、点、连字符，最长 40）。",
  bad_key: "key 用小写字母、数字、下划线、点、连字符，最长 64，以字母或数字开头。",
  bad_value: "value 必须是可序列化的 JSON 值。",
  value_too_large: "value 太大了；偏好应是一个简短的值（序列化后不超过 4096 字节）。",
  origin_not_allowed:
    "你只能写 observed 或 task_exception。要把一个值确认为用户明说的偏好，请用 nexus_preference_confirm 让用户确认。",
  task_required: "task_exception 必须带 taskId。",
  task_forbidden: "observed 不能带 taskId（它不属于某一个事项）。",
  bad_confidence:
    "observed 需要 0 到 1 之间的 confidence（不含 0）；task_exception 不能带 confidence。",
  source_note_required:
    "observed 必须在 sourceNote 里写明依据（是从哪几个事项里归纳出来的）；没有依据的归纳和臆测无法区分。",
  source_note_too_long: "sourceNote 最长 500 个字符。",
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
      return jsonResult(fail("no_principal", "无法确定当前主体，Nexus 不提供服务。"));
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
              return fail("invalid_task_id", "taskId 形如 T0ABC123（可带 #）。");
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
              message: "没有记录这条偏好。不要凭空假设用户的偏好；需要的话直接问用户。",
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
                ? "这是根据历史归纳出来的（observed），不是用户明说的；只能当作候选项，使用前先向用户确认。"
                : "这是当前生效的值。",
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
              return fail("invalid_task_id", "taskId 形如 T0ABC123（可带 #）。");
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
              return fail("not_found", "找不到这个事项。");
            case "task_closed":
              return fail("task_closed", `事项已结束（${out.status}），不能再记录例外。`);
            case "limit_reached":
              return fail("limit_reached", `偏好数量已达上限（${out.max}）。`);
            case "unchanged":
            case "created":
            case "updated":
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
                    ? "已记录为观察到的偏好（候选项，不是用户明说的，也不参与任何自动路径）。"
                    : "已记录为这个事项的一次性例外，事项结束后失效。",
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
            return fail("unavailable", "偏好确认需要启用决策模块（decisionsEnabled）。");
          }
          const parsed = readScopeKey(params);
          if ("ok" in parsed) {
            return parsed;
          }
          const taskId = normalizeTaskId(params.taskId);
          if (!taskId) {
            return fail("invalid_task_id", "taskId 形如 T0ABC123（可带 #）。");
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
              ...{ scope: parsed.scope, key: parsed.key },
              message: "用户已经确认过这个值，不需要再问。",
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
              return fail("not_found", "找不到这个事项。");
            case "task_closed":
              return fail("task_closed", `事项已结束（${created.task.status}）。`);
            case "invalid_effect": {
              const invalid = created.invalid;
              if (invalid.code === "bad_preference") {
                const hint = INVALID_HINTS[invalid.reason as PreferenceInvalidCode];
                return fail(`invalid_${invalid.reason}`, hint ?? "偏好不合法。");
              }
              return fail(`invalid_effect_${invalid.code}`, "这种决策暂不支持。");
            }
            case "fingerprint_conflict":
              return fail("fingerprint_conflict", "同一次调用对应了不同的请求。");
            case "already_approved":
              return fail("unexpected", "偏好确认不应返回已批准的授权。");
            case "created":
              deps.events.taskChanged("updated", created.task);
              deps.onOutboxWritten?.();
            // falls through
            case "replayed":
            case "reused_pending": {
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
                  "已把这条偏好交给用户确认（Nexus 决策页）。用户确认之前这条偏好没有被保存，也不要当作已设置；请告诉用户去确认。",
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
