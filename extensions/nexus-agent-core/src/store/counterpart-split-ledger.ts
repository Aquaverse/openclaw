// Counterpart kernel, corrections that pull things apart (design 4.3.4, 7.5, 7.6 b and c): split one record that holds two
// people, and move one contact method that was attached to the wrong person. Each method is one synchronous transaction with a
// dry-run preview that lists what would be reached.
//   * split: the user picks the contacts, other names and Commitments that belong to the NEW person. An open Commitment that
//     moves is a different person's responsibility now, so it starts a new version (communication and acceptance reset); a
//     closed one keeps its result and only changes the person it points at. Participant links stay where they are.
//   * contact move: the link on the contact is ended and a new version points at the right person. Default: from now on only
//     (what happened before is still judged by what was true then); "from the start" sets aside the evidence that was read
//     through the contact and judges it again. Nothing here sends a message or widens an outbound grant.
import {
  COUNTERPART_KINDS,
  COUNTERPART_LIMITS,
  COUNTERPART_RELATIONS,
  type ContactMoveImpact,
  type CounterpartKind,
  type CounterpartRecord,
  type RelationSpec,
  type SplitImpact,
} from "../counterpart/types.js";
import type { CommitmentCommon } from "./commitment-common.js";
import { normalizeName, type CounterpartCommon } from "./counterpart-common.js";
import { createReassign } from "./counterpart-reassign.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

export type CounterpartSplitDeps = {
  transaction: TransactionRunner;
  c: WorkCommon;
  k: CommitmentCommon;
  cp: CounterpartCommon;
  fetch: (owner: string, id: string) => CounterpartRecord | undefined;
  reevaluate: (owner: string, commitmentId: string, now: number) => void;
};

const clean = (text: unknown): string => (typeof text === "string" ? text.trim() : "");
const OPEN = new Set(["open", "waiting"]);
const inSet = (set: readonly string[], value: string): boolean => set.includes(value);

export function createCounterpartSplitOps(deps: CounterpartSplitDeps) {
  const { transaction, c, k, cp, fetch, reevaluate } = deps;
  const { one, all, run, newId } = c;
  const reassign = createReassign(c, k);
  const count = (sql: string, ...args: (string | number | null)[]): number =>
    Number((one(sql, ...args) as Row).n);

  /** The confirmed link a contact has with a person now (the latest version). */
  const linkOf = (owner: string, counterpartId: string, endpointId: string): Row | undefined =>
    one(
      "SELECT * FROM identity_links WHERE owner_id = ? AND counterpart_id = ? AND endpoint_id = ? AND status = 'confirmed' ORDER BY version DESC, rowid DESC LIMIT 1",
      owner,
      counterpartId,
      endpointId,
    );

  /**
   * End the link a contact has with one person and, when there is a right person, write a new version pointing at them. The
   * old row is kept (evidence refers to the mapping version that was in force). `from` is when the new link starts.
   */
  const relink = (
    owner: string,
    old: Row,
    toId: string | null,
    from: number,
    oldEnds: number,
    via: string,
    now: number,
  ): void => {
    run(
      "UPDATE identity_links SET status = 'revoked', valid_to = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
      oldEnds,
      now,
      owner,
      String(old.id),
    );
    if (toId === null) {
      return;
    }
    run(
      "INSERT INTO identity_links (owner_id, id, counterpart_id, endpoint_id, status, basis_kind, basis_json, scope_kind, confirmed_by, confirmed_at, " +
        "valid_from, version, supersedes_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'confirmed', 'user_confirmed', ?, 'account', 'user', ?, ?, ?, ?, ?, ?)",
      owner,
      newId("il_"),
      toId,
      String(old.endpoint_id),
      JSON.stringify({ via, from: String(old.counterpart_id), authorizes: "nothing" }),
      now,
      from,
      Number(old.version) + 1,
      String(old.id),
      now,
      now,
    );
  };

  const worksOf = (owner: string, commitmentIds: readonly string[]) => {
    const seen = new Map<string, string>();
    for (const id of commitmentIds) {
      for (const link of k.linkedWorks(owner, id)) {
        const title = one(
          "SELECT title FROM works WHERE owner_id = ? AND id = ?",
          owner,
          link.workId,
        );
        seen.set(link.workId, String(title?.title ?? link.workId));
      }
    }
    return [...seen].map(([workId, title]) => ({ workId, title }));
  };

  // ------------------------------------------------------------------ split

  const counterpartSplit = (input: {
    principal: Principal;
    /** The record that holds two people. */
    counterpartId: string;
    /** How the new person is called. */
    displayName: string;
    kind?: CounterpartKind;
    relation?: RelationSpec | null;
    /** Other names (of the record that is split) that belong to the new person. */
    aliases?: string[];
    contactIds?: string[];
    commitmentIds?: string[];
    allowSameName?: boolean;
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
      const name = clean(input.displayName);
      if (name.length === 0 || name.length > COUNTERPART_LIMITS.name) {
        return { outcome: "invalid" as const, code: "bad_name" };
      }
      const kind = input.kind ?? (String(row.kind) as CounterpartKind);
      if (!inSet(COUNTERPART_KINDS, kind)) {
        return { outcome: "invalid" as const, code: "bad_kind" };
      }
      const relation = input.relation ?? null;
      if (relation !== null && !inSet(COUNTERPART_RELATIONS, relation.relation)) {
        return { outcome: "invalid" as const, code: "bad_relation" };
      }
      if (
        kind !== "person" &&
        (relation?.relation === "direct_report" || relation?.relation === "colleague")
      ) {
        return { outcome: "relation_conflict" as const, relation: relation.relation };
      }
      // What the user picked has to belong to the record that is split, and nothing is picked twice.
      const picked = (list: readonly string[] | undefined) => [...new Set(list ?? [])];
      const contactIds = picked(input.contactIds);
      const heldContacts = new Set(cp.contactsOf(owner, input.counterpartId).map((e) => e.id));
      const aliasKeys = picked((input.aliases ?? []).map(normalizeName));
      const heldAliases = new Set(
        all(
          "SELECT name FROM counterpart_names WHERE owner_id = ? AND counterpart_id = ? AND revoked_at IS NULL AND name_kind <> 'display'",
          owner,
          input.counterpartId,
        ).map((r) => String(r.name)),
      );
      const commitmentIds = picked(input.commitmentIds);
      const wanted = commitmentIds.map((id) =>
        one(
          "SELECT * FROM commitments WHERE owner_id = ? AND id = ? AND responsible_counterpart_id = ?",
          owner,
          id,
          input.counterpartId,
        ),
      );
      if (
        contactIds.some((id) => !heldContacts.has(id)) ||
        aliasKeys.some((key) => !heldAliases.has(key)) ||
        wanted.some((r) => r === undefined)
      ) {
        return { outcome: "invalid" as const, code: "bad_selection" };
      }
      const moving = wanted as Row[];
      const movedOpen = moving.filter((r) => OPEN.has(String(r.lifecycle)));
      const movedClosed = moving.filter((r) => !OPEN.has(String(r.lifecycle)));
      const total = (sql: string) => count(sql, owner, input.counterpartId);
      const impact: SplitImpact = {
        movedContacts: contactIds.length,
        keptContacts: heldContacts.size - contactIds.length,
        movedAliases: aliasKeys.length,
        keptAliases: heldAliases.size - aliasKeys.length,
        movedOpenCommitments: movedOpen.length,
        movedResolvedCommitments: movedClosed.length,
        keptOpenCommitments:
          total(
            "SELECT COUNT(*) AS n FROM commitments WHERE owner_id = ? AND responsible_counterpart_id = ? AND lifecycle IN ('open','waiting')",
          ) - movedOpen.length,
        keptResolvedCommitments:
          total(
            "SELECT COUNT(*) AS n FROM commitments WHERE owner_id = ? AND responsible_counterpart_id = ? AND lifecycle IN ('resolved','cancelled')",
          ) - movedClosed.length,
        participantLinksStaying:
          total(
            "SELECT COUNT(*) AS n FROM work_participant_links WHERE owner_id = ? AND counterpart_id = ? AND status <> 'revoked'",
          ) +
          total(
            "SELECT COUNT(*) AS n FROM commitment_participant_links WHERE owner_id = ? AND counterpart_id = ? AND status <> 'revoked'",
          ),
        works: worksOf(
          owner,
          movedOpen.map((r) => String(r.id)),
        ),
      };
      if (input.dryRun === true) {
        return { outcome: "preview" as const, impact };
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== Number(row.revision)) {
        return { outcome: "revision_conflict" as const, revision: Number(row.revision) };
      }
      if (input.allowSameName !== true) {
        const taken = cp.resolveName(owner, name);
        if (taken.match !== "none") {
          return { outcome: "name_taken" as const, candidates: taken.candidates };
        }
      }
      const now = input.now;
      const createdId = cp.insertCounterpart(owner, {
        displayName: name,
        kind,
        origin: "user",
        relation: relation
          ? { relation: relation.relation, scopeLabel: clean(relation.scopeLabel) || null }
          : null,
        aliases: [],
        basisText: clean(relation?.basisText) || "split",
        now,
      });
      // Other names: the ones picked follow the new person (one the new person is already called by simply stops here).
      for (const key of aliasKeys) {
        if (cp.hasName(owner, createdId, key)) {
          run(
            "UPDATE counterpart_names SET revoked_at = ? WHERE owner_id = ? AND counterpart_id = ? AND name = ? AND revoked_at IS NULL AND name_kind <> 'display'",
            now,
            owner,
            input.counterpartId,
            key,
          );
        } else {
          run(
            "UPDATE counterpart_names SET counterpart_id = ? WHERE owner_id = ? AND counterpart_id = ? AND name = ? AND revoked_at IS NULL AND name_kind <> 'display'",
            createdId,
            owner,
            input.counterpartId,
            key,
          );
        }
      }
      for (const endpointId of contactIds) {
        const old = linkOf(owner, input.counterpartId, endpointId);
        if (old) {
          relink(owner, old, createdId, now, now, "split", now);
        }
      }
      const workIds = new Set<string>();
      for (const commitment of moving) {
        const open = OPEN.has(String(commitment.lifecycle));
        if (open) {
          reassign(
            owner,
            commitment,
            { counterpartId: createdId, raw: null },
            "counterpart_split",
            now,
          );
        } else {
          run(
            "UPDATE commitments SET responsible_counterpart_id = ?, revision = revision + 1 WHERE owner_id = ? AND id = ?",
            createdId,
            owner,
            String(commitment.id),
          );
          k.appendEvent(
            owner,
            String(commitment.id),
            "responsible_changed",
            "user",
            {
              from: { counterpartId: input.counterpartId, raw: null },
              to: { counterpartId: createdId, raw: null },
              cause: "counterpart_split",
              versioned: false,
            },
            now,
          );
        }
        for (const link of k.linkedWorks(owner, String(commitment.id))) {
          workIds.add(link.workId);
        }
      }
      cp.bump(owner, input.counterpartId, now);
      for (const commitment of movedOpen) {
        reevaluate(owner, String(commitment.id), now);
      }
      return {
        outcome: "split" as const,
        impact,
        counterpart: fetch(owner, input.counterpartId) as CounterpartRecord,
        created: fetch(owner, createdId) as CounterpartRecord,
        commitmentIds: moving.map((r) => String(r.id)),
        workIds: [...workIds],
      };
    });

  // ------------------------------------------------------------------ a contact attached to the wrong person

  const counterpartContactMove = (input: {
    principal: Principal;
    /** The person the contact is attached to now. */
    counterpartId: string;
    endpointId: string;
    /** The person it really belongs to; absent: it belongs to nobody we know. */
    toId?: string;
    /** It was wrong from the start: set aside the evidence read through it and judge that again. */
    fromStart?: boolean;
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
      const contact = cp
        .contactsOf(owner, input.counterpartId)
        .find((e) => e.id === input.endpointId);
      const old = linkOf(owner, input.counterpartId, input.endpointId);
      if (!contact || !old) {
        return { outcome: "contact_not_found" as const };
      }
      let target: Row | undefined;
      if (input.toId !== undefined) {
        if (input.toId === input.counterpartId) {
          return { outcome: "invalid" as const, code: "same_record" };
        }
        target = cp.counterpartRow(owner, input.toId);
        if (!target) {
          return { outcome: "not_found" as const };
        }
        if (cp.isSelf(owner, input.toId)) {
          return { outcome: "forbidden" as const, code: "self_identity" };
        }
        if (String(target.lifecycle) !== "live") {
          return { outcome: "closed" as const, lifecycle: String(target.lifecycle) };
        }
      }
      const same = (e: { type: string; label: string; value: string }) =>
        e.type === contact.type &&
        normalizeName(e.label) === normalizeName(contact.label) &&
        normalizeName(e.value) === normalizeName(contact.value);
      const duplicate = target !== undefined && cp.contactsOf(owner, String(target.id)).some(same);
      const attributed = all(
        "SELECT DISTINCT commitment_id FROM evidence_attributions WHERE owner_id = ? AND endpoint_id = ? AND superseded_at IS NULL",
        owner,
        input.endpointId,
      ).map((r) => String(r.commitment_id));
      const impact: ContactMoveImpact = {
        contact,
        to: target ? { id: String(target.id), displayName: String(target.display_name) } : null,
        duplicate,
        attributions: count(
          "SELECT COUNT(*) AS n FROM evidence_attributions WHERE owner_id = ? AND endpoint_id = ? AND superseded_at IS NULL",
          owner,
          input.endpointId,
        ),
        attributedCommitments: attributed.length,
        verifiedCommitments: attributed.filter(
          (id) =>
            one(
              "SELECT 1 AS yes FROM commitments WHERE owner_id = ? AND id = ? AND verification = 'verified_complete'",
              owner,
              id,
            ) !== undefined,
        ).length,
      };
      if (input.dryRun === true) {
        return { outcome: "preview" as const, impact };
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== Number(row.revision)) {
        return { outcome: "revision_conflict" as const, revision: Number(row.revision) };
      }
      const now = input.now;
      const start = Number(old.valid_from);
      // Default: from now on only. "From the start": the old link never counted, and the new one starts where it started.
      relink(
        owner,
        old,
        target && !duplicate ? String(target.id) : null,
        input.fromStart === true ? start : now,
        input.fromStart === true ? start : now,
        "contact_correction",
        now,
      );
      if (!target || duplicate) {
        // Nobody holds this record of the contact any more (a duplicate on the other side already stands for it).
        run(
          "UPDATE counterpart_endpoints SET valid_to = ? WHERE owner_id = ? AND id = ?",
          now,
          owner,
          input.endpointId,
        );
      }
      const redo: string[] = [];
      if (input.fromStart === true) {
        run(
          "UPDATE evidence_attributions SET superseded_at = ? WHERE owner_id = ? AND endpoint_id = ? AND superseded_at IS NULL",
          now,
          owner,
          input.endpointId,
        );
        redo.push(...attributed);
      }
      cp.bump(owner, input.counterpartId, now);
      if (target) {
        cp.bump(owner, String(target.id), now);
      }
      const workIds = new Set<string>();
      for (const id of redo) {
        reevaluate(owner, id, now);
        for (const link of k.linkedWorks(owner, id)) {
          workIds.add(link.workId);
        }
      }
      return {
        outcome: "moved" as const,
        impact,
        counterpart: fetch(owner, input.counterpartId) as CounterpartRecord,
        target: target ? (fetch(owner, String(target.id)) as CounterpartRecord) : null,
        commitmentIds: redo,
        workIds: [...workIds],
      };
    });

  return { counterpartSplit, counterpartContactMove };
}
