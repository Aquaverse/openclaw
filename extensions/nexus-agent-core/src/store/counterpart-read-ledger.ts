import type {
  CounterpartRecord,
  CounterpartSummary,
  NameMatch,
  PendingPersonGroup,
  PersonView,
} from "../counterpart/types.js";
// Counterpart reads (object-model design 9, 11.4): one person, the attention-ordered list, name matching, the typed-name group and
// the person view. Read-only: the view is an aggregation over Commitments and Works and owns no state of its own, so a stale
// caller can only see old data.
import { toCommitment, COMMITMENT_SELECT } from "./commitment-common.js";
import type { CounterpartCommon } from "./counterpart-common.js";
import { normalizeName } from "./counterpart-common.js";
import { createNotSameOf, createPossibleSame } from "./counterpart-same.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

export type CounterpartReadDeps = {
  transaction: TransactionRunner;
  c: WorkCommon;
  cp: CounterpartCommon;
};

type Stats = {
  unresolved: number;
  overdue: number;
  needsConfirmation: number;
  earliestDueAt: number | null;
};
const EMPTY: Stats = { unresolved: 0, overdue: 0, needsConfirmation: 0, earliestDueAt: null };
const LIST_MAX = 200;

export function createCounterpartReadOps(deps: CounterpartReadDeps) {
  const { transaction, c, cp } = deps;
  const { one, all } = c;
  const possibleSameOf = createPossibleSame(c);
  const notSameOf = createNotSameOf(c);

  /** Per person: the open or waiting Commitments they answer for. Each Commitment counts once however many Works cite it. */
  const statsFor = (owner: string, now: number, counterpartId?: string): Map<string, Stats> => {
    const rows = all(
      "SELECT responsible_counterpart_id AS id, COUNT(*) AS unresolved, " +
        "SUM(CASE WHEN due_at IS NOT NULL AND due_at < ? THEN 1 ELSE 0 END) AS overdue, " +
        "SUM(CASE WHEN acceptance_state <> 'accepted' THEN 1 ELSE 0 END) AS pending, MIN(due_at) AS earliest " +
        "FROM commitments WHERE owner_id = ? AND responsible_counterpart_id IS NOT NULL AND lifecycle IN ('open','waiting') " +
        (counterpartId ? "AND responsible_counterpart_id = ? " : "") +
        "GROUP BY responsible_counterpart_id",
      ...(counterpartId ? [now, owner, counterpartId] : [now, owner]),
    );
    const out = new Map<string, Stats>();
    for (const row of rows) {
      out.set(String(row.id), {
        unresolved: Number(row.unresolved),
        overdue: Number(row.overdue),
        needsConfirmation: Number(row.pending),
        earliestDueAt: row.earliest === null ? null : Number(row.earliest),
      });
    }
    return out;
  };

  const counterpartGet = (input: { principal: Principal; counterpartId: string; now: number }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = cp.counterpartRow(owner, input.counterpartId);
      if (!row) {
        return { outcome: "not_found" as const };
      }
      const stats =
        statsFor(owner, input.now, input.counterpartId).get(input.counterpartId) ?? EMPTY;
      const summary: CounterpartSummary = { ...cp.toCounterpart(owner, row), ...stats };
      return { outcome: "ok" as const, counterpart: summary };
    });

  const counterpartList = (input: {
    principal: Principal;
    now: number;
    /** Which people the rows are: the live ones (default) or the inactive. The counts always cover both. */
    lifecycle?: "live" | "inactive";
    keyword?: string;
    /** Row order: by attention (default) or by name. */
    order?: "attention" | "name";
    /** Only the people who need a look: something overdue or waiting for confirmation. */
    attention?: boolean;
    includeSelf?: boolean;
    limit: number;
    offset: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const where = ["cp.owner_id = ?", "cp.lifecycle IN ('live','inactive')"];
      const params: (string | number)[] = [owner];
      if (input.includeSelf !== true) {
        where.push(
          "cp.id NOT IN (SELECT self_counterpart_id FROM owner_identity WHERE owner_id = cp.owner_id)",
        );
      }
      const rows = all(`SELECT cp.* FROM counterparts cp WHERE ${where.join(" AND ")}`, ...params);
      const stats = statsFor(owner, input.now);
      const same = possibleSameOf(owner);
      let everyone: CounterpartSummary[] = rows.map((row) =>
        Object.assign(cp.toCounterpart(owner, row), stats.get(String(row.id)) ?? EMPTY, {
          possibleSame: same.get(String(row.id))?.length ?? 0,
        }),
      );
      // Whom to look at first: overdue, then waiting for confirmation, then the earliest due date; names break ties. order:"name" is plain name order.
      everyone.sort(
        (a, b) =>
          (input.order === "name"
            ? 0
            : b.overdue - a.overdue ||
              b.needsConfirmation - a.needsConfirmation ||
              (a.earliestDueAt ?? Infinity) - (b.earliestDueAt ?? Infinity)) ||
          a.displayName.localeCompare(b.displayName, "zh") ||
          a.id.localeCompare(b.id),
      );
      // The search narrows everything, the counts included: the numbers beside the segments describe what it finds.
      const keyword = normalizeName(input.keyword ?? "");
      if (keyword.length > 0) {
        const like = `%${keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        const hit = new Set(
          all(
            `SELECT cp.id FROM counterparts cp WHERE ${where.join(" AND ")} AND (lower(cp.display_name) LIKE ? ESCAPE '\\' OR EXISTS ` +
              "(SELECT 1 FROM counterpart_names n WHERE n.owner_id = cp.owner_id AND n.counterpart_id = cp.id " +
              "AND n.revoked_at IS NULL AND n.name LIKE ? ESCAPE '\\'))",
            ...params,
            like,
            like,
          ).map((row) => String(row.id)),
        );
        everyone = everyone.filter((p) => hit.has(p.id));
      }
      const needsLook = (p: CounterpartSummary) => p.overdue > 0 || p.needsConfirmation > 0;
      const live = everyone.filter((p) => p.lifecycle === "live");
      const inactive = everyone.filter((p) => p.lifecycle === "inactive");
      const counts = {
        all: live.length,
        attention: live.filter(needsLook).length,
        inactive: inactive.length,
      };
      const items =
        input.lifecycle === "inactive"
          ? inactive
          : input.attention === true
            ? live.filter(needsLook)
            : live;
      const limit = Math.min(Math.max(input.limit, 1), LIST_MAX);
      return {
        total: items.length,
        counts,
        items: items.slice(input.offset, input.offset + limit),
      };
    });

  const counterpartResolveName = (input: { principal: Principal; name: string }): NameMatch =>
    transaction(() => cp.resolveName(input.principal.ownerId, input.name));

  /** Typed-name Commitments, grouped by the normalized name. Groups with nothing open are history and stay out of the list. */
  /** How many still-open "several people" commitments a pending group names by id (the rest are counted). */
  const JOINT_SHOWN = 5;

  const counterpartPending = (input: { principal: Principal; now: number }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const rows = all(
        "SELECT id, responsible_raw, lifecycle, due_at, ambiguity_json FROM commitments WHERE owner_id = ? AND responsible_counterpart_id IS NULL ORDER BY created_at, id",
        owner,
      );
      const groups = new Map<string, PendingPersonGroup>();
      for (const row of rows) {
        const raw = String(row.responsible_raw ?? "").trim();
        const key = normalizeName(raw);
        if (key.length === 0) {
          continue;
        }
        let group = groups.get(key);
        if (!group) {
          group = {
            key,
            raw,
            total: 0,
            open: 0,
            overdue: 0,
            earliestDueAt: null,
            commitmentIds: [],
            suggestions: [],
          };
          groups.set(key, group);
        }
        group.total += 1;
        if (row.ambiguity_json != null) {
          group.joint = true;
          if (["open", "waiting"].includes(String(row.lifecycle))) {
            // The still-open ones are what the user can act on from the list (the page shows these as cards).
            group.jointOpen = (group.jointOpen ?? 0) + 1;
            const ids = (group.jointIds ??= []);
            if (ids.length < JOINT_SHOWN) {
              ids.push(String(row.id));
            }
          }
        }
        if (group.commitmentIds.length < 50) {
          group.commitmentIds.push(String(row.id));
        }
        if (["open", "waiting"].includes(String(row.lifecycle))) {
          group.open += 1;
          const due = row.due_at === null ? null : Number(row.due_at);
          if (due !== null) {
            if (due < input.now) {
              group.overdue += 1;
            }
            group.earliestDueAt =
              group.earliestDueAt === null ? due : Math.min(group.earliestDueAt, due);
          }
        }
      }
      const dismissed = new Set(
        all(
          "SELECT normalized_raw FROM counterpart_dismissals WHERE owner_id = ? AND revoked_at IS NULL",
          owner,
        ).map((row) => String(row.normalized_raw)),
      );
      const out = [...groups.values()].filter(
        (group) => group.open > 0 && !dismissed.has(group.key),
      );
      for (const group of out) {
        group.suggestions = cp.resolveName(owner, group.raw).candidates;
      }
      out.sort(
        (a, b) => b.overdue - a.overdue || b.open - a.open || a.raw.localeCompare(b.raw, "zh"),
      );
      return { groups: out };
    });

  const HISTORY_LIMIT = 50;
  const RELATED_LIMIT = 50;

  const counterpartView = (input: { principal: Principal; counterpartId: string; now: number }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = cp.counterpartRow(owner, input.counterpartId);
      if (!row) {
        return { outcome: "not_found" as const };
      }
      const record: CounterpartRecord = cp.toCounterpart(owner, row);
      const order = "ORDER BY c.updated_at DESC, c.id";
      const responsible = all(
        `${COMMITMENT_SELECT} WHERE c.owner_id = ? AND c.responsible_counterpart_id = ? AND c.lifecycle IN ('open','waiting') ${order}`,
        owner,
        input.counterpartId,
      ).map((r: Row) => toCommitment(r, input.now));
      const history = all(
        `${COMMITMENT_SELECT} WHERE c.owner_id = ? AND c.responsible_counterpart_id = ? AND c.lifecycle IN ('resolved','cancelled') ORDER BY c.updated_at DESC, c.id LIMIT ?`,
        owner,
        input.counterpartId,
        HISTORY_LIMIT,
      ).map((r: Row) => toCommitment(r, input.now));
      // The commitments he helps with (a live link), open ones first: he does not answer for them, so they are not in `responsible`.
      const roles = new Map<string, string[]>();
      for (const r of all(
        "SELECT commitment_id, role FROM commitment_participant_links WHERE owner_id = ? AND counterpart_id = ? AND status <> 'revoked' ORDER BY role",
        owner,
        input.counterpartId,
      )) {
        roles.set(String(r.commitment_id), [
          ...(roles.get(String(r.commitment_id)) ?? []),
          String(r.role),
        ]);
      }
      const assisting = all(
        `${COMMITMENT_SELECT} WHERE c.owner_id = ? AND EXISTS (SELECT 1 FROM commitment_participant_links hl WHERE hl.owner_id = c.owner_id ` +
          "AND hl.commitment_id = c.id AND hl.counterpart_id = ? AND hl.status <> 'revoked') " +
          "ORDER BY CASE WHEN c.lifecycle IN ('open','waiting') THEN 0 ELSE 1 END, c.updated_at DESC, c.id LIMIT ?",
        owner,
        input.counterpartId,
        RELATED_LIMIT,
      ).map((r: Row) => ({
        commitment: toCommitment(r, input.now),
        roles: roles.get(String(r.id)) ?? [],
      }));
      const related = all(
        "SELECT w.id AS work_id, w.title, w.lifecycle, w.updated_at, 'commitment' AS via FROM commitments cm " +
          "JOIN work_links l ON l.owner_id = cm.owner_id AND l.target_kind = 'commitment' AND l.target_id = cm.id AND l.ended_at IS NULL " +
          "JOIN works w ON w.owner_id = l.owner_id AND w.id = l.work_id AND w.lifecycle IN ('live','archived') " +
          "WHERE cm.owner_id = ? AND cm.responsible_counterpart_id = ? " +
          "UNION SELECT w.id, w.title, w.lifecycle, w.updated_at, 'participant' FROM work_participant_links p " +
          "JOIN works w ON w.owner_id = p.owner_id AND w.id = p.work_id AND w.lifecycle IN ('live','archived') " +
          "WHERE p.owner_id = ? AND p.counterpart_id = ? AND p.status <> 'revoked' ORDER BY 4 DESC LIMIT ?",
        owner,
        input.counterpartId,
        owner,
        input.counterpartId,
        RELATED_LIMIT,
      );
      const seen = new Set<string>();
      const works: PersonView["related"] = [];
      for (const r of related) {
        const workId = String(r.work_id);
        if (!seen.has(workId)) {
          seen.add(workId);
          works.push({
            workId,
            title: String(r.title),
            lifecycle: String(r.lifecycle),
            updatedAt: Number(r.updated_at),
            via: String(r.via),
          });
        }
      }
      const stats =
        statsFor(owner, input.now, input.counterpartId).get(input.counterpartId) ?? EMPTY;
      const view: PersonView = {
        counterpart: record,
        responsible,
        history,
        related: works,
        assisting,
        possibleSame: possibleSameOf(owner).get(input.counterpartId) ?? [],
        notSame: notSameOf(owner, input.counterpartId),
        counts: {
          unresolved: stats.unresolved,
          overdue: stats.overdue,
          needsConfirmation: stats.needsConfirmation,
        },
      };
      return { outcome: "ok" as const, view };
    });

  void one;
  return {
    counterpartGet,
    counterpartList,
    counterpartResolveName,
    counterpartPending,
    counterpartView,
  };
}
