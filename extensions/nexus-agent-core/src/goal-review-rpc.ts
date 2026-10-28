// Gateway RPC for the review reminder layer (Goals G3a). Console only: the user sets the cadence, says "reviewed" or "later",
// and the console asks which goals are due (the nav badge). Split from goal-rpc.ts to keep both files short.
import { answerRefusal, makeGuarded, needGoalId, reject } from "./goal-rpc-support.js";
import type { GoalService } from "./goal/goal-service.js";
import { resolveLang } from "./i18n.js";
import { GOAL_REVIEW_CADENCES, type GoalReviewCadence } from "./store/goal-types.js";
import type { Principal } from "./store/types.js";

export type GoalReviewRpcDeps = {
  service: Pick<GoalService, "setReview" | "actReview" | "dueReviews">;
  resolvePrincipal: () => Principal | undefined;
};

export function createGoalReviewHandlers(deps: GoalReviewRpcDeps) {
  const guarded = makeGuarded(deps.resolvePrincipal);
  return [
    [
      "nexus.goal.review.set",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        if (!goalId) {
          return;
        }
        const raw = params.cadence;
        if (raw !== null && !(GOAL_REVIEW_CADENCES as readonly unknown[]).includes(raw)) {
          reject(respond, "nexus_invalid_params", "cadence must be weekly|biweekly|monthly|null");
          return;
        }
        const out = await deps.service.setReview(
          principal,
          goalId,
          raw as GoalReviewCadence | null,
        );
        if (out.outcome === "set") {
          respond(true, { ownerId: principal.ownerId, review: out.plan });
          return;
        }
        if (out.outcome === "cleared") {
          respond(true, { ownerId: principal.ownerId, review: null });
          return;
        }
        if (!answerRefusal(respond, out)) {
          reject(respond, "nexus_store_error", `unexpected outcome ${out.outcome}`);
        }
      }),
      "operator.write",
    ],
    [
      "nexus.goal.review.act",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        if (!goalId) {
          return;
        }
        if (params.action !== "done" && params.action !== "snooze") {
          reject(respond, "nexus_invalid_params", "action must be done|snooze");
          return;
        }
        const out = await deps.service.actReview(
          principal,
          goalId,
          params.action,
          resolveLang(typeof params.lang === "string" ? params.lang : undefined),
        );
        if (out.outcome === "done" || out.outcome === "snoozed") {
          respond(true, { ownerId: principal.ownerId, review: out.plan, action: params.action });
          return;
        }
        if (out.outcome === "no_plan") {
          reject(respond, "nexus_conflict", "the goal has no review cadence");
          return;
        }
        if (!answerRefusal(respond, out)) {
          reject(respond, "nexus_store_error", `unexpected outcome ${out.outcome}`);
        }
      }),
      "operator.write",
    ],
    [
      "nexus.goal.review.due",
      guarded(async ({ principal, respond }) => {
        const due = await deps.service.dueReviews(principal);
        respond(true, { ownerId: principal.ownerId, due, count: due.length });
      }),
      "operator.read",
    ],
  ] as const;
}
