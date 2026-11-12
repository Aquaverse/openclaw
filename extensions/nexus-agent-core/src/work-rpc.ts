// Gateway RPC for Works (design 10.2, slice W1): nexus.work.list / get / counts / create / update / setGoal / link / unlink /
// control / delete / recordOutcome / integrity. Read methods need operator.read, writes operator.write. The console is the user:
// the end-fact methods (stop, end partial) take their `decisionRef` from the request itself. Replies carry ownerId.
import type { EventBridge } from "./events.js";
import { createGuard, reject, type GatewayRequestHandler, type TaskRpcDeps } from "./rpc.js";
import { scheduledDispatchReady } from "./schedule/host-capability.js";
import { CONTEXT_MODES, WORK_PRIMARY_STATES, type ContextMode } from "./work/types.js";

export type WorkRpcDeps = Pick<TaskRpcDeps, "getStore" | "resolvePrincipal" | "now"> & {
  events: EventBridge;
  /** Overrides the host check (tests only); by default whether the host can start scheduled checks. */
  dispatchReady?: () => boolean;
};

const LIST_LIMIT_MAX = 200;
const TEXT_MAX = 300;

/** An optional short string: the string, `undefined` when absent, `null` when present but not a string within the limit. */
const text = (raw: unknown, max: number): string | undefined | null =>
  raw === undefined || raw === null
    ? undefined
    : typeof raw === "string" && raw.length <= max
      ? raw
      : null;
const id = (raw: unknown): string | undefined =>
  typeof raw === "string" && /^[A-Za-z0-9_#:.-]{1,200}$/.test(raw) ? raw : undefined;
const mode = (raw: unknown): ContextMode | undefined | "invalid" =>
  raw === undefined
    ? undefined
    : (CONTEXT_MODES as readonly unknown[]).includes(raw)
      ? (raw as ContextMode)
      : "invalid";

export function createWorkRpcHandlers(deps: WorkRpcDeps) {
  const now = deps.now ?? Date.now;
  const guarded = createGuard(deps);
  const dispatchReady = deps.dispatchReady ?? scheduledDispatchReady;
  const notFound = "work not found";

  const methods: (readonly [string, GatewayRequestHandler, "operator.read" | "operator.write"])[] =
    [
      [
        "nexus.work.list",
        guarded(async ({ principal, store, params, respond }) => {
          const keyword = text(params.keyword, 200);
          const contextMode = mode(params.contextMode);
          const states = params.states;
          if (
            keyword === null ||
            (params.order !== undefined && params.order !== "recent" && params.order !== "state") ||
            contextMode === "invalid" ||
            (states !== undefined &&
              !(
                Array.isArray(states) &&
                states.every((s) => (WORK_PRIMARY_STATES as readonly unknown[]).includes(s))
              ))
          ) {
            reject(
              respond,
              "nexus_invalid_params",
              "states must be known work states; keyword, contextMode and order must be valid",
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
          const goalId = params.goalId === undefined ? undefined : id(params.goalId);
          if (params.goalId !== undefined && !goalId) {
            reject(respond, "nexus_invalid_params", "goalId is malformed");
            return;
          }
          const result = await store.workList({
            principal,
            now: now(),
            ...(states ? { states: states as string[] } : {}),
            includeHidden: params.includeHidden === true,
            includeArchived: params.includeArchived === true,
            ...(goalId ? { goalId } : {}),
            ...(contextMode ? { contextMode } : {}),
            ...(keyword ? { keyword } : {}),
            ...(params.order === "state" ? { order: "state" as const } : {}),
            limit,
            offset,
          });
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.read",
      ],
      [
        "nexus.work.get",
        guarded(async ({ principal, store, params, respond }) => {
          const workId = id(params.workId);
          if (!workId) {
            reject(respond, "nexus_invalid_params", "workId is required");
            return;
          }
          const detail = await store.workGet({ principal, workId, now: now(), eventLimit: 50 });
          if (!detail) {
            reject(respond, "nexus_not_found", notFound);
            return;
          }
          respond(true, { ownerId: principal.ownerId, ...detail });
        }),
        "operator.read",
      ],
      [
        "nexus.work.counts",
        guarded(async ({ principal, store, params, respond }) => {
          const top =
            typeof params.top === "number" && params.top >= 0
              ? Math.min(Math.floor(params.top), 20)
              : 3;
          const keyword = text(params.keyword, 200);
          if (keyword === null) {
            reject(
              respond,
              "nexus_invalid_params",
              "keyword must be text of at most 200 characters",
            );
            return;
          }
          respond(true, {
            ownerId: principal.ownerId,
            ...(await store.workCounts({
              principal,
              now: now(),
              top,
              ...(keyword ? { keyword } : {}),
            })),
          });
        }),
        "operator.read",
      ],
      [
        "nexus.work.integrity",
        guarded(async ({ principal, store, respond }) => {
          respond(true, {
            ownerId: principal.ownerId,
            ...(await store.workIntegrity({ principal, now: now() })),
          });
        }),
        "operator.read",
      ],
      [
        "nexus.work.create",
        guarded(async ({ principal, store, params, respond }) => {
          const title = typeof params.title === "string" ? params.title.trim() : "";
          const requestText = text(params.requestText, 4000);
          const outcomeText = text(params.outcomeText, 4000);
          const requestRef = text(params.requestRef, 200);
          const contextMode = mode(params.contextMode);
          if (
            !title ||
            title.length > TEXT_MAX ||
            requestText === null ||
            outcomeText === null ||
            requestRef === null ||
            contextMode === "invalid"
          ) {
            reject(
              respond,
              "nexus_invalid_params",
              "title is required (at most 300 characters); texts are limited to 4000",
            );
            return;
          }
          const result = await store.workCreate({
            principal,
            spec: {
              title,
              origin: "user",
              ...(requestText ? { requestText } : {}),
              ...(outcomeText ? { outcomeText } : {}),
              ...(requestRef ? { requestRef } : {}),
              ...(contextMode ? { contextMode } : {}),
            },
            now: now(),
          });
          deps.events.workChanged({
            ownerId: principal.ownerId,
            workId: result.workId,
            action: "created",
          });
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.work.update",
        guarded(async ({ principal, store, params, respond }) => {
          const workId = id(params.workId);
          const title = text(params.title, TEXT_MAX);
          const outcomeText = text(params.outcomeText, 4000);
          if (!workId || title === null || outcomeText === null) {
            reject(
              respond,
              "nexus_invalid_params",
              "workId is required; title and outcomeText must be short strings",
            );
            return;
          }
          const result = await store.workUpdate({
            principal,
            workId,
            patch: {
              ...(title !== undefined ? { title } : {}),
              ...(params.outcomeText !== undefined ? { outcomeText: outcomeText ?? null } : {}),
              ...(typeof params.hidden === "boolean" ? { hidden: params.hidden } : {}),
              ...(typeof params.archived === "boolean" ? { archived: params.archived } : {}),
            },
            ...(typeof params.expectedRevision === "number"
              ? { expectedRevision: params.expectedRevision }
              : {}),
            actor: "user",
            now: now(),
          });
          if (result.outcome === "not_found") {
            reject(respond, "nexus_not_found", notFound);
            return;
          }
          if (result.outcome === "revision_conflict") {
            reject(respond, "nexus_revision_conflict", "the work changed; reload it");
            return;
          }
          if (result.outcome === "invalid") {
            reject(respond, "nexus_invalid_params", result.code);
            return;
          }
          if (result.outcome === "updated") {
            deps.events.workChanged({ ownerId: principal.ownerId, workId, action: "updated" });
          }
          respond(true, { ownerId: principal.ownerId, outcome: result.outcome, work: result.work });
        }),
        "operator.write",
      ],
      [
        "nexus.work.setGoal",
        guarded(async ({ principal, store, params, respond }) => {
          const workId = id(params.workId);
          const goalId = params.goalId === null ? null : id(params.goalId);
          const role =
            params.role === undefined
              ? undefined
              : params.role === "primary" || params.role === "reference"
                ? params.role
                : "invalid";
          if (!workId || goalId === undefined || role === "invalid") {
            reject(
              respond,
              "nexus_invalid_params",
              "workId and goalId (or null to clear) are required; role is primary or reference",
            );
            return;
          }
          const result = await store.workSetGoal({
            principal,
            workId,
            goalId,
            ...(role ? { role } : {}),
            actor: "user",
            now: now(),
          });
          if (result.outcome === "not_found" || result.outcome === "goal_not_found") {
            reject(
              respond,
              "nexus_not_found",
              result.outcome === "not_found" ? notFound : "goal not found",
            );
            return;
          }
          if (result.outcome === "executive_work") {
            reject(
              respond,
              "nexus_executive_work",
              "a work in executive use cannot be linked to a personal goal",
            );
            return;
          }
          if (result.outcome === "goal_not_usable") {
            reject(
              respond,
              "nexus_goal_not_usable",
              `goal is ${result.lifecycle} / ${result.status}`,
            );
            return;
          }
          deps.events.workChanged({ ownerId: principal.ownerId, workId, action: "goal" });
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.work.link",
        guarded(async ({ principal, store, params, respond }) => {
          const workId = id(params.workId);
          const targetId = id(params.targetId);
          if (
            !workId ||
            typeof params.role !== "string" ||
            typeof params.targetKind !== "string" ||
            (!targetId && params.targetKind !== "artifact")
          ) {
            reject(
              respond,
              "nexus_invalid_params",
              "workId, role, targetKind and targetId are required",
            );
            return;
          }
          const result = await store.workLinkAdd({
            principal,
            workId,
            role: params.role,
            targetKind: params.targetKind,
            targetId: targetId ?? "",
            ...(typeof params.purpose === "string"
              ? { purpose: params.purpose.slice(0, 200) }
              : {}),
            ...(typeof params.taskPlanVersion === "number"
              ? { taskPlanVersion: params.taskPlanVersion }
              : {}),
            ...(typeof params.outputRef === "string"
              ? { outputRef: params.outputRef.slice(0, 200) }
              : {}),
            ...(typeof params.originalResultId === "string"
              ? { originalResultId: params.originalResultId.slice(0, 200) }
              : {}),
            ...(typeof params.artifactFileId === "string"
              ? { artifactFileId: params.artifactFileId.slice(0, 200) }
              : {}),
            ...(typeof params.artifactVersionSeq === "number"
              ? { artifactVersionSeq: params.artifactVersionSeq }
              : {}),
            actor: "user",
            now: now(),
          });
          if (result.outcome === "not_found" || result.outcome === "target_not_found") {
            reject(
              respond,
              "nexus_not_found",
              result.outcome === "not_found" ? notFound : "link target not found",
            );
            return;
          }
          if (result.outcome === "invalid") {
            reject(respond, "nexus_invalid_params", result.code);
            return;
          }
          if (result.outcome === "file_already_adopted") {
            reject(
              respond,
              "nexus_file_already_adopted",
              "this file already belongs to another work",
            );
            return;
          }
          if (result.outcome === "role_conflict") {
            reject(
              respond,
              "nexus_commitment_already_cited",
              `this work already cites the commitment as ${result.role}; change its role instead`,
            );
            return;
          }
          if (result.outcome === "linked") {
            deps.events.workChanged({ ownerId: principal.ownerId, workId, action: "link" });
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.work.unlink",
        guarded(async ({ principal, store, params, respond }) => {
          const workId = id(params.workId);
          const linkId = id(params.linkId);
          if (!workId || !linkId) {
            reject(respond, "nexus_invalid_params", "workId and linkId are required");
            return;
          }
          const result = await store.workLinkEnd({
            principal,
            workId,
            linkId,
            basis: "user_unlinked",
            actor: "user",
            acknowledgeGap: params.acknowledgeGap === true,
            now: now(),
          });
          if (result.outcome === "not_found") {
            reject(respond, "nexus_not_found", "link not found");
            return;
          }
          if (result.outcome === "gap_ack_required") {
            reject(
              respond,
              "nexus_gap_ack_required",
              "removing a required commitment can make this work look finished; confirm with acknowledgeGap",
            );
            return;
          }
          if (result.outcome === "ended") {
            deps.events.workChanged({ ownerId: principal.ownerId, workId, action: "unlink" });
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.work.control",
        guarded(async ({ principal, store, params, respond }) => {
          const workId = id(params.workId);
          const actions = [
            "pause",
            "resume",
            "stop_follow_up",
            "stop_work",
            "end_partial",
            "reopen",
          ] as const;
          const action = actions.find((a) => a === params.action);
          const reopenBasis = text(params.reopenBasis, 400);
          const reason = text(params.reason, 100);
          if (!workId || !action || reopenBasis === null || reason === null) {
            reject(respond, "nexus_invalid_params", "workId and a known action are required");
            return;
          }
          const requestId = id(params.requestId) ?? `t${now()}`;
          const dryRun = params.dryRun === true;
          const result = await store.workControl({
            principal,
            workId,
            action,
            ...(params.scopeKind === "task" ? { scopeKind: "task" as const } : {}),
            ...(id(params.scopeId) ? { scopeId: id(params.scopeId) as string } : {}),
            ...(reason ? { reason } : {}),
            ...(id(params.controlId) ? { controlId: id(params.controlId) as string } : {}),
            ...(id(params.scheduleId) ? { scheduleId: id(params.scheduleId) as string } : {}),
            dispatchReady: dispatchReady(),
            reconcileOnly: params.reconcileOnly === true,
            decisionRef: `console:${requestId}`,
            ...(reopenBasis ? { reopenBasis } : {}),
            dryRun,
            actor: "user",
            now: now(),
          });
          if (result.outcome === "not_found") {
            reject(respond, "nexus_not_found", notFound);
            return;
          }
          if (result.outcome === "invalid") {
            reject(respond, "nexus_invalid_params", result.code);
            return;
          }
          if (
            !dryRun &&
            ["applied", "released", "ended", "reopened", "follow_up_stopped"].includes(
              result.outcome,
            )
          ) {
            deps.events.workChanged({ ownerId: principal.ownerId, workId, action });
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.work.recordOutcome",
        guarded(async ({ principal, store, params, respond }) => {
          const workId = id(params.workId);
          const reason =
            typeof params.reason === "string" ? params.reason.trim().slice(0, 400) : "";
          if (!workId || !reason) {
            reject(respond, "nexus_invalid_params", "workId and a reason are required");
            return;
          }
          const result = await store.workRecordOutcome({
            principal,
            workId,
            reason,
            actor: "user",
            now: now(),
          });
          if (result.outcome === "not_found") {
            reject(respond, "nexus_not_found", notFound);
            return;
          }
          if (result.outcome === "recorded") {
            deps.events.workChanged({ ownerId: principal.ownerId, workId, action: "outcome" });
          }
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
      [
        "nexus.work.delete",
        guarded(async ({ principal, store, params, respond }) => {
          const workId = id(params.workId);
          if (!workId) {
            reject(respond, "nexus_invalid_params", "workId is required");
            return;
          }
          const result = await store.workDelete({ principal, workId, actor: "user", now: now() });
          if (result.outcome === "not_found") {
            reject(respond, "nexus_not_found", notFound);
            return;
          }
          if (result.outcome === "has_active_tasks") {
            respond(
              false,
              { ownerId: principal.ownerId, tasks: result.tasks },
              {
                code: "nexus_work_has_active_tasks",
                message: "stop or finish the work's active tasks first",
              },
            );
            return;
          }
          deps.events.workChanged({ ownerId: principal.ownerId, workId, action: "deleted" });
          respond(true, { ownerId: principal.ownerId, ...result });
        }),
        "operator.write",
      ],
    ];
  return methods;
}
