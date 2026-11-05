// RT-02: the five mutually exclusive classes over live, visible Works, and the top few of each. With a keyword the classes
// describe what that search finds, so the numbers beside the segments of a searched list add up to the rows.
import type { Principal } from "./types.js";
import type { WorkFactsReader, WorkView } from "./work-facts.js";
import { workKeywordFilter } from "./work-keyword.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

const CLASSES = ["done", "ended_incomplete", "needs_you", "blocked", "in_progress"] as const;

export function createWorkCountsOps(c: Pick<WorkCommon, "all" | "one">, facts: WorkFactsReader) {
  const { all, one } = c;

  const workCounts = (input: {
    principal: Principal;
    now: number;
    top: number;
    /** Count only the Works this search finds; hiddenCount stays the whole account's. */
    keyword?: string;
  }) => {
    const owner = input.principal.ownerId;
    const found = input.keyword ? workKeywordFilter(input.keyword) : undefined;
    const rows = all(
      "SELECT w.* FROM works w WHERE w.owner_id = ? AND w.lifecycle = 'live' AND w.hidden = 0" +
        (found ? ` AND ${found.sql}` : "") +
        " ORDER BY w.updated_at DESC, w.id DESC LIMIT 2000",
      owner,
      ...(found?.params ?? []),
    );
    const views = facts.buildViews(owner, rows, input.now);
    const counts = Object.fromEntries(CLASSES.map((k) => [k, 0])) as Record<
      (typeof CLASSES)[number],
      number
    >;
    const top = Object.fromEntries(CLASSES.map((k) => [k, [] as WorkView[]])) as Record<
      (typeof CLASSES)[number],
      WorkView[]
    >;
    for (const view of views) {
      counts[view.state.primary] += 1;
      if (top[view.state.primary].length < input.top) {
        top[view.state.primary].push(view);
      }
    }
    const hidden = Number(
      (
        one(
          "SELECT COUNT(*) AS c FROM works WHERE owner_id = ? AND lifecycle = 'live' AND hidden = 1",
          owner,
        ) as Row
      ).c,
    );
    return { total: views.length, counts, top, hiddenCount: hidden };
  };

  return { workCounts };
}
