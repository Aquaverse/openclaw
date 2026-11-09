import { likePairs } from "../commitment/likeness.js";
// Counterpart kernel, identity corrections (design 7.5, 7.6): merge two records of the SAME person, and say a typed name "is not a
// person". Each method is one synchronous transaction with a dry-run preview; the preview lists what would be reached and the
// real call needs the same facts the user saw. Nothing here sends a message or reads an account.
//   * merge: the Commitments move to the person who stays WITHOUT a new responsibility version (it is the same person), the
//     names join, shared contacts become one, a relation the two disagree on is the user's choice, and the old record stays
//     as a tombstone (`merged_into`). Two independent Commitments are never merged into one.
//   * not a person: the name becomes an organization or team record, or the Commitments become the user's own, or the name is
//     remembered as pointing at nobody.
import {
  COUNTERPART_LIMITS,
  type CounterpartKind,
  type CounterpartRecord,
  type DismissedName,
  type MergeImpact,
  type NotPersonDestination,
  type NotPersonImpact,
} from "../counterpart/types.js";
import type { CommitmentCommon } from "./commitment-common.js";
import { normalizeName, type CounterpartCommon } from "./counterpart-common.js";
import { createReassign } from "./counterpart-reassign.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

export type CounterpartMergeDeps = {
  transaction: TransactionRunner;
  c: WorkCommon;
  k: CommitmentCommon;
  cp: CounterpartCommon;
  fetch: (owner: string, id: string) => CounterpartRecord | undefined;
  reevaluate: (owner: string, commitmentId: string, now: number) => void;
};

/** How many open commitments of each person are compared, and how many "may repeat" pairs the preview lists. */
const DUP_SCAN_MAX = 200;
const DUP_HINT_MAX = 10;

const clean = (text: unknown): string => (typeof text === "string" ? text.trim() : "");
const contactKey = (type: string, label: string, value: string): string =>
  `${type}|${normalizeName(label)}|${normalizeName(value)}`;

export function createCounterpartMergeOps(deps: CounterpartMergeDeps) {
  const { transaction, c, k, cp, fetch, reevaluate } = deps;
  const { one, all, run, newId } = c;
  const reassign = createReassign(c, k);

  const worksOf = (owner: string, where: string, ...args: (string | number | null)[]) =>
    all(
      "SELECT DISTINCT w.id AS work_id, w.title FROM commitments cm " +
        "JOIN work_links l ON l.owner_id = cm.owner_id AND l.target_kind = 'commitment' AND l.target_id = cm.id AND l.ended_at IS NULL " +
        "JOIN works w ON w.owner_id = l.owner_id AND w.id = l.work_id AND w.lifecycle IN ('live','archived') " +
        `WHERE cm.owner_id = ? AND cm.lifecycle IN ('open','waiting') AND ${where} ORDER BY w.title`,
      owner,
      ...args,
    ).map((row) => ({ workId: String(row.work_id), title: String(row.title) }));

  const count = (sql: string, ...args: (string | number | null)[]): number =>
    Number((one(sql, ...args) as Row).n);

  /** The open commitments of one person (id and wording), oldest first: what the "may repeat" hint compares. */
  const openTexts = (owner: string, id: string) =>
    all(
      "SELECT id, requirement_text FROM commitments WHERE owner_id = ? AND responsible_counterpart_id = ? " +
        "AND lifecycle IN ('open','waiting') ORDER BY created_at, id LIMIT ?",
      owner,
      id,
      DUP_SCAN_MAX,
    ).map((row) => ({ id: String(row.id), text: String(row.requirement_text) }));

  // ------------------------------------------------------------------ merge

  const mergeImpact = (owner: string, source: string, target: string): MergeImpact => {
    const mine = cp.contactsOf(owner, source);
    const theirs = new Set(
      cp.contactsOf(owner, target).map((e) => contactKey(e.type, e.label, e.value)),
    );
    const sourceRelation = cp.relationOf(owner, source);
    const targetRelation = cp.relationOf(owner, target);
    const differ =
      sourceRelation !== null &&
      targetRelation !== null &&
      (sourceRelation.relation !== targetRelation.relation ||
        sourceRelation.scopeLabel !== targetRelation.scopeLabel);
    return {
      contacts: mine.length,
      sharedContacts: mine.filter((e) => theirs.has(contactKey(e.type, e.label, e.value))).length,
      aliases: count(
        "SELECT COUNT(*) AS n FROM counterpart_names WHERE owner_id = ? AND counterpart_id = ? AND revoked_at IS NULL",
        owner,
        source,
      ),
      openCommitments: count(
        "SELECT COUNT(*) AS n FROM commitments WHERE owner_id = ? AND responsible_counterpart_id = ? AND lifecycle IN ('open','waiting')",
        owner,
        source,
      ),
      resolvedCommitments: count(
        "SELECT COUNT(*) AS n FROM commitments WHERE owner_id = ? AND responsible_counterpart_id = ? AND lifecycle IN ('resolved','cancelled')",
        owner,
        source,
      ),
      participantLinks:
        count(
          "SELECT COUNT(*) AS n FROM work_participant_links WHERE owner_id = ? AND counterpart_id = ? AND status <> 'revoked'",
          owner,
          source,
        ) +
        count(
          "SELECT COUNT(*) AS n FROM commitment_participant_links WHERE owner_id = ? AND counterpart_id = ? AND status <> 'revoked'",
          owner,
          source,
        ),
      works: worksOf(owner, "cm.responsible_counterpart_id = ?", source),
      relations: differ ? { source: sourceRelation, target: targetRelation } : null,
      possibleDuplicates: likePairs(
        openTexts(owner, source),
        openTexts(owner, target),
        DUP_HINT_MAX,
      ),
    };
  };

  const counterpartMerge = (input: {
    principal: Principal;
    /** The record that goes away. */
    counterpartId: string;
    /** The record that stays. */
    intoId: string;
    dryRun?: boolean;
    expectedRevision?: number;
    /** Which relation survives when the two disagree. */
    relationChoice?: "source" | "target";
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const source = cp.counterpartRow(owner, input.counterpartId);
      const target = cp.counterpartRow(owner, input.intoId);
      if (!source || !target) {
        return { outcome: "not_found" as const };
      }
      if (input.counterpartId === input.intoId) {
        return { outcome: "invalid" as const, code: "same_record" };
      }
      if (cp.isSelf(owner, input.counterpartId) || cp.isSelf(owner, input.intoId)) {
        return { outcome: "forbidden" as const, code: "self_identity" };
      }
      for (const row of [source, target]) {
        if (String(row.lifecycle) !== "live") {
          return { outcome: "closed" as const, lifecycle: String(row.lifecycle) };
        }
      }
      if (String(source.kind) !== String(target.kind)) {
        return { outcome: "invalid" as const, code: "kind_mismatch" };
      }
      const impact = mergeImpact(owner, input.counterpartId, input.intoId);
      if (input.dryRun === true) {
        return { outcome: "preview" as const, impact };
      }
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== Number(source.revision)
      ) {
        return { outcome: "revision_conflict" as const, revision: Number(source.revision) };
      }
      if (
        impact.relations &&
        input.relationChoice !== "source" &&
        input.relationChoice !== "target"
      ) {
        return { outcome: "choice_required" as const, code: "relation", impact };
      }
      const from = input.counterpartId;
      const to = input.intoId;
      // Names: the old display name stays findable as an alias of the person who stays.
      run(
        "UPDATE counterpart_names SET counterpart_id = ?, name_kind = CASE name_kind WHEN 'display' THEN 'alias' ELSE name_kind END " +
          "WHERE owner_id = ? AND counterpart_id = ? AND revoked_at IS NULL",
        to,
        owner,
        from,
      );
      run(
        "UPDATE counterpart_names SET revoked_at = ? WHERE owner_id = ? AND counterpart_id = ? AND revoked_at IS NULL AND name_kind <> 'display' " +
          "AND rowid NOT IN (SELECT MIN(rowid) FROM counterpart_names WHERE owner_id = ? AND counterpart_id = ? AND revoked_at IS NULL GROUP BY name)",
        input.now,
        owner,
        to,
        owner,
        to,
      );
      // Relation: keep the one the user chose; when only one side has one, it is kept.
      const sourceRelation = cp.relationOf(owner, from);
      const targetRelation = cp.relationOf(owner, to);
      if (sourceRelation && (!targetRelation || input.relationChoice === "source")) {
        cp.setRelation(
          owner,
          to,
          sourceRelation.relation,
          sourceRelation.scopeLabel,
          "merge",
          input.now,
        );
      }
      if (sourceRelation) {
        cp.setRelation(owner, from, null, null, "merge", input.now);
      }
      // Contacts: a contact both sides hold becomes one; the others follow the person who stays.
      const held = new Set(
        cp.contactsOf(owner, to).map((e) => contactKey(e.type, e.label, e.value)),
      );
      for (const contact of cp.contactsOf(owner, from)) {
        if (held.has(contactKey(contact.type, contact.label, contact.value))) {
          run(
            "UPDATE identity_links SET status = 'revoked', valid_to = ?, updated_at = ? WHERE owner_id = ? AND counterpart_id = ? AND endpoint_id = ? AND status <> 'revoked'",
            input.now,
            input.now,
            owner,
            from,
            contact.id,
          );
          run(
            "UPDATE counterpart_endpoints SET valid_to = ? WHERE owner_id = ? AND id = ?",
            input.now,
            owner,
            contact.id,
          );
        } else {
          run(
            "UPDATE identity_links SET counterpart_id = ?, version = version + 1, updated_at = ? WHERE owner_id = ? AND counterpart_id = ? AND endpoint_id = ? AND status <> 'revoked'",
            to,
            input.now,
            owner,
            from,
            contact.id,
          );
        }
      }
      // Participant links: one the person who stays already has (same Work or Commitment, same role) is simply dropped.
      for (const [table, ref] of [
        ["work_participant_links", "work_id"],
        ["commitment_participant_links", "commitment_id"],
      ] as const) {
        run(
          `UPDATE ${table} SET status = 'revoked', revoked_at = ? WHERE owner_id = ? AND counterpart_id = ? AND status <> 'revoked' ` +
            `AND EXISTS (SELECT 1 FROM ${table} t WHERE t.owner_id = ${table}.owner_id AND t.counterpart_id = ? AND t.${ref} = ${table}.${ref} AND t.role = ${table}.role AND t.status <> 'revoked')`,
          input.now,
          owner,
          from,
          to,
        );
        run(
          `UPDATE ${table} SET counterpart_id = ? WHERE owner_id = ? AND counterpart_id = ? AND status <> 'revoked'`,
          to,
          owner,
          from,
        );
      }
      // Commitments: same person, so the responsibility version stays; the event records the move.
      const moved = all(
        "SELECT * FROM commitments WHERE owner_id = ? AND responsible_counterpart_id = ? ORDER BY created_at, id",
        owner,
        from,
      );
      const workIds = new Set<string>();
      const commitmentIds: string[] = [];
      for (const row of moved) {
        const open = ["open", "waiting"].includes(String(row.lifecycle));
        run(
          `UPDATE commitments SET responsible_counterpart_id = ?, revision = revision + 1${open ? ", updated_at = ?" : ""} WHERE owner_id = ? AND id = ?`,
          to,
          ...(open ? [input.now] : []),
          owner,
          String(row.id),
        );
        k.appendEvent(
          owner,
          String(row.id),
          "responsible_changed",
          "user",
          {
            from: { counterpartId: from, raw: null },
            to: { counterpartId: to, raw: null },
            cause: "counterpart_merged",
            versioned: false,
          },
          input.now,
        );
        commitmentIds.push(String(row.id));
        for (const link of k.linkedWorks(owner, String(row.id))) {
          workIds.add(link.workId);
        }
      }
      // The person who stays may now be both responsible and a helper on a commitment: only the responsible side remains.
      k.endHelperWhoIsResponsible(owner, input.now, { counterpartId: to });
      // The record that goes away stays as a tombstone that points at the one that stays.
      run(
        "UPDATE counterparts SET lifecycle = 'merged', merged_into = ?, merge_tx_id = ?, merged_at = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
        to,
        newId("mg_"),
        input.now,
        input.now,
        owner,
        from,
      );
      if (
        String(source.confirmation) === "confirmed" &&
        String(target.confirmation) !== "confirmed"
      ) {
        run(
          "UPDATE counterparts SET confirmation = 'confirmed', origin = CASE origin WHEN 'agent' THEN 'user' ELSE origin END WHERE owner_id = ? AND id = ?",
          owner,
          to,
        );
      }
      cp.bump(owner, to, input.now);
      for (const id of commitmentIds) {
        reevaluate(owner, id, input.now);
      }
      return {
        outcome: "merged" as const,
        impact,
        counterpart: fetch(owner, to) as CounterpartRecord,
        mergedId: from,
        commitmentIds,
        workIds: [...workIds],
      };
    });

  // ------------------------------------------------------------------ "this is not a person"

  const groupRows = (owner: string, key: string): Row[] =>
    all(
      "SELECT * FROM commitments WHERE owner_id = ? AND responsible_counterpart_id IS NULL ORDER BY created_at, id",
      owner,
    ).filter(
      // A commitment whose words named several people waits for the user's choice (design 6.8); no group move settles it.
      (row) =>
        row.ambiguity_json == null && normalizeName(String(row.responsible_raw ?? "")) === key,
    );

  const counterpartNotPerson = (input: {
    principal: Principal;
    /** The typed name of the group (any spelling that normalizes to it). */
    raw: string;
    destination: NotPersonDestination;
    /** For organization and team: the name of the new record (the typed name when empty). */
    displayName?: string;
    allowSameName?: boolean;
    dryRun?: boolean;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const raw = clean(input.raw);
      const key = normalizeName(raw);
      if (key.length === 0 || raw.length > COUNTERPART_LIMITS.name) {
        return { outcome: "invalid" as const, code: "bad_name" };
      }
      const rows = groupRows(owner, key);
      if (rows.length === 0) {
        return { outcome: "nothing_to_claim" as const };
      }
      const open = rows.filter((row) => ["open", "waiting"].includes(String(row.lifecycle)));
      const impact: NotPersonImpact = {
        total: rows.length,
        open: open.length,
        works: [
          ...new Map(
            rows.flatMap((row) =>
              k
                .linkedWorks(owner, String(row.id))
                .map((link) => [link.workId, { workId: link.workId, title: link.title }] as const),
            ),
          ).values(),
        ],
      };
      if (input.dryRun === true) {
        return { outcome: "preview" as const, impact };
      }
      const touched: Row[] = [];
      let counterpartId: string | null = null;
      let versioned = 0;
      if (input.destination === "organization" || input.destination === "team") {
        const name = clean(input.displayName) || raw;
        if (name.length === 0 || name.length > COUNTERPART_LIMITS.name) {
          return { outcome: "invalid" as const, code: "bad_name" };
        }
        const taken = cp.resolveName(owner, name);
        if (taken.match !== "none" && input.allowSameName !== true) {
          return { outcome: "name_taken" as const, candidates: taken.candidates };
        }
        const kind: CounterpartKind = input.destination;
        counterpartId = cp.insertCounterpart(owner, {
          displayName: name,
          kind,
          origin: "user",
          aliases: normalizeName(name) === key ? [] : [raw],
          basisText: "user",
          now: input.now,
        });
        // The typed name is one of the new record's names, so the Commitments only get identified: no new version.
        for (const row of rows) {
          run(
            "UPDATE commitments SET responsible_counterpart_id = ?, responsible_raw = NULL, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
            counterpartId,
            input.now,
            owner,
            String(row.id),
          );
          k.appendEvent(
            owner,
            String(row.id),
            "responsible_resolved",
            "user",
            {
              raw: String(row.responsible_raw ?? ""),
              counterpartId,
              versioned: false,
              notPerson: kind,
            },
            input.now,
          );
          touched.push(row);
        }
      } else if (input.destination === "self") {
        // It really is the user's own: a different party takes over, so it is a new responsibility version.
        const selfId = k.ensureSelf(owner, input.now);
        counterpartId = selfId;
        for (const row of open) {
          reassign(
            owner,
            row,
            { counterpartId: selfId, raw: null },
            "not_a_person_self",
            input.now,
          );
          versioned += 1;
          touched.push(row);
        }
      } else {
        const existing = one(
          "SELECT id FROM counterpart_dismissals WHERE owner_id = ? AND normalized_raw = ? AND revoked_at IS NULL",
          owner,
          key,
        );
        if (!existing) {
          run(
            "INSERT INTO counterpart_dismissals (owner_id, id, normalized_raw, raw, created_at) VALUES (?, ?, ?, ?, ?)",
            owner,
            newId("cd_"),
            key,
            raw,
            input.now,
          );
        }
      }
      const workIds = new Set<string>();
      for (const row of touched) {
        reevaluate(owner, String(row.id), input.now);
        for (const link of k.linkedWorks(owner, String(row.id))) {
          workIds.add(link.workId);
        }
      }
      if (counterpartId !== null) {
        cp.bump(owner, counterpartId, input.now);
      }
      return {
        outcome: input.destination === "dismiss" ? ("dismissed" as const) : ("moved" as const),
        destination: input.destination,
        impact,
        moved: touched.length,
        versioned,
        counterpartId,
        workIds: [...workIds],
      };
    });

  const counterpartDismissalRestore = (input: {
    principal: Principal;
    dismissalId: string;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = one(
        "SELECT id FROM counterpart_dismissals WHERE owner_id = ? AND id = ? AND revoked_at IS NULL",
        owner,
        input.dismissalId,
      );
      if (!row) {
        return { outcome: "not_found" as const };
      }
      run(
        "UPDATE counterpart_dismissals SET revoked_at = ? WHERE owner_id = ? AND id = ?",
        input.now,
        owner,
        input.dismissalId,
      );
      return { outcome: "restored" as const };
    });

  const counterpartDismissed = (input: { principal: Principal }): { items: DismissedName[] } =>
    transaction(() => ({
      items: all(
        "SELECT id, raw, created_at FROM counterpart_dismissals WHERE owner_id = ? AND revoked_at IS NULL ORDER BY created_at, id",
        input.principal.ownerId,
      ).map((row) => ({
        id: String(row.id),
        raw: String(row.raw),
        createdAt: Number(row.created_at),
      })),
    }));

  return {
    counterpartMerge,
    counterpartNotPerson,
    counterpartDismissalRestore,
    counterpartDismissed,
  };
}
