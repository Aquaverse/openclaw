// Counterpart kernel, "clear a deleted person" (PRD R-32, FG-01..FG-04). Deleting a person only stops them (lifecycle 'inactive');
// this is the separate step that actually removes what identifies them: the contact methods, the other names and the relations.
//   * The display name stays, so a Commitment's history still reads "who", and the typed names / snapshots on Commitments are
//     not touched. Participant records on works and Commitments stay as they are.
//   * A contact method that another person also holds keeps existing; only this person's attachment to it goes.
//   * The person row becomes lifecycle 'deleted' (cleared): it leaves the cleanup list and cannot be restored.
//   * Every cleared person gets one receipt row with ids, a hash of the name and counts, never a contact or an alias.
// One synchronous transaction for the whole selection; owner_id on every statement.
import { sha256Hex } from "../canonical.js";
import type { CounterpartPurgeReceipt, PurgeImpact } from "../counterpart/types.js";
import { normalizeName, type CounterpartCommon } from "./counterpart-common.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

export type CounterpartPurgeDeps = {
  transaction: TransactionRunner;
  c: WorkCommon;
  cp: CounterpartCommon;
};

export const PURGE_BATCH_MAX = 200;
const RECEIPTS_MAX = 200;

export type PurgeSkipReason = "not_found" | "not_deleted" | "self";
export type PurgeItem = { id: string; displayName: string; impact: PurgeImpact };

const clean = (text: unknown): string => (typeof text === "string" ? text.trim() : "");

const sum = (items: PurgeItem[]): PurgeImpact => {
  const total: PurgeImpact = {
    contacts: 0,
    links: 0,
    sharedContacts: 0,
    aliases: 0,
    relations: 0,
    commitmentsKept: 0,
    participantLinksKept: 0,
  };
  for (const item of items) {
    for (const key of Object.keys(total) as (keyof PurgeImpact)[]) {
      total[key] += item.impact[key];
    }
  }
  return total;
};

export function createCounterpartPurgeOps(deps: CounterpartPurgeDeps) {
  const { transaction, c, cp } = deps;
  const { one, all, run, newId } = c;
  const count = (sql: string, ...args: (string | number | null)[]): number =>
    Number((one(sql, ...args) as Row).n);

  /** Names that go: everything but the one display name that is in use (earlier display names included). */
  const GONE_NAMES = "NOT (name_kind = 'display' AND revoked_at IS NULL)";

  /** Contact methods attached to this person that nobody else is attached to (these are deleted with the person). */
  const ownEndpoints = (owner: string, id: string): string[] =>
    all(
      "SELECT DISTINCT l.endpoint_id FROM identity_links l WHERE l.owner_id = ? AND l.counterpart_id = ? AND NOT EXISTS " +
        "(SELECT 1 FROM identity_links o WHERE o.owner_id = l.owner_id AND o.endpoint_id = l.endpoint_id AND o.counterpart_id <> l.counterpart_id)",
      owner,
      id,
    ).map((row) => String(row.endpoint_id));

  const impactOf = (owner: string, id: string): PurgeImpact => {
    const links = count(
      "SELECT COUNT(*) AS n FROM identity_links WHERE owner_id = ? AND counterpart_id = ?",
      owner,
      id,
    );
    const attached = count(
      "SELECT COUNT(DISTINCT endpoint_id) AS n FROM identity_links WHERE owner_id = ? AND counterpart_id = ?",
      owner,
      id,
    );
    const contacts = ownEndpoints(owner, id).length;
    return {
      contacts,
      links,
      sharedContacts: attached - contacts,
      aliases: count(
        `SELECT COUNT(*) AS n FROM counterpart_names WHERE owner_id = ? AND counterpart_id = ? AND ${GONE_NAMES}`,
        owner,
        id,
      ),
      relations: count(
        "SELECT COUNT(*) AS n FROM counterpart_relations WHERE owner_id = ? AND counterpart_id = ?",
        owner,
        id,
      ),
      commitmentsKept: count(
        "SELECT COUNT(*) AS n FROM commitments WHERE owner_id = ? AND responsible_counterpart_id = ?",
        owner,
        id,
      ),
      participantLinksKept:
        count(
          "SELECT COUNT(*) AS n FROM work_participant_links WHERE owner_id = ? AND counterpart_id = ?",
          owner,
          id,
        ) +
        count(
          "SELECT COUNT(*) AS n FROM commitment_participant_links WHERE owner_id = ? AND counterpart_id = ?",
          owner,
          id,
        ),
    };
  };

  /** Sort the selection into the people who can be cleared (deleted, not yourself) and the ones that cannot, with the reason. */
  const sortOut = (owner: string, ids: string[]) => {
    const items: PurgeItem[] = [];
    const skipped: { id: string; reason: PurgeSkipReason }[] = [];
    for (const id of ids) {
      const row = cp.counterpartRow(owner, id);
      if (!row) {
        skipped.push({ id, reason: "not_found" });
      } else if (cp.isSelf(owner, id)) {
        skipped.push({ id, reason: "self" });
      } else if (String(row.lifecycle) !== "inactive") {
        skipped.push({ id, reason: "not_deleted" });
      } else {
        items.push({ id, displayName: String(row.display_name), impact: impactOf(owner, id) });
      }
    }
    return { items, skipped };
  };

  const counterpartPurge = (input: {
    principal: Principal;
    counterpartIds: string[];
    dryRun?: boolean;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const ids = [
        ...new Set((input.counterpartIds ?? []).map(clean).filter((id) => id.length > 0)),
      ];
      if (ids.length === 0) {
        return { outcome: "invalid" as const, code: "nothing_selected" };
      }
      if (ids.length > PURGE_BATCH_MAX) {
        return { outcome: "invalid" as const, code: "too_many" };
      }
      const { items, skipped } = sortOut(owner, ids);
      if (items.length === 0) {
        return { outcome: "nothing_to_purge" as const, skipped };
      }
      if (input.dryRun === true) {
        return { outcome: "preview" as const, items, skipped, total: sum(items) };
      }
      const requestedBy = input.principal.senderId ?? input.principal.agentId ?? owner;
      const purged: (PurgeItem & { receiptId: string })[] = [];
      for (const item of items) {
        const endpoints = ownEndpoints(owner, item.id);
        run("DELETE FROM identity_links WHERE owner_id = ? AND counterpart_id = ?", owner, item.id);
        for (const endpointId of endpoints) {
          run("DELETE FROM counterpart_endpoints WHERE owner_id = ? AND id = ?", owner, endpointId);
        }
        run(
          `DELETE FROM counterpart_names WHERE owner_id = ? AND counterpart_id = ? AND ${GONE_NAMES}`,
          owner,
          item.id,
        );
        run(
          "DELETE FROM counterpart_relations WHERE owner_id = ? AND counterpart_id = ?",
          owner,
          item.id,
        );
        // The CHECK on the row ties inactive_reason / inactive_at to lifecycle 'inactive', so a cleared person carries neither; the
        // remembered reason of an earlier delete goes too (it is the user's words about this person).
        run(
          "UPDATE counterparts SET lifecycle = 'deleted', inactive_reason = NULL, last_stop_reason = NULL, inactive_at = NULL WHERE owner_id = ? AND id = ?",
          owner,
          item.id,
        );
        // Marks that said "this is not the same person as X" name the cleared person by id: they go with them.
        run(
          "DELETE FROM counterpart_not_same WHERE owner_id = ? AND (low_id = ? OR high_id = ?)",
          owner,
          item.id,
          item.id,
        );
        cp.bump(owner, item.id, input.now);
        const receiptId = newId("cpr_");
        run(
          "INSERT INTO counterpart_purge_receipts (owner_id, id, counterpart_id, name_hash, contact_count, link_count, alias_count, relation_count, requested_by, executed_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          owner,
          receiptId,
          item.id,
          sha256Hex(normalizeName(item.displayName)),
          item.impact.contacts,
          item.impact.links,
          item.impact.aliases,
          item.impact.relations,
          requestedBy,
          input.now,
        );
        purged.push({ ...item, receiptId });
      }
      return { outcome: "purged" as const, purged, skipped, total: sum(items) };
    });

  /** The receipts, newest first. The name stays on the person row, so it can be shown beside the counts. */
  const counterpartPurgeReceipts = (input: {
    principal: Principal;
    limit: number;
    offset: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const limit = Math.min(Math.max(input.limit, 1), RECEIPTS_MAX);
      const rows = all(
        "SELECT r.*, cp.display_name FROM counterpart_purge_receipts r " +
          "LEFT JOIN counterparts cp ON cp.owner_id = r.owner_id AND cp.id = r.counterpart_id " +
          "WHERE r.owner_id = ? ORDER BY r.executed_at DESC, r.id DESC LIMIT ? OFFSET ?",
        owner,
        limit,
        Math.max(input.offset, 0),
      );
      const items: (CounterpartPurgeReceipt & { displayName: string })[] = rows.map((row) => ({
        id: String(row.id),
        counterpartId: String(row.counterpart_id),
        displayName: String(row.display_name ?? ""),
        nameHash: String(row.name_hash),
        contactCount: Number(row.contact_count),
        linkCount: Number(row.link_count),
        aliasCount: Number(row.alias_count),
        relationCount: Number(row.relation_count),
        requestedBy: String(row.requested_by),
        executedAt: Number(row.executed_at),
      }));
      return {
        total: count(
          "SELECT COUNT(*) AS n FROM counterpart_purge_receipts WHERE owner_id = ?",
          owner,
        ),
        items,
      };
    });

  return { counterpartPurge, counterpartPurgeReceipts };
}
