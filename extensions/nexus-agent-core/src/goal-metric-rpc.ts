import { answerRefusal, makeGuarded, needGoalId, readId, reject } from "./goal-rpc-support.js";
// Gateway RPC for goal metrics (Goals design 6.2, 9.2): the figures a user keeps on a goal. Console only (operator.write): the
// Agent has no tool that writes a metric. Split from goal-rpc.ts to keep both files short.
import type { GoalService } from "./goal/goal-service.js";
import { resolveLang } from "./i18n.js";
import type { Principal } from "./store/types.js";

export type GoalMetricRpcDeps = {
  service: Pick<GoalService, "setMetric" | "removeMetric">;
  resolvePrincipal: () => Principal | undefined;
};

export function createGoalMetricHandlers(deps: GoalMetricRpcDeps) {
  const guarded = makeGuarded(deps.resolvePrincipal);
  return [
    [
      "nexus.goal.metric.set",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        if (!goalId) {
          return;
        }
        const metricId = params.metricId === undefined ? undefined : readId(params.metricId);
        if (params.metricId !== undefined && !metricId) {
          reject(respond, "nexus_invalid_params", "metricId is not valid");
          return;
        }
        const text = (key: "name" | "unit"): string | undefined | null => {
          const raw = params[key];
          if (raw === undefined) {
            return undefined;
          }
          if (typeof raw !== "string") {
            reject(respond, "nexus_invalid_params", `${key} must be text`);
            return null;
          }
          return raw;
        };
        const figure = (key: "target" | "current"): number | null | undefined | false => {
          const raw = params[key];
          if (raw === undefined || raw === null) {
            return raw;
          }
          if (typeof raw !== "number" || !Number.isFinite(raw)) {
            reject(respond, "nexus_invalid_params", `${key} must be a number or null`);
            return false;
          }
          return raw;
        };
        const name = text("name");
        const unit = text("unit");
        const target = figure("target");
        const current = figure("current");
        if (name === null || unit === null || target === false || current === false) {
          return;
        }
        if (
          params.direction !== undefined &&
          params.direction !== "up" &&
          params.direction !== "down"
        ) {
          reject(respond, "nexus_invalid_params", "direction must be up|down");
          return;
        }
        if (
          params.source !== undefined &&
          params.source !== "manual" &&
          params.source !== "claim"
        ) {
          reject(respond, "nexus_invalid_params", "source must be manual|claim");
          return;
        }
        const taskId = params.taskId === undefined ? undefined : readId(params.taskId);
        const claimId = params.claimId === undefined ? undefined : readId(params.claimId);
        if (
          (params.taskId !== undefined && !taskId) ||
          (params.claimId !== undefined && !claimId)
        ) {
          reject(respond, "nexus_invalid_params", "taskId / claimId is not valid");
          return;
        }
        const out = await deps.service.setMetric(principal, {
          goalId,
          ...(metricId ? { metricId } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(unit !== undefined ? { unit } : {}),
          ...(params.direction ? { direction: params.direction } : {}),
          ...(target !== undefined ? { target } : {}),
          ...(current !== undefined ? { current } : {}),
          ...(params.source ? { source: params.source } : {}),
          ...(taskId ? { taskId } : {}),
          ...(claimId ? { claimId } : {}),
          lang: resolveLang(typeof params.lang === "string" ? params.lang : undefined),
        });
        if (out.outcome === "created" || out.outcome === "updated") {
          respond(true, {
            ownerId: principal.ownerId,
            metric: out.metric,
            created: out.outcome === "created",
            reachedNow: out.reachedNow,
          });
          return;
        }
        if (out.outcome === "name_taken") {
          reject(respond, "nexus_conflict", "a metric with that name already exists", {
            metricId: out.metricId,
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
      "nexus.goal.metric.remove",
      guarded(async ({ principal, params, respond }) => {
        const goalId = needGoalId(params, respond);
        const metricId = readId(params.metricId);
        if (!goalId) {
          return;
        }
        if (!metricId) {
          reject(respond, "nexus_invalid_params", "metricId is required");
          return;
        }
        const out = await deps.service.removeMetric(principal, { goalId, metricId });
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
  ] as const;
}
