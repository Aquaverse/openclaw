import type { GoalCommon } from "./goal-ledger-common.js";
// Goals kernel, reads: the list (with counts) and the detail of one goal.
import { createGoalLive } from "./goal-live-ledger.js";
import { GOAL_COLUMNS, likeEscape, toEntry, toGoal, type Row } from "./goal-rows.js";
import type {
  GoalDetailRecord,
  GoalGetInput,
  GoalListInput,
  GoalListOutcome,
  GoalSummaryRecord,
} from "./goal-types.js";

export function createGoalReads(c: GoalCommon) {
  const { one, all, goalRow, linksOf } = c;
  const live = createGoalLive(c);

  // ------------------------------------------------------------------ reads

  const SUMMARY_COLUMNS =
    GOAL_COLUMNS.split(", ")
      .map((column) => `g.${column}`)
      .join(", ") +
    ", (SELECT COUNT(*) FROM goals c WHERE c.owner_id = g.owner_id AND c.parent_id = g.id AND c.lifecycle = 'live') AS child_count" +
    ", (SELECT COUNT(*) FROM goal_links l WHERE l.owner_id = g.owner_id AND l.goal_id = g.id) AS link_count" +
    ", (SELECT COUNT(*) FROM goal_entries e WHERE e.owner_id = g.owner_id AND e.goal_id = g.id AND e.retracted_at IS NULL) AS entry_count" +
    ", (SELECT MAX(e.effective_at) FROM goal_entries e WHERE e.owner_id = g.owner_id AND e.goal_id = g.id AND e.retracted_at IS NULL) AS last_entry_at";

  const goalList = (input: GoalListInput): GoalListOutcome => {
    const owner = input.principal.ownerId;
    const where: string[] = ["g.owner_id = ?"];
    const params: (string | number)[] = [owner];
    where.push("g.lifecycle = ?");
    params.push(input.lifecycle ?? "live");
    if (input.status === "open") {
      where.push("g.status IN ('proposed','active')");
    } else if (input.status !== undefined) {
      where.push("g.status = ?");
      params.push(input.status);
    }
    if (input.parentId === null) {
      where.push("g.parent_id IS NULL");
    } else if (input.parentId !== undefined) {
      where.push("g.parent_id = ?");
      params.push(input.parentId);
    }
    if (input.category !== undefined) {
      where.push("g.category = ?");
      params.push(input.category);
    }
    for (const term of (input.query ?? "").split(/\s+/u).filter((part) => part.length > 0)) {
      const like = `%${likeEscape(term)}%`;
      where.push(
        "(g.title LIKE ? ESCAPE '\\' OR COALESCE(g.summary, '') LIKE ? ESCAPE '\\' OR COALESCE(g.current_state, '') LIKE ? ESCAPE '\\')",
      );
      params.push(like, like, like);
    }
    const clause = where.join(" AND ");
    const total = Number(
      (one(`SELECT COUNT(*) AS c FROM goals g WHERE ${clause}`, ...params) as Row).c,
    );
    const order =
      input.orderBy === "recent"
        ? "g.updated_at DESC, g.id"
        : input.status === "completed"
          ? "g.completed_at DESC, g.id"
          : "g.sort_order ASC, g.created_at DESC, g.id";
    const rows = all(
      `SELECT ${SUMMARY_COLUMNS} FROM goals g WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...params,
      input.limit,
      input.offset ?? 0,
    );
    const goals: GoalSummaryRecord[] = rows.map((row) =>
      Object.assign(toGoal(row), {
        childCount: Number(row.child_count),
        linkCount: Number(row.link_count),
        entryCount: Number(row.entry_count),
        lastEntryAt: row.last_entry_at === null ? null : Number(row.last_entry_at),
      }),
    );
    return { goals, total };
  };

  const goalGet = (input: GoalGetInput): GoalDetailRecord | undefined => {
    const owner = input.principal.ownerId;
    const row = goalRow(owner, input.goalId);
    if (!row) {
      return undefined;
    }
    const goal = toGoal(row);
    const limit = Math.min(Math.max(input.entryLimit ?? 50, 1), 200);
    const entryRows = all(
      "SELECT * FROM goal_entries WHERE owner_id = ? AND goal_id = ? ORDER BY effective_at DESC, created_at DESC, id DESC LIMIT ?",
      owner,
      input.goalId,
      limit + 1,
    );
    const parentRow = goal.parentId === null ? undefined : goalRow(owner, goal.parentId);
    return {
      goal,
      parent: parentRow
        ? {
            id: String(parentRow.id),
            title: String(parentRow.title),
            category: toGoal(parentRow).category,
          }
        : null,
      children: all(
        `SELECT ${GOAL_COLUMNS} FROM goals WHERE owner_id = ? AND parent_id = ? AND lifecycle = 'live' ORDER BY sort_order, created_at, id`,
        owner,
        input.goalId,
      ).map(toGoal),
      entries: live.withEntryPointers(owner, entryRows.slice(0, limit).map(toEntry)),
      entriesTruncated: entryRows.length > limit,
      links: live.withLinkTasks(owner, linksOf(owner, input.goalId)),
      metrics: live.metricsOf(owner, input.goalId),
    };
  };

  return {
    goalList,
    goalGet,
  };
}
