/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
// Synchronous Decision / Grant / Execution kernel for Stage 2 (DESIGN section 8). Runs inside the SQLite worker.
// Rules carried over from Stage 1: every method takes ONE input object with a mandatory `principal`, every statement
// filters on owner_id, and every write path is a single synchronous transaction with no await inside it.
// Rules specific to this file:
//   * grants are consumed only by `admitExecution`, which is called from a Nexus-owned tool handler (section 8.2);
//   * `resolveInTx` is the ONE function that applies a decision's effect, shared by the core-approval callback and
//     the `nexus.decision.resolve` RPC (section 8.9);
//   * the two external-I/O halves of a commit are `admitExecution` and `settleExecution`, never one transaction.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { asText } from "../as-text.js";
import { canonicalJson, sha256Hex } from "../canonical.js";
import { actionHashFor, specFor, tierForCapability } from "../decision/catalog.js";
import {
  buildDecisionContent,
  buildPreferenceContent,
  computeAuthorityHash,
  decisionFingerprint,
  decisionTypeFor,
  DEFAULT_DECISION_DEADLINE_MS,
  OPTION_IDS,
} from "../decision/content.js";
import type { ExecutionHookResult } from "./claim-ledger.js";
import type {
  ActionGrantRecord,
  ActionRecord,
  CoreApprovalState,
  DecisionRecord,
  DecisionResolution,
  EffectKind,
  ExecutionRecord,
  ExecutionState,
  GrantPolicy,
  OutboxRecord,
  ProviderCaps,
  RunTriggerRecord,
  StandingGrantRecord,
} from "./decision-types.js";
import { isClosed, parseJson, TASK_COLUMNS, toTask, type TransactionRunner } from "./kernel.js";
import { canonicalPreferenceValue, preferenceMutationCanonical } from "./preference-ledger.js";
import {
  isValidPreferenceKey,
  isValidPreferenceScope,
  type PreferenceMutation,
} from "./preference-types.js";
import type { Principal, TaskRecord } from "./types.js";

type Row = Record<string, unknown>;

export const CORE_APPROVER = "core-approval-reviewer-unavailable";
export const MAX_CANDIDATES = 5;
export const RECONCILE_DELAY_MS = 30_000;
export const DAY_MS = 86_400_000;

const DECISION_COLUMNS =
  "id, task_id, decision_type, risk_tier, question, facts_snapshot, options_snapshot, unknowns_snapshot, " +
  "grant_policy_snapshot, authority_hash, task_revision, required_decider, deadline_at, status, resolution, " +
  "resolution_source, resolved_by, resolved_at, core_approval_state, core_approval_attempt_at, " +
  "core_approval_attempt_id, session_key, run_id, tool_call_id, request_fingerprint, chosen_action_id, effect_kind, " +
  "effect_payload_canonical";
const ACTION_COLUMNS =
  "id, task_id, tool_name, capability, params_canonical, action_hash, amount, currency, merchant, reversible, created_at";
const EXECUTION_COLUMNS =
  "id, task_id, action_id, action_grant_id, standing_grant_id, provider_idempotency_key, " +
  "provider_idempotency_supported, state, provider_operation_id, result_canonical, error_canonical, attempts, " +
  "next_reconcile_at, prepared_at, started_at, completed_at";

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toAction(row: Row): ActionRecord {
  const capability = String(row.capability);
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    toolName: String(row.tool_name),
    capability,
    riskTier: tierForCapability(capability) ?? "R3",
    params: parseJson(row.params_canonical),
    paramsCanonical: String(row.params_canonical),
    actionHash: String(row.action_hash),
    amount: str(row.amount),
    currency: str(row.currency),
    merchant: str(row.merchant),
    reversible: Number(row.reversible) === 1,
    createdAt: Number(row.created_at),
  };
}

function toExecution(row: Row): ExecutionRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    actionId: String(row.action_id),
    actionGrantId: str(row.action_grant_id),
    standingGrantId: str(row.standing_grant_id),
    providerIdempotencyKey: String(row.provider_idempotency_key),
    providerIdempotencySupported: Number(row.provider_idempotency_supported) === 1,
    state: String(row.state) as ExecutionState,
    providerOperationId: str(row.provider_operation_id),
    result: row.result_canonical === null ? null : parseJson(row.result_canonical),
    error: row.error_canonical === null ? null : parseJson(row.error_canonical),
    attempts: Number(row.attempts),
    nextReconcileAt: num(row.next_reconcile_at),
    preparedAt: Number(row.prepared_at),
    startedAt: num(row.started_at),
    completedAt: num(row.completed_at),
  };
}

function toActionGrant(row: Row): ActionGrantRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    fromDecisionId: String(row.from_decision_id),
    actionId: String(row.action_id),
    capability: String(row.capability),
    toolName: String(row.tool_name),
    currency: str(row.currency),
    maxAmount: str(row.max_amount),
    taskRevision: Number(row.task_revision),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    consumedAt: num(row.consumed_at),
    consumedByExecution: str(row.consumed_by_execution),
    revokedAt: num(row.revoked_at),
    supersededBy: str(row.superseded_by),
  };
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export type DecisionKernelOptions = {
  newId?: (prefix: string) => string;
  /** Stage 3: runs inside settleExecution's transaction when the caller asks for it (`recordClaim`). Must not throw. */
  afterSettleInTx?: (owner: string, executionId: string, now: number) => ExecutionHookResult;
  /**
   * Stage 4: runs inside resolveInTx's transaction when a `set_preference` decision is approved. It may write `preferences` +
   * `preference_revisions` and nothing else (section 8.12); a failure throws, which rolls the whole resolve back.
   */
  applyPreferenceInTx?: (
    owner: string,
    mutationText: string,
    decisionId: string,
    now: number,
  ) => { ok: true } | { ok: false; reason: string };
};

export type CreateDecisionInput = {
  principal: Principal;
  taskId: string;
  effectKind?: EffectKind;
  actionIds: string[];
  /** Idempotency key parts (section 8.8.4); all three present or no key. */
  sessionKey: string | null;
  runId: string | null;
  toolCallId: string | null;
  /**
   * Server-built notice for an `acknowledge` decision (slice 2: evidence quota exceeded, tier R0). Only trusted service
   * code passes it - never a tool parameter - so the wording and facts are still not the model's.
   */
  notice?: {
    decisionType: string;
    question: string;
    facts: unknown;
    unknowns: string[];
  };
  /**
   * The mutation a `set_preference` decision asks the human to confirm (section 11.4). Only the preference tool passes it;
   * `nexus_decision_request` never does, so a bare `set_preference` kind stays unsupported there. The wording shown to the
   * human is still built here from this mutation and the current stated value, never from model text.
   */
  preference?: PreferenceMutation;
  now: number;
};

export type InvalidEffect =
  | { code: "no_actions" }
  | { code: "too_many_actions"; max: number }
  | { code: "action_not_found"; actionId: string }
  | { code: "mixed_tier" }
  | { code: "wrong_kind"; expected: EffectKind }
  | { code: "unsupported_effect"; kind: string }
  | { code: "bad_preference"; reason: string };

export type CreateDecisionOutcome =
  | { outcome: "created"; decision: DecisionRecord; task: TaskRecord }
  | { outcome: "replayed"; decision: DecisionRecord; noticeEnqueued: boolean }
  | { outcome: "reused_pending"; decision: DecisionRecord }
  | {
      outcome: "already_approved";
      decision: DecisionRecord;
      executionId: string | null;
      standingGrantId: string | null;
    }
  | { outcome: "fingerprint_conflict"; decision: DecisionRecord }
  | { outcome: "invalid_effect"; invalid: InvalidEffect }
  | { outcome: "not_found" }
  | { outcome: "task_closed"; task: TaskRecord };

export type ResolveInput = {
  principal: Principal;
  decisionId: string;
  resolution: "approved" | "denied";
  chosenActionId?: string;
  source: "core_approval" | "nexus_console";
  resolvedBy: string;
  approvalRef?: string;
  providerCaps: ProviderCaps;
  now: number;
};

export type ResolveOutcome =
  | {
      outcome: "approved";
      decision: DecisionRecord;
      executionId: string | null;
      actionGrantId: string | null;
      standingGrantId: string | null;
      task: TaskRecord | null;
    }
  | { outcome: "denied"; decision: DecisionRecord; task: TaskRecord | null }
  | { outcome: "already_resolved"; decision: DecisionRecord }
  | { outcome: "superseded"; decision: DecisionRecord; reason: string; task: TaskRecord | null }
  | { outcome: "expired"; decision: DecisionRecord; task: TaskRecord | null }
  | { outcome: "choice_required"; decision: DecisionRecord }
  | { outcome: "invalid_choice"; decision: DecisionRecord }
  | { outcome: "effect_unsupported"; decision: DecisionRecord }
  | { outcome: "effect_apply_failed"; decision: DecisionRecord | null; message: string }
  | { outcome: "not_found" };

export type AdmitAction = {
  toolName: string;
  capability: string;
  merchant: string | null;
  amount: string | null;
  currency: string | null;
  params: unknown;
  paramsCanonical: string;
};

export type AdmitOutcome =
  | { kind: "replay_succeeded"; execution: ExecutionRecord }
  | { kind: "replay_failed"; execution: ExecutionRecord }
  | {
      kind: "reconcile_only";
      execution: ExecutionRecord;
      reason: "unknown" | "in_flight" | "stale_executing";
    }
  | {
      kind: "retry_provider_idempotently";
      execution: ExecutionRecord;
      action: AdmitAction;
      task: TaskRecord | null;
    }
  | {
      kind: "execute_new";
      execution: ExecutionRecord;
      action: AdmitAction;
      task: TaskRecord | null;
    }
  | { kind: "rejected"; reason: string; message: string; execution: ExecutionRecord | null };

export type SettleOutcomeInput =
  | { kind: "succeeded"; result: unknown; providerOperationId?: string }
  | { kind: "failed"; error: unknown }
  | { kind: "unknown"; error: unknown };

export type AuthorizeOutcome =
  | { outcome: "authorized"; executionId: string; reentry: boolean; execution: ExecutionRecord }
  | { outcome: "not_found" }
  | { outcome: "task_closed"; task: TaskRecord }
  | { outcome: "not_r1"; tier: string }
  | { outcome: "no_policy" }
  | { outcome: "policy_not_applicable"; reason: string }
  | { outcome: "in_progress"; execution: ExecutionRecord }
  | { outcome: "already_done"; execution: ExecutionRecord };

export function createDecisionKernel(
  db: DatabaseSync,
  transaction: TransactionRunner,
  options: DecisionKernelOptions = {},
) {
  const newId =
    options.newId ??
    ((prefix: string) => {
      const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
      return `${prefix}${[...randomBytes(10)].map((byte) => alphabet[byte % 32]).join("")}`;
    });

  const one = (sql: string, ...params: (string | number | null)[]): Row | undefined =>
    db.prepare(sql).get(...params) as Row | undefined;
  const all = (sql: string, ...params: (string | number | null)[]): Row[] =>
    db.prepare(sql).all(...params) as Row[];
  const run = (sql: string, ...params: (string | number | null)[]): number =>
    Number(db.prepare(sql).run(...params).changes);
  const countOf = (sql: string, ...params: (string | number | null)[]): number =>
    (one(sql, ...params) as { c: number }).c;

  const taskRow = (owner: string, taskId: string): Row | undefined =>
    one(`SELECT ${TASK_COLUMNS} FROM nexus_tasks WHERE owner_id = ? AND id = ?`, owner, taskId);
  const liveTask = (owner: string, taskId: string): TaskRecord | undefined => {
    const row = taskRow(owner, taskId);
    return row && row.deleted_at === null ? toTask(row) : undefined;
  };

  const bindSession = (owner: string, taskId: string, sessionKey: string | null, now: number) => {
    if (!sessionKey) {
      return;
    }
    run(
      "INSERT INTO nexus_task_sessions (owner_id, task_id, session_key, first_seen, last_seen) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (task_id, session_key) DO UPDATE SET last_seen = excluded.last_seen",
      owner,
      taskId,
      sessionKey,
      now,
      now,
    );
  };

  const addStep = (
    owner: string,
    taskId: string,
    kind: string,
    status: string,
    title: string,
    detail: unknown,
    now: number,
  ) => {
    const seq = Number(
      (
        one(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM nexus_task_steps WHERE task_id = ?",
          taskId,
        ) as Row
      ).next,
    );
    run(
      "INSERT INTO nexus_task_steps (id, owner_id, task_id, seq, kind, status, title, detail_json, started_at, ended_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      newId("S"),
      owner,
      taskId,
      seq,
      kind,
      status,
      Array.from(title).slice(0, 80).join(""),
      JSON.stringify(detail),
      now,
      now,
    );
  };

  /** Task status follows decisions and executions: executing > awaiting_decision > back to planning. */
  const refreshTaskStatus = (owner: string, taskId: string, now: number): TaskRecord | null => {
    const task = liveTask(owner, taskId);
    if (!task || isClosed(task.status)) {
      return task ?? null;
    }
    const busy = countOf(
      "SELECT COUNT(*) AS c FROM action_executions WHERE owner_id = ? AND task_id = ? AND state IN ('executing','unknown')",
      owner,
      taskId,
    );
    const pending = countOf(
      "SELECT COUNT(*) AS c FROM decisions WHERE owner_id = ? AND task_id = ? AND status = 'pending'",
      owner,
      taskId,
    );
    let target: string = task.status;
    if (busy > 0) {
      target = "executing";
    } else if (pending > 0) {
      target = "awaiting_decision";
    } else if (task.status === "awaiting_decision" || task.status === "executing") {
      // An active watch keeps the Task in `watching` once the decision / execution that interrupted it is done.
      const watching = countOf(
        "SELECT COUNT(*) AS c FROM watches WHERE owner_id = ? AND task_id = ? AND status IN ('pending_schedule','scheduled','firing')",
        owner,
        taskId,
      );
      target = watching > 0 ? "watching" : "planning";
    }
    if (target !== task.status) {
      run(
        "UPDATE nexus_tasks SET status = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
        target,
        now,
        owner,
        taskId,
      );
    }
    return liveTask(owner, taskId) ?? null;
  };

  const enqueueOutbox = (
    owner: string,
    taskId: string,
    eventKey: string,
    kind: string,
    payload: unknown,
    decisionId: string | null,
    now: number,
  ): boolean =>
    run(
      "INSERT OR IGNORE INTO outbox (id, owner_id, task_id, event_key, kind, payload_canonical, decision_id, state, attempts, " +
        "next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
      newId("O"),
      owner,
      taskId,
      eventKey,
      kind,
      canonicalJson(payload),
      decisionId,
      now,
      now,
    ) > 0;

  const actionRow = (owner: string, actionId: string): Row | undefined =>
    one(`SELECT ${ACTION_COLUMNS} FROM actions WHERE owner_id = ? AND id = ?`, owner, actionId);

  const decisionRow = (owner: string, decisionId: string): Row | undefined =>
    one(
      `SELECT ${DECISION_COLUMNS} FROM decisions WHERE owner_id = ? AND id = ?`,
      owner,
      decisionId,
    );

  const candidateIds = (owner: string, decisionId: string): string[] =>
    all(
      "SELECT action_id FROM decision_actions WHERE owner_id = ? AND decision_id = ? ORDER BY action_id",
      owner,
      decisionId,
    ).map((row) => String(row.action_id));

  const toDecision = (row: Row, owner: string): DecisionRecord => ({
    id: String(row.id),
    taskId: String(row.task_id),
    decisionType: String(row.decision_type),
    riskTier: String(row.risk_tier),
    question: String(row.question),
    facts: parseJson(row.facts_snapshot),
    options: parseJson(row.options_snapshot),
    unknowns: parseJson(row.unknowns_snapshot),
    policies: ((parseJson(row.grant_policy_snapshot) as { policies?: GrantPolicy[] } | null)
      ?.policies ?? []) as GrantPolicy[],
    authorityHash: String(row.authority_hash),
    taskRevision: Number(row.task_revision),
    requiredDecider: str(row.required_decider),
    deadlineAt: num(row.deadline_at),
    status: String(row.status) as DecisionRecord["status"],
    resolution: str(row.resolution) as DecisionResolution | null,
    resolutionSource: str(row.resolution_source),
    resolvedBy: str(row.resolved_by),
    resolvedAt: num(row.resolved_at),
    coreApprovalState: String(row.core_approval_state) as CoreApprovalState,
    sessionKey: str(row.session_key),
    runId: str(row.run_id),
    toolCallId: str(row.tool_call_id),
    effectKind: String(row.effect_kind) as EffectKind,
    chosenActionId: str(row.chosen_action_id),
    actionIds: candidateIds(owner, String(row.id)),
  });

  const getDecisionRecord = (owner: string, decisionId: string): DecisionRecord | undefined => {
    const row = decisionRow(owner, decisionId);
    return row ? toDecision(row, owner) : undefined;
  };

  // ---- authority hash recomputation (section 8.10): from the CURRENT rows, never from cached copies ----
  const recomputeAuthorityHash = (owner: string, row: Row): { hash: string; reason?: string } => {
    const task = liveTask(owner, String(row.task_id));
    if (!task) {
      return { hash: "", reason: "task_gone" };
    }
    const actions = candidateIds(owner, String(row.id)).map((id) => actionRow(owner, id));
    if (actions.some((action) => !action)) {
      return { hash: "", reason: "action_gone" };
    }
    const snapshot = parseJson(row.grant_policy_snapshot) as { policies?: GrantPolicy[] } | null;
    const effectKind = String(row.effect_kind) as EffectKind;
    return {
      hash: computeAuthorityHash({
        ownerId: owner,
        taskId: task.id,
        taskRevision: task.revision,
        decisionType: String(row.decision_type),
        riskTier: String(row.risk_tier),
        requiredDecider: str(row.required_decider),
        actions: (actions as Row[]).map((action) => ({
          actionId: String(action.id),
          actionHash: String(action.action_hash),
        })),
        effectKind,
        grantPolicy:
          effectKind === "issue_action_grant" || effectKind === "issue_standing_grant"
            ? (snapshot?.policies ?? [])
            : null,
        ...(effectKind === "set_preference"
          ? { preferenceMutation: parseJson(row.effect_payload_canonical) }
          : {}),
        deadlineAt: num(row.deadline_at),
        allowedOptionIds: OPTION_IDS,
      }),
    };
  };

  // ======================================================================================================
  // Actions (section 8.3): the single source of truth for what would be executed
  // ======================================================================================================
  const registerAction = (input: {
    principal: Principal;
    taskId: string;
    toolName: string;
    params: unknown;
    occurrence?: number;
    sessionKey: string | null;
    now: number;
  }):
    | {
        outcome: "created" | "existing";
        action: ActionRecord;
        latestExecution: ExecutionRecord | null;
      }
    | { outcome: "unknown_tool"; known: string[] }
    | { outcome: "invalid_params"; reason: string }
    | { outcome: "not_found" }
    | { outcome: "task_closed"; task: TaskRecord } => {
    const owner = input.principal.ownerId;
    const spec = specFor(input.toolName);
    if (!spec) {
      return {
        outcome: "unknown_tool",
        known: ["fake_vendor_message", "fake_booking", "fake_payment"],
      };
    }
    const parsed = spec.parse(input.params);
    if (typeof parsed === "string") {
      return { outcome: "invalid_params", reason: parsed };
    }
    const occurrence =
      Number.isInteger(input.occurrence) && (input.occurrence ?? 1) >= 1
        ? (input.occurrence as number)
        : 1;
    return transaction(() => {
      const task = liveTask(owner, input.taskId);
      if (!task) {
        return { outcome: "not_found" as const };
      }
      if (isClosed(task.status)) {
        return { outcome: "task_closed" as const, task };
      }
      const paramsCanonical = canonicalJson(parsed.params);
      const actionHash = actionHashFor(spec.toolName, spec.capability, paramsCanonical, occurrence);
      let row = one(
        `SELECT ${ACTION_COLUMNS} FROM actions WHERE owner_id = ? AND task_id = ? AND action_hash = ?`,
        owner,
        task.id,
        actionHash,
      );
      let outcome: "created" | "existing" = "existing";
      if (!row) {
        const id = newId("A");
        run(
          "INSERT INTO actions (id, owner_id, task_id, tool_name, capability, params_canonical, action_hash, amount, currency, " +
            "merchant, reversible, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          id,
          owner,
          task.id,
          spec.toolName,
          spec.capability,
          paramsCanonical,
          actionHash,
          parsed.amount,
          parsed.currency,
          parsed.merchant,
          spec.reversible ? 1 : 0,
          input.now,
        );
        row = actionRow(owner, id) as Row;
        outcome = "created";
      }
      bindSession(owner, task.id, input.sessionKey, input.now);
      const latest = one(
        `SELECT ${EXECUTION_COLUMNS} FROM action_executions WHERE owner_id = ? AND action_id = ? ORDER BY prepared_at DESC, rowid DESC LIMIT 1`,
        owner,
        String(row.id),
      );
      return {
        outcome,
        action: toAction(row),
        latestExecution: latest ? toExecution(latest) : null,
      };
    });
  };

  const getAction = (input: { principal: Principal; actionId: string }): ActionRecord | null => {
    const row = actionRow(input.principal.ownerId, input.actionId);
    return row ? toAction(row) : null;
  };

  // ======================================================================================================
  // Decisions (section 8.8.3 / 8.10): content is generated here, never accepted from the model
  // ======================================================================================================
  const liveActionGrantFor = (owner: string, actionId: string, now: number, revision: number) =>
    one(
      "SELECT * FROM action_grants WHERE owner_id = ? AND action_id = ? AND consumed_at IS NULL AND revoked_at IS NULL " +
        "AND superseded_by IS NULL AND expires_at > ? AND task_revision = ?",
      owner,
      actionId,
      now,
      revision,
    );

  const createDecision = (input: CreateDecisionInput): CreateDecisionOutcome => {
    const owner = input.principal.ownerId;
    const hasKey = input.sessionKey !== null && input.runId !== null && input.toolCallId !== null;
    return transaction((): CreateDecisionOutcome => {
      const task = liveTask(owner, input.taskId);
      if (!task) {
        return { outcome: "not_found" };
      }
      if (isClosed(task.status)) {
        return { outcome: "task_closed", task };
      }

      // ---- validate the candidate set and derive the effect from server-side risk tiers ----
      const ids = [...new Set(input.actionIds)];
      let preferenceMutation: PreferenceMutation | null = null;
      let preferencePayload: string | null = null;
      if (input.effectKind === "set_preference") {
        if (!input.preference) {
          return {
            outcome: "invalid_effect",
            invalid: { code: "unsupported_effect", kind: "set_preference" },
          };
        }
        if (ids.length > 0) {
          return {
            outcome: "invalid_effect",
            invalid: { code: "wrong_kind", expected: "issue_action_grant" },
          };
        }
        const wanted = input.preference;
        if (!isValidPreferenceScope(wanted.scope)) {
          return {
            outcome: "invalid_effect",
            invalid: { code: "bad_preference", reason: "bad_scope" },
          };
        }
        if (!isValidPreferenceKey(wanted.key)) {
          return {
            outcome: "invalid_effect",
            invalid: { code: "bad_preference", reason: "bad_key" },
          };
        }
        const canonical = canonicalPreferenceValue(wanted.value);
        if (!canonical.ok) {
          return {
            outcome: "invalid_effect",
            invalid: { code: "bad_preference", reason: canonical.code },
          };
        }
        preferenceMutation = {
          op: "set",
          scope: wanted.scope,
          key: wanted.key,
          value: wanted.value,
        };
        preferencePayload = preferenceMutationCanonical(preferenceMutation);
      } else if (input.preference !== undefined) {
        return {
          outcome: "invalid_effect",
          invalid: { code: "wrong_kind", expected: "set_preference" },
        };
      }
      let effectKind: EffectKind;
      let actions: ActionRecord[] = [];
      if (preferenceMutation) {
        effectKind = "set_preference";
      } else if (input.effectKind === "acknowledge") {
        if (ids.length > 0) {
          return {
            outcome: "invalid_effect",
            invalid: { code: "wrong_kind", expected: "issue_action_grant" },
          };
        }
        effectKind = "acknowledge";
      } else {
        if (ids.length === 0) {
          return { outcome: "invalid_effect", invalid: { code: "no_actions" } };
        }
        if (ids.length > MAX_CANDIDATES) {
          return {
            outcome: "invalid_effect",
            invalid: { code: "too_many_actions", max: MAX_CANDIDATES },
          };
        }
        for (const id of ids) {
          const row = actionRow(owner, id);
          if (!row || String(row.task_id) !== task.id) {
            return {
              outcome: "invalid_effect",
              invalid: { code: "action_not_found", actionId: id },
            };
          }
          actions.push(toAction(row));
        }
        const tiers = new Set(actions.map((action) => action.riskTier));
        if (tiers.size !== 1) {
          return { outcome: "invalid_effect", invalid: { code: "mixed_tier" } };
        }
        const expected: EffectKind =
          actions[0]?.riskTier === "R1" ? "issue_standing_grant" : "issue_action_grant";
        if (input.effectKind !== undefined && input.effectKind !== expected) {
          return { outcome: "invalid_effect", invalid: { code: "wrong_kind", expected } };
        }
        effectKind = expected;
      }
      if (input.notice !== undefined && effectKind !== "acknowledge") {
        return {
          outcome: "invalid_effect",
          invalid: { code: "wrong_kind", expected: "acknowledge" },
        };
      }
      actions = actions.toSorted((a, b) => (a.id < b.id ? -1 : 1));
      const decisionType = input.notice?.decisionType ?? decisionTypeFor(effectKind);
      // A preference decision has no candidate actions; its identity is the mutation, so two different keys never reuse a card.
      const fingerprint = decisionFingerprint({
        taskId: task.id,
        decisionType,
        actionIds: preferencePayload ? [`pref:${sha256Hex(preferencePayload)}`] : ids,
      });

      // ---- 1. idempotency key hit (check-then-write, independent of the unique index) ----
      if (hasKey) {
        const hit = one(
          `SELECT ${DECISION_COLUMNS} FROM decisions WHERE owner_id = ? AND session_key = ? AND run_id = ? AND tool_call_id = ?`,
          owner,
          input.sessionKey,
          input.runId,
          input.toolCallId,
        );
        if (hit) {
          const decision = toDecision(hit, owner);
          if (hit.request_fingerprint !== fingerprint) {
            return { outcome: "fingerprint_conflict", decision };
          }
          // A crash between the decision row and its notice can no longer happen (one transaction), but a replay
          // still checks the outbox row exists so an older partial state heals instead of staying silent.
          const noticeEnqueued = enqueueOutbox(
            owner,
            task.id,
            `decision_pending:${decision.id}`,
            "decision_pending",
            pendingPayload(decision),
            decision.id,
            input.now,
          );
          return { outcome: "replayed", decision, noticeEnqueued };
        }
      }
      // ---- 2. an identical decision is already waiting for the human: reuse it, never stack a second card ----
      const pending = one(
        `SELECT ${DECISION_COLUMNS} FROM decisions WHERE owner_id = ? AND task_id = ? AND status = 'pending' AND request_fingerprint = ? ORDER BY rowid DESC LIMIT 1`,
        owner,
        task.id,
        fingerprint,
      );
      if (pending) {
        return { outcome: "reused_pending", decision: toDecision(pending, owner) };
      }
      // ---- 3. the human already approved this and the authority is still live ----
      if (actions.length === 1 && effectKind === "issue_action_grant") {
        const action = actions[0] as ActionRecord;
        const grant = liveActionGrantFor(owner, action.id, input.now, task.revision);
        if (grant) {
          const exec = one(
            "SELECT id FROM action_executions WHERE owner_id = ? AND action_grant_id = ? AND state = 'prepared'",
            owner,
            String(grant.id),
          );
          if (exec) {
            return {
              outcome: "already_approved",
              decision: getDecisionRecord(owner, String(grant.from_decision_id)) as DecisionRecord,
              executionId: String(exec.id),
              standingGrantId: null,
            };
          }
        }
      }
      if (actions.length === 1 && effectKind === "issue_standing_grant") {
        const action = actions[0] as ActionRecord;
        const standing = findStandingGrant(owner, action, input.now, task.revision);
        if (standing.grant) {
          return {
            outcome: "already_approved",
            decision: getDecisionRecord(
              owner,
              String(standing.grant.from_decision_id),
            ) as DecisionRecord,
            executionId: null,
            standingGrantId: String(standing.grant.id),
          };
        }
      }

      // ---- 4. create ----
      const currentStated = preferenceMutation
        ? one(
            "SELECT value_json, revision FROM preferences WHERE owner_id = ? AND scope = ? AND key = ? AND origin = 'stated' " +
              "AND deleted_at IS NULL AND purged_at IS NULL",
            owner,
            preferenceMutation.scope,
            preferenceMutation.key,
          )
        : undefined;
      const built = preferenceMutation
        ? buildPreferenceContent({
            task,
            mutation: preferenceMutation,
            current: currentStated
              ? {
                  value: parseJson(currentStated.value_json),
                  revision: Number(currentStated.revision),
                }
              : null,
          })
        : buildDecisionContent({
            task,
            effectKind,
            actions,
            describe: (action) => describeAction(action),
          });
      const content = input.notice
        ? {
            ...built,
            question: input.notice.question,
            facts: input.notice.facts,
            unknowns: input.notice.unknowns,
          }
        : built;
      const riskTier = input.notice || preferenceMutation ? "R0" : (actions[0]?.riskTier ?? "R1");
      const deadlineAt = input.now + DEFAULT_DECISION_DEADLINE_MS;
      const authorityHash = computeAuthorityHash({
        ownerId: owner,
        taskId: task.id,
        taskRevision: task.revision,
        decisionType,
        riskTier,
        requiredDecider: null,
        actions: actions.map((action) => ({ actionId: action.id, actionHash: action.actionHash })),
        effectKind,
        grantPolicy:
          effectKind === "issue_action_grant" || effectKind === "issue_standing_grant"
            ? content.policies
            : null,
        ...(preferenceMutation ? { preferenceMutation } : {}),
        deadlineAt,
        allowedOptionIds: OPTION_IDS,
      });
      const id = newId("D");
      run(
        "INSERT INTO decisions (id, owner_id, task_id, decision_type, risk_tier, question, facts_snapshot, options_snapshot, " +
          "unknowns_snapshot, grant_policy_snapshot, authority_hash, task_revision, required_decider, deadline_at, status, " +
          "core_approval_state, session_key, run_id, tool_call_id, request_fingerprint, effect_kind, effect_payload_canonical) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pending', 'not_attempted', ?, ?, ?, ?, ?, ?)",
        id,
        owner,
        task.id,
        decisionType,
        riskTier,
        content.question,
        canonicalJson(content.facts),
        canonicalJson(content.options),
        canonicalJson(content.unknowns),
        canonicalJson({
          policies:
            effectKind === "acknowledge" || effectKind === "set_preference" ? [] : content.policies,
        }),
        authorityHash,
        task.revision,
        deadlineAt,
        hasKey ? input.sessionKey : null,
        hasKey ? input.runId : null,
        hasKey ? input.toolCallId : null,
        fingerprint,
        effectKind,
        preferencePayload,
      );
      for (const action of actions) {
        run(
          "INSERT INTO decision_actions (owner_id, task_id, decision_id, action_id, decision_effect) VALUES (?, ?, ?, ?, ?)",
          owner,
          task.id,
          id,
          action.id,
          effectKind,
        );
      }
      const decision = getDecisionRecord(owner, id) as DecisionRecord;
      enqueueOutbox(
        owner,
        task.id,
        `decision_pending:${id}`,
        "decision_pending",
        pendingPayload(decision),
        id,
        input.now,
      );
      bindSession(owner, task.id, input.sessionKey, input.now);
      const refreshed = refreshTaskStatus(owner, task.id, input.now) as TaskRecord;
      return { outcome: "created", decision, task: refreshed };
    });
  };

  const pendingPayload = (decision: DecisionRecord) => ({
    decisionId: decision.id,
    taskId: decision.taskId,
    riskTier: decision.riskTier,
    effectKind: decision.effectKind,
    question: Array.from(decision.question).slice(0, 120).join(""),
  });

  const describeAction = (action: ActionRecord): string => {
    const spec = specFor(action.toolName);
    return spec
      ? spec.describe({
          params: action.params as Record<string, unknown>,
          amount: action.amount,
          currency: action.currency,
          merchant: action.merchant,
        })
      : action.toolName;
  };

  // ======================================================================================================
  // Standing policy matching (section 8.6)
  // ======================================================================================================
  const POLICY_MISMATCH = new Set(["tool_mismatch", "merchant_mismatch", "recipient_mismatch"]);

  const standingReason = (
    owner: string,
    grant: Row,
    action: ActionRecord,
    now: number,
    revision: number,
  ): string | null => {
    if (grant.revoked_at !== null) {
      return "revoked";
    }
    if (Number(grant.expires_at) <= now) {
      return "expired";
    }
    if (Number(grant.task_revision) !== revision) {
      return "task_revision_changed";
    }
    if (typeof grant.tool_name === "string" && grant.tool_name !== action.toolName) {
      return "tool_mismatch";
    }
    const merchant = (action.merchant ?? "").trim().toLowerCase();
    if (typeof grant.merchant === "string" && grant.merchant.trim().toLowerCase() !== merchant) {
      return "merchant_mismatch";
    }
    if (
      typeof grant.recipient_pattern === "string" &&
      !globMatches(grant.recipient_pattern, merchant)
    ) {
      return "recipient_mismatch";
    }
    const id = String(grant.id);
    if (grant.max_uses !== null) {
      const used = countOf(
        "SELECT COUNT(*) AS c FROM grant_uses WHERE owner_id = ? AND standing_grant_id = ?",
        owner,
        id,
      );
      if (used >= Number(grant.max_uses)) {
        return "max_uses_reached";
      }
    }
    if (grant.max_uses_per_day !== null) {
      const usedToday = countOf(
        "SELECT COUNT(*) AS c FROM grant_uses WHERE owner_id = ? AND standing_grant_id = ? AND used_at > ?",
        owner,
        id,
        now - DAY_MS,
      );
      if (usedToday >= Number(grant.max_uses_per_day)) {
        return "daily_limit_reached";
      }
    }
    return null;
  };

  const findStandingGrant = (
    owner: string,
    action: ActionRecord,
    now: number,
    revision: number,
  ): { grant?: Row; reason?: string; covered: boolean } => {
    const rows = all(
      "SELECT * FROM standing_grants WHERE owner_id = ? AND task_id = ? AND capability = ? ORDER BY created_at, id",
      owner,
      action.taskId,
      action.capability,
    );
    let firstReason: string | undefined;
    let covered = false;
    for (const row of rows) {
      const reason = standingReason(owner, row, action, now, revision);
      if (reason === null) {
        return { grant: row, covered: true };
      }
      if (!POLICY_MISMATCH.has(reason)) {
        covered = true;
        firstReason ??= reason;
      }
    }
    return { reason: firstReason, covered };
  };

  // ======================================================================================================
  // Resolve: the one function that applies a decision's effect (section 8.9 / 8.12 / 8.13)
  // ======================================================================================================
  const failStranded = (owner: string, grantIds: string[], code: string, now: number) => {
    if (grantIds.length === 0) {
      return;
    }
    run(
      `UPDATE action_executions SET state = 'failed', error_canonical = ?, completed_at = ? WHERE owner_id = ? AND state = 'prepared' AND action_grant_id IN (${grantIds.map(() => "?").join(",")})`,
      canonicalJson({ code }),
      now,
      owner,
      ...grantIds,
    );
  };

  /** Section 8.5 order: retire expired live rows, mark valid old rows, insert the new grant, pre-create the execution. */
  const issueActionGrant = (
    owner: string,
    decision: DecisionRecord,
    action: ActionRecord,
    task: TaskRecord,
    caps: ProviderCaps,
    now: number,
  ) => {
    const policy = decision.policies.find((entry) => entry.actionId === action.id);
    if (!policy || policy.kind !== "action_grant") {
      throw new Error("decision has no action_grant policy for the chosen action");
    }
    const liveWhere =
      "owner_id = ? AND action_id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND superseded_by IS NULL";
    const expiredIds = all(
      `SELECT id FROM action_grants WHERE ${liveWhere} AND expires_at <= ?`,
      owner,
      action.id,
      now,
    ).map((row) => String(row.id));
    run(
      `UPDATE action_grants SET revoked_at = ? WHERE ${liveWhere} AND expires_at <= ?`,
      now,
      owner,
      action.id,
      now,
    );
    const supersededIds = all(
      `SELECT id FROM action_grants WHERE ${liveWhere}`,
      owner,
      action.id,
    ).map((row) => String(row.id));
    const grantId = newId("G");
    run(`UPDATE action_grants SET superseded_by = ? WHERE ${liveWhere}`, grantId, owner, action.id);
    run(
      "INSERT INTO action_grants (id, owner_id, task_id, from_decision_id, capability, tool_name, action_id, action_hash, " +
        "currency, max_amount, allowed_variance_json, task_revision, nonce, created_at, expires_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)",
      grantId,
      owner,
      task.id,
      decision.id,
      action.capability,
      action.toolName,
      action.id,
      action.actionHash,
      policy.currency,
      policy.maxAmount,
      task.revision,
      randomBytes(12).toString("hex"),
      now,
      now + policy.ttlMs,
    );
    const executionId = newId("X");
    run(
      "INSERT INTO action_executions (id, owner_id, task_id, action_id, action_grant_id, standing_grant_id, " +
        "provider_idempotency_key, provider_idempotency_supported, state, attempts, prepared_at) " +
        "VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'prepared', 0, ?)",
      executionId,
      owner,
      task.id,
      action.id,
      grantId,
      `nxk_${randomBytes(16).toString("hex")}`,
      caps[action.toolName] === true ? 1 : 0,
      now,
    );
    failStranded(owner, expiredIds, "grant_expired", now);
    failStranded(owner, supersededIds, "grant_superseded", now);
    return { grantId, executionId };
  };

  const issueStandingGrant = (
    owner: string,
    decision: DecisionRecord,
    action: ActionRecord,
    task: TaskRecord,
    now: number,
  ) => {
    const policy = decision.policies.find((entry) => entry.actionId === action.id);
    if (!policy || policy.kind !== "standing_grant") {
      throw new Error("decision has no standing_grant policy for the chosen action");
    }
    const id = newId("SG");
    run(
      "INSERT INTO standing_grants (id, owner_id, task_id, from_decision_id, source_action_id, capability, tool_name, merchant, " +
        "recipient_pattern, max_uses, max_uses_per_day, task_revision, created_at, expires_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)",
      id,
      owner,
      task.id,
      decision.id,
      action.id,
      policy.capability,
      policy.toolName,
      policy.merchant,
      policy.maxUses,
      policy.maxUsesPerDay,
      task.revision,
      now,
      now + policy.ttlMs,
    );
    return id;
  };

  const supersede = (owner: string, row: Row, reason: string, now: number) => {
    run(
      "UPDATE decisions SET status = 'superseded', resolved_at = ? WHERE owner_id = ? AND task_id = ? AND id = ? AND status = 'pending'",
      now,
      owner,
      String(row.task_id),
      String(row.id),
    );
    const task = refreshTaskStatus(owner, String(row.task_id), now);
    enqueueOutbox(
      owner,
      String(row.task_id),
      `decision_resolved:${String(row.id)}`,
      "decision_resolved",
      { decisionId: String(row.id), taskId: String(row.task_id), status: "superseded", reason },
      String(row.id),
      now,
    );
    return task;
  };

  const resolveInTx = (input: ResolveInput): ResolveOutcome => {
    const owner = input.principal.ownerId;
    const row = decisionRow(owner, input.decisionId);
    if (!row) {
      return { outcome: "not_found" };
    }
    const decision = toDecision(row, owner);
    if (row.status !== "pending") {
      return { outcome: "already_resolved", decision };
    }
    const taskId = String(row.task_id);
    const deadline = num(row.deadline_at);
    if (deadline !== null && deadline <= input.now) {
      run(
        "UPDATE decisions SET status = 'expired', resolution = 'timed_out', resolved_at = ? WHERE owner_id = ? AND task_id = ? AND id = ? AND status = 'pending'",
        input.now,
        owner,
        taskId,
        decision.id,
      );
      const task = refreshTaskStatus(owner, taskId, input.now);
      enqueueOutbox(
        owner,
        taskId,
        `decision_resolved:${decision.id}`,
        "decision_resolved",
        { decisionId: decision.id, taskId, status: "expired" },
        decision.id,
        input.now,
      );
      return {
        outcome: "expired",
        decision: getDecisionRecord(owner, decision.id) as DecisionRecord,
        task,
      };
    }
    const task = liveTask(owner, taskId);
    const check = recomputeAuthorityHash(owner, row);
    if (!task || isClosed(task.status) || check.reason || check.hash !== row.authority_hash) {
      const reason = !task
        ? "task_gone"
        : isClosed(task.status)
          ? "task_closed"
          : (check.reason ?? "authority_changed");
      const refreshed = supersede(owner, row, reason, input.now);
      return {
        outcome: "superseded",
        decision: getDecisionRecord(owner, decision.id) as DecisionRecord,
        reason,
        task: refreshed,
      };
    }

    const effect = decision.effectKind;
    let chosen: string | null = null;
    if (input.resolution === "approved") {
      if (effect === "issue_action_grant" || effect === "issue_standing_grant") {
        chosen =
          input.chosenActionId ??
          (decision.actionIds.length === 1 ? (decision.actionIds[0] as string) : null);
        if (!chosen) {
          return { outcome: "choice_required", decision };
        }
        if (!decision.actionIds.includes(chosen)) {
          return { outcome: "invalid_choice", decision };
        }
      }
    }

    const changes = run(
      "UPDATE decisions SET status = 'decided', resolution = ?, resolution_source = ?, resolved_by = ?, resolved_at = ?, " +
        "approval_ref = ?, chosen_action_id = ? WHERE owner_id = ? AND task_id = ? AND id = ? AND status = 'pending'",
      input.resolution,
      input.source,
      input.resolvedBy,
      input.now,
      input.approvalRef ?? null,
      chosen,
      owner,
      taskId,
      decision.id,
    );
    if (changes === 0) {
      return {
        outcome: "already_resolved",
        decision: getDecisionRecord(owner, decision.id) as DecisionRecord,
      };
    }

    let executionId: string | null = null;
    let actionGrantId: string | null = null;
    let standingGrantId: string | null = null;
    if (input.resolution === "approved") {
      const decided = getDecisionRecord(owner, decision.id) as DecisionRecord;
      if (effect === "issue_action_grant") {
        const action = toAction(actionRow(owner, chosen as string) as Row);
        const issued = issueActionGrant(
          owner,
          decided,
          action,
          task,
          input.providerCaps,
          input.now,
        );
        executionId = issued.executionId;
        actionGrantId = issued.grantId;
      } else if (effect === "issue_standing_grant") {
        const action = toAction(actionRow(owner, chosen as string) as Row);
        standingGrantId = issueStandingGrant(owner, decided, action, task, input.now);
      } else if (effect === "set_preference") {
        // Writes preferences + preference_revisions in THIS transaction and nothing else: no grant, no execution (section 8.12).
        const payload = str(row.effect_payload_canonical);
        const applied =
          payload !== null && options.applyPreferenceInTx
            ? options.applyPreferenceInTx(owner, payload, decision.id, input.now)
            : ({ ok: false, reason: "preference_store_unavailable" } as const);
        if (!applied.ok) {
          // Throwing rolls the whole resolve back: the decision stays pending instead of half applied.
          throw new Error(`preference_apply_failed:${applied.reason}`);
        }
      }
      // acknowledge: nothing beyond the decision row itself.
    }
    const refreshed = refreshTaskStatus(owner, taskId, input.now);
    const final = getDecisionRecord(owner, decision.id) as DecisionRecord;
    addStep(
      owner,
      taskId,
      "decision",
      "done",
      `Decision ${input.resolution === "approved" ? "approved" : "rejected"}: ${final.question}`,
      { decisionId: final.id, resolution: input.resolution, source: input.source, executionId },
      input.now,
    );
    enqueueOutbox(
      owner,
      taskId,
      `decision_resolved:${final.id}`,
      "decision_resolved",
      {
        decisionId: final.id,
        taskId,
        status: "decided",
        resolution: input.resolution,
        executionId,
        standingGrantId,
      },
      final.id,
      input.now,
    );
    if (executionId) {
      enqueueOutbox(
        owner,
        taskId,
        `execution_ready:${executionId}`,
        "execution_ready",
        { decisionId: final.id, taskId, executionId },
        final.id,
        input.now,
      );
    }
    return input.resolution === "approved"
      ? {
          outcome: "approved",
          decision: final,
          executionId,
          actionGrantId,
          standingGrantId,
          task: refreshed,
        }
      : { outcome: "denied", decision: final, task: refreshed };
  };

  const markEffectApplyFailed = (input: ResolveInput, message: string): ResolveOutcome => {
    const owner = input.principal.ownerId;
    try {
      return transaction((): ResolveOutcome => {
        const row = decisionRow(owner, input.decisionId);
        if (!row) {
          return { outcome: "effect_apply_failed", decision: null, message };
        }
        const changes = run(
          "UPDATE decisions SET status = 'effect_apply_failed', resolution = 'approved', resolution_source = ?, resolved_by = ?, resolved_at = ? " +
            "WHERE owner_id = ? AND task_id = ? AND id = ? AND status = 'pending'",
          input.source,
          input.resolvedBy,
          input.now,
          owner,
          String(row.task_id),
          String(row.id),
        );
        if (changes > 0) {
          refreshTaskStatus(owner, String(row.task_id), input.now);
          enqueueOutbox(
            owner,
            String(row.task_id),
            `decision_resolved:${String(row.id)}`,
            "decision_resolved",
            {
              decisionId: String(row.id),
              taskId: String(row.task_id),
              status: "effect_apply_failed",
            },
            String(row.id),
            input.now,
          );
        }
        return { outcome: "effect_apply_failed", decision: toDecision(row, owner), message };
      });
    } catch {
      // Best effort (section 8.9): if the database itself cannot be written, this state cannot be written either.
      return { outcome: "effect_apply_failed", decision: null, message };
    }
  };

  const resolveDecision = (input: ResolveInput): ResolveOutcome => {
    try {
      return transaction(() => resolveInTx(input));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (input.source === "core_approval" && input.resolution === "approved") {
        return markEffectApplyFailed(input, message);
      }
      throw error;
    }
  };

  // ---- core approval attempt (section 8.8.3): a lease, never a terminal state ----
  const claimCoreApproval = (input: {
    principal: Principal;
    decisionId: string;
    approvalTimeoutMs: number;
    workerId: string;
    now: number;
  }): { attemptId: string } | null =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = decisionRow(owner, input.decisionId);
      if (!row) {
        return null;
      }
      const leaseMs = input.approvalTimeoutMs + 60_000;
      const attemptId = newId("CA");
      const changes = run(
        "UPDATE decisions SET core_approval_state = 'attempted', core_approval_attempt_at = ?, core_approval_attempt_by = ?, " +
          "core_approval_attempt_id = ? WHERE owner_id = ? AND task_id = ? AND id = ? AND status = 'pending' " +
          "AND (deadline_at IS NULL OR deadline_at > ?) " +
          "AND (core_approval_state = 'not_attempted' OR (core_approval_state = 'attempted' AND core_approval_attempt_at < ? - ?))",
        input.now,
        input.workerId,
        attemptId,
        owner,
        String(row.task_id),
        String(row.id),
        input.now,
        input.now,
        leaseMs,
      );
      return changes > 0 ? { attemptId } : null;
    });

  /**
   * A card click that arrives after the decision was already settled elsewhere (decision page / RPC / expiry).
   * First-writer-wins still holds for the decision itself; two safety rules sit on top:
   *  - a late Deny on an APPROVED decision withdraws what has not been used yet: prepared executions and their
   *    unconsumed action grants, or a standing grant that has no recorded use. Anything already started stays.
   *  - a late Allow never upgrades anything.
   * Either way the click is written to the task steps so the audit trail shows what the user actually did.
   */
  const recordLateCardClick = (
    owner: string,
    decision: DecisionRecord,
    value: string,
    now: number,
  ) => {
    const revokedExecutionIds: string[] = [];
    let startedKept = false;
    const withdrawable =
      value === "deny" && decision.status === "decided" && decision.resolution === "approved";
    if (withdrawable && decision.effectKind === "issue_action_grant") {
      const grants = all(
        "SELECT id FROM action_grants WHERE owner_id = ? AND from_decision_id = ? AND revoked_at IS NULL AND superseded_by IS NULL",
        owner,
        decision.id,
      );
      for (const grant of grants) {
        const live = one(
          "SELECT id FROM action_grants WHERE owner_id = ? AND id = ? AND consumed_at IS NULL",
          owner,
          String(grant.id),
        );
        const prepared = live
          ? all(
              "SELECT id FROM action_executions WHERE owner_id = ? AND action_grant_id = ? AND state = 'prepared'",
              owner,
              String(grant.id),
            )
          : [];
        if (live && prepared.length > 0) {
          run(
            "UPDATE action_grants SET revoked_at = ? WHERE owner_id = ? AND id = ? AND revoked_at IS NULL",
            now,
            owner,
            String(grant.id),
          );
          failStranded(owner, [String(grant.id)], "late_deny_revoked", now);
          revokedExecutionIds.push(...prepared.map((row) => String(row.id)));
        } else {
          startedKept = true;
        }
      }
    } else if (withdrawable && decision.effectKind === "issue_standing_grant") {
      const grants = all(
        "SELECT id FROM standing_grants WHERE owner_id = ? AND from_decision_id = ? AND revoked_at IS NULL",
        owner,
        decision.id,
      );
      for (const grant of grants) {
        const uses = countOf(
          "SELECT COUNT(*) AS c FROM grant_uses WHERE owner_id = ? AND standing_grant_id = ?",
          owner,
          String(grant.id),
        );
        if (uses > 0) {
          startedKept = true;
          continue;
        }
        const prepared = all(
          "SELECT id FROM action_executions WHERE owner_id = ? AND standing_grant_id = ? AND state = 'prepared'",
          owner,
          String(grant.id),
        );
        run(
          "UPDATE standing_grants SET revoked_at = ? WHERE owner_id = ? AND id = ? AND revoked_at IS NULL",
          now,
          owner,
          String(grant.id),
        );
        run(
          "UPDATE action_executions SET state = 'failed', error_canonical = ?, completed_at = ? WHERE owner_id = ? AND standing_grant_id = ? AND state = 'prepared'",
          canonicalJson({ code: "late_deny_revoked" }),
          now,
          owner,
          String(grant.id),
        );
        revokedExecutionIds.push(...prepared.map((row) => String(row.id)));
      }
    }
    const resolution = decision.resolution ?? decision.status;
    const title =
      revokedExecutionIds.length > 0
        ? `Late card rejection: already approved; revoked unused credentials (${revokedExecutionIds.join(", ")})`
        : withdrawable
          ? "Late card rejection: already approved, execution started; recorded only"
          : `Late card click (${value}) ignored: decision is already ${resolution}`;
    addStep(
      owner,
      decision.taskId,
      "decision",
      "done",
      title,
      {
        decisionId: decision.id,
        click: value,
        decisionResolution: resolution,
        revokedExecutionIds,
        ...(startedKept ? { alreadyStarted: true } : {}),
      },
      now,
    );
    for (const executionId of revokedExecutionIds) {
      enqueueOutbox(
        owner,
        decision.taskId,
        `execution_settled:${executionId}:failed`,
        "execution_settled",
        { executionId, taskId: decision.taskId, state: "failed" },
        null,
        now,
      );
    }
    const task =
      revokedExecutionIds.length > 0 ? refreshTaskStatus(owner, decision.taskId, now) : null;
    return { revokedExecutionIds, task };
  };

  const recordApprovalResolution = (input: {
    principal: Principal;
    decisionId: string;
    attemptId: string;
    value: string;
    providerCaps: ProviderCaps;
    now: number;
  }):
    | { outcome: "stale_attempt" }
    | { outcome: "ignored"; coreApprovalState: string }
    | { outcome: "noted"; coreApprovalState: CoreApprovalState; value: string }
    | {
        outcome: "resolved";
        result: ResolveOutcome;
        late?: { revokedExecutionIds: string[]; task: TaskRecord | null };
      } => {
    const owner = input.principal.ownerId;
    const gate = transaction(() => {
      const row = decisionRow(owner, input.decisionId);
      if (!row || row.core_approval_attempt_id !== input.attemptId) {
        return { kind: "stale" as const };
      }
      if (row.core_approval_state !== "attempted") {
        return { kind: "ignored" as const, state: String(row.core_approval_state) };
      }
      return { kind: "ok" as const, taskId: String(row.task_id) };
    });
    if (gate.kind === "stale") {
      return { outcome: "stale_attempt" };
    }
    if (gate.kind === "ignored") {
      return { outcome: "ignored", coreApprovalState: gate.state };
    }
    const setState = (state: CoreApprovalState) =>
      run(
        "UPDATE decisions SET core_approval_state = ? WHERE owner_id = ? AND task_id = ? AND id = ? AND core_approval_attempt_id = ? AND core_approval_state = 'attempted'",
        state,
        owner,
        gate.taskId,
        input.decisionId,
        input.attemptId,
      );
    if (input.value === "allow-once" || input.value === "deny") {
      const resolveInput: ResolveInput = {
        principal: input.principal,
        decisionId: input.decisionId,
        resolution: input.value === "deny" ? "denied" : "approved",
        source: "core_approval",
        resolvedBy: CORE_APPROVER,
        providerCaps: input.providerCaps,
        now: input.now,
      };
      let result: ResolveOutcome;
      let late: { revokedExecutionIds: string[]; task: TaskRecord | null } | undefined;
      try {
        // Same function as the RPC path, plus the card state, in one transaction.
        result = transaction(() => {
          const inner = resolveInTx(resolveInput);
          setState("resolved");
          if (inner.outcome === "already_resolved") {
            late = recordLateCardClick(owner, inner.decision, input.value, input.now);
          }
          return inner;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = markEffectApplyFailed(resolveInput, message);
        try {
          transaction(() => setState("resolved"));
        } catch {
          // best effort
        }
      }
      return late ? { outcome: "resolved", result, late } : { outcome: "resolved", result };
    }
    // timeout / cancelled / anything else (including an unexpected allow-always): the decision stays pending.
    const state: CoreApprovalState = input.value === "timeout" ? "timed_out" : "cancelled";
    transaction(() => setState(state));
    return { outcome: "noted", coreApprovalState: state, value: input.value };
  };

  const findDecisionForToolCall = (input: {
    principal: Principal;
    sessionKey: string;
    toolCallId: string;
  }): DecisionRecord | null => {
    const row = one(
      `SELECT ${DECISION_COLUMNS} FROM decisions WHERE owner_id = ? AND session_key = ? AND tool_call_id = ? ORDER BY rowid DESC LIMIT 1`,
      input.principal.ownerId,
      input.sessionKey,
      input.toolCallId,
    );
    return row ? toDecision(row, input.principal.ownerId) : null;
  };

  const getDecision = (input: {
    principal: Principal;
    decisionId: string;
  }): {
    decision: DecisionRecord;
    actions: ActionRecord[];
    executions: ExecutionRecord[];
  } | null => {
    const owner = input.principal.ownerId;
    const decision = getDecisionRecord(owner, input.decisionId);
    if (!decision) {
      return null;
    }
    const actions = decision.actionIds.map((id) => toAction(actionRow(owner, id) as Row));
    const executions = all(
      `SELECT ${EXECUTION_COLUMNS.split(", ")
        .map((c) => `e.${c}`)
        .join(", ")} FROM action_executions e ` +
        "JOIN action_grants g ON g.id = e.action_grant_id WHERE e.owner_id = ? AND g.from_decision_id = ? ORDER BY e.prepared_at",
      owner,
      decision.id,
    ).map(toExecution);
    return { decision, actions, executions };
  };

  const listDecisions = (input: {
    principal: Principal;
    taskId?: string;
    statuses?: string[];
    openTasksOnly?: boolean;
    limit: number;
  }): DecisionRecord[] => {
    const owner = input.principal.ownerId;
    const where = ["d.owner_id = ?"];
    const params: (string | number)[] = [owner];
    if (input.taskId) {
      where.push("d.task_id = ?");
      params.push(input.taskId);
    }
    if (input.statuses && input.statuses.length > 0) {
      where.push(`d.status IN (${input.statuses.map(() => "?").join(",")})`);
      params.push(...input.statuses);
    }
    if (input.openTasksOnly !== false) {
      where.push(
        "t.deleted_at IS NULL AND t.status NOT IN ('succeeded','failed','cancelled','deleted','purging')",
      );
    }
    params.push(input.limit);
    return all(
      `SELECT ${DECISION_COLUMNS.split(", ")
        .map((c) => `d.${c}`)
        .join(", ")} FROM decisions d ` +
        `JOIN nexus_tasks t ON t.owner_id = d.owner_id AND t.id = d.task_id WHERE ${where.join(" AND ")} ORDER BY d.rowid DESC LIMIT ?`,
      ...params,
    ).map((row) => toDecision(row, owner));
  };

  const expireDueDecisions = (input: { principal: Principal; now: number }): DecisionRecord[] =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const due = all(
        `SELECT ${DECISION_COLUMNS} FROM decisions WHERE owner_id = ? AND status = 'pending' AND deadline_at IS NOT NULL AND deadline_at <= ?`,
        owner,
        input.now,
      );
      const out: DecisionRecord[] = [];
      for (const row of due) {
        run(
          "UPDATE decisions SET status = 'expired', resolution = 'timed_out', resolved_at = ? WHERE owner_id = ? AND task_id = ? AND id = ? AND status = 'pending'",
          input.now,
          owner,
          String(row.task_id),
          String(row.id),
        );
        refreshTaskStatus(owner, String(row.task_id), input.now);
        enqueueOutbox(
          owner,
          String(row.task_id),
          `decision_resolved:${String(row.id)}`,
          "decision_resolved",
          { decisionId: String(row.id), taskId: String(row.task_id), status: "expired" },
          String(row.id),
          input.now,
        );
        out.push(getDecisionRecord(owner, String(row.id)) as DecisionRecord);
      }
      return out;
    });

  // ======================================================================================================
  // run_triggers (section 8.8.1): the prompt phase's trigger, carried to the tool phase. Fails closed.
  // ======================================================================================================
  const recordRunTrigger = (input: {
    principal: Principal;
    runId: string;
    sessionKey: string;
    trigger: string;
    jobId?: string;
    watchId?: string;
    ttlMs: number;
    now: number;
  }): { outcome: "recorded" | "existing" | "conflict" } =>
    transaction(() => {
      const owner = input.principal.ownerId;
      run(
        "INSERT INTO run_triggers (run_id, owner_id, trigger, session_key, job_id, watch_id, recorded_at, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner_id, run_id) DO NOTHING",
        input.runId,
        owner,
        input.trigger,
        input.sessionKey,
        input.jobId ?? null,
        input.watchId ?? null,
        input.now,
        input.now + input.ttlMs,
      );
      const stored = one(
        "SELECT * FROM run_triggers WHERE owner_id = ? AND run_id = ?",
        owner,
        input.runId,
      ) as Row;
      const same =
        stored.trigger === input.trigger &&
        stored.session_key === input.sessionKey &&
        (stored.job_id ?? null) === (input.jobId ?? null) &&
        (stored.watch_id ?? null) === (input.watchId ?? null);
      if (!same) {
        return { outcome: "conflict" as const };
      }
      return {
        outcome:
          Number(stored.recorded_at) === input.now ? ("recorded" as const) : ("existing" as const),
      };
    });

  const readRunTrigger = (input: {
    principal: Principal;
    runId: string;
    sessionKey: string;
    now: number;
  }): RunTriggerRecord | null => {
    const row = one(
      "SELECT * FROM run_triggers WHERE run_id = ? AND owner_id = ? AND session_key = ? AND expires_at > ?",
      input.runId,
      input.principal.ownerId,
      input.sessionKey,
      input.now,
    );
    return row
      ? {
          runId: String(row.run_id),
          trigger: String(row.trigger),
          sessionKey: String(row.session_key),
          jobId: str(row.job_id),
          watchId: str(row.watch_id),
          recordedAt: Number(row.recorded_at),
          expiresAt: Number(row.expires_at),
        }
      : null;
  };

  const purgeRunTriggers = (input: { principal: Principal; now: number }): number =>
    run(
      "DELETE FROM run_triggers WHERE owner_id = ? AND expires_at <= ?",
      input.principal.ownerId,
      input.now,
    );

  // ======================================================================================================
  // R1: nexus_action_authorize signs an execution under a standing policy (section 8.6)
  // ======================================================================================================
  const insertStandingExecution = (
    owner: string,
    action: ActionRecord,
    standingGrantId: string,
    caps: ProviderCaps,
    now: number,
  ): string => {
    const id = newId("X");
    run(
      "INSERT INTO action_executions (id, owner_id, task_id, action_id, action_grant_id, standing_grant_id, " +
        "provider_idempotency_key, provider_idempotency_supported, state, attempts, prepared_at) " +
        "VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'prepared', 0, ?)",
      id,
      owner,
      action.taskId,
      action.id,
      standingGrantId,
      `nxk_${randomBytes(16).toString("hex")}`,
      caps[action.toolName] === true ? 1 : 0,
      now,
    );
    return id;
  };

  const executionRow = (owner: string, executionId: string): Row | undefined =>
    one(
      `SELECT ${EXECUTION_COLUMNS} FROM action_executions WHERE owner_id = ? AND id = ?`,
      owner,
      executionId,
    );

  const authorizeAction = (input: {
    principal: Principal;
    actionId: string;
    providerCaps: ProviderCaps;
    sessionKey: string | null;
    now: number;
  }): AuthorizeOutcome =>
    transaction((): AuthorizeOutcome => {
      const owner = input.principal.ownerId;
      const arow = actionRow(owner, input.actionId);
      if (!arow) {
        return { outcome: "not_found" };
      }
      const action = toAction(arow);
      const task = liveTask(owner, action.taskId);
      if (!task) {
        return { outcome: "not_found" };
      }
      if (isClosed(task.status)) {
        return { outcome: "task_closed", task };
      }
      if (action.riskTier !== "R1") {
        return { outcome: "not_r1", tier: action.riskTier };
      }
      const executions = all(
        `SELECT ${EXECUTION_COLUMNS} FROM action_executions WHERE owner_id = ? AND action_id = ? ORDER BY prepared_at DESC, rowid DESC`,
        owner,
        action.id,
      ).map(toExecution);
      const busy = executions.find(
        (entry) => entry.state === "executing" || entry.state === "unknown",
      );
      if (busy) {
        return { outcome: "in_progress", execution: busy };
      }
      const done = executions.find(
        (entry) => entry.state === "succeeded" || entry.state === "failed",
      );
      if (done) {
        return { outcome: "already_done", execution: done };
      }
      const found = findStandingGrant(owner, action, input.now, task.revision);
      if (!found.grant) {
        return found.covered && found.reason
          ? { outcome: "policy_not_applicable", reason: found.reason }
          : { outcome: "no_policy" };
      }
      const grantId = String(found.grant.id);
      const prepared = executions.find((entry) => entry.state === "prepared");
      bindSession(owner, task.id, input.sessionKey, input.now);
      if (prepared && prepared.standingGrantId === grantId) {
        return {
          outcome: "authorized",
          executionId: prepared.id,
          reentry: true,
          execution: prepared,
        };
      }
      if (prepared) {
        // A prepared execution bound to a different (now unusable or replaced) policy: retire it, sign a fresh one.
        run(
          "UPDATE action_executions SET state = 'failed', error_canonical = ?, completed_at = ? WHERE owner_id = ? AND id = ? AND state = 'prepared'",
          canonicalJson({ code: "policy_replaced" }),
          input.now,
          owner,
          prepared.id,
        );
      }
      const executionId = insertStandingExecution(
        owner,
        action,
        grantId,
        input.providerCaps,
        input.now,
      );
      return {
        outcome: "authorized",
        executionId,
        reentry: false,
        execution: toExecution(executionRow(owner, executionId) as Row),
      };
    });

  // ======================================================================================================
  // Admission and settlement: the two synchronous halves around the external call (section 8.2 / 8.4)
  // ======================================================================================================
  const admitAction = (action: ActionRecord): AdmitAction => ({
    toolName: action.toolName,
    capability: action.capability,
    merchant: action.merchant,
    amount: action.amount,
    currency: action.currency,
    params: action.params,
    paramsCanonical: action.paramsCanonical,
  });

  const cents = (value: string): number => Math.round(Number(value) * 100);

  const admitExecution = (input: {
    principal: Principal;
    executionId: string;
    staleExecutingMs: number;
    now: number;
  }): AdmitOutcome =>
    transaction((): AdmitOutcome => {
      const owner = input.principal.ownerId;
      const erow = executionRow(owner, input.executionId);
      if (!erow) {
        return {
          kind: "rejected",
          reason: "execution_not_found",
          message: "executionId not found.",
          execution: null,
        };
      }
      const execution = toExecution(erow);
      switch (execution.state) {
        case "succeeded":
          return { kind: "replay_succeeded", execution };
        case "failed":
          return { kind: "replay_failed", execution };
        case "unknown": {
          run(
            "UPDATE action_executions SET next_reconcile_at = COALESCE(next_reconcile_at, ?) WHERE owner_id = ? AND id = ?",
            input.now + RECONCILE_DELAY_MS,
            owner,
            execution.id,
          );
          return {
            kind: "reconcile_only",
            execution: toExecution(executionRow(owner, execution.id) as Row),
            reason: "unknown",
          };
        }
        case "executing": {
          const stale = input.now - (execution.startedAt ?? 0) >= input.staleExecutingMs;
          if (!stale) {
            return { kind: "reconcile_only", execution, reason: "in_flight" };
          }
          if (execution.providerIdempotencySupported) {
            // Same key, same provider: a retry cannot duplicate the effect. CAS on started_at so only one retrier wins.
            const changes = run(
              "UPDATE action_executions SET attempts = attempts + 1, started_at = ? WHERE owner_id = ? AND id = ? AND state = 'executing' AND started_at = ?",
              input.now,
              owner,
              execution.id,
              execution.startedAt,
            );
            if (changes === 0) {
              return { kind: "reconcile_only", execution, reason: "in_flight" };
            }
            const action = toAction(actionRow(owner, execution.actionId) as Row);
            return {
              kind: "retry_provider_idempotently",
              execution: toExecution(executionRow(owner, execution.id) as Row),
              action: admitAction(action),
              task: liveTask(owner, execution.taskId) ?? null,
            };
          }
          run(
            "UPDATE action_executions SET next_reconcile_at = COALESCE(next_reconcile_at, ?) WHERE owner_id = ? AND id = ?",
            input.now + RECONCILE_DELAY_MS,
            owner,
            execution.id,
          );
          return {
            kind: "reconcile_only",
            execution: toExecution(executionRow(owner, execution.id) as Row),
            reason: "stale_executing",
          };
        }
        case "prepared":
          break;
      }

      const reject = (reason: string, message: string, permanent: boolean): AdmitOutcome => {
        if (permanent) {
          run(
            "UPDATE action_executions SET state = 'failed', error_canonical = ?, completed_at = ? WHERE owner_id = ? AND id = ? AND state = 'prepared'",
            canonicalJson({ code: "admission_rejected", reason }),
            input.now,
            owner,
            execution.id,
          );
        }
        return {
          kind: "rejected",
          reason,
          message,
          execution: toExecution(executionRow(owner, execution.id) as Row),
        };
      };

      const arow = actionRow(owner, execution.actionId);
      const task = liveTask(owner, execution.taskId);
      if (!arow || !task || isClosed(task.status)) {
        return reject(
          "task_closed",
          "The Task has ended or does not exist; it cannot be executed.",
          true,
        );
      }
      const action = toAction(arow);
      if (canonicalJson(JSON.parse(action.paramsCanonical)) !== action.paramsCanonical) {
        return reject(
          "action_tampered",
          "The action parameters differ from what was registered; refusing to execute.",
          true,
        );
      }

      if (execution.actionGrantId) {
        const grant = one(
          "SELECT * FROM action_grants WHERE owner_id = ? AND id = ?",
          owner,
          execution.actionGrantId,
        );
        if (!grant) {
          return reject(
            "grant_missing",
            "The authorization for this execution was not found.",
            true,
          );
        }
        if (
          grant.max_amount !== null &&
          action.amount !== null &&
          cents(action.amount) > cents(asText(grant.max_amount))
        ) {
          return reject("amount_exceeds_grant", "The amount exceeds the authorized limit.", true);
        }
        if (grant.currency !== null && grant.currency !== action.currency) {
          return reject(
            "currency_mismatch",
            "The currency does not match the authorization.",
            true,
          );
        }
        const changes = run(
          "UPDATE action_grants SET consumed_at = ?, consumed_by_execution = ? WHERE id = (" +
            "SELECT g.id FROM action_grants g JOIN action_executions e ON e.action_grant_id = g.id " +
            "WHERE e.id = ? AND e.owner_id = ? AND e.state = 'prepared' AND g.consumed_at IS NULL AND g.revoked_at IS NULL " +
            "AND g.superseded_by IS NULL AND g.expires_at > ? " +
            "AND g.action_hash = (SELECT action_hash FROM actions WHERE id = e.action_id) " +
            "AND g.task_revision = (SELECT revision FROM nexus_tasks WHERE id = g.task_id) " +
            "ORDER BY g.created_at, g.id LIMIT 1) AND consumed_at IS NULL",
          input.now,
          execution.id,
          execution.id,
          owner,
          input.now,
        );
        if (changes === 0) {
          const why =
            grant.consumed_at !== null
              ? "grant_consumed"
              : grant.revoked_at !== null
                ? "grant_revoked"
                : grant.superseded_by !== null
                  ? "grant_superseded"
                  : Number(grant.expires_at) <= input.now
                    ? "grant_expired"
                    : Number(grant.task_revision) !== task.revision
                      ? "task_revision_changed"
                      : grant.action_hash !== action.actionHash
                        ? "action_changed"
                        : "grant_invalid";
          return reject(
            why,
            `The authorization is not usable (${why}); approval must be obtained again.`,
            true,
          );
        }
      } else if (execution.standingGrantId) {
        const grant = one(
          "SELECT * FROM standing_grants WHERE owner_id = ? AND id = ?",
          owner,
          execution.standingGrantId,
        );
        if (!grant) {
          return reject(
            "grant_missing",
            "The authorization policy for this execution was not found.",
            true,
          );
        }
        const reason = standingReason(owner, grant, action, input.now, task.revision);
        if (reason) {
          return reject(
            reason,
            `The authorization policy does not allow this execution (${reason}).`,
            reason !== "daily_limit_reached",
          );
        }
        run(
          "INSERT INTO grant_uses (id, owner_id, task_id, standing_grant_id, execution_id, used_at) VALUES (?, ?, ?, ?, ?, ?)",
          newId("U"),
          owner,
          task.id,
          String(grant.id),
          execution.id,
          input.now,
        );
      } else {
        return reject("grant_missing", "This execution is not bound to an authorization.", true);
      }
      const moved = run(
        "UPDATE action_executions SET state = 'executing', started_at = ?, attempts = attempts + 1 WHERE owner_id = ? AND id = ? AND state = 'prepared'",
        input.now,
        owner,
        execution.id,
      );
      if (moved !== 1) {
        throw new Error("admission lost the execution row");
      }
      const refreshed = refreshTaskStatus(owner, task.id, input.now);
      return {
        kind: "execute_new",
        execution: toExecution(executionRow(owner, execution.id) as Row),
        action: admitAction(action),
        task: refreshed,
      };
    });

  const settleExecution = (input: {
    principal: Principal;
    executionId: string;
    outcome: SettleOutcomeInput;
    from?: ExecutionState[];
    /** Stage 3: also write the execution-result claim + its evidence in this transaction (never fails the settle). */
    recordClaim?: boolean;
    /** An operator closed this execution by hand (`nexus.execution.resolve`): who and why go into the step log. */
    operatorResolution?: { actor: string; note: string };
    now: number;
  }):
    | { outcome: "settled"; execution: ExecutionRecord; task: TaskRecord | null }
    | { outcome: "already_settled"; execution: ExecutionRecord }
    | { outcome: "not_found" } =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const erow = executionRow(owner, input.executionId);
      if (!erow) {
        return { outcome: "not_found" as const };
      }
      const from = input.from ?? ["executing"];
      const outcome = input.outcome;
      const state: ExecutionState =
        outcome.kind === "succeeded"
          ? "succeeded"
          : outcome.kind === "failed"
            ? "failed"
            : "unknown";
      const resultCanonical = outcome.kind === "succeeded" ? canonicalJson(outcome.result) : null;
      const errorCanonical = outcome.kind === "succeeded" ? null : canonicalJson(outcome.error);
      const changes = run(
        `UPDATE action_executions SET state = ?, provider_operation_id = COALESCE(?, provider_operation_id), result_canonical = ?, ` +
          `result_hash = ?, error_canonical = ?, next_reconcile_at = ?, completed_at = ? ` +
          `WHERE owner_id = ? AND id = ? AND state IN (${from.map(() => "?").join(",")})`,
        state,
        outcome.kind === "succeeded" ? (outcome.providerOperationId ?? null) : null,
        resultCanonical,
        resultCanonical === null ? null : sha256Hex(resultCanonical),
        errorCanonical,
        state === "unknown" ? input.now + RECONCILE_DELAY_MS : null,
        state === "unknown" ? null : input.now,
        owner,
        input.executionId,
        ...from,
      );
      const execution = toExecution(executionRow(owner, input.executionId) as Row);
      if (changes === 0) {
        return { outcome: "already_settled" as const, execution };
      }
      const task = refreshTaskStatus(owner, execution.taskId, input.now);
      addStep(
        owner,
        execution.taskId,
        "execution",
        state === "succeeded" ? "done" : state === "failed" ? "failed" : "unknown",
        input.operatorResolution
          ? `Operator resolved as ${state === "succeeded" ? "succeeded" : "failed"} (${execution.id})`
          : `Execution ${state === "succeeded" ? "succeeded" : state === "failed" ? "failed" : "outcome unconfirmed"} (${execution.id})`,
        {
          executionId: execution.id,
          actionId: execution.actionId,
          state,
          ...(input.operatorResolution
            ? {
                resolvedBy: input.operatorResolution.actor,
                note: Array.from(input.operatorResolution.note).slice(0, 500).join(""),
              }
            : {}),
        },
        input.now,
      );
      enqueueOutbox(
        owner,
        execution.taskId,
        `execution_settled:${execution.id}:${state}`,
        "execution_settled",
        { executionId: execution.id, taskId: execution.taskId, state },
        null,
        input.now,
      );
      if (input.recordClaim && options.afterSettleInTx) {
        const recorded = options.afterSettleInTx(owner, execution.id, input.now);
        if (!recorded.ok) {
          // The provider outcome is already settled; the ledger failure is surfaced in the step log instead.
          addStep(
            owner,
            execution.taskId,
            "execution",
            "failed",
            `Execution result could not be written to the fact ledger (${execution.id})`,
            { executionId: execution.id, error: recorded.error.slice(0, 300) },
            input.now,
          );
        }
      }
      return { outcome: "settled" as const, execution, task };
    });

  const getExecution = (input: {
    principal: Principal;
    executionId: string;
  }): { execution: ExecutionRecord; action: ActionRecord } | null => {
    const owner = input.principal.ownerId;
    const row = executionRow(owner, input.executionId);
    if (!row) {
      return null;
    }
    const execution = toExecution(row);
    return { execution, action: toAction(actionRow(owner, execution.actionId) as Row) };
  };

  const listExecutions = (input: {
    principal: Principal;
    taskId?: string;
    states?: ExecutionState[];
    limit: number;
  }): ExecutionRecord[] => {
    const where = ["owner_id = ?"];
    const params: (string | number)[] = [input.principal.ownerId];
    if (input.taskId) {
      where.push("task_id = ?");
      params.push(input.taskId);
    }
    if (input.states && input.states.length > 0) {
      where.push(`state IN (${input.states.map(() => "?").join(",")})`);
      params.push(...input.states);
    }
    params.push(input.limit);
    return all(
      `SELECT ${EXECUTION_COLUMNS} FROM action_executions WHERE ${where.join(" AND ")} ORDER BY prepared_at DESC, rowid DESC LIMIT ?`,
      ...params,
    ).map(toExecution);
  };

  /** Prepared executions whose authority is still live: what the model may commit right now. */
  const listReadyExecutions = (input: {
    principal: Principal;
    taskId: string;
    now: number;
  }): { executionId: string; actionId: string; toolName: string; summary: string }[] => {
    const owner = input.principal.ownerId;
    return all(
      `SELECT ${EXECUTION_COLUMNS.split(", ")
        .map((c) => `e.${c}`)
        .join(", ")} FROM action_executions e ` +
        "LEFT JOIN action_grants g ON g.id = e.action_grant_id " +
        "WHERE e.owner_id = ? AND e.task_id = ? AND e.state = 'prepared' AND " +
        "(e.standing_grant_id IS NOT NULL OR (g.consumed_at IS NULL AND g.revoked_at IS NULL AND g.superseded_by IS NULL AND g.expires_at > ?)) " +
        "ORDER BY e.prepared_at",
      owner,
      input.taskId,
      input.now,
    ).map((row) => {
      const execution = toExecution(row);
      const action = toAction(actionRow(owner, execution.actionId) as Row);
      return {
        executionId: execution.id,
        actionId: action.id,
        toolName: action.toolName,
        summary: describeAction(action),
      };
    });
  };

  // ======================================================================================================
  // Grants (read + revoke)
  // ======================================================================================================
  const listGrants = (input: {
    principal: Principal;
    taskId?: string;
    limit: number;
  }): { actionGrants: ActionGrantRecord[]; standingGrants: StandingGrantRecord[] } => {
    const owner = input.principal.ownerId;
    const taskFilter = input.taskId ? " AND task_id = ?" : "";
    const params = input.taskId ? [owner, input.taskId, input.limit] : [owner, input.limit];
    const actionGrants = all(
      `SELECT * FROM action_grants WHERE owner_id = ?${taskFilter} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ...params,
    ).map(toActionGrant);
    const standingGrants = all(
      `SELECT * FROM standing_grants WHERE owner_id = ?${taskFilter} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ...params,
    ).map((row): StandingGrantRecord => ({
      id: String(row.id),
      taskId: String(row.task_id),
      fromDecisionId: String(row.from_decision_id),
      sourceActionId: String(row.source_action_id),
      capability: String(row.capability),
      toolName: str(row.tool_name),
      merchant: str(row.merchant),
      maxUses: num(row.max_uses),
      maxUsesPerDay: num(row.max_uses_per_day),
      taskRevision: Number(row.task_revision),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      revokedAt: num(row.revoked_at),
      uses: countOf(
        "SELECT COUNT(*) AS c FROM grant_uses WHERE owner_id = ? AND standing_grant_id = ?",
        owner,
        String(row.id),
      ),
    }));
    return { actionGrants, standingGrants };
  };

  const revokeGrant = (input: {
    principal: Principal;
    grantId: string;
    now: number;
  }):
    | { outcome: "revoked"; kind: "action" | "standing" }
    | { outcome: "not_found" | "already_revoked" | "already_consumed" } =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const action = one(
        "SELECT * FROM action_grants WHERE owner_id = ? AND id = ?",
        owner,
        input.grantId,
      );
      if (action) {
        if (action.consumed_at !== null) {
          return { outcome: "already_consumed" as const };
        }
        if (action.revoked_at !== null) {
          return { outcome: "already_revoked" as const };
        }
        run(
          "UPDATE action_grants SET revoked_at = ? WHERE owner_id = ? AND id = ? AND revoked_at IS NULL",
          input.now,
          owner,
          input.grantId,
        );
        failStranded(owner, [input.grantId], "grant_revoked", input.now);
        return { outcome: "revoked" as const, kind: "action" as const };
      }
      const standing = one(
        "SELECT * FROM standing_grants WHERE owner_id = ? AND id = ?",
        owner,
        input.grantId,
      );
      if (!standing) {
        return { outcome: "not_found" as const };
      }
      if (standing.revoked_at !== null) {
        return { outcome: "already_revoked" as const };
      }
      run(
        "UPDATE standing_grants SET revoked_at = ? WHERE owner_id = ? AND id = ? AND revoked_at IS NULL",
        input.now,
        owner,
        input.grantId,
      );
      run(
        "UPDATE action_executions SET state = 'failed', error_canonical = ?, completed_at = ? WHERE owner_id = ? AND standing_grant_id = ? AND state = 'prepared'",
        canonicalJson({ code: "grant_revoked" }),
        input.now,
        owner,
        input.grantId,
      );
      return { outcome: "revoked" as const, kind: "standing" as const };
    });

  // ======================================================================================================
  // Outbox (section 8.8.3): claim CAS, finish with backoff, recovery of stale `delivering` rows
  // ======================================================================================================
  const toOutbox = (row: Row): OutboxRecord => ({
    id: String(row.id),
    taskId: String(row.task_id),
    eventKey: String(row.event_key),
    kind: String(row.kind),
    payload: parseJson(row.payload_canonical),
    decisionId: str(row.decision_id),
    attempts: Number(row.attempts),
  });

  const claimOutbox = (input: {
    principal: Principal;
    workerId: string;
    limit: number;
    now: number;
  }): OutboxRecord[] =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const due = all(
        "SELECT id FROM outbox WHERE owner_id = ? AND state = 'pending' AND next_attempt_at <= ? ORDER BY created_at, rowid LIMIT ?",
        owner,
        input.now,
        input.limit,
      );
      const won: OutboxRecord[] = [];
      for (const candidate of due) {
        const changes = run(
          "UPDATE outbox SET state = 'delivering', claimed_by = ?, claimed_at = ? WHERE owner_id = ? AND id = ? AND state = 'pending' AND next_attempt_at <= ?",
          input.workerId,
          input.now,
          owner,
          String(candidate.id),
          input.now,
        );
        if (changes > 0) {
          won.push(
            toOutbox(
              one(
                "SELECT * FROM outbox WHERE owner_id = ? AND id = ?",
                owner,
                String(candidate.id),
              ) as Row,
            ),
          );
        }
      }
      return won;
    });

  const finishOutbox = (input: {
    principal: Principal;
    id: string;
    workerId: string;
    ok: boolean;
    error?: string;
    maxAttempts: number;
    now: number;
  }): { outcome: "delivered" | "retry" | "failed" | "not_claimed" } =>
    transaction(() => {
      const owner = input.principal.ownerId;
      if (input.ok) {
        const changes = run(
          "UPDATE outbox SET state = 'delivered', delivered_at = ?, attempts = attempts + 1 WHERE owner_id = ? AND id = ? AND state = 'delivering' AND claimed_by = ?",
          input.now,
          owner,
          input.id,
          input.workerId,
        );
        return { outcome: changes > 0 ? ("delivered" as const) : ("not_claimed" as const) };
      }
      const row = one(
        "SELECT attempts FROM outbox WHERE owner_id = ? AND id = ? AND state = 'delivering' AND claimed_by = ?",
        owner,
        input.id,
        input.workerId,
      );
      if (!row) {
        return { outcome: "not_claimed" as const };
      }
      const attempts = Number(row.attempts) + 1;
      if (attempts >= input.maxAttempts) {
        run(
          "UPDATE outbox SET state = 'failed', attempts = ?, last_error = ? WHERE owner_id = ? AND id = ?",
          attempts,
          input.error ?? null,
          owner,
          input.id,
        );
        return { outcome: "failed" as const };
      }
      const backoff = Math.min(60_000 * 2 ** (attempts - 1), 3_600_000);
      run(
        "UPDATE outbox SET state = 'pending', attempts = ?, last_error = ?, next_attempt_at = ?, claimed_by = NULL, claimed_at = NULL WHERE owner_id = ? AND id = ?",
        attempts,
        input.error ?? null,
        input.now + backoff,
        owner,
        input.id,
      );
      return { outcome: "retry" as const };
    });

  const recoverOutbox = (input: { principal: Principal; staleMs: number; now: number }): number =>
    run(
      "UPDATE outbox SET state = 'pending', claimed_by = NULL, claimed_at = NULL, next_attempt_at = ? WHERE owner_id = ? AND state = 'delivering' AND claimed_at < ?",
      input.now,
      input.principal.ownerId,
      input.now - input.staleMs,
    );

  /** gateway_start reconciliation (section 8.9.1 #3): nothing is inferred, the module just gets the open items. */
  const reconcileOnStart = (input: {
    principal: Principal;
    now: number;
    outboxStaleMs: number;
    /** `<pid>:<OS start time>` of THIS process (DESIGN section 9.5.1), or null when it could not be read. */
    bootId?: string | null;
  }): {
    expired: DecisionRecord[];
    pendingDecisions: DecisionRecord[];
    unfinishedExecutions: ExecutionRecord[];
    recoveredOutbox: number;
    purgedRunTriggers: number;
    orphanAttemptsReset: number;
  } => {
    const expired = expireDueDecisions({ principal: input.principal, now: input.now });
    // A core-approval attempt made by a DIFFERENT process can never be answered (its card died with it), so it is put
    // back to not_attempted at once instead of waiting for the lease. Only attempts that carry a readable boot id of
    // another process qualify; attempts from this process (a reload keeps the pid) and legacy ones are never touched.
    const orphanAttemptsReset =
      input.bootId && input.bootId !== "unavailable"
        ? run(
            "UPDATE decisions SET core_approval_state = 'not_attempted', core_approval_attempt_at = NULL, " +
              "core_approval_attempt_by = NULL, core_approval_attempt_id = NULL " +
              "WHERE owner_id = ? AND status = 'pending' AND core_approval_state = 'attempted' " +
              "AND core_approval_attempt_by LIKE 'nexus@%#%' AND core_approval_attempt_by NOT LIKE 'nexus@unavailable#%' " +
              "AND core_approval_attempt_by NOT LIKE ?",
            input.principal.ownerId,
            `nexus@${input.bootId}#%`,
          )
        : 0;
    return {
      expired,
      pendingDecisions: listDecisions({
        principal: input.principal,
        statuses: ["pending"],
        limit: 200,
      }),
      unfinishedExecutions: listExecutions({
        principal: input.principal,
        states: ["executing", "unknown"],
        limit: 200,
      }),
      recoveredOutbox: recoverOutbox({
        principal: input.principal,
        staleMs: input.outboxStaleMs,
        now: input.now,
      }),
      purgedRunTriggers: purgeRunTriggers({ principal: input.principal, now: input.now }),
      orphanAttemptsReset,
    };
  };

  return {
    registerAction,
    getAction,
    createDecision,
    getDecision,
    listDecisions,
    findDecisionForToolCall,
    resolveDecision,
    claimCoreApproval,
    recordApprovalResolution,
    expireDueDecisions,
    recordRunTrigger,
    readRunTrigger,
    purgeRunTriggers,
    authorizeAction,
    admitExecution,
    settleExecution,
    getExecution,
    listExecutions,
    listReadyExecutions,
    listGrants,
    revokeGrant,
    claimOutbox,
    finishOutbox,
    recoverOutbox,
    reconcileOnStart,
  };
}

export type DecisionKernel = ReturnType<typeof createDecisionKernel>;
