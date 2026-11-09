// Counterpart kernel, responsibility moves (design 7.5, 7.6, 9): deactivate / restore a person and claim typed-name Commitments.
// A Commitment follows its person when the name only gets resolved, and starts a new responsibility version (communication and
// acceptance reset, the old version kept as a snapshot) when the person actually changes. One synchronous transaction each.
import {
  COUNTERPART_LIMITS,
  type CounterpartImpact,
  type CounterpartRecord,
} from "../counterpart/types.js";
import type { CommitmentCommon } from "./commitment-common.js";
import { normalizeName, type CounterpartCommon } from "./counterpart-common.js";
import { createReassign } from "./counterpart-reassign.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

export type CounterpartMoveDeps = {
  transaction: TransactionRunner;
  c: WorkCommon;
  k: CommitmentCommon;
  cp: CounterpartCommon;
  fetch: (owner: string, id: string) => CounterpartRecord | undefined;
  reevaluate: (owner: string, commitmentId: string, now: number) => void;
};

const clean = (text: unknown): string => (typeof text === "string" ? text.trim() : "");

export function createCounterpartMoveOps(deps: CounterpartMoveDeps) {
  const { transaction, c, k, cp, fetch, reevaluate } = deps;
  const { one, all, run } = c;

  const reassign = createReassign(c, k);

  const impactOf = (owner: string, id: string): CounterpartImpact => {
    const count = (sql: string): number => Number((one(sql, owner, id) as Row).n);
    const works = all(
      "SELECT DISTINCT w.id AS work_id, w.title FROM commitments cm " +
        "JOIN work_links l ON l.owner_id = cm.owner_id AND l.target_kind = 'commitment' AND l.target_id = cm.id AND l.ended_at IS NULL " +
        "JOIN works w ON w.owner_id = l.owner_id AND w.id = l.work_id AND w.lifecycle IN ('live','archived') " +
        "WHERE cm.owner_id = ? AND cm.responsible_counterpart_id = ? AND cm.lifecycle IN ('open','waiting') ORDER BY w.title",
      owner,
      id,
    ).map((row) => ({ workId: String(row.work_id), title: String(row.title) }));
    return {
      contacts: cp.contactsOf(owner, id).length,
      openCommitments: count(
        "SELECT COUNT(*) AS n FROM commitments WHERE owner_id = ? AND responsible_counterpart_id = ? AND lifecycle IN ('open','waiting')",
      ),
      resolvedCommitments: count(
        "SELECT COUNT(*) AS n FROM commitments WHERE owner_id = ? AND responsible_counterpart_id = ? AND lifecycle IN ('resolved','cancelled')",
      ),
      participantLinks:
        count(
          "SELECT COUNT(*) AS n FROM work_participant_links WHERE owner_id = ? AND counterpart_id = ? AND status <> 'revoked'",
        ) +
        count(
          "SELECT COUNT(*) AS n FROM commitment_participant_links WHERE owner_id = ? AND counterpart_id = ? AND status <> 'revoked'",
        ),
      works,
    };
  };

  const counterpartDeactivate = (input: {
    principal: Principal;
    counterpartId: string;
    reason?: string;
    dryRun?: boolean;
    expectedRevision?: number;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = cp.counterpartRow(owner, input.counterpartId);
      if (!row) {
        return { outcome: "not_found" as const };
      }
      if (cp.isSelf(owner, input.counterpartId)) {
        return { outcome: "forbidden" as const, code: "self_identity" };
      }
      if (String(row.lifecycle) !== "live") {
        return { outcome: "closed" as const, lifecycle: String(row.lifecycle) };
      }
      const impact = impactOf(owner, input.counterpartId);
      if (input.dryRun === true) {
        return { outcome: "preview" as const, impact };
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== Number(row.revision)) {
        return { outcome: "revision_conflict" as const, revision: Number(row.revision) };
      }
      const reason = clean(input.reason);
      if (reason.length === 0) {
        return { outcome: "reason_required" as const };
      }
      if (reason.length > COUNTERPART_LIMITS.reason) {
        return { outcome: "invalid" as const, code: "bad_reason" };
      }
      const open = all(
        "SELECT * FROM commitments WHERE owner_id = ? AND responsible_counterpart_id = ? AND lifecycle IN ('open','waiting') ORDER BY created_at, id",
        owner,
        input.counterpartId,
      );
      const name = String(row.display_name);
      for (const commitment of open) {
        reassign(
          owner,
          commitment,
          { counterpartId: null, raw: name },
          "counterpart_deactivated",
          input.now,
        );
      }
      run(
        "UPDATE counterparts SET lifecycle = 'inactive', inactive_reason = ?, inactive_at = ? WHERE owner_id = ? AND id = ?",
        reason,
        input.now,
        owner,
        input.counterpartId,
      );
      cp.bump(owner, input.counterpartId, input.now);
      for (const commitment of open) {
        reevaluate(owner, String(commitment.id), input.now);
      }
      return {
        outcome: "deactivated" as const,
        impact,
        counterpart: fetch(owner, input.counterpartId) as CounterpartRecord,
      };
    });

  const counterpartRestore = (input: {
    principal: Principal;
    counterpartId: string;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = cp.counterpartRow(owner, input.counterpartId);
      if (!row) {
        return { outcome: "not_found" as const };
      }
      if (String(row.lifecycle) !== "inactive") {
        return { outcome: "not_inactive" as const, lifecycle: String(row.lifecycle) };
      }
      run(
        "UPDATE counterparts SET lifecycle = 'live', inactive_reason = NULL, inactive_at = NULL WHERE owner_id = ? AND id = ?",
        owner,
        input.counterpartId,
      );
      cp.bump(owner, input.counterpartId, input.now);
      return {
        outcome: "restored" as const,
        counterpart: fetch(owner, input.counterpartId) as CounterpartRecord,
      };
    });

  /**
   * Point typed-name Commitments at a person. When the name already is one of that person's names (or the user says to remember
   * it), the same responsibility just got identified: no new version. Otherwise it is a different person taking over, and only
   * the open ones move, with a new responsibility version.
   */
  const counterpartClaim = (input: {
    principal: Principal;
    counterpartId: string;
    raw?: string;
    commitmentIds?: string[];
    rememberAlias?: boolean;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const target = cp.counterpartRow(owner, input.counterpartId);
      if (!target || String(target.lifecycle) !== "live") {
        return { outcome: "not_found" as const };
      }
      const key = normalizeName(clean(input.raw));
      const ids = new Set((input.commitmentIds ?? []).map((id) => clean(id)));
      if (key.length === 0 && ids.size === 0) {
        return { outcome: "invalid" as const, code: "nothing_selected" };
      }
      const rows = all(
        "SELECT * FROM commitments WHERE owner_id = ? AND responsible_counterpart_id IS NULL ORDER BY created_at, id",
        owner,
      ).filter(
        (row) =>
          // A commitment whose words named several people waits for the user's choice (design 6.8); no group move settles it.
          row.ambiguity_json == null &&
          (ids.has(String(row.id)) ||
            (key.length > 0 && normalizeName(String(row.responsible_raw ?? "")) === key)),
      );
      if (rows.length === 0) {
        return { outcome: "nothing_to_claim" as const };
      }
      let versioned = 0;
      let resolved = 0;
      const touchedIds: string[] = [];
      for (const row of rows) {
        const raw = String(row.responsible_raw ?? "");
        const rawKey = normalizeName(raw);
        if (
          input.rememberAlias === true &&
          rawKey.length > 0 &&
          !cp.hasName(owner, input.counterpartId, raw)
        ) {
          cp.addName(owner, input.counterpartId, raw, "raw_mention", "claim", input.now);
        }
        const identified = rawKey.length > 0 && cp.hasName(owner, input.counterpartId, raw);
        if (identified) {
          run(
            "UPDATE commitments SET responsible_counterpart_id = ?, responsible_raw = NULL, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
            input.counterpartId,
            input.now,
            owner,
            String(row.id),
          );
          k.appendEvent(
            owner,
            String(row.id),
            "responsible_resolved",
            "user",
            { raw, counterpartId: input.counterpartId, versioned: false },
            input.now,
          );
          resolved += 1;
        } else if (["open", "waiting"].includes(String(row.lifecycle))) {
          reassign(
            owner,
            row,
            { counterpartId: input.counterpartId, raw: null },
            "responsible_claimed",
            input.now,
          );
          versioned += 1;
        } else {
          continue;
        }
        touchedIds.push(String(row.id));
      }
      if (touchedIds.length === 0) {
        return { outcome: "nothing_to_claim" as const };
      }
      const workIds = new Set<string>();
      for (const id of touchedIds) {
        reevaluate(owner, id, input.now);
        for (const link of k.linkedWorks(owner, id)) {
          workIds.add(link.workId);
        }
      }
      cp.bump(owner, input.counterpartId, input.now);
      return {
        outcome: "claimed" as const,
        claimed: touchedIds.length,
        resolved,
        versioned,
        commitmentIds: touchedIds,
        workIds: [...workIds],
      };
    });

  return { counterpartDeactivate, counterpartRestore, counterpartClaim };
}
