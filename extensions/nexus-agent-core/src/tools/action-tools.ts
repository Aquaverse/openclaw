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
  /** Stage 3: a settled execution also writes its execution claim + evidence into the ledger. */
  claimsEnabled?: boolean;
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
          "This decision has been handed to the user (the Nexus decision page, and an approval card where available). Nothing happens and nothing is authorized until the user approves. " +
          "Tell the user to confirm, then continue. If the user says they just approved, the result may still be recording: check readyExecutions with nexus_task_get a moment later; do not assume it was approved.",
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
            ? "The user approved. You can now call nexus_action_commit; its only parameter is executionId."
            : "The user approved, but no committable execution was found; check readyExecutions with nexus_task_get.",
        };
      }
      return {
        ...base,
        message:
          "The user approved a standing grant. For each specific action, call nexus_action_authorize(actionId) to get an executionId, then call nexus_action_commit with that executionId; do not use an actionId as an executionId.",
      };
    }
    if (decision.status === "decided") {
      return {
        ...base,
        message:
          "The user refused; this is final. Do not retry the same thing another way; ask the user what they want to do.",
      };
    }
    const reasons: Record<string, string> = {
      expired: "This decision timed out and is no longer valid; it must be requested again.",
      superseded:
        "The Task changed after the question was asked, so this decision is void; request it again with the new content.",
      effect_apply_failed:
        "The user's approval could not be saved, so nothing is authorized. Ask the user to confirm again.",
    };
    return { ...base, message: reasons[decision.status] ?? "This decision has ended." };
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
            return fail("invalid_task_id", "taskId looks like T0ABC123 (a leading # is allowed).");
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
              return fail("unknown_tool", "toolName is not one of the registrable actions.", {
                known: out.known,
              });
            case "invalid_params":
              return fail("invalid_params", out.reason);
            case "not_found":
              return fail("not_found", "Task not found.");
            case "task_closed":
              return fail(
                "task_closed",
                `The Task has ended (${out.task.status}); actions can no longer be registered.`,
              );
            default: {
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
                    ? "Call nexus_action_authorize(actionId); if it returns no_policy, first get the user's consent with nexus_decision_request, then authorize."
                    : `Call nexus_decision_request with {"taskId":"${out.action.taskId}","effect":{"actionIds":["${out.action.id}"]}} (do not set kind); you only get an executionId after the user approves.`,
                ...(done && (done.state === "succeeded" || done.state === "failed")
                  ? {
                      warning:
                        "This action was already executed (see latestExecution for its state). If the user really wants the same thing done again, register it as a new action with occurrence: 2.",
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
            return fail("invalid_action_id", "Invalid actionId.");
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
                  "Authorized. Execute with nexus_action_commit(executionId); do not call authorize again.",
              };
            case "not_found":
              return fail("not_found", "Action not found.");
            case "task_closed":
              return fail("task_closed", "The Task has ended.");
            case "not_r1":
              return fail(
                "not_r1",
                `This action is ${out.tier} and cannot use authorize; get the user's approval with nexus_decision_request.`,
              );
            case "no_policy":
              return {
                ok: false,
                code: "no_policy",
                message:
                  "The user has not approved a standing grant covering this action. Get consent with nexus_decision_request (put this actionId in effect.actionIds).",
              };
            case "policy_not_applicable":
              return fail(
                "policy_not_applicable",
                `The standing grant does not apply right now (${out.reason}). The user needs to approve again, or try later.`,
              );
            case "in_progress":
              return fail(
                "in_progress",
                `This action already has an execution in progress or awaiting confirmation (${out.execution.state}); a second execution will not be issued.`,
                {
                  executionId: out.execution.id,
                },
              );
            default:
              return fail(
                "already_done",
                `This action already has a final execution (${out.execution.state}). If the user really wants it done again, register a new action with the occurrence parameter of nexus_action_prepare.`,
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
              return fail(
                "params_changed",
                "The request parameters changed after approval; refusing.",
              );
            }
            const read = async () =>
              (await store.getDecision({ principal, decisionId: hooked.id }))?.decision;
            let fresh = (await read()) ?? hooked;
            // The handler only runs after the host let the call through, i.e. after an approval. The callback that
            // records it is not awaited by the host, so read until it lands (bounded) instead of reporting "pending".
            const sleep =
              deps.sleep ??
              ((ms: number) =>
                new Promise<void>((resolve) => {
                  setTimeout(resolve, ms);
                }));
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
              return fail("not_found", "Task not found.");
            case "task_closed":
              return fail("task_closed", `The Task has ended (${created.task.status}).`);
            case "invalid_effect": {
              const invalid = created.invalid;
              const hints: Record<string, string> = {
                no_actions:
                  "effect.actionIds must not be empty: register actions with nexus_action_prepare first.",
                too_many_actions: "At most 5 candidate actions.",
                action_not_found: "Some actionId does not belong to this Task.",
                mixed_tier: "Actions in one decision must share the same risk tier.",
                wrong_kind: "effect.kind does not match the action's risk tier; omit kind.",
                unsupported_effect: "This kind of decision is not supported yet.",
              };
              return fail(
                `invalid_effect_${invalid.code}`,
                hints[invalid.code] ?? "Invalid effect.",
                {
                  detail: invalid,
                },
              );
            }
            case "fingerprint_conflict":
              return fail("fingerprint_conflict", "The same tool call maps to different requests.");
            case "created":
              deps.events.taskChanged("updated", created.task);
              deps.onOutboxWritten?.();
              return await describeDecision(principal, store, created.decision);
            case "replayed":
            case "reused_pending":
              return await describeDecision(principal, store, created.decision);
            default: {
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
            return fail("invalid_execution_id", "Invalid executionId.");
          }
          // First synchronous transaction: ownership, grant consumption, state -> executing.
          const verdict = await store.admitExecution({
            principal,
            executionId,
            staleExecutingMs: deps.staleExecutingMs ?? STALE_EXECUTING_MS,
            now: now(),
          });
          switch (verdict.kind) {
            case "rejected": {
              if (verdict.reason === "execution_not_found") {
                // A model sometimes passes the actionId here. Say so, so it fixes the call instead of improvising.
                const asAction = await store.getAction({ principal, actionId: executionId });
                if (asAction) {
                  return fail(
                    "execution_not_found",
                    "This is an actionId, not an executionId. First call nexus_action_authorize(actionId) to get an executionId (it returns one directly when the user has approved a standing grant), then use it to call nexus_action_commit.",
                    { hint: "use_authorize_first" },
                  );
                }
              }
              return fail(verdict.reason, verdict.message);
            }
            case "replay_succeeded":
              return {
                ok: true,
                status: "succeeded",
                replayed: true,
                executionId,
                result: verdict.execution.result,
                message:
                  "This execution already succeeded; this is the earlier result and the vendor was not called again.",
              };
            case "replay_failed":
              return fail(
                "execution_failed",
                "This execution already failed and the vendor was not called again. The user must approve again before a retry.",
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
                message:
                  "The outcome of this execution is not confirmed yet; Nexus will reconcile it. Do not retry, and do not tell the user it succeeded.",
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
            recordClaim: deps.claimsEnabled === true,
          });
          if (settled.outcome === "settled" && settled.task) {
            deps.events.taskChanged("updated", settled.task);
          }
          deps.onOutboxWritten?.();
          if (outcome.kind === "succeeded") {
            return { ok: true, status: "succeeded", executionId, result: outcome.result };
          }
          if (outcome.kind === "failed") {
            return fail(
              "execution_failed",
              "The vendor explicitly rejected this execution; it had no effect.",
              {
                executionId,
                error: outcome.error,
              },
            );
          }
          return {
            ok: true,
            status: "unknown",
            executionId,
            notice:
              "The outcome is UNCERTAIN (the connection failed). Do not retry, do not tell the user it succeeded or failed; say the result is awaiting confirmation.",
            message:
              "The outcome is uncertain (connection interrupted). Nexus will reconcile with the vendor; do not retry, and do not say it succeeded.",
          };
        });
      },
    },
  ];
  const visible = tools.map((tool) => Object.assign(tool, { catalogMode: "direct-only" as const }));
  return visible as unknown as AnyAgentTool[];
}
