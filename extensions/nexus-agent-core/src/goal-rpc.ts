import { createGoalMetricHandlers } from "./goal-metric-rpc.js";
import { createGoalReviewHandlers } from "./goal-review-rpc.js";
import {
  answerRefusal,
  makeGuarded,
  MAX_LIST,
  needGoalId,
  readId,
  reject,
  SESSION_KEY,
  USER_ENTRY_KINDS,
  USER_LINK_KINDS,
} from "./goal-rpc-support.js";
// Gateway RPC for Goals (Goals design 9.2). Reads are operator.read, edits and the creation click operator.write, the hard
// purge is operator.admin and needs the goal id typed twice. The user's words, the confirmation of an Agent's proposal and the
// tick that completes a goal all enter here: an Agent has its own, much smaller tool surface (src/tools/goal-tools.ts).
import type { GoalService } from "./goal/goal-service.js";
import {
  GOAL_CATEGORIES,
  isOpenGoalCategory,
  type GoalCategory,
  type GoalEntryKind,
  type GoalLinkKind,
  type GoalListInput,
  type GoalSensitivity,
} from "./store/goal-types.js";
import type { Principal } from "./store/types.js";

export const GOAL_OPERATOR_ACTOR = "operator:console";

export type GoalRpcDeps = {
  service: Pick<
    GoalService,
    | "list"
    | "get"
    | "startCreation"
    | "update"
    | "confirm"
    | "complete"
    | "reopen"
    | "remove"
    | "restore"
    | "addEntry"
    | "retractEntry"
    | "addLink"
    | "removeLink"
    | "setMetric"
    | "removeMetric"
    | "setReview"
    | "actReview"
    | "dueReviews"
    | "purge"
    | "purgeStatus"
    | "purgeReceipts"
    | "forFile"
  >;
  resolvePrincipal: () => Principal | undefined;
};

export function createGoalRpcHandlers(deps: GoalRpcDeps) {
  const guarded = makeGuarded(deps.resolvePrincipal);

  const readCategory = (raw: unknown): GoalCategory | undefined | "invalid" => {
    if (raw === undefined) {
      return undefined;
    }
    return typeof raw === "string" && (GOAL_CATEGORIES as readonly string[]).includes(raw)
      ? (raw as GoalCategory)
      : "invalid";
  };

  const own = [
    [
      "nexus.goal.list",
      guarded(async ({ principal, params, respond }) => {
        const category = readCategory(params.category);
        if (category === "invalid") {
          reject(respond, "nexus_invalid_params", "category is not valid");
          return;
        }
        if (
          params.status !== undefined &&
          !["open", "proposed", "active", "completed"].includes(String(params.status))
        ) {
          reject(respond, "nexus_invalid_params", "status must be open|proposed|active|completed");
          return;
        }
        if (
          params.lifecycle !== undefined &&
          params.lifecycle !== "live" &&
          params.lifecycle !== "deleted"
        ) {
          reject(respond, "nexus_invalid_params", "lifecycle must be live|deleted");
          return;
        }
        if (
          params.orderBy !== undefined &&
          params.orderBy !== "manual" &&
          params.orderBy !== "recent"
        ) {
          reject(respond, "nexus_invalid_params", "orderBy must be manual|recent");
          return;
        }
        if (params.query !== undefined && typeof params.query !== "string") {
          reject(respond, "nexus_invalid_params", "query must be text");
          return;
        }
        let parentId: string | null | undefined;
        if (params.parentId === null) {
          parentId = null;
        } else if (params.parentId !== undefined) {
          parentId = readId(params.parentId);
          if (parentId === undefined) {
            reject(respond, "nexus_invalid_params", "parentId is not valid");
            return;
          }
        }
        const limit = params.limit === undefined ? 100 : Number(params.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) {
          reject(respond, "nexus_invalid_params", `limit must be 1..${MAX_LIST}`);
          return;
        }
        const offset = params.offset === undefined ? 0 : Number(params.offset);
        if (!Number.isInteger(offset) || offset < 0) {
          reject(respond, "nexus_invalid_params", "offset must be 0 or more");
          return;
        }
        const input: Omit<GoalListInput, "principal"> = {
          limit,
          offset,
          ...(params.status
            ? { status: params.status as NonNullable<GoalListInput["status"]> }
            : {}),
          ...(params.lifecycle ? { lifecycle: params.lifecycle as "live" | "deleted" } : {}),
          ...(parentId !== undefined ? { parentId } : {}),
          ...(category ? { category } : {}),
          ...(typeof params.query === "string" ? { query: params.query.slice(0, 200) } : {}),
          ...(params.orderBy ? { orderBy: params.orderBy as "manual" | "recent" } : {}),
        };
        const out = await deps.service.list(principal, input);
        respond(true, { ownerId: principal.ownerId, ...out });
      }),
      "operator.read",
    ],
    [
      "nexus.goal.get",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        if (!goalId) {
          return;
        }
        const detail = await deps.service.get(principal, goalId, 200);
        if (!detail) {
          reject(respond, "nexus_not_found", "goal not found");
          return;
        }
        respond(true, { ownerId: principal.ownerId, ...detail });
      }),
      "operator.read",
    ],
    [
      "nexus.goal.forFile",
      guarded(async ({ principal, params, respond }) => {
        const fileId = readId(params.fileId);
        if (!fileId) {
          reject(respond, "nexus_invalid_params", "fileId is required");
          return;
        }
        respond(true, {
          ownerId: principal.ownerId,
          goals: await deps.service.forFile(principal, fileId),
        });
      }),
      "operator.read",
    ],
    [
      "nexus.goal.startCreation",
      guarded(async ({ principal, params, respond }) => {
        if (!isOpenGoalCategory(params.category)) {
          reject(
            respond,
            "nexus_invalid_params",
            "category must be finance|interests|something_else",
          );
          return;
        }
        if (typeof params.sessionKey !== "string" || !SESSION_KEY.test(params.sessionKey)) {
          reject(respond, "nexus_invalid_params", "sessionKey is required");
          return;
        }
        let parentId: string | undefined;
        if (params.parentId !== undefined) {
          parentId = readId(params.parentId);
          if (!parentId) {
            reject(respond, "nexus_invalid_params", "parentId is not valid");
            return;
          }
        }
        const out = await deps.service.startCreation(principal, {
          sessionKey: params.sessionKey,
          category: params.category,
          ...(parentId ? { parentId } : {}),
          issuedBy: GOAL_OPERATOR_ACTOR,
        });
        switch (out.outcome) {
          case "issued":
            respond(true, {
              ownerId: principal.ownerId,
              grant: {
                id: out.grant.id,
                category: out.grant.category,
                parentId: out.grant.parentId,
                expiresAt: out.grant.expiresAt,
              },
            });
            return;
          case "limit_reached":
            reject(respond, "nexus_limit_reached", `you already have ${out.max} active goals`, {
              max: out.max,
              kind: out.kind,
            });
            return;
          case "parent_invalid":
            reject(
              respond,
              "nexus_conflict",
              `the parent goal cannot take a sub-goal (${out.reason})`,
              {
                reason: out.reason,
              },
            );
            return;
          case "bad_category":
            reject(
              respond,
              "nexus_invalid_params",
              "category must be finance|interests|something_else",
            );
            return;
          case "bad_session":
            reject(respond, "nexus_invalid_params", "sessionKey is not valid");
        }
      }),
      "operator.write",
    ],
    [
      "nexus.goal.update",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        if (!goalId) {
          return;
        }
        const raw = params.patch;
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          reject(respond, "nexus_invalid_params", "patch is required");
          return;
        }
        const p = raw as Record<string, unknown>;
        const textOrNull = (value: unknown): string | null | undefined | "bad" =>
          value === undefined || value === null || typeof value === "string"
            ? (value as string | null | undefined)
            : "bad";
        const summary = textOrNull(p.summary);
        const currentState = textOrNull(p.currentState);
        if (
          (p.title !== undefined && typeof p.title !== "string") ||
          summary === "bad" ||
          currentState === "bad" ||
          (p.sortOrder !== undefined && !Number.isInteger(p.sortOrder)) ||
          (p.sensitivity !== undefined &&
            p.sensitivity !== "normal" &&
            p.sensitivity !== "sensitive")
        ) {
          reject(respond, "nexus_invalid_params", "patch holds a field of the wrong type");
          return;
        }
        const category = readCategory(p.category);
        if (category === "invalid") {
          reject(respond, "nexus_invalid_params", "category is not valid");
          return;
        }
        if (params.expectedRevision !== undefined && !Number.isInteger(params.expectedRevision)) {
          reject(respond, "nexus_invalid_params", "expectedRevision must be an integer");
          return;
        }
        const out = await deps.service.update(principal, {
          goalId,
          patch: {
            ...(p.title !== undefined ? { title: p.title as string } : {}),
            ...(summary !== undefined ? { summary } : {}),
            ...(currentState !== undefined ? { currentState } : {}),
            ...(category ? { category } : {}),
            ...(p.sensitivity ? { sensitivity: p.sensitivity as GoalSensitivity } : {}),
            ...(p.sortOrder !== undefined ? { sortOrder: p.sortOrder as number } : {}),
          },
          ...(params.expectedRevision !== undefined
            ? { expectedRevision: params.expectedRevision as number }
            : {}),
        });
        if (out.outcome === "updated" || out.outcome === "unchanged") {
          respond(true, {
            ownerId: principal.ownerId,
            goal: out.goal,
            changed: out.outcome === "updated",
          });
          return;
        }
        if (!answerRefusal(respond, out)) {
          reject(respond, "nexus_store_error", `unexpected outcome ${out.outcome}`);
        }
      }),
      "operator.write",
    ],
    [
      "nexus.goal.confirm",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        if (!goalId) {
          return;
        }
        let edits: { title?: string; summary?: string; currentState?: string } | undefined;
        if (params.edits !== undefined) {
          const e = params.edits as Record<string, unknown> | null;
          if (
            typeof e !== "object" ||
            e === null ||
            ["title", "summary", "currentState"].some(
              (k) => e[k] !== undefined && typeof e[k] !== "string",
            )
          ) {
            reject(respond, "nexus_invalid_params", "edits holds a field of the wrong type");
            return;
          }
          edits = {
            ...(e.title !== undefined ? { title: e.title as string } : {}),
            ...(e.summary !== undefined ? { summary: e.summary as string } : {}),
            ...(e.currentState !== undefined ? { currentState: e.currentState as string } : {}),
          };
        }
        const out = await deps.service.confirm(principal, {
          goalId,
          actor: GOAL_OPERATOR_ACTOR,
          ...(edits ? { edits } : {}),
        });
        if (out.outcome === "confirmed") {
          respond(true, { ownerId: principal.ownerId, goal: out.goal });
          return;
        }
        if (!answerRefusal(respond, out)) {
          reject(respond, "nexus_store_error", `unexpected outcome ${out.outcome}`);
        }
      }),
      "operator.write",
    ],
    ...(
      [
        ["complete", (principal: Principal, id: string) => deps.service.complete(principal, id)],
        ["reopen", (principal: Principal, id: string) => deps.service.reopen(principal, id)],
      ] as const
    ).map(
      ([name, call]) =>
        [
          `nexus.goal.${name}`,
          guarded(async ({ principal, params, respond }) => {
            const goalId = needGoalId(params, respond);
            if (!goalId) {
              return;
            }
            const out = await call(principal, goalId);
            if (out.outcome === "done" || out.outcome === "unchanged") {
              respond(true, {
                ownerId: principal.ownerId,
                goal: out.goal,
                changed: out.outcome === "done",
              });
              return;
            }
            if (!answerRefusal(respond, out)) {
              reject(respond, "nexus_store_error", `unexpected outcome ${out.outcome}`);
            }
          }),
          "operator.write",
        ] as const,
    ),
    [
      "nexus.goal.delete",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        if (!goalId) {
          return;
        }
        const out = await deps.service.remove(principal, goalId);
        if (out.outcome === "deleted" || out.outcome === "already_deleted") {
          respond(true, { ownerId: principal.ownerId, goal: out.goal, affected: out.affected });
          return;
        }
        if (!answerRefusal(respond, out)) {
          reject(respond, "nexus_store_error", `unexpected outcome ${out.outcome}`);
        }
      }),
      "operator.write",
    ],
    [
      "nexus.goal.restore",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        if (!goalId) {
          return;
        }
        const out = await deps.service.restore(principal, goalId);
        if (out.outcome === "restored") {
          respond(true, { ownerId: principal.ownerId, goal: out.goal, affected: out.affected });
          return;
        }
        if (out.outcome === "not_deleted") {
          reject(respond, "nexus_conflict", `the goal is ${out.lifecycle}, not deleted`, {
            lifecycle: out.lifecycle,
          });
          return;
        }
        if (!answerRefusal(respond, out)) {
          reject(respond, "nexus_store_error", `unexpected outcome ${out.outcome}`);
        }
      }),
      "operator.write",
    ],
    [
      "nexus.goal.entry.add",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        if (!goalId) {
          return;
        }
        if (typeof params.text !== "string" || params.text.trim() === "") {
          reject(respond, "nexus_invalid_params", "text is required");
          return;
        }
        const kind = (params.kind ?? "note") as GoalEntryKind;
        if (!USER_ENTRY_KINDS.has(kind)) {
          reject(respond, "nexus_invalid_params", "kind must be note|milestone");
          return;
        }
        const taskId = params.taskId === undefined ? undefined : readId(params.taskId);
        if (params.taskId !== undefined && !taskId) {
          reject(respond, "nexus_invalid_params", "taskId is not valid");
          return;
        }
        const claimId = params.claimId === undefined ? undefined : readId(params.claimId);
        if (params.claimId !== undefined && !claimId) {
          reject(respond, "nexus_invalid_params", "claimId is not valid");
          return;
        }
        if (params.effectiveAt !== undefined && !Number.isFinite(params.effectiveAt)) {
          reject(respond, "nexus_invalid_params", "effectiveAt must be a time in milliseconds");
          return;
        }
        const out = await deps.service.addEntry(principal, {
          goalId,
          kind,
          text: params.text,
          author: "user",
          ...(taskId ? { taskId } : {}),
          ...(claimId ? { claimId } : {}),
          ...(params.effectiveAt !== undefined
            ? { effectiveAt: params.effectiveAt as number }
            : {}),
        });
        if (out.outcome === "added") {
          respond(true, { ownerId: principal.ownerId, entry: out.entry });
          return;
        }
        if (!answerRefusal(respond, out)) {
          reject(respond, "nexus_store_error", `unexpected outcome ${out.outcome}`);
        }
      }),
      "operator.write",
    ],
    [
      "nexus.goal.entry.retract",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        const entryId = readId(params.entryId);
        if (!goalId) {
          return;
        }
        if (!entryId) {
          reject(respond, "nexus_invalid_params", "entryId is required");
          return;
        }
        const out = await deps.service.retractEntry(principal, { goalId, entryId });
        if (out.outcome === "retracted" || out.outcome === "already_retracted") {
          respond(true, { ownerId: principal.ownerId, entry: out.entry });
          return;
        }
        if (!answerRefusal(respond, out)) {
          reject(respond, "nexus_store_error", `unexpected outcome ${out.outcome}`);
        }
      }),
      "operator.write",
    ],
    [
      "nexus.goal.link.add",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        const refId = readId(params.refId);
        if (!goalId) {
          return;
        }
        if (!USER_LINK_KINDS.has(params.kind as GoalLinkKind) || !refId) {
          reject(respond, "nexus_invalid_params", "kind (task|vault_file) and refId are required");
          return;
        }
        const out = await deps.service.addLink(principal, {
          goalId,
          kind: params.kind as GoalLinkKind,
          refId,
        });
        if (out.outcome === "linked" || out.outcome === "unchanged") {
          respond(true, {
            ownerId: principal.ownerId,
            link: out.link,
            changed: out.outcome === "linked",
          });
          return;
        }
        if (!answerRefusal(respond, out)) {
          reject(respond, "nexus_store_error", `unexpected outcome ${out.outcome}`);
        }
      }),
      "operator.write",
    ],
    [
      "nexus.goal.link.remove",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        const linkId = readId(params.linkId);
        if (!goalId) {
          return;
        }
        if (!linkId) {
          reject(respond, "nexus_invalid_params", "linkId is required");
          return;
        }
        const out = await deps.service.removeLink(principal, { goalId, linkId });
        if (out.outcome === "removed") {
          respond(true, { ownerId: principal.ownerId, removed: true });
          return;
        }
        if (!answerRefusal(respond, out)) {
          reject(respond, "nexus_store_error", `unexpected outcome ${out.outcome}`);
        }
      }),
      "operator.write",
    ],
    [
      "nexus.goal.purgeStatus",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        if (!goalId) {
          return;
        }
        respond(true, {
          ownerId: principal.ownerId,
          ...(await deps.service.purgeStatus(principal, goalId)),
        });
      }),
      "operator.read",
    ],
    [
      "nexus.goal.purgeReceipts",
      guarded(async ({ principal, params, respond }) => {
        const limit = params.limit === undefined ? 50 : Number(params.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) {
          reject(respond, "nexus_invalid_params", `limit must be 1..${MAX_LIST}`);
          return;
        }
        respond(true, {
          ownerId: principal.ownerId,
          receipts: await deps.service.purgeReceipts(principal, limit),
        });
      }),
      "operator.read",
    ],
    [
      "nexus.goal.purge",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        if (!goalId) {
          return;
        }
        if (params.confirmGoalId !== goalId) {
          reject(respond, "nexus_invalid_params", "confirmGoalId must repeat goalId");
          return;
        }
        const out = await deps.service.purge(principal, goalId, GOAL_OPERATOR_ACTOR);
        switch (out.outcome) {
          case "purged":
            respond(true, {
              ownerId: principal.ownerId,
              outcome: "purged",
              receipts: out.receipts,
            });
            return;
          case "not_found":
            reject(respond, "nexus_not_found", "goal not found");
            return;
          case "worker_active":
            reject(
              respond,
              "nexus_conflict",
              "a purge of this goal is already running; check purgeStatus",
              {
                purgeId: out.purgeId,
              },
            );
            return;
          case "lost_lease":
            reject(
              respond,
              "nexus_conflict",
              "the purge was taken over by another worker; check purgeStatus",
              {
                goalId: out.goalId,
              },
            );
            return;
          case "failed":
            // Recorded and resumed by the next maintenance pass.
            reject(respond, "nexus_store_error", out.message);
        }
      }),
      "operator.admin",
    ],
  ] as const;
  return [...own, ...createGoalMetricHandlers(deps), ...createGoalReviewHandlers(deps)] as const;
}
