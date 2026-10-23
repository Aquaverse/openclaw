/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
// Claim / Evidence ledger kernel (DESIGN section 9), Stage 3 slice 1. Runs inside the SQLite worker.
// Same rules as the other kernels: one input object with a mandatory `principal`, every statement filters on owner_id,
// every write is ONE synchronous transaction. What is specific here:
//   * `claim_events` is append-only and digest-chained per Task (digest = sha256(prev_digest || payload_canonical));
//     `claims` is only the projection and is rewritten in the same transaction as the event;
//   * the Agent can only write ASSERTED / UNKNOWN. SUPPORTED / VERIFIED / REFUTED are DERIVED from the currently effective
//     evidence links (section 9.5.4), never accepted as input, so the derived state is a function of the effective set;
//   * slice 1 accepts `execution` evidence refs only. tool_output / blob refs need the Blob store (later slice) and are
//     reported as `ref_kind_not_supported`; evidence rows therefore carry blob_key NULL and no bytes at all.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { asText } from "../as-text.js";
import { canonicalJson, sha256Hex } from "../canonical.js";
import type {
  AgentClaimState,
  ClaimDetail,
  ClaimEventRecord,
  ClaimLinkRecord,
  ClaimPolicy,
  ClaimRecord,
  ClaimState,
  CompletionCheck,
  CompletionItem,
  CompletionState,
  EvidenceRef,
} from "./claim-types.js";
import { isClosed, parseJson, TASK_COLUMNS, toTask, type TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";

type Row = Record<string, unknown>;

/** Bumped whenever classifyExecutionEvidence or the group mapping changes (rules are re-computable and auditable). */
export const RELATION_RULE_VERSION = 1;
/** v2 = v1 plus the `user_upload` group for operator uploads (slice 2). Execution evidence maps exactly as in v1. */
export const SOURCE_GROUP_RULE_VERSION = 2;
/** Relation verdicts that are an operator declaration rather than a verifier rule (slice 2). */
export const OPERATOR_RELATION_RULE_VERSION = 2;
export const DEFAULT_MIN_GROUPS_FOR_VERIFIED = 2;
export const EVENT_TAIL = 20;
export const OPERATOR_ATTESTATION_GROUP = "operator_attestation";

const RANK: Record<ClaimState, number> = {
  UNKNOWN: 0,
  ASSERTED: 0,
  REFUTED: 0,
  SUPPORTED: 1,
  VERIFIED: 2,
};

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export function parsePolicy(raw: unknown): ClaimPolicy | null {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const policy: ClaimPolicy = {};
  if (Array.isArray(source.allowedGroups)) {
    const groups = source.allowedGroups.filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
    if (groups.length > 0) {
      policy.allowedGroups = groups;
    }
  }
  if (
    typeof source.minGroupsForVerified === "number" &&
    Number.isInteger(source.minGroupsForVerified)
  ) {
    policy.minGroupsForVerified = Math.max(
      DEFAULT_MIN_GROUPS_FOR_VERIFIED,
      source.minGroupsForVerified,
    );
  }
  return Object.keys(policy).length > 0 ? policy : null;
}

/**
 * Relation verifier, rule version 1 (section 9.5.5). It reads the claim and the evidence's IMMUTABLE facts, never the
 * model's wording. It only understands the predicate `executed`; anything else is `unclassified`, which never counts
 * for or against a claim (a verifier that cannot judge must not default to `supports`).
 */
export function classifyExecutionEvidence(
  claim: { predicate: string; value: unknown },
  facts: { state: string; actionId: string },
): { relation: "supports" | "contradicts" | "unclassified"; reason: string } {
  if (claim.predicate !== "executed") {
    return {
      relation: "unclassified",
      reason: `no rule for predicate "${claim.predicate}" (rule v${RELATION_RULE_VERSION} only judges "executed")`,
    };
  }
  const wanted =
    claim.value !== null && typeof claim.value === "object"
      ? (claim.value as Record<string, unknown>).actionId
      : undefined;
  if (typeof wanted === "string" && wanted !== facts.actionId) {
    return { relation: "unclassified", reason: "evidence is about a different action" };
  }
  if (facts.state === "succeeded") {
    return { relation: "supports", reason: "the provider settled the execution as succeeded" };
  }
  if (facts.state === "failed") {
    return { relation: "contradicts", reason: "the execution failed; nothing was done" };
  }
  return { relation: "unclassified", reason: `execution state "${facts.state}" is not final` };
}

export type ClaimLedgerOptions = { newId?: (prefix: string) => string };

export type AddClaimInput = {
  principal: Principal;
  taskId: string;
  claimId?: string;
  subject: string;
  predicate: string;
  value?: unknown;
  state: AgentClaimState;
  policy?: ClaimPolicy | null;
  /** Register this claim as a Task completion condition. Agents may only strengthen an existing requirement. */
  completion?: CompletionState;
  actor: string;
  now: number;
};
export type AddClaimOutcome =
  | { outcome: "created" | "appended"; claim: ClaimRecord; eventId: string }
  | { outcome: "not_found" }
  | { outcome: "claim_not_found" }
  | { outcome: "task_closed"; status: string }
  | { outcome: "value_conflict"; claim: ClaimRecord }
  | { outcome: "policy_conflict"; claim: ClaimRecord }
  | { outcome: "completion_weakening_refused"; claim: ClaimRecord };

export type AddEvidenceInput = {
  principal: Principal;
  taskId: string;
  claimId: string;
  ref: EvidenceRef;
  expectedHeadEventId?: string;
  actor: string;
  now: number;
};
export type AddEvidenceOutcome =
  | {
      outcome: "linked";
      claim: ClaimRecord;
      evidenceId: string;
      reusedEvidence: boolean;
      relation: "supports" | "contradicts" | "unclassified";
      reason: string;
      stateBefore: ClaimState;
      stateAfter: ClaimState;
      eventId: string;
    }
  | { outcome: "already_linked"; claim: ClaimRecord; evidenceId: string }
  | { outcome: "not_found" }
  | { outcome: "claim_not_found" }
  | { outcome: "task_closed"; status: string }
  | { outcome: "stale_head"; headEventId: string }
  | { outcome: "ref_kind_not_supported"; kind: string }
  | { outcome: "ref_not_found" }
  | { outcome: "ref_not_ready"; state: string }
  | { outcome: "detached_by_operator"; evidenceId: string };

export type ExecutionHookResult =
  | { ok: true; claimId: string | null }
  | { ok: false; error: string };

export function createClaimLedger(
  db: DatabaseSync,
  transaction: TransactionRunner,
  options: ClaimLedgerOptions = {},
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

  const CLAIM_COLUMNS =
    "id, task_id, subject, predicate, value_json, state, verification_policy, head_event_id, created_at, updated_at";

  const taskRow = (owner: string, taskId: string): Row | undefined =>
    one(`SELECT ${TASK_COLUMNS} FROM nexus_tasks WHERE owner_id = ? AND id = ?`, owner, taskId);
  const claimRow = (owner: string, taskId: string, claimId: string): Row | undefined =>
    one(
      `SELECT ${CLAIM_COLUMNS} FROM claims WHERE owner_id = ? AND task_id = ? AND id = ?`,
      owner,
      taskId,
      claimId,
    );

  const requirementOf = (
    owner: string,
    taskId: string,
    claimId: string,
  ): CompletionState | null => {
    const row = one(
      "SELECT required_state FROM nexus_task_completion_claims WHERE owner_id = ? AND task_id = ? AND claim_id = ?",
      owner,
      taskId,
      claimId,
    );
    return row ? (String(row.required_state) as CompletionState) : null;
  };

  const toClaim = (owner: string, row: Row): ClaimRecord => ({
    id: String(row.id),
    taskId: String(row.task_id),
    subject: String(row.subject),
    predicate: String(row.predicate),
    value: row.value_json === null ? null : parseJson(row.value_json),
    state: String(row.state) as ClaimState,
    policy: row.verification_policy === null ? null : parsePolicy(row.verification_policy),
    headEventId: String(row.head_event_id),
    requiredForCompletion: requirementOf(owner, String(row.task_id), String(row.id)),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });

  /** Writes are refused for deleted or closed Tasks (purging included); the settle hook passes allowClosed. */
  const writableTask = (
    owner: string,
    taskId: string,
    allowClosed = false,
  ):
    | { ok: true }
    | { ok: false; outcome: "not_found" }
    | { ok: false; outcome: "task_closed"; status: string } => {
    const row = taskRow(owner, taskId);
    if (!row || row.deleted_at !== null) {
      return { ok: false, outcome: "not_found" };
    }
    const task = toTask(row);
    if (!allowClosed && isClosed(task.status)) {
      return { ok: false, outcome: "task_closed", status: task.status };
    }
    if (task.status === "purging") {
      return { ok: false, outcome: "task_closed", status: task.status };
    }
    return { ok: true };
  };

  /** Append one event to the Task's digest chain. The chain is per Task: seq and prev_digest come from the last row. */
  const appendEvent = (
    owner: string,
    taskId: string,
    claimId: string,
    transition: string,
    source: string,
    actor: string,
    payload: Record<string, unknown>,
    now: number,
    presetId?: string,
  ): { id: string; seq: number; digest: string } => {
    const last = one(
      "SELECT seq, digest FROM claim_events WHERE owner_id = ? AND task_id = ? ORDER BY seq DESC LIMIT 1",
      owner,
      taskId,
    );
    const seq = last ? Number(last.seq) + 1 : 1;
    const prevDigest = last ? String(last.digest) : null;
    const id = presetId ?? newId("CE");
    const payloadCanonical = canonicalJson({ ...payload, claimId, seq, transition });
    const digest = sha256Hex(`${prevDigest ?? ""}${payloadCanonical}`);
    run(
      "INSERT INTO claim_events (id, owner_id, task_id, claim_id, seq, transition, source, actor, payload_canonical, prev_digest, digest, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      owner,
      taskId,
      claimId,
      seq,
      transition,
      source,
      actor.slice(0, 160),
      payloadCanonical,
      prevDigest,
      digest,
      now,
    );
    return { id, seq, digest };
  };

  const enqueueOutbox = (
    owner: string,
    taskId: string,
    eventKey: string,
    kind: string,
    payload: unknown,
    now: number,
  ) => {
    run(
      "INSERT OR IGNORE INTO outbox (id, owner_id, task_id, event_key, kind, payload_canonical, decision_id, state, attempts, " +
        "next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', 0, ?, ?)",
      newId("O"),
      owner,
      taskId,
      eventKey,
      kind,
      canonicalJson(payload),
      now,
      now,
    );
  };

  /** Currently effective source groups for one relation (section 9.5.4): distinct groups, not rows. */
  const effectiveGroups = (
    owner: string,
    taskId: string,
    claimId: string,
    relation: "supports" | "contradicts",
  ): string[] =>
    all(
      "SELECT DISTINCT e.source_group AS g FROM claim_evidence_links l " +
        "JOIN evidence e ON e.owner_id = l.owner_id AND e.task_id = l.task_id AND e.id = l.evidence_id " +
        "WHERE l.owner_id = ? AND l.task_id = ? AND l.claim_id = ? AND l.relation = ? AND l.effective = 1 ORDER BY g",
      owner,
      taskId,
      claimId,
      relation,
    ).map((row) => String(row.g));

  /** The ONLY place a claim's state is computed. Retraction is sticky; conflicting evidence yields UNKNOWN. */
  const computeState = (
    owner: string,
    taskId: string,
    row: Row,
  ): { state: ClaimState; supportGroups: number; contradictGroups: number } => {
    const claimId = String(row.id);
    const policy = row.verification_policy === null ? null : parsePolicy(row.verification_policy);
    const retracted = one(
      "SELECT 1 AS x FROM claim_events WHERE owner_id = ? AND task_id = ? AND claim_id = ? AND transition = 'retract' LIMIT 1",
      owner,
      taskId,
      claimId,
    );
    const baseEvent = one(
      "SELECT payload_canonical FROM claim_events WHERE owner_id = ? AND task_id = ? AND claim_id = ? " +
        "AND transition IN ('create','assert') ORDER BY seq DESC LIMIT 1",
      owner,
      taskId,
      claimId,
    );
    const baseRaw = baseEvent
      ? (parseJson(baseEvent.payload_canonical) as { base?: unknown } | null)?.base
      : undefined;
    const base: ClaimState = baseRaw === "UNKNOWN" ? "UNKNOWN" : "ASSERTED";
    let support = effectiveGroups(owner, taskId, claimId, "supports");
    if (policy?.allowedGroups) {
      const patterns = policy.allowedGroups;
      support = support.filter((group) => patterns.some((pattern) => globMatches(pattern, group)));
    }
    const contradict = effectiveGroups(owner, taskId, claimId, "contradicts");
    const minGroups = policy?.minGroupsForVerified ?? DEFAULT_MIN_GROUPS_FOR_VERIFIED;
    let state: ClaimState;
    if (retracted) {
      state = "REFUTED";
    } else if (contradict.length > 0 && support.length > 0) {
      state = "UNKNOWN";
    } else if (contradict.length > 0) {
      state = "REFUTED";
    } else if (support.length >= minGroups) {
      state = "VERIFIED";
    } else if (support.length >= 1) {
      state = "SUPPORTED";
    } else {
      state = base;
    }
    return { state, supportGroups: support.length, contradictGroups: contradict.length };
  };

  /** Write the recomputed state + head into the projection and queue the notices. Returns the new state. */
  const settleProjection = (
    owner: string,
    taskId: string,
    claimId: string,
    eventId: string,
    before: ClaimState,
    transition: string,
    now: number,
    valueJson?: string | null,
  ): ClaimState => {
    const row = claimRow(owner, taskId, claimId) as Row;
    const { state } = computeState(owner, taskId, row);
    run(
      `UPDATE claims SET state = ?, head_event_id = ?, updated_at = ?${valueJson !== undefined ? ", value_json = ?" : ""} ` +
        "WHERE owner_id = ? AND task_id = ? AND id = ?",
      state,
      eventId,
      now,
      ...(valueJson !== undefined ? [valueJson] : []),
      owner,
      taskId,
      claimId,
    );
    enqueueOutbox(
      owner,
      taskId,
      `claim_changed:${eventId}`,
      "claim_changed",
      {
        claimId,
        taskId,
        state,
        previousState: before,
        eventId,
        transition,
      },
      now,
    );
    if (state === "VERIFIED" && before !== "VERIFIED") {
      enqueueOutbox(
        owner,
        taskId,
        `claim_verified:${claimId}:${eventId}`,
        "claim_verified",
        {
          claimId,
          taskId,
          state,
          eventId,
        },
        now,
      );
    }
    return state;
  };

  // ---------------------------------------------------------------- execution evidence

  type ExecutionFacts = {
    executionId: string;
    actionId: string;
    state: string;
    toolName: string;
    capability: string;
    providerOperationId: string | null;
    contentHash: string;
    operatorResolved: boolean;
    confirmation: string | null;
    note: string | null;
  };

  const executionFacts = (
    owner: string,
    taskId: string,
    executionId: string,
  ): ExecutionFacts | null => {
    const row = one(
      "SELECT e.id, e.action_id, e.state, e.provider_operation_id, e.result_canonical, e.result_hash, e.error_canonical, " +
        "a.tool_name, a.capability FROM action_executions e JOIN actions a ON a.owner_id = e.owner_id AND a.id = e.action_id " +
        "WHERE e.owner_id = ? AND e.task_id = ? AND e.id = ?",
      owner,
      taskId,
      executionId,
    );
    if (!row) {
      return null;
    }
    const result =
      row.result_canonical === null ? null : (parseJson(row.result_canonical) as Row | null);
    const error =
      row.error_canonical === null ? null : (parseJson(row.error_canonical) as Row | null);
    const detail = result ?? error;
    const contentHash =
      typeof row.result_hash === "string" && row.result_hash
        ? row.result_hash
        : sha256Hex(String(row.error_canonical ?? row.result_canonical ?? row.state));
    return {
      executionId,
      actionId: String(row.action_id),
      state: String(row.state),
      toolName: String(row.tool_name),
      capability: String(row.capability),
      providerOperationId:
        typeof row.provider_operation_id === "string" ? row.provider_operation_id : null,
      contentHash,
      operatorResolved:
        detail?.operatorResolved === true || detail?.code === "operator_resolved_failed",
      confirmation: typeof result?.confirmation === "string" ? result.confirmation : null,
      note: typeof detail?.note === "string" ? detail.note.slice(0, 200) : null,
    };
  };

  /** Has this evidence already been linked to (or detached from) this claim? Newest link event wins. */
  const priorLink = (
    owner: string,
    taskId: string,
    claimId: string,
    evidenceId: string,
  ): { relation: string } | undefined =>
    one(
      "SELECT cee.relation FROM claim_event_evidence cee " +
        "JOIN claim_events ce ON ce.owner_id = cee.owner_id AND ce.task_id = cee.task_id AND ce.id = cee.claim_event_id " +
        "WHERE cee.owner_id = ? AND cee.task_id = ? AND ce.claim_id = ? AND cee.evidence_id = ? ORDER BY ce.seq DESC LIMIT 1",
      owner,
      taskId,
      claimId,
      evidenceId,
    ) as { relation: string } | undefined;

  /**
   * Link a registered evidence row to a claim: append the event, the link event row and the projection, then recompute.
   * Shared by execution evidence, blob evidence and the operator paths; the caller decides the verdict.
   */
  const linkEvidenceRow = (args: {
    owner: string;
    taskId: string;
    claimId: string;
    evidenceId: string;
    sourceGroup: string;
    verdict: { relation: "supports" | "contradicts" | "unclassified"; reason: string };
    ruleVersion: number;
    source: string;
    actor: string;
    now: number;
    reusedEvidence: boolean;
    extraPayload?: Record<string, unknown>;
  }): Extract<AddEvidenceOutcome, { outcome: "linked" }> => {
    const { owner, taskId, claimId, evidenceId, verdict } = args;
    const claim = toClaim(owner, claimRow(owner, taskId, claimId) as Row);
    const stateBefore = claim.state;
    const event = appendEvent(
      owner,
      taskId,
      claimId,
      "evidence",
      args.source,
      args.actor,
      {
        evidenceId,
        relation: verdict.relation,
        reason: verdict.reason,
        ruleVersion: args.ruleVersion,
        sourceGroup: args.sourceGroup,
        stateBefore,
        ...args.extraPayload,
      },
      args.now,
    );
    run(
      "INSERT INTO claim_event_evidence (owner_id, task_id, claim_event_id, evidence_id, relation, relation_rule_version, relation_reason, supersedes_evidence_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      owner,
      taskId,
      event.id,
      evidenceId,
      verdict.relation,
      args.ruleVersion,
      verdict.reason,
    );
    if (verdict.relation !== "unclassified") {
      run(
        "INSERT INTO claim_evidence_links (owner_id, task_id, claim_id, evidence_id, relation, effective, head_link_event_id, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT (owner_id, task_id, claim_id, evidence_id) DO UPDATE SET " +
          "relation = excluded.relation, effective = 1, head_link_event_id = excluded.head_link_event_id, updated_at = excluded.updated_at",
        owner,
        taskId,
        claimId,
        evidenceId,
        verdict.relation,
        event.id,
        args.now,
      );
    }
    const stateAfter = settleProjection(
      owner,
      taskId,
      claimId,
      event.id,
      stateBefore,
      "evidence",
      args.now,
    );
    return {
      outcome: "linked",
      claim: toClaim(owner, claimRow(owner, taskId, claimId) as Row),
      evidenceId,
      reusedEvidence: args.reusedEvidence,
      relation: verdict.relation,
      reason: verdict.reason,
      stateBefore,
      stateAfter,
      eventId: event.id,
    };
  };

  /** Shared by nexus_evidence_add and the settle hook. Runs inside the caller's transaction. */
  const linkExecutionEvidence = (
    owner: string,
    taskId: string,
    claimId: string,
    facts: ExecutionFacts,
    source: "store" | "settle",
    actor: string,
    now: number,
  ): Extract<
    AddEvidenceOutcome,
    { outcome: "linked" | "already_linked" | "detached_by_operator" }
  > => {
    const row = claimRow(owner, taskId, claimId) as Row;
    const claim = toClaim(owner, row);
    const provider = facts.toolName.split("_")[0] || "unknown";
    const sourceGroup = facts.operatorResolved
      ? OPERATOR_ATTESTATION_GROUP
      : `agent_call:${provider}`;
    const locator = `execution:${facts.executionId}`;
    const version = facts.providerOperationId ?? `content:${facts.contentHash}`;
    const identity = sha256Hex(canonicalJson({ locator, version, contentHash: facts.contentHash }));
    const existing = one(
      "SELECT id FROM evidence WHERE owner_id = ? AND task_id = ? AND source_identity_hash = ?",
      owner,
      taskId,
      identity,
    );
    const evidenceId = existing ? String(existing.id) : newId("EV");
    const previous = priorLink(owner, taskId, claimId, evidenceId);
    if (previous) {
      return previous.relation === "detach"
        ? { outcome: "detached_by_operator", evidenceId }
        : { outcome: "already_linked", claim, evidenceId };
    }
    if (!existing) {
      run(
        "INSERT INTO evidence (id, owner_id, task_id, kind, blob_key, content_hash, byte_size, source_ref_kind, source_ref_id, " +
          "source_locator_canonical, source_version, source_identity_hash, source_run_id, source_session_key, source_group, " +
          "source_group_rule_version, retention_policy, meta_json, captured_at) " +
          "VALUES (?, ?, ?, 'execution_receipt', NULL, ?, NULL, 'execution', ?, ?, ?, ?, NULL, NULL, ?, ?, 'task', ?, ?)",
        evidenceId,
        owner,
        taskId,
        facts.contentHash,
        facts.executionId,
        locator,
        version,
        identity,
        sourceGroup,
        SOURCE_GROUP_RULE_VERSION,
        canonicalJson({
          executionId: facts.executionId,
          actionId: facts.actionId,
          toolName: facts.toolName,
          capability: facts.capability,
          state: facts.state,
          confirmation: facts.confirmation,
          operatorResolved: facts.operatorResolved,
          note: facts.note,
        }),
        now,
      );
    }
    const verdict = classifyExecutionEvidence(claim, {
      state: facts.state,
      actionId: facts.actionId,
    });
    return linkEvidenceRow({
      owner,
      taskId,
      claimId,
      evidenceId,
      sourceGroup,
      verdict,
      ruleVersion: RELATION_RULE_VERSION,
      source,
      actor,
      now,
      reusedEvidence: existing !== undefined,
    });
  };

  /** Create a claim row + its first event (the circular FK is deferred, both rows are written in this transaction). */
  const createClaim = (
    owner: string,
    taskId: string,
    spec: {
      subject: string;
      predicate: string;
      value: unknown;
      base: AgentClaimState;
      policy: ClaimPolicy | null;
      source: string;
      actor: string;
    },
    now: number,
  ): { claimId: string; eventId: string } => {
    const claimId = newId("CL");
    const eventId = newId("CE");
    run(
      "INSERT INTO claims (id, owner_id, task_id, subject, predicate, value_json, state, verification_policy, head_event_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      claimId,
      owner,
      taskId,
      spec.subject,
      spec.predicate,
      spec.value === undefined || spec.value === null ? null : canonicalJson(spec.value),
      spec.base,
      spec.policy ? canonicalJson(spec.policy) : null,
      eventId,
      now,
      now,
    );
    appendEvent(
      owner,
      taskId,
      claimId,
      "create",
      spec.source,
      spec.actor,
      { base: spec.base, subject: spec.subject, predicate: spec.predicate },
      now,
      eventId,
    );
    enqueueOutbox(
      owner,
      taskId,
      `claim_changed:${eventId}`,
      "claim_changed",
      {
        claimId,
        taskId,
        state: spec.base,
        previousState: null,
        eventId,
        transition: "create",
      },
      now,
    );
    return { claimId, eventId };
  };

  const setCompletion = (
    owner: string,
    taskId: string,
    claimId: string,
    required: CompletionState,
  ) => {
    run(
      "INSERT INTO nexus_task_completion_claims (owner_id, task_id, claim_id, required_state) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (task_id, claim_id) DO UPDATE SET required_state = excluded.required_state " +
        "WHERE excluded.required_state = 'VERIFIED' AND nexus_task_completion_claims.required_state = 'SUPPORTED'",
      owner,
      taskId,
      claimId,
      required,
    );
  };

  // ---------------------------------------------------------------- completion

  const checkCompletionInTx = (owner: string, taskId: string): CompletionCheck => {
    const rows = all(
      "SELECT c.id, c.subject, c.predicate, c.state, k.required_state FROM nexus_task_completion_claims k " +
        "JOIN claims c ON c.owner_id = k.owner_id AND c.task_id = k.task_id AND c.id = k.claim_id " +
        "WHERE k.owner_id = ? AND k.task_id = ? ORDER BY c.created_at, c.id",
      owner,
      taskId,
    );
    const items: CompletionItem[] = rows.map((row) => {
      const state = String(row.state) as ClaimState;
      const requiredState = String(row.required_state) as CompletionState;
      return {
        claimId: String(row.id),
        subject: String(row.subject),
        predicate: String(row.predicate),
        state,
        requiredState,
        met: RANK[state] >= RANK[requiredState] && RANK[state] > 0,
      };
    });
    if (items.length === 0) {
      return { ok: false, reason: "no_completion_claims", items };
    }
    return items.every((item) => item.met)
      ? { ok: true, reason: "ok", items }
      : { ok: false, reason: "unmet", items };
  };

  // ---------------------------------------------------------------- settle hook

  /**
   * Called from settleExecution's transaction when the ledger is enabled. It must NEVER make the settle fail: the
   * provider already did (or did not do) the thing, so a ledger bug is rolled back to a savepoint and reported instead.
   */
  const recordExecutionResultInTx = (
    owner: string,
    executionId: string,
    now: number,
  ): ExecutionHookResult => {
    db.exec("SAVEPOINT nexus_claim_hook");
    try {
      const idRow = one(
        "SELECT task_id FROM action_executions WHERE owner_id = ? AND id = ?",
        owner,
        executionId,
      );
      if (!idRow) {
        db.exec("RELEASE nexus_claim_hook");
        return { ok: true, claimId: null };
      }
      const taskId = String(idRow.task_id);
      const facts = executionFacts(owner, taskId, executionId) as ExecutionFacts;
      const subject = `execution:${executionId}`;
      const existing = one(
        `SELECT ${CLAIM_COLUMNS} FROM claims WHERE owner_id = ? AND task_id = ? AND subject = ? AND predicate = 'executed'`,
        owner,
        taskId,
        subject,
      );
      let claimId: string;
      if (existing) {
        claimId = String(existing.id);
      } else {
        claimId = createClaim(
          owner,
          taskId,
          {
            subject,
            predicate: "executed",
            value: { actionId: facts.actionId, executionId, toolName: facts.toolName },
            base: facts.state === "unknown" ? "UNKNOWN" : "ASSERTED",
            policy: null,
            source: "settle",
            actor: "system:settle",
          },
          now,
        ).claimId;
      }
      if (facts.state === "succeeded" || facts.state === "failed") {
        linkExecutionEvidence(owner, taskId, claimId, facts, "settle", "system:settle", now);
      }
      db.exec("RELEASE nexus_claim_hook");
      return { ok: true, claimId };
    } catch (error) {
      db.exec("ROLLBACK TO nexus_claim_hook");
      db.exec("RELEASE nexus_claim_hook");
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  // ---------------------------------------------------------------- kernel methods

  const addClaim = (input: AddClaimInput): AddClaimOutcome =>
    transaction((): AddClaimOutcome => {
      const owner = input.principal.ownerId;
      const gate = writableTask(owner, input.taskId);
      if (!gate.ok) {
        return gate;
      }
      let row: Row | undefined;
      if (input.claimId) {
        row = claimRow(owner, input.taskId, input.claimId);
        if (!row) {
          return { outcome: "claim_not_found" };
        }
      } else {
        row = one(
          `SELECT ${CLAIM_COLUMNS} FROM claims WHERE owner_id = ? AND task_id = ? AND subject = ? AND predicate = ?`,
          owner,
          input.taskId,
          input.subject,
          input.predicate,
        );
      }
      const valueJson =
        input.value === undefined || input.value === null ? null : canonicalJson(input.value);
      if (!row) {
        const created = createClaim(
          owner,
          input.taskId,
          {
            subject: input.subject,
            predicate: input.predicate,
            value: input.value,
            base: input.state,
            policy: input.policy ?? null,
            source: "agent",
            actor: input.actor,
          },
          input.now,
        );
        if (input.completion) {
          setCompletion(owner, input.taskId, created.claimId, input.completion);
        }
        return {
          outcome: "created",
          claim: toClaim(owner, claimRow(owner, input.taskId, created.claimId) as Row),
          eventId: created.eventId,
        };
      }
      const current = toClaim(owner, row);
      if (valueJson !== null && row.value_json !== null && row.value_json !== valueJson) {
        return { outcome: "value_conflict", claim: current };
      }
      if (
        input.policy &&
        canonicalJson(parsePolicy(input.policy)) !== canonicalJson(current.policy)
      ) {
        return { outcome: "policy_conflict", claim: current };
      }
      if (input.completion === "SUPPORTED" && current.requiredForCompletion === "VERIFIED") {
        return { outcome: "completion_weakening_refused", claim: current };
      }
      const before = current.state;
      const event = appendEvent(
        owner,
        input.taskId,
        current.id,
        "assert",
        "agent",
        input.actor,
        { base: input.state, stateBefore: before },
        input.now,
      );
      settleProjection(
        owner,
        input.taskId,
        current.id,
        event.id,
        before,
        "assert",
        input.now,
        row.value_json === null && valueJson !== null ? valueJson : undefined,
      );
      if (input.completion) {
        setCompletion(owner, input.taskId, current.id, input.completion);
      }
      return {
        outcome: "appended",
        claim: toClaim(owner, claimRow(owner, input.taskId, current.id) as Row),
        eventId: event.id,
      };
    });

  const addEvidence = (input: AddEvidenceInput): AddEvidenceOutcome =>
    transaction((): AddEvidenceOutcome => {
      const owner = input.principal.ownerId;
      const gate = writableTask(owner, input.taskId);
      if (!gate.ok) {
        return gate;
      }
      const row = claimRow(owner, input.taskId, input.claimId);
      if (!row) {
        return { outcome: "claim_not_found" };
      }
      if (
        input.expectedHeadEventId !== undefined &&
        input.expectedHeadEventId !== String(row.head_event_id)
      ) {
        return { outcome: "stale_head", headEventId: String(row.head_event_id) };
      }
      if (input.ref.kind !== "execution") {
        return { outcome: "ref_kind_not_supported", kind: input.ref.kind };
      }
      // A0: the reference must belong to the same owner AND the same Task before anything is derived from it.
      const facts = executionFacts(owner, input.taskId, input.ref.id);
      if (!facts) {
        return { outcome: "ref_not_found" };
      }
      if (facts.state !== "succeeded" && facts.state !== "failed") {
        return { outcome: "ref_not_ready", state: facts.state };
      }
      return linkExecutionEvidence(
        owner,
        input.taskId,
        input.claimId,
        facts,
        "store",
        input.actor,
        input.now,
      );
    });

  const retractClaim = (input: {
    principal: Principal;
    taskId: string;
    claimId: string;
    reason: string;
    actor: string;
    now: number;
  }):
    | { outcome: "retracted"; claim: ClaimRecord; eventId: string }
    | { outcome: "already_retracted"; claim: ClaimRecord }
    | { outcome: "not_found" }
    | { outcome: "claim_not_found" } =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const gate = writableTask(owner, input.taskId, true);
      if (!gate.ok && gate.outcome === "not_found") {
        return { outcome: "not_found" as const };
      }
      const row = claimRow(owner, input.taskId, input.claimId);
      if (!row) {
        return { outcome: "claim_not_found" as const };
      }
      const already = one(
        "SELECT 1 AS x FROM claim_events WHERE owner_id = ? AND task_id = ? AND claim_id = ? AND transition = 'retract' LIMIT 1",
        owner,
        input.taskId,
        input.claimId,
      );
      if (already) {
        return { outcome: "already_retracted" as const, claim: toClaim(owner, row) };
      }
      const before = String(row.state) as ClaimState;
      const event = appendEvent(
        owner,
        input.taskId,
        input.claimId,
        "retract",
        "operator",
        input.actor,
        { reason: input.reason.slice(0, 500), stateBefore: before },
        input.now,
      );
      settleProjection(owner, input.taskId, input.claimId, event.id, before, "retract", input.now);
      return {
        outcome: "retracted" as const,
        claim: toClaim(owner, claimRow(owner, input.taskId, input.claimId) as Row),
        eventId: event.id,
      };
    });

  const unlinkEvidence = (input: {
    principal: Principal;
    taskId: string;
    claimId: string;
    evidenceId: string;
    reason: string;
    actor: string;
    now: number;
  }):
    | { outcome: "unlinked"; claim: ClaimRecord; eventId: string }
    | { outcome: "not_linked" }
    | { outcome: "not_found" }
    | { outcome: "claim_not_found" } =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const gate = writableTask(owner, input.taskId, true);
      if (!gate.ok && gate.outcome === "not_found") {
        return { outcome: "not_found" as const };
      }
      const row = claimRow(owner, input.taskId, input.claimId);
      if (!row) {
        return { outcome: "claim_not_found" as const };
      }
      const link = one(
        "SELECT relation FROM claim_evidence_links WHERE owner_id = ? AND task_id = ? AND claim_id = ? AND evidence_id = ? AND effective = 1",
        owner,
        input.taskId,
        input.claimId,
        input.evidenceId,
      );
      if (!link) {
        return { outcome: "not_linked" as const };
      }
      const before = String(row.state) as ClaimState;
      const event = appendEvent(
        owner,
        input.taskId,
        input.claimId,
        "detach",
        "operator",
        input.actor,
        { evidenceId: input.evidenceId, reason: input.reason.slice(0, 500), stateBefore: before },
        input.now,
      );
      run(
        "INSERT INTO claim_event_evidence (owner_id, task_id, claim_event_id, evidence_id, relation, relation_rule_version, relation_reason, supersedes_evidence_id) " +
          "VALUES (?, ?, ?, ?, 'detach', ?, ?, NULL)",
        owner,
        input.taskId,
        event.id,
        input.evidenceId,
        RELATION_RULE_VERSION,
        input.reason.slice(0, 500),
      );
      run(
        "UPDATE claim_evidence_links SET effective = 0, head_link_event_id = ?, updated_at = ? " +
          "WHERE owner_id = ? AND task_id = ? AND claim_id = ? AND evidence_id = ?",
        event.id,
        input.now,
        owner,
        input.taskId,
        input.claimId,
        input.evidenceId,
      );
      settleProjection(owner, input.taskId, input.claimId, event.id, before, "detach", input.now);
      return {
        outcome: "unlinked" as const,
        claim: toClaim(owner, claimRow(owner, input.taskId, input.claimId) as Row),
        eventId: event.id,
      };
    });

  const eventRecord = (row: Row): ClaimEventRecord => ({
    id: String(row.id),
    seq: Number(row.seq),
    claimId: String(row.claim_id),
    transition: String(row.transition),
    source: String(row.source),
    actor: String(row.actor),
    digest: String(row.digest),
    prevDigest: row.prev_digest === null ? null : asText(row.prev_digest),
    payload: parseJson(row.payload_canonical),
    createdAt: Number(row.created_at),
  });

  const getClaim = (input: {
    principal: Principal;
    taskId: string;
    claimId: string;
  }): ClaimDetail | null => {
    const owner = input.principal.ownerId;
    const row = claimRow(owner, input.taskId, input.claimId);
    if (!row) {
      return null;
    }
    const events = all(
      "SELECT id, seq, claim_id, transition, source, actor, payload_canonical, prev_digest, digest, created_at " +
        "FROM claim_events WHERE owner_id = ? AND task_id = ? AND claim_id = ? ORDER BY seq DESC LIMIT ?",
      owner,
      input.taskId,
      input.claimId,
      EVENT_TAIL,
    )
      .map(eventRecord)
      .toReversed();
    const links: ClaimLinkRecord[] = all(
      "SELECT l.relation, l.effective, e.id, e.kind, e.source_ref_kind, e.source_ref_id, e.source_group, e.content_hash, e.meta_json, e.captured_at " +
        "FROM claim_evidence_links l JOIN evidence e ON e.owner_id = l.owner_id AND e.task_id = l.task_id AND e.id = l.evidence_id " +
        "WHERE l.owner_id = ? AND l.task_id = ? AND l.claim_id = ? ORDER BY e.captured_at, e.id",
      owner,
      input.taskId,
      input.claimId,
    ).map((link) => ({
      relation: String(link.relation) as "supports" | "contradicts",
      effective: Number(link.effective) === 1,
      evidence: {
        evidenceId: String(link.id),
        kind: String(link.kind),
        sourceRefKind: String(link.source_ref_kind),
        sourceRefId: String(link.source_ref_id),
        sourceGroup: String(link.source_group),
        contentHash: String(link.content_hash),
        summary: link.meta_json === null ? null : parseJson(link.meta_json),
        capturedAt: Number(link.captured_at),
      },
    }));
    const { supportGroups, contradictGroups } = computeState(owner, input.taskId, row);
    return { claim: toClaim(owner, row), events, links, supportGroups, contradictGroups };
  };

  const listClaims = (input: {
    principal: Principal;
    taskId: string;
    states?: ClaimState[];
    limit: number;
  }): ClaimRecord[] => {
    const owner = input.principal.ownerId;
    const where = ["owner_id = ?", "task_id = ?"];
    const params: (string | number)[] = [owner, input.taskId];
    if (input.states && input.states.length > 0) {
      where.push(`state IN (${input.states.map(() => "?").join(",")})`);
      params.push(...input.states);
    }
    params.push(input.limit);
    return all(
      `SELECT ${CLAIM_COLUMNS} FROM claims WHERE ${where.join(" AND ")} ORDER BY created_at, id LIMIT ?`,
      ...params,
    ).map((row) => toClaim(owner, row));
  };

  /** Operator integrity check: re-walk the Task's chain and recompute every digest. Read-only. */
  const verifyChain = (input: {
    principal: Principal;
    taskId: string;
  }): { ok: boolean; checked: number; brokenAtSeq: number | null; reason: string | null } => {
    const owner = input.principal.ownerId;
    const rows = all(
      "SELECT seq, payload_canonical, prev_digest, digest FROM claim_events WHERE owner_id = ? AND task_id = ? ORDER BY seq",
      owner,
      input.taskId,
    );
    let prev: string | null = null;
    let expectedSeq = 1;
    for (const row of rows) {
      const seq = Number(row.seq);
      if (seq !== expectedSeq) {
        return { ok: false, checked: expectedSeq - 1, brokenAtSeq: seq, reason: "seq_gap" };
      }
      if ((row.prev_digest === null ? null : asText(row.prev_digest)) !== prev) {
        return {
          ok: false,
          checked: expectedSeq - 1,
          brokenAtSeq: seq,
          reason: "prev_digest_mismatch",
        };
      }
      const digest = sha256Hex(`${prev ?? ""}${String(row.payload_canonical)}`);
      if (digest !== String(row.digest)) {
        return { ok: false, checked: expectedSeq - 1, brokenAtSeq: seq, reason: "digest_mismatch" };
      }
      prev = digest;
      expectedSeq += 1;
    }
    return { ok: true, checked: rows.length, brokenAtSeq: null, reason: null };
  };

  const checkCompletion = (input: { principal: Principal; taskId: string }): CompletionCheck =>
    checkCompletionInTx(input.principal.ownerId, input.taskId);

  /**
   * Per-process provenance row. With `supersedeOthers` (only when the operator enabled `incarnation_gone`, DESIGN 9.5.1) the
   * same transaction also marks every unterminated row whose boot id differs from this process as
   * `superseded_under_gateway_lock`: a crashed process's boot id always differs from its successor's, a same-process
   * predecessor (service reload) has the SAME boot id and is never touched. Never done for an unreadable boot id.
   */
  const registerIncarnation = (input: {
    principal: Principal;
    incarnationId: string;
    bootId: string;
    now: number;
    supersedeOthers?: boolean;
  }): { registered: boolean; superseded: number } =>
    transaction(() => {
      const registered =
        run(
          "INSERT OR IGNORE INTO process_incarnations (incarnation_id, process_boot_id, started_at) VALUES (?, ?, ?)",
          input.incarnationId,
          input.bootId,
          input.now,
        ) > 0;
      const superseded =
        input.supersedeOthers === true && input.bootId !== "unavailable"
          ? run(
              "UPDATE process_incarnations SET gone_at = ?, gone_basis = 'superseded_under_gateway_lock' " +
                "WHERE gone_at IS NULL AND incarnation_id <> ? AND process_boot_id <> ?",
              input.now,
              input.incarnationId,
              input.bootId,
            )
          : 0;
      return { registered, superseded };
    });

  const closeIncarnation = (input: {
    principal: Principal;
    incarnationId: string;
    now: number;
  }): { closed: boolean } =>
    transaction(() => ({
      closed:
        run(
          "UPDATE process_incarnations SET gone_at = ?, gone_basis = 'clean_shutdown' WHERE incarnation_id = ? AND gone_at IS NULL",
          input.now,
          input.incarnationId,
        ) > 0,
    }));

  return {
    kernel: {
      addClaim,
      addEvidence,
      retractClaim,
      unlinkEvidence,
      getClaim,
      listClaims,
      verifyChain,
      checkCompletion,
      registerIncarnation,
      closeIncarnation,
    },
    hooks: { recordExecutionResultInTx, checkCompletionInTx },
    /** Building blocks for sibling kernels that share this ledger's transaction (blob-ledger.ts). Not a worker operation. */
    internals: {
      one,
      all,
      run,
      newId,
      claimRow,
      toClaim,
      writableTask,
      priorLink,
      linkEvidenceRow,
      enqueueOutbox,
    },
  };
}

export type ClaimLedger = ReturnType<typeof createClaimLedger>;
export type ClaimKernel = ClaimLedger["kernel"];
