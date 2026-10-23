// Server-generated decision content and the authority hash (DESIGN section 8.10).
// The model never supplies facts, options or wording: everything a human sees is built here from rows the server
// owns. `authorityHash` is recomputed at resolve time from the current rows; any difference means the thing the
// human looked at is no longer the thing that would be authorized, and the decision becomes `superseded`.
import { canonicalJson, sha256Hex } from "../canonical.js";
import type { ActionRecord, EffectKind, GrantPolicy, TaskLike } from "./content-types.js";

export const ACTION_GRANT_TTL_MS = 30 * 60_000;
export const STANDING_GRANT_TTL_MS = 24 * 3_600_000;
export const STANDING_MAX_USES = 3;
export const STANDING_MAX_USES_PER_DAY = 3;
export const DEFAULT_DECISION_DEADLINE_MS = 24 * 3_600_000;

export const OPTION_IDS = ["approve", "deny"] as const;

export function decisionTypeFor(effectKind: EffectKind): string {
  switch (effectKind) {
    case "issue_action_grant":
      return "action_approval";
    case "issue_standing_grant":
      return "standing_policy";
    case "set_preference":
      return "preference_confirmation";
    default:
      return "acknowledge";
  }
}

/** request_fingerprint := sha256(taskId, decisionType, sorted actionIds) (DESIGN section 8.8.4). */
export function decisionFingerprint(input: {
  taskId: string;
  decisionType: string;
  actionIds: readonly string[];
}): string {
  return sha256Hex(
    canonicalJson({
      taskId: input.taskId,
      decisionType: input.decisionType,
      actionIds: [...input.actionIds].toSorted(),
    }),
  );
}

export function policyFor(action: ActionRecord, effectKind: EffectKind): GrantPolicy {
  if (effectKind === "issue_standing_grant") {
    return {
      actionId: action.id,
      kind: "standing_grant",
      capability: action.capability,
      toolName: action.toolName,
      merchant: action.merchant,
      currency: null,
      maxAmount: null,
      ttlMs: STANDING_GRANT_TTL_MS,
      singleUse: false,
      maxUses: STANDING_MAX_USES,
      maxUsesPerDay: STANDING_MAX_USES_PER_DAY,
    };
  }
  return {
    actionId: action.id,
    kind: "action_grant",
    capability: action.capability,
    toolName: action.toolName,
    merchant: action.merchant,
    currency: action.currency,
    // R3: the grant covers exactly the amount the human saw; no variance in Stage 2.
    maxAmount: action.amount,
    ttlMs: ACTION_GRANT_TTL_MS,
    singleUse: true,
    maxUses: null,
    maxUsesPerDay: null,
  };
}

function flatEntities(entities: unknown): { key: string; value: string }[] {
  if (typeof entities !== "object" || entities === null || Array.isArray(entities)) {
    return [];
  }
  return Object.entries(entities as Record<string, unknown>)
    .slice(0, 20)
    .map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));
}

export type DecisionContent = {
  question: string;
  facts: unknown;
  options: unknown;
  unknowns: unknown;
  policies: GrantPolicy[];
};

/** Builds everything the human is shown. `describe` comes from the catalog (one line per candidate action). */
export function buildDecisionContent(input: {
  task: TaskLike;
  effectKind: EffectKind;
  actions: ActionRecord[];
  describe: (action: ActionRecord) => string;
}): DecisionContent {
  const policies = input.actions.map((action) => policyFor(action, input.effectKind));
  const candidates = input.actions.map((action) => ({
    actionId: action.id,
    summary: input.describe(action),
    riskTier: action.riskTier,
    reversible: action.reversible,
    amount: action.amount,
    currency: action.currency,
    merchant: action.merchant,
    params: action.params,
  }));
  const standing = input.effectKind === "issue_standing_grant";
  const first = input.actions[0];
  const question =
    input.effectKind === "acknowledge"
      ? `请确认事项「${input.task.title}」`
      : standing
        ? `是否允许在事项「${input.task.title}」中，持续为「${first?.capability ?? ""}」类动作（对象：${first?.merchant ?? "不限"}）自动签发执行凭证？`
        : `是否批准执行：${candidates.map((c) => c.summary).join("；")}？`;
  const facts = {
    task: {
      id: input.task.id,
      title: input.task.title,
      revision: input.task.revision,
      goal: input.task.goal,
      // Stage 1 finding: models fabricate entity fields. The human must see the exact values.
      entities: flatEntities(input.task.entities),
    },
    candidates,
    policy: policies.map((policy) =>
      policy.kind === "standing_grant"
        ? {
            actionId: policy.actionId,
            kind: policy.kind,
            validForMs: policy.ttlMs,
            maxUses: policy.maxUses,
            maxUsesPerDay: policy.maxUsesPerDay,
            merchant: policy.merchant,
          }
        : {
            actionId: policy.actionId,
            kind: policy.kind,
            validForMs: policy.ttlMs,
            singleUse: true,
            maxAmount: policy.maxAmount,
            currency: policy.currency,
          },
    ),
  };
  const unknowns = [
    "事项里的 entities 由模型整理，Nexus 没有逐项核对用户原话；批准前请逐项确认上面列出的值。",
    "Stage 2 不接入真实供应商：批准后只会调用演示用的 fake provider。",
  ];
  return {
    question,
    facts,
    options: OPTION_IDS.map((id) => ({ id, label: id === "approve" ? "批准" : "拒绝" })),
    unknowns,
    policies,
  };
}

function previewValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const chars = Array.from(text ?? "null");
  return chars.length > 200 ? `${chars.slice(0, 200).join("")}...` : chars.join("");
}

/**
 * Card for a `set_preference` decision (DESIGN section 11.4 / 8.12). Everything shown is built here from the mutation and the
 * CURRENT stated value; the model supplies neither wording nor options. There are no grant policies: confirming a preference
 * authorizes nothing.
 */
export function buildPreferenceContent(input: {
  task: TaskLike;
  mutation: { scope: string; key: string; value: unknown };
  current: { value: unknown; revision: number } | null;
}): DecisionContent {
  const { mutation, current } = input;
  const question = current
    ? `是否把偏好「${mutation.key}」（范围 ${mutation.scope}）从 ${previewValue(current.value)} 改为 ${previewValue(mutation.value)}？`
    : `是否把偏好「${mutation.key}」（范围 ${mutation.scope}）确认为 ${previewValue(mutation.value)}？`;
  return {
    question,
    facts: {
      task: {
        id: input.task.id,
        title: input.task.title,
        revision: input.task.revision,
      },
      mutation: { op: "set", scope: mutation.scope, key: mutation.key, value: mutation.value },
      current: current ? { value: current.value, revision: current.revision } : null,
      effect: "只会写入这条偏好；不授权任何操作，也不改变任何动作的风险档。",
    },
    options: OPTION_IDS.map((id) => ({ id, label: id === "approve" ? "确认" : "拒绝" })),
    unknowns: [
      "这个值是模型根据对话整理的，Nexus 没有核对用户原话；确认前请核对上面列出的值。",
      "偏好只影响默认选项，不构成授权；之后可以随时在偏好页修改或删除。",
    ],
    policies: [],
  };
}

export type AuthorityInput = {
  ownerId: string;
  taskId: string;
  taskRevision: number;
  decisionType: string;
  riskTier: string;
  requiredDecider: string | null;
  actions: { actionId: string; actionHash: string }[];
  effectKind: EffectKind;
  grantPolicy: GrantPolicy[] | null;
  deadlineAt: number | null;
  allowedOptionIds: readonly string[];
  /** Stage 3 fills these from claims; Stage 2 has no claims, so both are empty. */
  facts?: unknown[];
  completion?: unknown[];
  /** Stage 4 (set_preference). */
  preferenceMutation?: unknown;
};

export function computeAuthorityHash(input: AuthorityInput): string {
  return sha256Hex(
    canonicalJson({
      ownerId: input.ownerId,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      decisionType: input.decisionType,
      riskTier: input.riskTier,
      requiredDecider: input.requiredDecider,
      actions: [...input.actions].toSorted((a, b) => (a.actionId < b.actionId ? -1 : 1)),
      facts: input.facts ?? [],
      completion: input.completion ?? [],
      effectKind: input.effectKind,
      grantPolicy: input.grantPolicy
        ? [...input.grantPolicy].toSorted((a, b) => (a.actionId < b.actionId ? -1 : 1))
        : null,
      preferenceMutation: input.preferenceMutation ?? null,
      deadlineAt: input.deadlineAt,
      allowedOptionIds: [...input.allowedOptionIds].toSorted(),
    }),
  );
}
