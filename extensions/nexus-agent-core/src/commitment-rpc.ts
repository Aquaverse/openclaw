// Gateway RPC for Commitments (design 10.2, slice W2): nexus.commitment.list / get / impact / create / update / communication /
// acceptance / resolve / cancel / restore / reopen / setRole / generatePeriods. Reads need operator.read, writes operator.write.
// The console is the user, so these write as the user: the Agent has its own narrower tools. A change reaches the Works that cite
// the Commitment through `work_changed` (ids only), which the Work page already listens to. Replies carry ownerId.
import { EITHER_RESPONSIBLE_MESSAGE } from "./commitment/joint.js";
import type {
  CommitmentChanges,
  DueSpec,
  PeriodSpec,
  ResponsibleSpec,
} from "./commitment/types.js";
import {
  ACCEPTANCE_STATES,
  COMMITMENT_LIFECYCLES,
  COMMITMENT_LIMITS,
  COMMUNICATION_STATES,
} from "./commitment/types.js";
import type { EventBridge } from "./events.js";
import {
  createGuard,
  reject,
  type GatewayRequestHandler,
  type Respond,
  type TaskRpcDeps,
} from "./rpc.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";
import { CONTEXT_MODES, type ContextMode } from "./work/types.js";

export type CommitmentRpcDeps = Pick<TaskRpcDeps, "getStore" | "resolvePrincipal" | "now"> & {
  events: EventBridge;
};

const LIST_LIMIT_MAX = 200;
const id = (raw: unknown): string | undefined =>
  typeof raw === "string" && /^[A-Za-z0-9_#:.-]{1,200}$/.test(raw) ? raw : undefined;
const str = (raw: unknown, max: number): string | undefined | null =>
  raw === undefined || raw === null
    ? undefined
    : typeof raw === "string" && raw.length <= max
      ? raw
      : null;

function parseResponsible(raw: unknown): ResponsibleSpec | undefined | "invalid" {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) {
    return "invalid";
  }
  const spec = raw as Record<string, unknown>;
  if (spec.kind === "self") {
    return { kind: "self" };
  }
  if (spec.kind === "name" && typeof spec.name === "string") {
    return { kind: "name", name: spec.name };
  }
  const counterpartId = id(spec.counterpartId);
  if (spec.kind === "counterpart" && counterpartId) {
    return { kind: "counterpart", counterpartId };
  }
  return "invalid";
}

function parseDue(raw: unknown): DueSpec | undefined | "invalid" {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) {
    return "invalid";
  }
  const spec = raw as Record<string, unknown>;
  if (spec.kind === "pending" || spec.kind === "none") {
    return { kind: spec.kind };
  }
  if (spec.kind === "known" && typeof spec.at === "number" && typeof spec.tz === "string") {
    return { kind: "known", at: spec.at, tz: spec.tz };
  }
  return "invalid";
}

function parsePeriods(raw: unknown): PeriodSpec[] | "invalid" {
  if (!Array.isArray(raw) || raw.length > COMMITMENT_LIMITS.periods + 1) {
    // One past the limit is let through so the ledger answers "too_many_periods" with the limit, not a vague shape error.
    return "invalid";
  }
  const out: PeriodSpec[] = [];
  for (const item of raw) {
    const p = item as Record<string, unknown>;
    if (
      typeof item !== "object" ||
      item === null ||
      typeof p.key !== "string" ||
      typeof p.index !== "number" ||
      typeof p.start !== "number" ||
      typeof p.end !== "number" ||
      typeof p.tz !== "string" ||
      typeof p.dueAt !== "number"
    ) {
      return "invalid";
    }
    out.push({ key: p.key, index: p.index, start: p.start, end: p.end, tz: p.tz, dueAt: p.dueAt });
  }
  return out;
}

/** The outcomes every mutating call can answer besides its success; null when the result is the success. */
function refuse(respond: Respond, result: { outcome: string } & Record<string, unknown>): boolean {
  switch (result.outcome) {
    case "not_found":
    case "work_not_found":
    case "target_not_found":
    case "not_linked":
      reject(respond, "nexus_not_found", `${result.outcome.replace(/_/g, " ")}`);
      return true;
    case "revision_conflict":
      reject(respond, "nexus_revision_conflict", "the commitment changed; reload it");
      return true;
    case "invalid":
      if (result.code === "either_responsible") {
        // "Any one of them is enough" has no legal form (design 6.8): say what to do instead, never record two obligations.
        reject(respond, "nexus_unsupported", EITHER_RESPONSIBLE_MESSAGE);
        return true;
      }
      reject(respond, "nexus_invalid_params", String(result.code));
      return true;
    case "forbidden":
      reject(respond, "nexus_forbidden", String(result.code));
      return true;
    case "gap_ack_required":
      reject(
        respond,
        "nexus_gap_ack_required",
        "this can make the work look finished; confirm with acknowledgeGap",
      );
      return true;
    case "closed":
    case "not_open":
    case "not_cancelled":
    case "not_resolved":
      reject(respond, "nexus_commitment_state", `the commitment is ${String(result.lifecycle)}`);
      return true;
    case "stale":
      reject(respond, "nexus_revision_conflict", "the commitment changed; reload it");
      return true;
    default:
      return false;
  }
}

export function createCommitmentRpcHandlers(deps: CommitmentRpcDeps) {
  const now = deps.now ?? Date.now;
  const guarded = createGuard(deps);

  /** Tell the Work page which Works to re-read: every Work that cites the Commitment. */
  const announce = async (
    store: TaskStore,
    principal: Principal,
    commitmentId: string,
    action: string,
  ): Promise<void> => {
    try {
      const out = await store.commitmentImpact({ principal, commitmentId });
      if (out.outcome === "ok") {
        for (const work of out.impact.works) {
          deps.events.workChanged({ ownerId: principal.ownerId, workId: work.workId, action });
        }
      }
    } catch {
      // best effort after the commit
    }
  };

  const methods: (readonly [string, GatewayRequestHandler, "operator.read" | "operator.write"])[] =
    [
      [
        "nexus.commitment.list",
        guarded(async ({ principal, store, params, respond }) => {
          const states = params.states;
          const keyword = str(params.keyword, 200);
          const workId = params.workId === undefined ? undefined : id(params.workId);
          const counterpartId =
            params.counterpartId === undefined ? undefined : id(params.counterpartId);
          const contextMode =
            params.contextMode === undefined
              ? undefined
              : (CONTEXT_MODES as readonly unknown[]).includes(params.contextMode)
                ? (params.contextMode as ContextMode)
                : "invalid";
          if (
            keyword === null ||
            (params.workId !== undefined && !workId) ||
            (params.counterpartId !== undefined && !counterpartId) ||
            contextMode === "invalid" ||
            (params.order !== undefined && params.order !== "due" && params.order !== "recent") ||
            (states !== undefined &&
              !(
                Array.isArray(states) &&
                states.every((s) => (COMMITMENT_LIFECYCLES as readonly unknown[]).includes(s))
              ))
          ) {
            reject(
              respond,
              "nexus_invalid_params",
              "states, ids, keyword, order or contextMode are invalid",
            );
            return;
          }
          const limit =
            typeof params.limit === "number" && params.limit >= 1
              ? Math.min(Math.floor(params.limit), LIST_LIMIT_MAX)
              : 50;
          const offset =
            typeof params.offset === "number" && params.offset >= 1
              ? Math.min(Math.floor(params.offset), 100_000)
              : 0;
          const result = await store.commitmentList({
            principal,
            now: now(),
            ...(states ? { lifecycles: states as string[] } : {}),
            ...(workId ? { workId } : {}),
            ...(counterpartId ? { counterpartId } : {}),
            ...(contextMode ? { contextMode } : {}),
            ...(keyword ? { keyword } : {}),
            ...(params.overdueOnly === true ? { overdueOnly: true } : {}),
            ...(typeof params.dueBefore === "number" ? { dueBefore: params.dueBefore } : {}),
            ...(params.order === "recent" ? { order: "recent" as const } : {}),
            limit,
            offset,
          });
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.read",
      ],
      [
        "nexus.commitment.get",
        guarded(async ({ principal, store, params, respond }) => {
          const commitmentId = id(params.commitmentId);
          if (!commitmentId) {
            reject(respond, "nexus_invalid_params", "commitmentId is required");
            return;
          }
          const result = await store.commitmentGet({ principal, commitmentId, now: now() });
          if (refuse(respond, result)) {
            return;
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.read",
      ],
      [
        "nexus.commitment.impact",
        guarded(async ({ principal, store, params, respond }) => {
          const commitmentId = id(params.commitmentId);
          if (!commitmentId) {
            reject(respond, "nexus_invalid_params", "commitmentId is required");
            return;
          }
          const result = await store.commitmentImpact({ principal, commitmentId });
          if (refuse(respond, result)) {
            return;
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.read",
      ],
      [
        "nexus.commitment.create",
        guarded(async ({ principal, store, params, respond }) => {
          const requirementText = str(params.requirementText, COMMITMENT_LIMITS.requirement);
          const responsible = parseResponsible(params.responsible);
          const due = parseDue(params.due);
          const nextStep = str(params.nextStep, COMMITMENT_LIMITS.nextStep);
          const requestId = id(params.requestId);
          const workId = params.workId === undefined ? undefined : id(params.workId);
          const workRole =
            params.workRole === undefined || params.workRole === "required"
              ? "required"
              : params.workRole === "reference"
                ? "reference"
                : undefined;
          const contextMode =
            params.contextMode === undefined
              ? undefined
              : (CONTEXT_MODES as readonly unknown[]).includes(params.contextMode)
                ? (params.contextMode as ContextMode)
                : "invalid";
          if (
            !requirementText ||
            !responsible ||
            responsible === "invalid" ||
            due === "invalid" ||
            nextStep === null ||
            (params.workId !== undefined && !workId) ||
            !workRole ||
            contextMode === "invalid"
          ) {
            reject(
              respond,
              "nexus_invalid_params",
              "requirementText and a responsible (self, name or counterpart) are required; due, nextStep, workId, workRole and contextMode must be valid",
            );
            return;
          }
          const result = await store.commitmentCreate({
            principal,
            spec: {
              requirementText,
              responsible,
              ...(due ? { due } : {}),
              ...(contextMode ? { contextMode } : {}),
              ...(nextStep ? { nextStep } : {}),
              origin: { kind: "native_record", refId: `console:${requestId ?? `r${now()}`}` },
            },
            createdBy: "user",
            ...(workId ? { workId, workRole } : {}),
            now: now(),
          });
          if (refuse(respond, result)) {
            return;
          }
          if (result.outcome === "created" || result.outcome === "exists") {
            await announce(store, principal, result.commitment.id, "commitment");
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.commitment.update",
        guarded(async ({ principal, store, params, respond }) => {
          const commitmentId = id(params.commitmentId);
          const raw = (params.changes ?? {}) as Record<string, unknown>;
          const requirementText = str(raw.requirementText, COMMITMENT_LIMITS.requirement);
          const responsible = parseResponsible(raw.responsible);
          const due = parseDue(raw.due);
          const stepBad =
            raw.nextStep !== undefined &&
            raw.nextStep !== null &&
            (typeof raw.nextStep !== "string" || raw.nextStep.length > COMMITMENT_LIMITS.nextStep);
          const reason = str(params.reason, COMMITMENT_LIMITS.reason);
          if (
            !commitmentId ||
            typeof params.changes !== "object" ||
            requirementText === null ||
            responsible === "invalid" ||
            due === "invalid" ||
            stepBad ||
            reason === null
          ) {
            reject(respond, "nexus_invalid_params", "commitmentId and valid changes are required");
            return;
          }
          const changes: CommitmentChanges = {
            ...(requirementText !== undefined ? { requirementText } : {}),
            ...(responsible ? { responsible } : {}),
            ...(due ? { due } : {}),
            ...(raw.nextStep !== undefined ? { nextStep: raw.nextStep as string | null } : {}),
          };
          const result = await store.commitmentUpdate({
            principal,
            commitmentId,
            changes,
            ...(typeof params.expectedRevision === "number"
              ? { expectedRevision: params.expectedRevision }
              : {}),
            ...(reason ? { reason } : {}),
            actor: "user",
            now: now(),
          });
          if (refuse(respond, result)) {
            return;
          }
          if (result.outcome === "updated") {
            await announce(store, principal, commitmentId, "commitment");
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.commitment.communication",
        guarded(async ({ principal, store, params, respond }) => {
          const commitmentId = id(params.commitmentId);
          const state = (COMMUNICATION_STATES as readonly unknown[]).find(
            (s) => s === params.state,
          );
          if (!commitmentId || !state || state === "draft") {
            reject(
              respond,
              "nexus_invalid_params",
              "commitmentId and a state (submitted, confirmed, unknown, failed) are required",
            );
            return;
          }
          const result = await store.commitmentCommunication({
            principal,
            commitmentId,
            state: state as "submitted" | "confirmed" | "unknown" | "failed",
            actor: "user",
            ...(typeof params.expectedRevision === "number"
              ? { expectedRevision: params.expectedRevision }
              : {}),
            now: now(),
          });
          if (refuse(respond, result)) {
            return;
          }
          await announce(store, principal, commitmentId, "commitment");
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.commitment.acceptance",
        guarded(async ({ principal, store, params, respond }) => {
          const commitmentId = id(params.commitmentId);
          const state = (ACCEPTANCE_STATES as readonly unknown[]).find((s) => s === params.state);
          const basis = str(params.basis, COMMITMENT_LIMITS.basis);
          if (!commitmentId || !state || basis === null) {
            reject(respond, "nexus_invalid_params", "commitmentId and a state are required");
            return;
          }
          const result = await store.commitmentAcceptance({
            principal,
            commitmentId,
            state: state as "unknown" | "accepted" | "declined" | "needs_clarification",
            ...(basis ? { basis } : {}),
            // What the user types here is the user's own report; a source record is only ever attached by the system.
            basisKind: "user_report",
            actor: "user",
            ...(typeof params.expectedRevision === "number"
              ? { expectedRevision: params.expectedRevision }
              : {}),
            now: now(),
          });
          if (refuse(respond, result)) {
            return;
          }
          await announce(store, principal, commitmentId, "commitment");
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      ...(["resolve", "cancel"] as const).map(
        (action) =>
          [
            `nexus.commitment.${action}`,
            guarded(async ({ principal, store, params, respond }) => {
              const commitmentId = id(params.commitmentId);
              const reason = str(params.reason, COMMITMENT_LIMITS.reason);
              if (!commitmentId || reason === null) {
                reject(respond, "nexus_invalid_params", "commitmentId and a reason are required");
                return;
              }
              const dryRun = params.dryRun === true;
              const call = action === "resolve" ? store.commitmentResolve : store.commitmentCancel;
              const result = await call({
                principal,
                commitmentId,
                reason: reason ?? "",
                dryRun,
                ...(typeof params.expectedRevision === "number"
                  ? { expectedRevision: params.expectedRevision }
                  : {}),
                now: now(),
              });
              if (refuse(respond, result)) {
                return;
              }
              if (result.outcome === "resolved" || result.outcome === "cancelled") {
                for (const work of result.impact.works) {
                  deps.events.workChanged({
                    ownerId: principal.ownerId,
                    workId: work.workId,
                    action: "commitment",
                  });
                }
              }
              respond(true, { ownerId: principal.ownerId, ...result });
            }),
            "operator.write",
          ] as const,
      ),
      [
        "nexus.commitment.restore",
        guarded(async ({ principal, store, params, respond }) => {
          const commitmentId = id(params.commitmentId);
          if (!commitmentId) {
            reject(respond, "nexus_invalid_params", "commitmentId is required");
            return;
          }
          const result = await store.commitmentRestore({
            principal,
            commitmentId,
            ...(typeof params.expectedRevision === "number"
              ? { expectedRevision: params.expectedRevision }
              : {}),
            now: now(),
          });
          if (refuse(respond, result)) {
            return;
          }
          await announce(store, principal, commitmentId, "commitment");
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.commitment.reopen",
        guarded(async ({ principal, store, params, respond }) => {
          const commitmentId = id(params.commitmentId);
          const reason = str(params.reason, COMMITMENT_LIMITS.reason);
          if (!commitmentId || reason === null) {
            reject(respond, "nexus_invalid_params", "commitmentId is required");
            return;
          }
          const dryRun = params.dryRun === true;
          const result = await store.commitmentReopen({
            principal,
            commitmentId,
            ...(reason ? { reason } : {}),
            dryRun,
            ...(typeof params.expectedRevision === "number"
              ? { expectedRevision: params.expectedRevision }
              : {}),
            now: now(),
          });
          if (refuse(respond, result)) {
            return;
          }
          if (result.outcome === "reopened") {
            for (const work of result.impact.works) {
              deps.events.workChanged({
                ownerId: principal.ownerId,
                workId: work.workId,
                action: "commitment",
              });
            }
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.commitment.setRole",
        guarded(async ({ principal, store, params, respond }) => {
          const commitmentId = id(params.commitmentId);
          const workId = id(params.workId);
          const role =
            params.role === "required" || params.role === "reference" ? params.role : undefined;
          if (!commitmentId || !workId || !role) {
            reject(
              respond,
              "nexus_invalid_params",
              "commitmentId, workId and a role (required, reference) are required",
            );
            return;
          }
          const result = await store.commitmentSetRole({
            principal,
            workId,
            commitmentId,
            role,
            acknowledgeGap: params.acknowledgeGap === true,
            actor: "user",
            now: now(),
          });
          if (refuse(respond, result)) {
            return;
          }
          if (result.outcome === "changed") {
            deps.events.workChanged({ ownerId: principal.ownerId, workId, action: "commitment" });
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.commitment.generatePeriods",
        guarded(async ({ principal, store, params, respond }) => {
          const requestId = id(params.requestId);
          const requirementText = str(params.requirementText, COMMITMENT_LIMITS.requirement);
          const responsible = parseResponsible(params.responsible);
          const periods = parsePeriods(params.periods);
          const workId = params.workId === undefined ? undefined : id(params.workId);
          if (
            !requestId ||
            !requirementText ||
            !responsible ||
            responsible === "invalid" ||
            periods === "invalid" ||
            (params.workId !== undefined && !workId)
          ) {
            reject(
              respond,
              "nexus_invalid_params",
              "requestId, requirementText, a responsible and a list of periods are required",
            );
            return;
          }
          const result = await store.commitmentGeneratePeriods({
            principal,
            requestId,
            spec: {
              requirementText,
              responsible,
              origin: { kind: "native_record", refId: `console:${requestId}` },
            },
            periods,
            createdBy: "user",
            ...(workId
              ? {
                  workId,
                  workRole:
                    params.workRole === "reference"
                      ? ("reference" as const)
                      : ("required" as const),
                }
              : {}),
            now: now(),
          });
          if (refuse(respond, result)) {
            return;
          }
          if (result.outcome === "generated" && workId) {
            deps.events.workChanged({ ownerId: principal.ownerId, workId, action: "commitment" });
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
    ];
  return methods;
}
