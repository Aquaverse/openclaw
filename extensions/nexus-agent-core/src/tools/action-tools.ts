// Agent tools for actions and decisions (DESIGN section 8): nexus_action_prepare / nexus_action_authorize /
// nexus_decision_request / nexus_action_commit. Stage 2 only wires FAKE actions (decision/catalog.ts).
//
// Authority never lives in a hook: `nexus_action_commit` consumes the grant here, in the tool handler, through two
// synchronous store transactions around the one external call (section 8.2).
import { Type } from "typebox";
import type { AnyAgentTool } from "../../api.js";
import { FAKE_TOOL_NAMES } from "../decision/catalog.js";
import { parseDecisionRequest } from "../decision/request.js";
import type { EventBridge } from "../events.js";
import type { FakeProvider } from "../provider/fake-provider.js";
import type { DecisionRecord } from "../store/decision-types.js";
import type { TaskStore } from "../store/host.js";
import type { Principal } from "../store/types.js";
import { jsonResult, normalizeTaskId } from "./task-tools.js";

export const ACTION_TOOL_NAMES = [
  "nexus_action_prepare",
  "nexus_action_authorize",
  "nexus_decision_request",
  "nexus_action_commit",
] as const;

export const STALE_EXECUTING_MS = 120_000;
/** The host does not await onResolution (section 8.9.1 #1): a handler that runs after an approval waits this long for the write. */
export const CARD_WAIT_MS = 2_500;
const CARD_WAIT_STEP_MS = 200;
const NO_SESSION = "(no-session)";
const ID = /^[A-Za-z0-9_-]{1,40}$/;

export type ActionToolDeps = {
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  resolvePrincipal: (ctx: { agentId?: string; sessionKey?: string }) => Principal | undefined;
  provider: FakeProvider;
  now?: () => number;
  staleExecutingMs?: number;
  cardWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after a write that produced outbox rows, so delivery does not wait for the next sweep. */
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
      "This call FAILED: nothing was executed and no authority was issued. Tell the user it failed; never claim the action was done or approved.",
  };
}

function decisionView(decision: DecisionRecord) {
  return {
    decisionId: decision.id,
    taskId: decision.taskId,
    status: decision.status,
    resolution: decision.resolution,
    riskTier: decision.riskTier,
    effectKind: decision.effectKind,
    question: decision.question,
    actionIds: decision.actionIds,
    deadlineAt: decision.deadlineAt,
  };
}

export function createActionTools(deps: ActionToolDeps, ctx: ToolContext): AnyAgentTool[] {
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

  /** What the model is told about a decision, by state. Reading the store, never inferring from "I was run". */
  const describeDecision = async (
    principal: Principal,
    store: TaskStore,
    decision: DecisionRecord,
  ) => {
    const base = { ok: true, ...decisionView(decision) };
    if (decision.status === "pending") {
      return {
        ...base,
        message:
          "已把这条待决策交给用户（Nexus 决策页，必要时还有审批卡片）。用户批准之前什么都不会发生，也没有任何授权。" +
          "请告诉用户去确认；确认后再继续。如果用户说刚刚已经批准，结果可能还在记录中：稍后用 nexus_task_get 查看 readyExecutions，不要自己假设已批准。",
      };
    }
    if (decision.status === "decided" && decision.resolution === "approved") {
      if (decision.effectKind === "issue_action_grant") {
        const detail = await store.getDecision({ principal, decisionId: decision.id });
        const execution =
          detail?.executions.find((entry) => entry.state === "prepared") ?? detail?.executions[0];
        return {
          ...base,
          executionId: execution?.id ?? null,
          executionState: execution?.state ?? null,
          message: execution
            ? "用户已批准。现在可以调用 nexus_action_commit，参数只有 executionId。"
            : "用户已批准，但没有找到可提交的执行凭证；请用 nexus_task_get 查看 readyExecutions。",
        };
      }
      return {
        ...base,
        message:
          "用户已批准持续授权。现在对每个具体动作调用 nexus_action_authorize 取得 executionId。",
      };
    }
    if (decision.status === "decided") {
      return {
        ...base,
        message: "用户已拒绝，这是终局。不要换一种办法重试同一件事；问用户想怎么办。",
      };
    }
    const reasons: Record<string, string> = {
      expired: "这条决策已超时失效，需要重新发起。",
      superseded: "事项内容在提问之后发生了变化，这条决策作废；需要用新内容重新发起。",
      effect_apply_failed: "用户的批准没能保存成功，没有授权。请让用户重新确认。",
    };
    return { ...base, message: reasons[decision.status] ?? "这条决策已结束。" };
  };

  const tools = [
    {
      name: "nexus_action_prepare",
      label: "Nexus: register a candidate action",
      description:
        "Register an external action you want to do (contact a vendor, book, pay) on a Task. This only RECORDS the action: nothing is sent, booked or paid. The server decides the risk tier from toolName and returns an actionId plus the next step. Parameters must come from what the user stated; never guess vendor names, dates or amounts.",
      parameters: Type.Object({
        taskId: Type.String({ description: "Explicit Task id." }),
        toolName: Type.Union(FAKE_TOOL_NAMES.map((name) => Type.Literal(name))),
        params: Type.Object(
          {},
          {
            additionalProperties: true,
            description:
              "fake_vendor_message {vendor, message} | fake_booking {vendor, item, date?} | fake_payment {merchant, amount, currency}",
          },
        ),
        occurrence: Type.Optional(
          Type.Integer({
            minimum: 1,
            description:
              "Only when the user explicitly wants the same action done AGAIN: use 2, 3, ... so it is a separate action.",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const taskId = normalizeTaskId(params.taskId);
          if (!taskId) {
            return fail("invalid_task_id", "taskId 形如 T0ABC123（可带 #）。");
          }
          const toolName = typeof params.toolName === "string" ? params.toolName : "";
          const occurrence =
            typeof params.occurrence === "number" ? Math.floor(params.occurrence) : undefined;
          const out = await store.registerAction({
            principal,
            taskId,
            toolName,
            params: params.params,
            ...(occurrence && occurrence >= 1 ? { occurrence } : {}),
            sessionKey,
            now: now(),
          });
          switch (out.outcome) {
            case "unknown_tool":
              return fail("unknown_tool", "toolName 不在可登记的动作里。", { known: out.known });
            case "invalid_params":
              return fail("invalid_params", out.reason);
            case "not_found":
              return fail("not_found", "找不到这个事项。");
            case "task_closed":
              return fail("task_closed", `事项已结束（${out.task.status}），不能再登记动作。`);
            case "created":
            case "existing": {
              const tier = out.action.riskTier;
              const done = out.latestExecution;
              return {
                ok: true,
                created: out.outcome === "created",
                actionId: out.action.id,
                riskTier: tier,
                capability: out.action.capability,
                reversible: out.action.reversible,
                params: out.action.params,
                latestExecution: done ? { executionId: done.id, state: done.state } : null,
                next:
                  tier === "R1"
                    ? "调用 nexus_action_authorize(actionId)；返回 no_policy 时先 nexus_decision_request 取得用户同意，再 authorize。"
                    : `调用 nexus_decision_request，参数 {"taskId":"${out.action.taskId}","effect":{"actionIds":["${out.action.id}"]}}（不要写 kind）；用户批准后才会得到 executionId。`,
                ...(done && (done.state === "succeeded" || done.state === "failed")
                  ? {
                      warning:
                        "这个动作已经执行过了（状态见 latestExecution）。如果用户确实要再做一次相同的事，用 occurrence: 2 登记成新动作。",
                    }
                  : {}),
              };
            }
          }
        });
      },
    },
    {
      name: "nexus_action_authorize",
      label: "Nexus: authorize a low-risk action under a standing policy",
      description:
        "For low-risk (R1) actions only. If the user has approved a standing policy that covers this action, returns an executionId to pass to nexus_action_commit. Calling it again returns the same executionId. It never executes anything.",
      parameters: Type.Object({ actionId: Type.String() }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const actionId =
            typeof params.actionId === "string" && ID.test(params.actionId) ? params.actionId : "";
          if (!actionId) {
            return fail("invalid_action_id", "actionId 无效。");
          }
          const out = await store.authorizeAction({
            principal,
            actionId,
            providerCaps: deps.provider.caps(),
            sessionKey,
            now: now(),
          });
          switch (out.outcome) {
            case "authorized":
              return {
                ok: true,
                executionId: out.executionId,
                reentry: out.reentry,
                message:
                  "已授权。用 nexus_action_commit(executionId) 执行；不要重复调用 authorize。",
              };
            case "not_found":
              return fail("not_found", "找不到这个动作。");
            case "task_closed":
              return fail("task_closed", "事项已结束。");
            case "not_r1":
              return fail(
                "not_r1",
                `这个动作是 ${out.tier}，不能走 authorize；用 nexus_decision_request 征得用户批准。`,
              );
            case "no_policy":
              return {
                ok: false,
                code: "no_policy",
                message:
                  "用户还没有批准覆盖这个动作的持续授权。用 nexus_decision_request（effect.actionIds 填这个 actionId）去征得同意。",
              };
            case "policy_not_applicable":
              return fail(
                "policy_not_applicable",
                `持续授权现在不适用（${out.reason}）。需要用户重新批准或稍后再试。`,
              );
            case "in_progress":
              return fail(
                "in_progress",
                `这个动作已有执行在进行或结果待确认（${out.execution.state}），不会签发第二张凭证。`,
                {
                  executionId: out.execution.id,
                },
              );
            case "already_done":
              return fail(
                "already_done",
                `这个动作已经有终态执行（${out.execution.state}）。如果用户确实要再做一次，用 nexus_action_prepare 的 occurrence 登记成新动作。`,
                {
                  executionId: out.execution.id,
                },
              );
          }
        });
      },
    },
    {
      name: "nexus_decision_request",
      label: "Nexus: ask the user to decide",
      description:
        "Ask the user to approve an action (or a standing policy for low-risk actions). Question, facts and options are generated by the server; you only pass the Task and the candidate actionIds. Nothing happens until the user approves; if they approve you get an executionId for nexus_action_commit. A denial is final.",
      parameters: Type.Object({
        taskId: Type.String(),
        effect: Type.Object({
          actionIds: Type.Array(Type.String(), {
            description: "Candidate actionIds from nexus_action_prepare (max 5, one risk tier).",
          }),
          kind: Type.Optional(
            Type.String({
              description:
                "Do NOT set this; the server derives it from the risk tier. Anything unrecognised is ignored.",
            }),
          ),
        }),
      }),
      async execute(toolCallId: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const parsed = parseDecisionRequest(params);
          if (typeof parsed === "string") {
            return fail("invalid_request", parsed);
          }
          const hooked =
            ctx.sessionKey && toolCallId
              ? await store.findDecisionForToolCall({
                  principal,
                  sessionKey: ctx.sessionKey,
                  toolCallId,
                })
              : null;
          if (hooked) {
            // The hook created this decision from the parameters it saw. If a later hook changed them, refuse.
            const sameSet =
              hooked.taskId === parsed.taskId &&
              JSON.stringify([...hooked.actionIds].toSorted()) ===
                JSON.stringify([...parsed.actionIds].toSorted());
            if (!sameSet) {
              return fail("params_changed", "请求参数在审批之后被改动，拒绝处理。");
            }
            const read = async () =>
              (await store.getDecision({ principal, decisionId: hooked.id }))?.decision;
            let fresh = (await read()) ?? hooked;
            // The handler only runs after the host let the call through, i.e. after an approval. The callback that
            // records it is not awaited by the host, so read until it lands (bounded) instead of reporting "pending".
            const sleep =
              deps.sleep ??
              ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
            const limit = deps.cardWaitMs ?? CARD_WAIT_MS;
            for (
              let waited = 0;
              fresh.status === "pending" &&
              fresh.coreApprovalState === "attempted" &&
              waited < limit;
              waited += CARD_WAIT_STEP_MS
            ) {
              await sleep(CARD_WAIT_STEP_MS);
              fresh = (await read()) ?? fresh;
            }
            return await describeDecision(principal, store, fresh);
          }
          const created = await store.createDecision({
            principal,
            taskId: parsed.taskId,
            ...(parsed.effectKind ? { effectKind: parsed.effectKind } : {}),
            actionIds: parsed.actionIds,
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
              const hints: Record<string, string> = {
                no_actions: "effect.actionIds 不能为空：先用 nexus_action_prepare 登记动作。",
                too_many_actions: "候选动作最多 5 个。",
                action_not_found: "有 actionId 不属于这个事项。",
                mixed_tier: "同一条决策里的动作必须是同一风险档。",
                wrong_kind: "effect.kind 与动作的风险档不符；省略 kind 即可。",
                unsupported_effect: "这种决策暂不支持。",
              };
              return fail(
                `invalid_effect_${invalid.code}`,
                hints[invalid.code] ?? "effect 不合法。",
                {
                  detail: invalid,
                },
              );
            }
            case "fingerprint_conflict":
              return fail("fingerprint_conflict", "同一次工具调用对应了不同的请求。");
            case "created":
              deps.events.taskChanged("updated", created.task);
              deps.onOutboxWritten?.();
              return await describeDecision(principal, store, created.decision);
            case "replayed":
            case "reused_pending":
              return await describeDecision(principal, store, created.decision);
            case "already_approved": {
              const view = await describeDecision(principal, store, created.decision);
              return {
                ...view,
                alreadyApproved: true,
                ...(created.executionId ? { executionId: created.executionId } : {}),
                ...(created.standingGrantId ? { standingGrantId: created.standingGrantId } : {}),
              };
            }
          }
        });
      },
    },
    {
      name: "nexus_action_commit",
      label: "Nexus: execute an authorized action",
      description:
        "Execute an action using the executionId you were given after the user approved (or after nexus_action_authorize). The only parameter is executionId. Never invent one. If the result is unknown or pending_confirmation, do NOT retry and do NOT say it succeeded.",
      parameters: Type.Object({ executionId: Type.String() }),
      async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
        return withPrincipal(async (principal, store) => {
          const executionId =
            typeof params.executionId === "string" && ID.test(params.executionId)
              ? params.executionId
              : "";
          if (!executionId) {
            return fail("invalid_execution_id", "executionId 无效。");
          }
          // First synchronous transaction: ownership, grant consumption, state -> executing.
          const verdict = await store.admitExecution({
            principal,
            executionId,
            staleExecutingMs: deps.staleExecutingMs ?? STALE_EXECUTING_MS,
            now: now(),
          });
          switch (verdict.kind) {
            case "rejected":
              return fail(verdict.reason, verdict.message);
            case "replay_succeeded":
              return {
                ok: true,
                status: "succeeded",
                replayed: true,
                executionId,
                result: verdict.execution.result,
                message: "这次执行早已成功，这里返回的是上次的结果；没有再次调用供应商。",
              };
            case "replay_failed":
              return fail(
                "execution_failed",
                "这次执行已经失败，没有再次调用供应商。需要用户重新批准才能再试。",
                {
                  executionId,
                  error: verdict.execution.error,
                },
              );
            case "reconcile_only":
              return {
                ok: true,
                status: "pending_confirmation",
                executionId,
                reason: verdict.reason,
                notice:
                  "The outcome is NOT confirmed. Do not retry and do not tell the user it succeeded or failed; say it is awaiting confirmation.",
                message: "这次执行的结果还没有确认，Nexus 会对账。不要重试，也不要对用户说成功。",
              };
            case "execute_new":
            case "retry_provider_idempotently":
              break;
          }
          if (verdict.task) {
            deps.events.taskChanged("updated", verdict.task);
          }
          // The one external call, outside any transaction.
          let outcome: Parameters<TaskStore["settleExecution"]>[0]["outcome"];
          try {
            const reply = await deps.provider.execute({
              toolName: verdict.action.toolName,
              params: verdict.action.params,
              idempotencyKey: verdict.execution.providerIdempotencyKey,
              signal,
            });
            outcome =
              reply.status === "ok"
                ? {
                    kind: "succeeded",
                    result: reply.result,
                    providerOperationId: reply.operationId,
                  }
                : { kind: "failed", error: reply.error };
          } catch (error) {
            // Anything thrown after the request may have left: we cannot prove it did not happen.
            outcome = {
              kind: "unknown",
              error: { message: error instanceof Error ? error.message : String(error) },
            };
          }
          // Second synchronous transaction: record the outcome.
          const settled = await store.settleExecution({
            principal,
            executionId,
            outcome,
            now: now(),
          });
          if (settled.outcome === "settled" && settled.task) {
            deps.events.taskChanged("updated", settled.task);
          }
          deps.onOutboxWritten?.();
          if (outcome.kind === "succeeded") {
            return { ok: true, status: "succeeded", executionId, result: outcome.result };
          }
          if (outcome.kind === "failed") {
            return fail("execution_failed", "供应商明确拒绝了这次执行，没有产生效果。", {
              executionId,
              error: outcome.error,
            });
          }
          return {
            ok: true,
            status: "unknown",
            executionId,
            notice:
              "The outcome is UNCERTAIN (the connection failed). Do not retry, do not tell the user it succeeded or failed; say the result is awaiting confirmation.",
            message: "结果不确定（连接中断）。Nexus 会向供应商对账；不要重试，也不要说成功。",
          };
        });
      },
    },
  ];
  const visible = tools.map((tool) => ({ ...tool, catalogMode: "direct-only" as const }));
  return visible as unknown as AnyAgentTool[];
}
