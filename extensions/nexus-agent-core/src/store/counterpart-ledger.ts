// Counterpart kernel (object-model design 7, 9, slice W3a): create, ensure, edit, contact methods, deactivate / restore and the
// claim of typed-name Commitments. Reads (list, view, matching, pending group) are in counterpart-read-ledger.ts.
// Every method is ONE synchronous transaction and every statement filters on owner_id. What holds across the files:
//   * same name never means same person: creating over an existing name is refused unless the caller says so, and an Agent
//     facing several matches gets the candidates back instead of choosing; only the user writes `confirmation = 'confirmed'`;
//   * a contact method is reference data: storing one authorizes no message, no read and no account link;
//   * a Commitment follows its person when the name only gets resolved, and starts a new responsibility version (communication and
//     acceptance reset) when the person actually changes.
import {
  COUNTERPART_KINDS,
  COUNTERPART_LIMITS,
  COUNTERPART_RELATIONS,
  CONTACT_TYPES,
  type ContactSpec,
  type CounterpartKind,
  type CounterpartRecord,
  type NameMatch,
  type RelationSpec,
} from "../counterpart/types.js";
import { createCommitmentCommon } from "./commitment-common.js";
import {
  CONTACT_SOURCE_REF,
  createCounterpartCommon,
  normalizeName,
} from "./counterpart-common.js";
import { createCounterpartMergeOps } from "./counterpart-merge-ledger.js";
import { createCounterpartMoveOps } from "./counterpart-move-ledger.js";
import { createCounterpartReadOps } from "./counterpart-read-ledger.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { Row } from "./work-ledger-common.js";
import type { WorkLedger } from "./work-ledger.js";

type Problem = { outcome: "invalid"; code: string };
const clean = (text: unknown): string => (typeof text === "string" ? text.trim() : "");
const inSet = <T extends string>(set: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (set as readonly string[]).includes(value);

export function createCounterpartLedger(
  transaction: TransactionRunner,
  work: WorkLedger["internals"],
) {
  const c = work.common;
  const { one, run, newId } = c;
  const k = createCommitmentCommon(c);
  const cp = createCounterpartCommon(c);
  const read = createCounterpartReadOps({ transaction, c, cp });

  const fetch = (owner: string, id: string): CounterpartRecord | undefined => {
    const row = cp.counterpartRow(owner, id);
    return row ? cp.toCounterpart(owner, row) : undefined;
  };

  /** Re-evaluate the Works that require the Commitment and refresh the order of every Work that cites it. */
  const reevaluate = (owner: string, commitmentId: string, now: number): void => {
    for (const link of k.linkedWorks(owner, commitmentId)) {
      if (link.role === "required") {
        work.evaluateOutcomeInTx(owner, link.workId, now);
      }
      c.touch(owner, link.workId, now);
    }
  };

  const checkRelation = (relation: RelationSpec | null | undefined): Problem | null => {
    if (relation === undefined || relation === null) {
      return null;
    }
    if (!inSet(COUNTERPART_RELATIONS, relation.relation)) {
      return { outcome: "invalid", code: "bad_relation" };
    }
    const label = clean(relation.scopeLabel);
    if (label.length > COUNTERPART_LIMITS.scopeLabel) {
      return { outcome: "invalid", code: "bad_scope_label" };
    }
    return null;
  };

  const checkNames = (displayName: string, aliases: string[]): Problem | null => {
    if (displayName.length === 0 || displayName.length > COUNTERPART_LIMITS.name) {
      return { outcome: "invalid", code: "bad_name" };
    }
    if (aliases.length > COUNTERPART_LIMITS.aliases) {
      return { outcome: "invalid", code: "too_many_aliases" };
    }
    for (const alias of aliases) {
      if (alias.length === 0 || alias.length > COUNTERPART_LIMITS.name) {
        return { outcome: "invalid", code: "bad_alias" };
      }
    }
    return null;
  };

  const aliasList = (raw: unknown, displayName: string): string[] => {
    const seen = new Set<string>([normalizeName(displayName)]);
    const out: string[] = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const text = clean(item);
      const key = normalizeName(text);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(text);
      }
    }
    return out;
  };

  const isStaffRelation = (relation: string | null | undefined): boolean =>
    relation === "direct_report" || relation === "colleague";

  // ------------------------------------------------------------------ create / ensure

  const counterpartCreate = (input: {
    principal: Principal;
    displayName: string;
    kind?: CounterpartKind;
    relation?: RelationSpec | null;
    aliases?: string[];
    contacts?: ContactSpec[];
    /** Create even though a live person already answers to this name (the user looked at the candidates and said so). */
    allowSameName?: boolean;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const displayName = clean(input.displayName);
      const aliases = aliasList(input.aliases, displayName);
      const problem = checkNames(displayName, aliases) ?? checkRelation(input.relation);
      if (problem) {
        return problem;
      }
      const kind = input.kind ?? "person";
      if (!inSet(COUNTERPART_KINDS, kind)) {
        return { outcome: "invalid" as const, code: "bad_kind" };
      }
      // An organization or a team is nobody's direct report or colleague (the same rule as changing the type of a record).
      if (kind !== "person" && isStaffRelation(input.relation?.relation)) {
        return {
          outcome: "relation_conflict" as const,
          relation: String(input.relation?.relation),
        };
      }
      const contacts = input.contacts ?? [];
      if (contacts.length > COUNTERPART_LIMITS.contacts) {
        return { outcome: "invalid" as const, code: "too_many_contacts" };
      }
      for (const contact of contacts) {
        const bad = checkContact(contact);
        if (bad) {
          return bad;
        }
      }
      if (input.allowSameName !== true) {
        const taken = cp.resolveName(owner, displayName);
        if (taken.match !== "none") {
          return { outcome: "name_taken" as const, candidates: taken.candidates };
        }
      }
      const id = cp.insertCounterpart(owner, {
        displayName,
        kind,
        origin: "user",
        relation: input.relation
          ? {
              relation: input.relation.relation,
              scopeLabel: clean(input.relation.scopeLabel) || null,
            }
          : null,
        aliases,
        basisText: clean(input.relation?.basisText) || "user",
        now: input.now,
      });
      for (const contact of contacts) {
        addContactInTx(owner, id, contact, input.now);
      }
      return { outcome: "created" as const, counterpart: fetch(owner, id) as CounterpartRecord };
    });

  /**
   * The Agent's way to name a person. One match: reuse it. Several: hand the candidates back, the user chooses. None: a record
   * the user only STATED, tied to the sentence it came from; it can never be `confirmed` by an Agent.
   */
  const counterpartEnsure = (input: {
    principal: Principal;
    name: string;
    kind?: CounterpartKind;
    relation?: RelationSpec | null;
    userStatementRef: string;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const name = clean(input.name);
      const ref = clean(input.userStatementRef);
      if (ref.length === 0 || ref.length > COUNTERPART_LIMITS.ref) {
        return { outcome: "invalid" as const, code: "statement_ref_required" };
      }
      const problem = checkNames(name, []) ?? checkRelation(input.relation);
      if (problem) {
        return problem;
      }
      const kind = input.kind ?? "person";
      if (!inSet(COUNTERPART_KINDS, kind)) {
        return { outcome: "invalid" as const, code: "bad_kind" };
      }
      if (kind !== "person" && isStaffRelation(input.relation?.relation)) {
        return { outcome: "invalid" as const, code: "relation_kind_mismatch" };
      }
      const found = cp.resolveName(owner, name);
      if (found.match === "one") {
        const only = found.candidates[0] as NameMatch["candidates"][number];
        return {
          outcome: "existing" as const,
          counterpart: fetch(owner, only.id) as CounterpartRecord,
        };
      }
      if (found.match === "many") {
        return { outcome: "ambiguous" as const, candidates: found.candidates };
      }
      const id = cp.insertCounterpart(owner, {
        displayName: name,
        kind,
        origin: "agent",
        relation: input.relation
          ? {
              relation: input.relation.relation,
              scopeLabel: clean(input.relation.scopeLabel) || null,
            }
          : null,
        aliases: [],
        basisText: ref,
        now: input.now,
      });
      return {
        outcome: "created" as const,
        counterpart: fetch(owner, id) as CounterpartRecord,
        similar: found.similar,
      };
    });

  // ------------------------------------------------------------------ edit

  const counterpartUpdate = (input: {
    principal: Principal;
    counterpartId: string;
    changes: {
      displayName?: string;
      kind?: CounterpartKind;
      addAliases?: string[];
      removeAliases?: string[];
      relation?: RelationSpec | null;
      /** The user confirms a person an Agent only stated. */
      confirm?: boolean;
    };
    expectedRevision?: number;
    allowSameName?: boolean;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = cp.counterpartRow(owner, input.counterpartId);
      if (!row) {
        return { outcome: "not_found" as const };
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== Number(row.revision)) {
        return { outcome: "revision_conflict" as const, revision: Number(row.revision) };
      }
      if (String(row.lifecycle) !== "live") {
        return { outcome: "closed" as const, lifecycle: String(row.lifecycle) };
      }
      const changes = input.changes;
      const self = cp.isSelf(owner, input.counterpartId);
      const problem = checkRelation(changes.relation);
      if (problem) {
        return problem;
      }
      let touched = false;
      if (changes.kind !== undefined && changes.kind !== String(row.kind)) {
        if (!inSet(COUNTERPART_KINDS, changes.kind)) {
          return { outcome: "invalid" as const, code: "bad_kind" };
        }
        if (self) {
          return { outcome: "forbidden" as const, code: "self_identity" };
        }
        // An organization or a team is nobody's direct report or colleague: the relation has to change with the type.
        if (changes.kind !== "person") {
          const nextRelation =
            changes.relation !== undefined
              ? (changes.relation?.relation ?? null)
              : (cp.relationOf(owner, input.counterpartId)?.relation ?? null);
          if (isStaffRelation(nextRelation)) {
            return { outcome: "relation_conflict" as const, relation: nextRelation };
          }
        }
        run(
          "UPDATE counterparts SET kind = ? WHERE owner_id = ? AND id = ?",
          changes.kind,
          owner,
          input.counterpartId,
        );
        touched = true;
      } else if (String(row.kind) !== "person" && isStaffRelation(changes.relation?.relation)) {
        // The type stays as it is, but the new relation would make an organization or a team somebody's colleague.
        return {
          outcome: "relation_conflict" as const,
          relation: changes.relation?.relation ?? null,
        };
      }
      if (changes.displayName !== undefined) {
        const name = clean(changes.displayName);
        const bad = checkNames(name, []);
        if (bad) {
          return bad;
        }
        if (normalizeName(name) !== normalizeName(String(row.display_name))) {
          if (input.allowSameName !== true) {
            const others = cp
              .resolveName(owner, name)
              .candidates.filter((candidate) => candidate.id !== input.counterpartId);
            if (others.length > 0) {
              return { outcome: "name_taken" as const, candidates: others };
            }
          }
          // The old display name keeps pointing at this person as an alias; the new one becomes the display name.
          run(
            "UPDATE counterpart_names SET name_kind = 'alias' WHERE owner_id = ? AND counterpart_id = ? AND name_kind = 'display' AND revoked_at IS NULL",
            owner,
            input.counterpartId,
          );
          if (cp.hasName(owner, input.counterpartId, name)) {
            run(
              "UPDATE counterpart_names SET name_kind = 'display' WHERE owner_id = ? AND counterpart_id = ? AND name = ? AND revoked_at IS NULL",
              owner,
              input.counterpartId,
              normalizeName(name),
            );
          } else {
            cp.addName(owner, input.counterpartId, name, "display", "user", input.now);
          }
          run(
            "UPDATE counterparts SET display_name = ? WHERE owner_id = ? AND id = ?",
            name,
            owner,
            input.counterpartId,
          );
          touched = true;
        }
      }
      const display = clean(changes.displayName) || String(row.display_name);
      for (const raw of changes.addAliases ?? []) {
        const alias = clean(raw);
        const bad = checkNames(display, [alias]);
        if (bad) {
          return bad;
        }
        if (!cp.hasName(owner, input.counterpartId, alias)) {
          const have = cp.aliasesOf(owner, input.counterpartId, display).length;
          if (have >= COUNTERPART_LIMITS.aliases) {
            return { outcome: "invalid" as const, code: "too_many_aliases" };
          }
          cp.addName(owner, input.counterpartId, alias, "alias", "user", input.now);
          touched = true;
        }
      }
      for (const raw of changes.removeAliases ?? []) {
        const key = normalizeName(clean(raw));
        if (key === normalizeName(display)) {
          continue;
        }
        const before = Number(
          (
            one(
              "SELECT COUNT(*) AS n FROM counterpart_names WHERE owner_id = ? AND counterpart_id = ? AND name = ? AND revoked_at IS NULL AND name_kind <> 'display'",
              owner,
              input.counterpartId,
              key,
            ) as Row
          ).n,
        );
        if (before > 0) {
          run(
            "UPDATE counterpart_names SET revoked_at = ? WHERE owner_id = ? AND counterpart_id = ? AND name = ? AND revoked_at IS NULL AND name_kind <> 'display'",
            input.now,
            owner,
            input.counterpartId,
            key,
          );
          touched = true;
        }
      }
      if (changes.relation !== undefined) {
        const next = changes.relation;
        const current = cp.relationOf(owner, input.counterpartId);
        const nextLabel = next ? clean(next.scopeLabel) || null : null;
        if (
          (next === null && current !== null) ||
          (next !== null &&
            (current?.relation !== next.relation || current.scopeLabel !== nextLabel))
        ) {
          cp.setRelation(
            owner,
            input.counterpartId,
            next ? next.relation : null,
            nextLabel,
            clean(next?.basisText) || "user",
            input.now,
          );
          touched = true;
        }
      }
      if (changes.confirm === true && String(row.confirmation) !== "confirmed") {
        run(
          "UPDATE counterparts SET confirmation = 'confirmed', origin = CASE origin WHEN 'agent' THEN 'user' ELSE origin END WHERE owner_id = ? AND id = ?",
          owner,
          input.counterpartId,
        );
        touched = true;
      }
      if (!touched) {
        return {
          outcome: "unchanged" as const,
          counterpart: fetch(owner, input.counterpartId) as CounterpartRecord,
        };
      }
      cp.bump(owner, input.counterpartId, input.now);
      return {
        outcome: "updated" as const,
        counterpart: fetch(owner, input.counterpartId) as CounterpartRecord,
      };
    });

  // ------------------------------------------------------------------ contact methods (reference data only)

  function checkContact(contact: ContactSpec): Problem | null {
    if (!inSet(CONTACT_TYPES, contact?.type)) {
      return { outcome: "invalid", code: "bad_contact_type" };
    }
    const value = clean(contact.value);
    if (value.length === 0 || value.length > COUNTERPART_LIMITS.contactValue) {
      return { outcome: "invalid", code: "bad_contact_value" };
    }
    if (clean(contact.label).length > COUNTERPART_LIMITS.contactLabel) {
      return { outcome: "invalid", code: "bad_contact_label" };
    }
    return null;
  }

  /** An endpoint (weak: a typed value is not a verified account) plus a confirmed link the user made. It grants nothing. */
  function addContactInTx(
    owner: string,
    counterpartId: string,
    contact: ContactSpec,
    now: number,
  ): { id: string; created: boolean } {
    const value = clean(contact.value);
    const existing = cp
      .contactsOf(owner, counterpartId)
      .find(
        (entry) => entry.type === contact.type && entry.value.toLowerCase() === value.toLowerCase(),
      );
    if (existing) {
      return { id: existing.id, created: false };
    }
    const endpointId = newId("ep_");
    run(
      "INSERT INTO counterpart_endpoints (owner_id, id, endpoint_type, provider, handle, id_strength, observed_at, source_ref, created_at) " +
        "VALUES (?, ?, ?, ?, ?, 'weak', ?, ?, ?)",
      owner,
      endpointId,
      contact.type,
      clean(contact.label) || contact.type,
      value,
      now,
      CONTACT_SOURCE_REF,
      now,
    );
    run(
      "INSERT INTO identity_links (owner_id, id, counterpart_id, endpoint_id, status, basis_kind, basis_json, scope_kind, confirmed_by, confirmed_at, " +
        "valid_from, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'confirmed', 'user_confirmed', ?, 'account', 'user', ?, ?, 1, ?, ?)",
      owner,
      newId("il_"),
      counterpartId,
      endpointId,
      JSON.stringify({ via: "contact_entry", authorizes: "nothing" }),
      now,
      now,
      now,
      now,
    );
    return { id: endpointId, created: true };
  }

  const counterpartContactAdd = (input: {
    principal: Principal;
    counterpartId: string;
    contact: ContactSpec;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = cp.counterpartRow(owner, input.counterpartId);
      if (!row) {
        return { outcome: "not_found" as const };
      }
      if (String(row.lifecycle) !== "live") {
        return { outcome: "closed" as const, lifecycle: String(row.lifecycle) };
      }
      const bad = checkContact(input.contact);
      if (bad) {
        return bad;
      }
      if (cp.contactsOf(owner, input.counterpartId).length >= COUNTERPART_LIMITS.contacts) {
        return { outcome: "invalid" as const, code: "too_many_contacts" };
      }
      const added = addContactInTx(owner, input.counterpartId, input.contact, input.now);
      if (added.created) {
        cp.bump(owner, input.counterpartId, input.now);
      }
      return {
        outcome: added.created ? ("added" as const) : ("unchanged" as const),
        counterpart: fetch(owner, input.counterpartId) as CounterpartRecord,
      };
    });

  const counterpartContactRemove = (input: {
    principal: Principal;
    counterpartId: string;
    endpointId: string;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      if (!cp.counterpartRow(owner, input.counterpartId)) {
        return { outcome: "not_found" as const };
      }
      if (
        !cp.contactsOf(owner, input.counterpartId).some((entry) => entry.id === input.endpointId)
      ) {
        return { outcome: "contact_not_found" as const };
      }
      run(
        "UPDATE identity_links SET status = 'revoked', valid_to = ?, updated_at = ? WHERE owner_id = ? AND counterpart_id = ? AND endpoint_id = ? AND status = 'confirmed'",
        input.now,
        input.now,
        owner,
        input.counterpartId,
        input.endpointId,
      );
      run(
        "UPDATE counterpart_endpoints SET valid_to = ? WHERE owner_id = ? AND id = ?",
        input.now,
        owner,
        input.endpointId,
      );
      cp.bump(owner, input.counterpartId, input.now);
      return {
        outcome: "removed" as const,
        counterpart: fetch(owner, input.counterpartId) as CounterpartRecord,
      };
    });

  const moves = createCounterpartMoveOps({ transaction, c, k, cp, fetch, reevaluate });
  const merges = createCounterpartMergeOps({ transaction, c, k, cp, fetch, reevaluate });

  return {
    counterpartCreate,
    counterpartEnsure,
    counterpartUpdate,
    counterpartContactAdd,
    counterpartContactRemove,
    ...moves,
    ...merges,
    ...read,
  };
}

export type CounterpartLedger = ReturnType<typeof createCounterpartLedger>;
