// Agent tools for the Claim / Evidence ledger (DESIGN sections 9 and 12): nexus_claim_add, nexus_evidence_add,
// nexus_claim_verify. The Agent can only ASSERT (or mark UNKNOWN). SUPPORTED / VERIFIED / REFUTED are derived by the store
// from the evidence it can check itself; nothing here accepts a state the model could use to promote its own claim.
import { Type } from "typebox";
import type { AnyAgentTool } from "../../api.js";
import { EvidenceBytesUnavailableError } from "../evidence/blob-store.js";
import type { EvidenceOutcome, EvidenceService } from "../evidence/evidence-service.js";
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
/** `<sha256 hex>.<generation>`: the physical key of an evidence object (DESIGN 9.5.1). */
export const BLOB_KEY = /^[0-9a-f]{64}\.[0-9]{1,6}$/;
const NO_SESSION = "(no-session)";

export type ClaimToolDeps = {
  getStore: () => Promise<TaskStore>;
  resolvePrincipal: (ctx: { agentId?: string; sessionKey?: string }) => Principal | undefined;
  now?: () => number;
  /** Called after a write that produced outbox rows (claim_changed / claim_verified). */
  onOutboxWritten?: () => void;
  /** Present only when evidence blobs are enabled; without it `blob` refs are reported as not supported. */
  evidence?: Pick<EvidenceService, "attachBlob">;
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

/** Maps the evidence service outcome to a tool result. Never reports a claim as supported unless the store derived it. */
function blobEvidenceResult(result: EvidenceOutcome): Record<string, unknown> {
  switch (result.outcome) {
    case "not_found":
      return fail("not_found", "Task not found.");
    case "claim_not_found":
      return fail("claim_not_found", "Claim not found.");
    case "task_closed":
      return fail(
        "task_closed",
        `The Task has ended (${result.status}); evidence can no longer be attached.`,
      );
    case "stale_head":
      return fail(
        "stale_head",
        "This claim was modified; call nexus_claim_verify to read the latest state first.",
        {
          headEventId: result.headEventId,
        },
      );
    case "ref_not_found":
      return fail(
        "ref_not_found",
        "Evidence material not found (the blobKey does not exist, or does not belong to this account).",
      );
    case "ref_not_ready":
      return fail("ref_not_ready", `This material is not available right now (${result.state}).`);
    case "quota_exceeded":
      return fail(
        "quota_exceeded",
        result.scope === "entry"
          ? "This material exceeds the size limit for a single piece of evidence and was not saved."
          : "The evidence space is full and this evidence was not saved; the user has been notified. Do not present the related conclusion as proven.",
        {
          scope: result.scope,
          ...("noticeDecisionId" in result && result.noticeDecisionId
            ? { noticeDecisionId: result.noticeDecisionId }
            : {}),
        },
      );
    case "busy":
      return fail("busy", "The same material is being written or reclaimed; try again shortly.", {
        retryAfterMs: result.retryAfterMs,
      });
    case "storage_error":
      return fail(
        "storage_error",
        `Evidence storage failed (${result.stage}); no evidence was attached.`,
      );
    case "blob_corrupt":
      return fail(
        "blob_corrupt",
        `The evidence object does not match its record (${result.reason}); no evidence was attached.`,
        {
          blobKey: result.blobKey,
        },
      );
    case "reservation_lost":
    case "object_not_live":
      return fail(
        "conflict",
        "The material was reclaimed or changed during the write; no evidence was attached; retry.",
      );
    case "evidence_purged":
      return fail(
        "evidence_purged",
        "This evidence was deleted at the user's request and cannot be silently restored; the user must provide the material again.",
        { evidenceId: result.evidenceId },
      );
    case "detached_by_operator":
      return fail(
        "detached_by_operator",
        "An operator withdrew this evidence; it cannot be attached again.",
        {
          evidenceId: result.evidenceId,
        },
      );
    case "already_linked":
      return {
        ok: true,
        alreadyLinked: true,
        evidenceId: result.evidenceId,
        ...claimView(result.claim),
      };
    case "registered":
      return { ok: true, registered: true, evidenceId: result.evidenceId };
    case "linked":
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
            return fail("invalid_task_id", "taskId looks like T0ABC123 (a leading # is allowed).");
          }
          const subject = typeof params.subject === "string" ? params.subject.trim() : "";
          if (!subject || [...subject].length > CLAIM_LIMITS.subject) {
            return fail("invalid_subject", "subject must not be empty, at most 200 characters.");
          }
          const predicate = typeof params.predicate === "string" ? params.predicate.trim() : "";
          if (!/^[a-z][a-z0-9_]{0,79}$/.test(predicate)) {
            return fail(
              "invalid_predicate",
              "predicate must be lower_snake_case, at most 80 characters.",
            );
          }
          if (
            params.value !== undefined &&
            JSON.stringify(params.value).length > CLAIM_LIMITS.json
          ) {
            return fail("invalid_value", "value must not exceed 4 KB.");
          }
          const state = params.state ?? "ASSERTED";
          if (!(AGENT_CLAIM_STATES as readonly unknown[]).includes(state)) {
            return fail(
              "state_not_allowed",
              "The model can only write ASSERTED or UNKNOWN; SUPPORTED / VERIFIED / REFUTED are derived from evidence and cannot be set directly.",
              { allowed: [...AGENT_CLAIM_STATES] },
            );
          }
          let completion: "SUPPORTED" | "VERIFIED" | undefined;
          if (params.completion !== undefined) {
            if (!(COMPLETION_STATES as readonly unknown[]).includes(params.completion)) {
              return fail("invalid_completion", "completion can only be SUPPORTED or VERIFIED.");
            }
            completion = params.completion as "SUPPORTED" | "VERIFIED";
          }
          const policy = readPolicy(params.policy);
          if (policy === "invalid") {
            return fail(
              "invalid_policy",
              "policy only accepts allowedGroups (an array of strings) and minGroupsForVerified (an integer).",
            );
          }
          let claimId: string | undefined;
          if (params.claimId !== undefined) {
            if (typeof params.claimId !== "string" || !ID.test(params.claimId)) {
              return fail("invalid_claim_id", "claimId is malformed.");
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
              return fail("not_found", "Task not found.");
            case "claim_not_found":
              return fail("claim_not_found", "Claim not found.");
            case "task_closed":
              return fail(
                "task_closed",
                `The Task has ended (${result.status}); claims can no longer be registered.`,
              );
            case "value_conflict":
              return fail(
                "value_conflict",
                "The same subject+predicate was already registered with a different value; it cannot be overwritten.",
                {
                  claim: claimView(result.claim),
                },
              );
            case "policy_conflict":
              return fail(
                "policy_conflict",
                "This claim already has a different policy; it cannot be overwritten.",
                {
                  claim: claimView(result.claim),
                },
              );
            case "completion_weakening_refused":
              return fail(
                "completion_weakening_refused",
                "A completion condition that requires VERIFIED cannot be lowered to SUPPORTED.",
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
        'Attach evidence to a claim by REFERENCE, never by pasting content. kind="execution" takes the executionId returned by nexus_action_commit. kind="blob" takes the blobKey of material the user already uploaded (listed as unlinkedEvidence by nexus_claim_verify). tool_output refs are not supported yet. The store reads the evidence itself, decides whether it supports or contradicts the claim (an uploaded document you attach stays unclassified until the operator declares its relation), and recomputes the claim state; you cannot set the relation or the state. Pass expectedHeadEventId (from the claim) to detect a concurrent change.',
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
            return fail("invalid_task_id", "taskId looks like T0ABC123 (a leading # is allowed).");
          }
          if (typeof params.claimId !== "string" || !ID.test(params.claimId)) {
            return fail("invalid_claim_id", "claimId is malformed.");
          }
          const ref = params.ref;
          if (
            !isPlainObject(ref) ||
            typeof ref.kind !== "string" ||
            !(EVIDENCE_REF_KINDS as readonly string[]).includes(ref.kind) ||
            typeof ref.id !== "string" ||
            !(ref.kind === "blob" ? BLOB_KEY.test(ref.id) : ID.test(ref.id))
          ) {
            return fail(
              "invalid_ref",
              "ref must be {kind: execution|tool_output|blob, id}; a blob id is a blobKey like <64-hex>.<number>.",
            );
          }
          if (
            params.expectedHeadEventId !== undefined &&
            typeof params.expectedHeadEventId !== "string"
          ) {
            return fail("invalid_expected_head", "expectedHeadEventId must be a string.");
          }
          if (ref.kind === "blob" && deps.evidence) {
            try {
              const result = await deps.evidence.attachBlob({
                principal,
                taskId,
                claimId: params.claimId,
                blobKey: ref.id,
                ...(typeof params.expectedHeadEventId === "string"
                  ? { expectedHeadEventId: params.expectedHeadEventId }
                  : {}),
                actor,
                eventSource: "store",
              });
              return blobEvidenceResult(result);
            } catch (error) {
              if (error instanceof EvidenceBytesUnavailableError) {
                return fail(
                  "evidence_bytes_unavailable",
                  "This install does not provide evidence byte storage, so no evidence was attached; do not present the related conclusion as proven. Use execution evidence instead, or let the user record the conclusion as unproven.",
                  { reason: error.reason },
                );
              }
              throw error;
            }
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
              return fail("not_found", "Task not found.");
            case "claim_not_found":
              return fail("claim_not_found", "Claim not found.");
            case "task_closed":
              return fail(
                "task_closed",
                `The Task has ended (${result.status}); evidence can no longer be attached.`,
              );
            case "stale_head":
              return fail(
                "stale_head",
                "This claim was modified; call nexus_claim_verify to read the latest state first.",
                {
                  headEventId: result.headEventId,
                },
              );
            case "ref_kind_not_supported":
              return fail(
                "ref_kind_not_supported",
                `This version does not support ${result.kind} evidence references (execution is supported; blob needs evidenceBlobsEnabled).`,
              );
            case "ref_not_found":
              return fail(
                "ref_not_found",
                "Execution not found (or it does not belong to this Task).",
              );
            case "ref_not_ready":
              return fail(
                "ref_not_ready",
                `This execution has no final outcome yet (${result.state}); attach evidence after it is succeeded / failed.`,
              );
            case "detached_by_operator":
              return fail(
                "detached_by_operator",
                "An operator withdrew this evidence; it cannot be attached again.",
                {
                  evidenceId: result.evidenceId,
                },
              );
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
            return fail("invalid_task_id", "taskId looks like T0ABC123 (a leading # is allowed).");
          }
          if (params.claimId !== undefined) {
            if (typeof params.claimId !== "string" || !ID.test(params.claimId)) {
              return fail("invalid_claim_id", "claimId is malformed.");
            }
            const detail = await store.getClaim({ principal, taskId, claimId: params.claimId });
            if (!detail) {
              return fail("claim_not_found", "Claim not found.");
            }
            return { ok: true, ...detailView(detail) };
          }
          const claims = await store.listClaims({
            principal,
            taskId,
            limit: CLAIM_LIMITS.claimsReturned,
          });
          const completion = await store.checkCompletion({ principal, taskId });
          const unlinked = deps.evidence
            ? await store.listEvidence({ principal, taskId, onlyUnlinked: true, limit: 10 })
            : [];
          return {
            ok: true,
            taskId,
            claims: claims.map(claimView),
            completion: { ok: completion.ok, reason: completion.reason, items: completion.items },
            ...(unlinked.length > 0
              ? {
                  unlinkedEvidence: unlinked
                    .filter((row) => row.blobKey !== null)
                    .map((row) => ({
                      blobKey: row.blobKey,
                      sourceGroup: row.sourceGroup,
                      bytes: row.byteSize,
                      classification: row.classification,
                      // Names of financial / sensitive material are not shown to the model.
                      ...(row.classification === "personal" &&
                      row.meta &&
                      typeof (row.meta as { name?: unknown }).name === "string"
                        ? { name: (row.meta as { name: string }).name }
                        : {}),
                    })),
                }
              : {}),
          };
        });
      },
    },
  ];
  const visible = tools.map((tool) => ({ ...tool, catalogMode: "direct-only" as const }));
  return visible as unknown as AnyAgentTool[];
}
