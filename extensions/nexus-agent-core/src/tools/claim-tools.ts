// Agent tools for the Claim / Evidence ledger (DESIGN sections 9 and 12): nexus_claim_add, nexus_evidence_add,
// nexus_claim_verify. The Agent can only ASSERT (or mark UNKNOWN). SUPPORTED / VERIFIED / REFUTED are derived by the store
// from the evidence it can check itself; nothing here accepts a state the model could use to promote its own claim.
import { Type } from "typebox";
import type { AnyAgentTool } from "../../api.js";
import type { ClaimDetail, ClaimPolicy, ClaimRecord } from "../store/claim-types.js";
import { AGENT_CLAIM_STATES, COMPLETION_STATES, EVIDENCE_REF_KINDS } from "../store/claim-types.js";
import type { TaskStore } from "../store/host.js";
import type { Principal } from "../store/types.js";
import { isPlainObject, jsonResult, normalizeTaskId } from "./task-tools.js";

export const CLAIM_TOOL_NAMES = [
  "nexus_claim_add",
  "nexus_evidence_add",
  "nexus_claim_verify",
] as const;

export const CLAIM_LIMITS = {
  subject: 200,
  predicate: 80,
  json: 4_096,
  claimsReturned: 30,
} as const;

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const NO_SESSION = "(no-session)";

export type ClaimToolDeps = {
  getStore: () => Promise<TaskStore>;
  resolvePrincipal: (ctx: { agentId?: string; sessionKey?: string }) => Principal | undefined;
  now?: () => number;
  /** Called after a write that produced outbox rows (claim_changed / claim_verified). */
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
      "This call FAILED and changed nothing. Tell the user it failed; never describe the claim as supported or the Task as done.",
  };
}

export function claimView(claim: ClaimRecord) {
  return {
    claimId: claim.id,
    taskId: claim.taskId,
    subject: claim.subject,
    predicate: claim.predicate,
    value: claim.value,
    state: claim.state,
    requiredForCompletion: claim.requiredForCompletion,
    headEventId: claim.headEventId,
    updatedAt: claim.updatedAt,
  };
}

export function detailView(detail: ClaimDetail) {
  return {
    ...claimView(detail.claim),
    supportGroups: detail.supportGroups,
    contradictGroups: detail.contradictGroups,
    evidence: detail.links.map((link) => ({
      evidenceId: link.evidence.evidenceId,
      relation: link.relation,
      effective: link.effective,
      kind: link.evidence.kind,
      ref: { kind: link.evidence.sourceRefKind, id: link.evidence.sourceRefId },
      sourceGroup: link.evidence.sourceGroup,
    })),
    recentEvents: detail.events.slice(0, 5).map((event) => ({
      seq: event.seq,
      transition: event.transition,
      source: event.source,
      at: event.createdAt,
    })),
  };
}

function readPolicy(raw: unknown): ClaimPolicy | undefined | "invalid" {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw) || JSON.stringify(raw).length > CLAIM_LIMITS.json) {
    return "invalid";
  }
  const policy: ClaimPolicy = {};
  if (raw.allowedGroups !== undefined) {
    if (
      !Array.isArray(raw.allowedGroups) ||
      raw.allowedGroups.some((entry) => typeof entry !== "string" || !entry || entry.length > 80)
    ) {
      return "invalid";
    }
    policy.allowedGroups = raw.allowedGroups as string[];
  }
  if (raw.minGroupsForVerified !== undefined) {
    if (!Number.isInteger(raw.minGroupsForVerified)) {
      return "invalid";
    }
    policy.minGroupsForVerified = raw.minGroupsForVerified as number;
  }
  return policy;
}

/** Builds the three ledger tools for one tool context. */
export function createClaimTools(deps: ClaimToolDeps, ctx: ToolContext): AnyAgentTool[] {
  const now = deps.now ?? Date.now;
  const sessionKey = ctx.sessionKey ?? NO_SESSION;
  const actor = `agent:${ctx.agentId ?? "main"}:${sessionKey}`;

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

  const tools = [
    {
      name: "nexus_claim_add",
      label: "Nexus: register a claim",
      description:
        'Register something you are about to tell the user is true (a claim) on a Task, e.g. subject "booking", predicate "executed". You can only assert it (ASSERTED) or say you do not know (UNKNOWN); you can NOT mark it supported or verified - the store derives that from evidence you attach with nexus_evidence_add. Pass completion=SUPPORTED or VERIFIED to make this claim a condition the Task must meet before it can be marked succeeded. Calling again with the same subject+predicate (or claimId) re-asserts the same claim.',
      parameters: Type.Object({
        taskId: Type.String(),
        subject: Type.String({
          description: 'What the claim is about, e.g. "booking" or an entity name.',
        }),
        predicate: Type.String({
          description:
            'lower_snake_case. Only "executed" can currently be checked against evidence (the value may carry {actionId}); other predicates stay ASSERTED.',
        }),
        value: Type.Optional(
          Type.Unknown({
            description: 'Optional JSON value. For "executed": {"actionId": "..."}.',
          }),
        ),
        state: Type.Optional(
          Type.Union(
            AGENT_CLAIM_STATES.map((state) => Type.Literal(state)),
            {
              description: "ASSERTED (default) or UNKNOWN. No other state is accepted.",
            },
          ),
        ),
        completion: Type.Optional(
          Type.Union(
            COMPLETION_STATES.map((state) => Type.Literal(state)),
            {
              description:
                "Make this claim a completion condition at SUPPORTED or VERIFIED. You can only raise it, never lower it.",
            },
          ),
        ),
        policy: Type.Optional(
          Type.Object(
            {
              allowedGroups: Type.Optional(Type.Array(Type.String())),
              minGroupsForVerified: Type.Optional(Type.Integer({ minimum: 2 })),
            },
            {
              description:
                "Optional evidence policy: which source groups count, and how many are needed for VERIFIED.",
            },
          ),
        ),
        claimId: Type.Optional(Type.String({ description: "Re-assert an existing claim by id." })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const taskId = normalizeTaskId(params.taskId);
          if (!taskId) {
            return fail("invalid_task_id", "taskId 形如 T0ABC123（可带 #）。");
          }
          const subject = typeof params.subject === "string" ? params.subject.trim() : "";
          if (!subject || [...subject].length > CLAIM_LIMITS.subject) {
            return fail("invalid_subject", "subject 不能为空，最长 200 个字符。");
          }
          const predicate = typeof params.predicate === "string" ? params.predicate.trim() : "";
          if (!/^[a-z][a-z0-9_]{0,79}$/.test(predicate)) {
            return fail("invalid_predicate", "predicate 需为 lower_snake_case，最长 80 个字符。");
          }
          if (
            params.value !== undefined &&
            JSON.stringify(params.value).length > CLAIM_LIMITS.json
          ) {
            return fail("invalid_value", "value 不能超过 4 KB。");
          }
          const state = params.state ?? "ASSERTED";
          if (!(AGENT_CLAIM_STATES as readonly unknown[]).includes(state)) {
            return fail(
              "state_not_allowed",
              "模型只能写 ASSERTED 或 UNKNOWN；SUPPORTED / VERIFIED / REFUTED 由证据推导，不能直接设置。",
              { allowed: [...AGENT_CLAIM_STATES] },
            );
          }
          let completion: "SUPPORTED" | "VERIFIED" | undefined;
          if (params.completion !== undefined) {
            if (!(COMPLETION_STATES as readonly unknown[]).includes(params.completion)) {
              return fail("invalid_completion", "completion 只能是 SUPPORTED 或 VERIFIED。");
            }
            completion = params.completion as "SUPPORTED" | "VERIFIED";
          }
          const policy = readPolicy(params.policy);
          if (policy === "invalid") {
            return fail(
              "invalid_policy",
              "policy 只接受 allowedGroups（字符串数组）和 minGroupsForVerified（整数）。",
            );
          }
          let claimId: string | undefined;
          if (params.claimId !== undefined) {
            if (typeof params.claimId !== "string" || !ID.test(params.claimId)) {
              return fail("invalid_claim_id", "claimId 格式不正确。");
            }
            claimId = params.claimId;
          }
          const result = await store.addClaim({
            principal,
            taskId,
            ...(claimId ? { claimId } : {}),
            subject,
            predicate,
            ...(params.value !== undefined ? { value: params.value } : {}),
            state: state as "ASSERTED" | "UNKNOWN",
            ...(policy ? { policy } : {}),
            ...(completion ? { completion } : {}),
            actor,
            now: now(),
          });
          switch (result.outcome) {
            case "not_found":
              return fail("not_found", "找不到这个事项。");
            case "claim_not_found":
              return fail("claim_not_found", "找不到这个 claim。");
            case "task_closed":
              return fail("task_closed", `事项已结束（${result.status}），不能再登记 claim。`);
            case "value_conflict":
              return fail(
                "value_conflict",
                "同一个 subject+predicate 已登记了不同的 value；不能覆盖。",
                {
                  claim: claimView(result.claim),
                },
              );
            case "policy_conflict":
              return fail("policy_conflict", "这个 claim 已有不同的 policy；不能覆盖。", {
                claim: claimView(result.claim),
              });
            case "completion_weakening_refused":
              return fail(
                "completion_weakening_refused",
                "不能把已要求 VERIFIED 的完成条件降为 SUPPORTED。",
                {
                  claim: claimView(result.claim),
                },
              );
            case "created":
            case "appended":
              deps.onOutboxWritten?.();
              return {
                ok: true,
                created: result.outcome === "created",
                ...claimView(result.claim),
                notice:
                  result.claim.state === "ASSERTED" || result.claim.state === "UNKNOWN"
                    ? "This claim is NOT supported yet. Do not tell the user it is true until nexus_evidence_add makes it SUPPORTED."
                    : undefined,
              };
          }
        });
      },
    },
    {
      name: "nexus_evidence_add",
      label: "Nexus: attach evidence to a claim",
      description:
        'Attach evidence to a claim by REFERENCE. Currently only kind="execution" with the executionId returned by nexus_action_commit is accepted (tool_output and blob refs are not supported yet). The store reads the settled execution itself, decides whether it supports or contradicts the claim, and recomputes the claim state; you cannot set the relation or the state. Pass expectedHeadEventId (from the claim) to detect a concurrent change.',
      parameters: Type.Object({
        taskId: Type.String(),
        claimId: Type.String(),
        ref: Type.Object({
          kind: Type.Union(EVIDENCE_REF_KINDS.map((kind) => Type.Literal(kind))),
          id: Type.String(),
        }),
        expectedHeadEventId: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const taskId = normalizeTaskId(params.taskId);
          if (!taskId) {
            return fail("invalid_task_id", "taskId 形如 T0ABC123（可带 #）。");
          }
          if (typeof params.claimId !== "string" || !ID.test(params.claimId)) {
            return fail("invalid_claim_id", "claimId 格式不正确。");
          }
          const ref = params.ref;
          if (
            !isPlainObject(ref) ||
            typeof ref.kind !== "string" ||
            !(EVIDENCE_REF_KINDS as readonly string[]).includes(ref.kind) ||
            typeof ref.id !== "string" ||
            !ID.test(ref.id)
          ) {
            return fail("invalid_ref", "ref 需为 {kind: execution|tool_output|blob, id}。");
          }
          if (
            params.expectedHeadEventId !== undefined &&
            typeof params.expectedHeadEventId !== "string"
          ) {
            return fail("invalid_expected_head", "expectedHeadEventId 为字符串。");
          }
          const result = await store.addEvidence({
            principal,
            taskId,
            claimId: params.claimId,
            ref: { kind: ref.kind as "execution" | "tool_output" | "blob", id: ref.id },
            ...(typeof params.expectedHeadEventId === "string"
              ? { expectedHeadEventId: params.expectedHeadEventId }
              : {}),
            actor,
            now: now(),
          });
          switch (result.outcome) {
            case "not_found":
              return fail("not_found", "找不到这个事项。");
            case "claim_not_found":
              return fail("claim_not_found", "找不到这个 claim。");
            case "task_closed":
              return fail("task_closed", `事项已结束（${result.status}），不能再挂证据。`);
            case "stale_head":
              return fail(
                "stale_head",
                "这个 claim 已被修改；请先 nexus_claim_verify 读取最新状态。",
                {
                  headEventId: result.headEventId,
                },
              );
            case "ref_kind_not_supported":
              return fail(
                "ref_kind_not_supported",
                `当前版本只支持 execution 证据；${result.kind} 需要证据字节存储（后续版本）。`,
              );
            case "ref_not_found":
              return fail("ref_not_found", "找不到这个 execution（或它不属于这个事项）。");
            case "ref_not_ready":
              return fail(
                "ref_not_ready",
                `这个 execution 还没有定论（${result.state}）；等它 succeeded / failed 后再挂证据。`,
              );
            case "detached_by_operator":
              return fail("detached_by_operator", "这条证据已被操作员撤下，不能再挂回去。", {
                evidenceId: result.evidenceId,
              });
            case "already_linked":
              return {
                ok: true,
                alreadyLinked: true,
                evidenceId: result.evidenceId,
                ...claimView(result.claim),
              };
            case "linked":
              deps.onOutboxWritten?.();
              return {
                ok: true,
                alreadyLinked: false,
                evidenceId: result.evidenceId,
                relation: result.relation,
                reason: result.reason,
                stateBefore: result.stateBefore,
                stateAfter: result.stateAfter,
                ...claimView(result.claim),
                notice:
                  result.stateAfter === "SUPPORTED" || result.stateAfter === "VERIFIED"
                    ? undefined
                    : "The claim is NOT supported by this evidence. Do not tell the user it is true.",
              };
          }
        });
      },
    },
    {
      name: "nexus_claim_verify",
      label: "Nexus: read claim status",
      description:
        "Read-only. With claimId: the claim's derived state, its evidence and distinct source groups. Without claimId: all claims of the Task plus whether the Task's completion conditions are met. This tool never changes a state; it tells you what the store has actually established.",
      parameters: Type.Object({
        taskId: Type.String(),
        claimId: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const taskId = normalizeTaskId(params.taskId);
          if (!taskId) {
            return fail("invalid_task_id", "taskId 形如 T0ABC123（可带 #）。");
          }
          if (params.claimId !== undefined) {
            if (typeof params.claimId !== "string" || !ID.test(params.claimId)) {
              return fail("invalid_claim_id", "claimId 格式不正确。");
            }
            const detail = await store.getClaim({ principal, taskId, claimId: params.claimId });
            if (!detail) {
              return fail("claim_not_found", "找不到这个 claim。");
            }
            return { ok: true, ...detailView(detail) };
          }
          const claims = await store.listClaims({
            principal,
            taskId,
            limit: CLAIM_LIMITS.claimsReturned,
          });
          const completion = await store.checkCompletion({ principal, taskId });
          return {
            ok: true,
            taskId,
            claims: claims.map(claimView),
            completion: { ok: completion.ok, reason: completion.reason, items: completion.items },
          };
        });
      },
    },
  ];
  const visible = tools.map((tool) => ({ ...tool, catalogMode: "direct-only" as const }));
  return visible as unknown as AnyAgentTool[];
}
