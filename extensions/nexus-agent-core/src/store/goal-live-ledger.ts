import type { ClaimState } from "./claim-types.js";
// Goals kernel, live state (Goals design 6.1 / 6.2): what the Task and the claim behind an entry, a link or a metric look like
// RIGHT NOW. Nothing here is stored: a pointer's label is read at get time, so a refuted claim or a purged Task changes the
// label and never the text. Read-only; every statement filters on owner_id.
import type { GoalCommon } from "./goal-ledger-common.js";
import { toMetric, type Row } from "./goal-rows.js";
import type {
  GoalEntryRecord,
  GoalLinkRecord,
  GoalMetricRecord,
  GoalPointerState,
} from "./goal-types.js";

/** A number out of a claim value: the number itself, or `{ value: n }` / `{ amount: n }`. Anything else is not a figure. */
export function claimFigure(raw: unknown): number | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["value", "amount"]) {
      const candidate = record[key];
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function createGoalLive(c: Pick<GoalCommon, "one" | "all">) {
  const { one, all } = c;

  /** Resolves pointers with a per-call cache, so a goal with many entries on one Task asks the database once. */
  const resolver = (owner: string) => {
    const tasks = new Map<string, Row | undefined>();
    const claims = new Map<string, Row | undefined>();
    const task = (id: string): Row | undefined => {
      if (!tasks.has(id)) {
        tasks.set(
          id,
          one(
            "SELECT status, title FROM nexus_tasks WHERE owner_id = ? AND id = ? AND purged_at IS NULL",
            owner,
            id,
          ),
        );
      }
      return tasks.get(id);
    };
    const claim = (taskId: string, id: string): Row | undefined => {
      const key = `${taskId}/${id}`;
      if (!claims.has(key)) {
        claims.set(
          key,
          one(
            "SELECT state, value_json, updated_at FROM claims WHERE owner_id = ? AND task_id = ? AND id = ?",
            owner,
            taskId,
            id,
          ),
        );
      }
      return claims.get(key);
    };
    const pointer = (taskId: string, claimId: string | null): GoalPointerState => {
      const t = task(taskId);
      const cl = claimId === null || !t ? undefined : claim(taskId, claimId);
      return {
        taskGone: !t,
        taskStatus: t ? String(t.status) : null,
        taskTitle: t ? String(t.title) : null,
        claimState: cl ? (String(cl.state) as ClaimState) : null,
        claimGone: claimId !== null && !cl,
      };
    };
    return { task, claim, pointer };
  };

  const withEntryPointers = (owner: string, entries: GoalEntryRecord[]): GoalEntryRecord[] => {
    const resolve = resolver(owner);
    return entries.map((entry) =>
      entry.taskId === null
        ? entry
        : Object.assign(entry, { pointer: resolve.pointer(entry.taskId, entry.claimId) }),
    );
  };

  const withLinkTasks = (owner: string, links: GoalLinkRecord[]): GoalLinkRecord[] => {
    const resolve = resolver(owner);
    return links.map((link) => {
      if (link.kind !== "task") {
        return link;
      }
      const t = resolve.task(link.refId);
      return t
        ? Object.assign(link, { task: { status: String(t.status), title: String(t.title) } })
        : link;
    });
  };

  /** Metrics of a goal; a `claim` metric gets its figure and pointer state from the claim as it is now. */
  const metricsOf = (owner: string, goalId: string): GoalMetricRecord[] => {
    const resolve = resolver(owner);
    return all(
      "SELECT * FROM goal_metrics WHERE owner_id = ? AND goal_id = ? ORDER BY created_at, id",
      owner,
      goalId,
    ).map((row) => {
      const metric = toMetric(row);
      if (metric.source !== "claim" || metric.taskId === null || metric.claimId === null) {
        return metric;
      }
      const state = resolve.pointer(metric.taskId, metric.claimId);
      const live = resolve.claim(metric.taskId, metric.claimId);
      return Object.assign(metric, {
        current: live ? claimFigure(live.value_json) : null,
        asOf: live ? Number(live.updated_at) : null,
        pointer: state,
      });
    });
  };

  return { withEntryPointers, withLinkTasks, metricsOf };
}
