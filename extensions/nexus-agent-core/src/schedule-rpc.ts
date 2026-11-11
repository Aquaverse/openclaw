// Gateway RPC of follow-up plans and schedules (design 10.2, W4a): nexus.delegation.* and nexus.schedule.*, plus the goal letter
// policy nexus.goal.briefing.*. The console is the user, so the writes here are the user's hand: accepting a plan, pausing,
// resuming and stopping a schedule exist ONLY here, never as Agent tools. Reads need operator.read, writes operator.write. Which
// schedules the host can actually start is `scheduledDispatchReady()`; without it new schedules are saved blocked, never "active".
// A change tells the Work page through work_changed (ids and an action only). Replies carry ownerId.
import type { EventBridge } from "./events.js";
import { createGuard, reject, type GatewayRequestHandler, type TaskRpcDeps } from "./rpc.js";
import { scheduledDispatchReady } from "./schedule/host-capability.js";
import {
  PLAN_OWNER_TYPES,
  SCHEDULE_STATUSES,
  START_INTENTS,
  type PlanBody,
  type PlanGap,
  type PlanOwnerType,
  type ScheduleStatus,
  type StartIntent,
} from "./schedule/types.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";

export type ScheduleRpcDeps = Pick<TaskRpcDeps, "getStore" | "resolvePrincipal" | "now"> & {
  events: EventBridge;
  /** Overrides the host check (tests only). */
  dispatchReady?: () => boolean;
};

type Respond = Parameters<GatewayRequestHandler>[0]["respond"];
const idOf = (raw: unknown): string | undefined =>
  typeof raw === "string" && /^[A-Za-z0-9_#:.@-]{1,200}$/.test(raw) ? raw : undefined;
const intOf = (raw: unknown): number | undefined =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
const isObject = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw);

/** The answers every call can give besides its success; true when it has answered. */
function refuse(respond: Respond, result: { outcome: string } & Record<string, unknown>): boolean {
  switch (result.outcome) {
    case "not_found":
    case "work_not_found":
    case "owner_missing":
      reject(respond, "nexus_not_found", result.outcome.replace(/_/g, " "));
      return true;
    case "conflict":
    case "current_changed":
      reject(respond, "nexus_revision_conflict", "it changed; reload it");
      return true;
    case "invalid":
      reject(respond, "nexus_invalid_params", String(result.code));
      return true;
    case "owner_closed":
    case "executive_work":
    case "work_changed":
    case "not_draft":
    case "not_accepted":
    case "plan_exists":
    case "gaps":
    case "already_final":
    case "not_paused":
    case "is_blocked":
    case "manual_pause_kept":
    case "not_blocked":
      reject(respond, "nexus_schedule_state", result.outcome.replace(/_/g, " "));
      return true;
    default:
      return false;
  }
}

function parseGaps(raw: unknown): PlanGap[] | undefined | "invalid" {
  if (raw === undefined) {
    return undefined;
  }
  return Array.isArray(raw) ? (raw as PlanGap[]) : "invalid";
}

/** Returns [method, handler, scope] triples; the caller registers them. */
export function createScheduleRpcHandlers(deps: ScheduleRpcDeps) {
  const now = deps.now ?? Date.now;
  const ready = deps.dispatchReady ?? scheduledDispatchReady;
  const guarded = createGuard(deps);

  const announce = (principal: Principal, workId: string | undefined, action: string): void => {
    if (workId) {
      deps.events.workChanged({ ownerId: principal.ownerId, workId, action });
    }
  };
  /** The Work that carries a schedule, read after a change so the page that shows it can re-read. */
  const workOfSchedule = async (
    store: TaskStore,
    principal: Principal,
    scheduleId: string,
  ): Promise<string | undefined> => {
    const got = await store.scheduleGet({ principal, scheduleId });
    return got.outcome === "ok" ? got.schedule.workId : undefined;
  };

  const methods: (readonly [string, GatewayRequestHandler, "operator.read" | "operator.write"])[] =
    [
      // ------------------------------------------------------------------ plans: read
      [
        "nexus.delegation.get",
        guarded(async ({ principal, store, params, respond }) => {
          const planId = idOf(params.planId);
          if (!planId) {
            reject(respond, "nexus_invalid_params", "planId is required");
            return;
          }
          const out = await store.delegationPlanGet({ principal, planId });
          if (refuse(respond, out)) {
            return;
          }
          respond(true, { ownerId: principal.ownerId, ...out });
        }),
        "operator.read",
      ],
      [
        "nexus.delegation.list",
        guarded(async ({ principal, store, params, respond }) => {
          const type = params.planOwnerType;
          if (type !== undefined && !(PLAN_OWNER_TYPES as readonly unknown[]).includes(type)) {
            reject(respond, "nexus_invalid_params", "planOwnerType is not known");
            return;
          }
          const out = await store.delegationPlanList({
            principal,
            ...(type !== undefined ? { planOwnerType: type as PlanOwnerType } : {}),
            ...(idOf(params.planOwnerId)
              ? { planOwnerId: idOf(params.planOwnerId) as string }
              : {}),
            ...(idOf(params.workId) ? { workId: idOf(params.workId) as string } : {}),
            ...(Array.isArray(params.statuses)
              ? { statuses: params.statuses.filter((s): s is string => typeof s === "string") }
              : {}),
            ...(intOf(params.limit) ? { limit: intOf(params.limit) as number } : {}),
          });
          respond(true, { ownerId: principal.ownerId, ...out });
        }),
        "operator.read",
      ],
      [
        "nexus.delegation.carrier",
        guarded(async ({ principal, store, params, respond }) => {
          const commitmentId = idOf(params.commitmentId);
          if (!commitmentId) {
            reject(respond, "nexus_invalid_params", "commitmentId is required");
            return;
          }
          const out = await store.delegationCarrier({ principal, commitmentId });
          if (refuse(respond, out)) {
            return;
          }
          respond(true, { ownerId: principal.ownerId, ...out });
        }),
        "operator.read",
      ],
      // ------------------------------------------------------------------ plans: write
      [
        "nexus.delegation.create",
        guarded(async ({ principal, store, params, respond }) => {
          const workId = idOf(params.workId);
          const planOwnerId = idOf(params.planOwnerId);
          const gaps = parseGaps(params.gaps);
          if (
            !workId ||
            !planOwnerId ||
            !(PLAN_OWNER_TYPES as readonly unknown[]).includes(params.planOwnerType) ||
            typeof params.purpose !== "string" ||
            (params.plan !== undefined && !isObject(params.plan)) ||
            gaps === "invalid" ||
            (params.startIntent !== undefined &&
              !(START_INTENTS as readonly unknown[]).includes(params.startIntent)) ||
            (params.requestRef !== undefined && !idOf(params.requestRef)) ||
            (params.replacesPlanId !== undefined && !idOf(params.replacesPlanId))
          ) {
            reject(
              respond,
              "nexus_invalid_params",
              "workId, planOwnerType, planOwnerId and purpose are required; plan must be an object",
            );
            return;
          }
          const out = await store.delegationPlanCreate({
            principal,
            workId,
            planOwnerType: params.planOwnerType as PlanOwnerType,
            planOwnerId,
            purpose: params.purpose,
            ...(params.plan !== undefined ? { plan: params.plan as PlanBody } : {}),
            ...(params.startIntent !== undefined
              ? { startIntent: params.startIntent as StartIntent }
              : {}),
            ...(gaps ? { gaps } : {}),
            ...(params.replacesPlanId !== undefined
              ? { replacesPlanId: params.replacesPlanId as string }
              : {}),
            ...(params.requestRef !== undefined ? { requestRef: params.requestRef as string } : {}),
            createdBy: "user",
            now: now(),
          });
          if (refuse(respond, out)) {
            return;
          }
          if (out.outcome === "created") {
            announce(principal, workId, "plan");
          }
          respond(true, { ownerId: principal.ownerId, ...out });
        }),
        "operator.write",
      ],
      [
        "nexus.delegation.update",
        guarded(async ({ principal, store, params, respond }) => {
          const planId = idOf(params.planId);
          const expectedPlanVersion = intOf(params.expectedPlanVersion);
          const changes = params.changes;
          const gaps = isObject(changes) ? parseGaps(changes.gaps) : undefined;
          if (
            !planId ||
            expectedPlanVersion === undefined ||
            !isObject(changes) ||
            gaps === "invalid" ||
            (changes.plan !== undefined && !isObject(changes.plan)) ||
            (changes.purpose !== undefined && typeof changes.purpose !== "string") ||
            (changes.startIntent !== undefined &&
              !(START_INTENTS as readonly unknown[]).includes(changes.startIntent))
          ) {
            reject(
              respond,
              "nexus_invalid_params",
              "planId, expectedPlanVersion and changes are required",
            );
            return;
          }
          const out = await store.delegationPlanUpdate({
            principal,
            planId,
            expectedPlanVersion,
            changes: {
              ...(changes.purpose !== undefined ? { purpose: changes.purpose as string } : {}),
              ...(changes.plan !== undefined ? { plan: changes.plan as PlanBody } : {}),
              ...(changes.startIntent !== undefined
                ? { startIntent: changes.startIntent as StartIntent }
                : {}),
              ...(gaps ? { gaps } : {}),
            },
            now: now(),
          });
          if (refuse(respond, out)) {
            return;
          }
          if (out.outcome === "updated") {
            announce(principal, out.plan?.workId, "plan");
          }
          respond(true, { ownerId: principal.ownerId, ...out });
        }),
        "operator.write",
      ],
      [
        "nexus.delegation.confirm",
        guarded(async ({ principal, store, params, respond }) => {
          const planId = idOf(params.planId);
          const expectedPlanVersion = intOf(params.expectedPlanVersion);
          const replaces = params.replaces;
          const replaceId = isObject(replaces) ? idOf(replaces.planId) : undefined;
          const replaceVersion = isObject(replaces) ? intOf(replaces.planVersion) : undefined;
          if (
            !planId ||
            expectedPlanVersion === undefined ||
            (replaces !== undefined && (!replaceId || replaceVersion === undefined))
          ) {
            reject(
              respond,
              "nexus_invalid_params",
              "planId and expectedPlanVersion are required; replaces needs planId and planVersion",
            );
            return;
          }
          const out = await store.delegationPlanConfirm({
            principal,
            planId,
            expectedPlanVersion,
            ...(replaceId && replaceVersion !== undefined
              ? { replaces: { planId: replaceId, planVersion: replaceVersion } }
              : {}),
            dispatchReady: ready(),
            now: now(),
          });
          if (refuse(respond, out)) {
            return;
          }
          if (out.outcome === "accepted") {
            announce(principal, out.plan.workId, "plan_accepted");
          }
          respond(true, { ownerId: principal.ownerId, dispatchReady: ready(), ...out });
        }),
        "operator.write",
      ],
      [
        "nexus.delegation.revoke",
        guarded(async ({ principal, store, params, respond }) => {
          const planId = idOf(params.planId);
          if (!planId) {
            reject(respond, "nexus_invalid_params", "planId is required");
            return;
          }
          const out = await store.delegationPlanRevoke({
            principal,
            planId,
            ...(intOf(params.expectedPlanVersion) !== undefined
              ? { expectedPlanVersion: intOf(params.expectedPlanVersion) as number }
              : {}),
            now: now(),
          });
          if (refuse(respond, out)) {
            return;
          }
          if (out.outcome === "revoked") {
            announce(principal, out.plan?.workId, "plan");
          }
          respond(true, { ownerId: principal.ownerId, ...out });
        }),
        "operator.write",
      ],
      [
        "nexus.delegation.end",
        guarded(async ({ principal, store, params, respond }) => {
          const planId = idOf(params.planId);
          if (!planId || (params.reason !== undefined && typeof params.reason !== "string")) {
            reject(respond, "nexus_invalid_params", "planId is required; reason must be text");
            return;
          }
          const out = await store.delegationPlanEnd({
            principal,
            planId,
            reason: typeof params.reason === "string" ? params.reason : "",
            ...(intOf(params.expectedPlanVersion) !== undefined
              ? { expectedPlanVersion: intOf(params.expectedPlanVersion) as number }
              : {}),
            now: now(),
          });
          if (refuse(respond, out)) {
            return;
          }
          if (out.outcome === "ended") {
            announce(principal, out.plan?.workId, "plan_ended");
          }
          respond(true, { ownerId: principal.ownerId, ...out });
        }),
        "operator.write",
      ],
      // ------------------------------------------------------------------ schedules: read
      [
        "nexus.schedule.get",
        guarded(async ({ principal, store, params, respond }) => {
          const scheduleId = idOf(params.scheduleId);
          if (!scheduleId) {
            reject(respond, "nexus_invalid_params", "scheduleId is required");
            return;
          }
          const out = await store.scheduleGet({
            principal,
            scheduleId,
            ...(intOf(params.triggers) !== undefined
              ? { triggers: intOf(params.triggers) as number }
              : {}),
          });
          if (refuse(respond, out)) {
            return;
          }
          respond(true, { ownerId: principal.ownerId, dispatchReady: ready(), ...out });
        }),
        "operator.read",
      ],
      [
        "nexus.schedule.list",
        guarded(async ({ principal, store, params, respond }) => {
          const statuses = params.statuses;
          if (
            statuses !== undefined &&
            (!Array.isArray(statuses) ||
              !statuses.every((s) => (SCHEDULE_STATUSES as readonly unknown[]).includes(s)))
          ) {
            reject(respond, "nexus_invalid_params", "statuses must be known schedule statuses");
            return;
          }
          const out = await store.scheduleList({
            principal,
            ...(idOf(params.workId) ? { workId: idOf(params.workId) as string } : {}),
            ...(idOf(params.ownerRef) ? { ownerRef: idOf(params.ownerRef) as string } : {}),
            ...(idOf(params.planId) ? { planId: idOf(params.planId) as string } : {}),
            ...(typeof params.ownerType === "string" ? { ownerType: params.ownerType } : {}),
            ...(statuses ? { statuses: statuses as ScheduleStatus[] } : {}),
            ...(intOf(params.limit) ? { limit: intOf(params.limit) as number } : {}),
          });
          respond(true, { ownerId: principal.ownerId, dispatchReady: ready(), ...out });
        }),
        "operator.read",
      ],
      // ------------------------------------------------------------------ schedules: write
      [
        "nexus.schedule.pause",
        guarded(async ({ principal, store, params, respond }) => {
          const scheduleId = idOf(params.scheduleId);
          if (!scheduleId) {
            reject(respond, "nexus_invalid_params", "scheduleId is required");
            return;
          }
          const out = await store.schedulePause({
            principal,
            scheduleId,
            source: "user",
            ...(intOf(params.expectedRevision) !== undefined
              ? { expectedRevision: intOf(params.expectedRevision) as number }
              : {}),
            now: now(),
          });
          if (refuse(respond, out)) {
            return;
          }
          if (out.outcome === "paused") {
            announce(principal, out.schedule.workId, "schedule");
          }
          respond(true, { ownerId: principal.ownerId, ...out });
        }),
        "operator.write",
      ],
      [
        "nexus.schedule.resume",
        guarded(async ({ principal, store, params, respond }) => {
          const scheduleId = idOf(params.scheduleId);
          if (!scheduleId) {
            reject(respond, "nexus_invalid_params", "scheduleId is required");
            return;
          }
          const out = await store.scheduleResume({
            principal,
            scheduleId,
            by: "user",
            dispatchReady: ready(),
            ...(intOf(params.expectedRevision) !== undefined
              ? { expectedRevision: intOf(params.expectedRevision) as number }
              : {}),
            now: now(),
          });
          if (out.outcome === "gaps") {
            // The real gaps go back with the refusal so the page can say what is missing.
            respond(true, { ownerId: principal.ownerId, ...out });
            return;
          }
          if (refuse(respond, out)) {
            return;
          }
          announce(principal, await workOfSchedule(store, principal, scheduleId), "schedule");
          respond(true, { ownerId: principal.ownerId, ...out });
        }),
        "operator.write",
      ],
      [
        "nexus.schedule.cancel",
        guarded(async ({ principal, store, params, respond }) => {
          const scheduleId = idOf(params.scheduleId);
          if (!scheduleId || (params.reason !== undefined && typeof params.reason !== "string")) {
            reject(respond, "nexus_invalid_params", "scheduleId is required; reason must be text");
            return;
          }
          const out = await store.scheduleCancel({
            principal,
            scheduleId,
            ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
            ...(intOf(params.expectedRevision) !== undefined
              ? { expectedRevision: intOf(params.expectedRevision) as number }
              : {}),
            now: now(),
          });
          if (refuse(respond, out)) {
            return;
          }
          if ("schedule" in out) {
            announce(principal, out.schedule.workId, "schedule");
          }
          respond(true, { ownerId: principal.ownerId, ...out });
        }),
        "operator.write",
      ],
      [
        "nexus.schedule.unblock",
        guarded(async ({ principal, store, params, respond }) => {
          // "Check again": every prerequisite is looked at once more; nothing old is replayed.
          const scheduleId = idOf(params.scheduleId);
          if (!scheduleId) {
            reject(respond, "nexus_invalid_params", "scheduleId is required");
            return;
          }
          const out = await store.scheduleUnblock({
            principal,
            scheduleId,
            dispatchReady: ready(),
            now: now(),
          });
          if (refuse(respond, out)) {
            return;
          }
          if ("schedule" in out) {
            announce(principal, out.schedule.workId, "schedule");
          }
          respond(true, { ownerId: principal.ownerId, dispatchReady: ready(), ...out });
        }),
        "operator.write",
      ],
      // ------------------------------------------------------------------ goal letter policy
      [
        "nexus.goal.briefing.get",
        guarded(async ({ principal, store, params, respond }) => {
          const goalId = idOf(params.goalId);
          if (!goalId) {
            reject(respond, "nexus_invalid_params", "goalId is required");
            return;
          }
          const out = await store.goalBriefingGet({ principal, goalId });
          if (refuse(respond, out)) {
            return;
          }
          respond(true, { ownerId: principal.ownerId, ...out });
        }),
        "operator.read",
      ],
      [
        "nexus.goal.briefing.set",
        guarded(async ({ principal, store, params, respond }) => {
          const goalId = idOf(params.goalId);
          const cadence = params.cadence;
          if (
            !goalId ||
            typeof params.enabled !== "boolean" ||
            (cadence !== undefined && cadence !== null && !isObject(cadence))
          ) {
            reject(respond, "nexus_invalid_params", "goalId and enabled are required");
            return;
          }
          const out = await store.goalBriefingSet({
            principal,
            goalId,
            enabled: params.enabled,
            ...(cadence !== undefined
              ? { cadence: cadence as { kind: "weekly"; weekday: number } | null }
              : {}),
            ...(intOf(params.expectedVersion) !== undefined
              ? { expectedVersion: intOf(params.expectedVersion) as number }
              : {}),
            now: now(),
          });
          if (refuse(respond, out)) {
            return;
          }
          respond(true, { ownerId: principal.ownerId, ...out });
        }),
        "operator.write",
      ],
    ];
  return methods;
}
