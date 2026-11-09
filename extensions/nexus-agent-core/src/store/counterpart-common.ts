// Counterpart kernel, shared part: name normalization, name matching (design 7.3), row mapping and the insert every creating path
// uses. No transaction is opened here. Every statement filters on owner_id. Same name never means same person: matching only
// REPORTS candidates, and a caller with more than one must ask the user.
import type {
  ContactRecord,
  CounterpartKind,
  CounterpartRecord,
  CounterpartRelation,
  NameMatch,
} from "../counterpart/types.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

/** The key names are compared by: full-width forms folded, spaces collapsed, case ignored. Stored this way in counterpart_names. */
export function normalizeName(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

const CONTACT_SOURCE = "user_entered";

export function createCounterpartCommon(c: WorkCommon) {
  const { one, all, run, newId } = c;

  const relationOf = (owner: string, id: string): CounterpartRecord["relation"] => {
    const row = one(
      "SELECT relation, scope_label FROM counterpart_relations WHERE owner_id = ? AND counterpart_id = ? AND status = 'stated' " +
        "ORDER BY created_at DESC, id DESC LIMIT 1",
      owner,
      id,
    );
    return row
      ? {
          relation: String(row.relation) as CounterpartRelation,
          scopeLabel: (row.scope_label as string | null) ?? null,
        }
      : null;
  };

  const contactsOf = (owner: string, id: string): ContactRecord[] =>
    all(
      "SELECT e.id, e.endpoint_type, e.provider, e.handle, e.created_at FROM identity_links l " +
        "JOIN counterpart_endpoints e ON e.owner_id = l.owner_id AND e.id = l.endpoint_id " +
        "WHERE l.owner_id = ? AND l.counterpart_id = ? AND l.status = 'confirmed' AND e.source_ref = ? AND e.valid_to IS NULL " +
        "ORDER BY e.created_at, e.rowid",
      owner,
      id,
      CONTACT_SOURCE,
    ).map((row) => ({
      id: String(row.id),
      type: String(row.endpoint_type),
      label: String(row.provider),
      value: String(row.handle ?? ""),
      createdAt: Number(row.created_at),
    }));

  /** Names the person is known by besides the display name (the display name is its own column). */
  const aliasesOf = (owner: string, id: string, displayName: string): string[] => {
    const shown = normalizeName(displayName);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of all(
      "SELECT name, source FROM counterpart_names WHERE owner_id = ? AND counterpart_id = ? AND revoked_at IS NULL AND name_kind <> 'display' " +
        "ORDER BY created_at, rowid",
      owner,
      id,
    )) {
      const name = String(row.name);
      if (name !== shown && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
    return out;
  };

  const toCounterpart = (owner: string, row: Row): CounterpartRecord => {
    const id = String(row.id);
    const displayName = String(row.display_name);
    return {
      ownerId: owner,
      id,
      kind: String(row.kind) as CounterpartKind,
      displayName,
      confirmation: String(row.confirmation) as CounterpartRecord["confirmation"],
      origin: String(row.origin) as CounterpartRecord["origin"],
      lifecycle: String(row.lifecycle) as CounterpartRecord["lifecycle"],
      inactiveReason: (row.inactive_reason as string | null) ?? null,
      lastStopReason: (row.last_stop_reason as string | null) ?? null,
      inactiveAt:
        row.inactive_at === null || row.inactive_at === undefined ? null : Number(row.inactive_at),
      mergedInto: (row.merged_into as string | null) ?? null,
      isSelf:
        one(
          "SELECT 1 AS yes FROM owner_identity WHERE owner_id = ? AND self_counterpart_id = ?",
          owner,
          id,
        ) !== undefined,
      aliases: aliasesOf(owner, id, displayName),
      relation: relationOf(owner, id),
      contacts: contactsOf(owner, id),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  };

  const counterpartRow = (owner: string, id: string): Row | undefined =>
    one("SELECT * FROM counterparts WHERE owner_id = ? AND id = ?", owner, id);

  const isSelf = (owner: string, id: string): boolean =>
    one(
      "SELECT 1 AS yes FROM owner_identity WHERE owner_id = ? AND self_counterpart_id = ?",
      owner,
      id,
    ) !== undefined;

  /**
   * Who does this name point at? Exact matches on a live person the user stated or confirmed (display name or alias); a
   * proposed record never answers. Inactive and merged people are not matched. `similar` is a hint for a human, never used.
   */
  const resolveName = (owner: string, name: string): NameMatch => {
    const key = normalizeName(name);
    if (key.length === 0) {
      return { match: "none", candidates: [], similar: [] };
    }
    const found = all(
      "SELECT DISTINCT cp.id, cp.display_name, cp.kind, cp.confirmation, cp.created_at FROM counterpart_names n " +
        "JOIN counterparts cp ON cp.owner_id = n.owner_id AND cp.id = n.counterpart_id " +
        "WHERE n.owner_id = ? AND n.name = ? AND n.revoked_at IS NULL AND cp.lifecycle = 'live' " +
        "AND cp.confirmation IN ('stated','confirmed') ORDER BY cp.created_at, cp.id",
      owner,
      key,
    );
    const candidates = found.map((row) => ({
      id: String(row.id),
      displayName: String(row.display_name),
      kind: String(row.kind) as CounterpartKind,
      confirmation: String(row.confirmation),
      relation: relationOf(owner, String(row.id))?.relation ?? null,
    }));
    if (candidates.length > 0) {
      return { match: candidates.length === 1 ? "one" : "many", candidates, similar: [] };
    }
    const similar = all(
      "SELECT DISTINCT cp.id, cp.display_name FROM counterpart_names n JOIN counterparts cp ON cp.owner_id = n.owner_id AND cp.id = n.counterpart_id " +
        "WHERE n.owner_id = ? AND n.revoked_at IS NULL AND cp.lifecycle = 'live' AND cp.confirmation IN ('stated','confirmed') " +
        "AND length(n.name) >= 2 AND (instr(n.name, ?) > 0 OR instr(?, n.name) > 0) ORDER BY cp.display_name LIMIT 5",
      owner,
      key,
      key,
    ).map((row) => ({ id: String(row.id), displayName: String(row.display_name) }));
    return { match: "none", candidates: [], similar };
  };

  const addName = (
    owner: string,
    counterpartId: string,
    name: string,
    nameKind: "display" | "alias" | "raw_mention",
    source: string,
    now: number,
  ): void => {
    run(
      "INSERT INTO counterpart_names (owner_id, id, counterpart_id, name, name_kind, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      owner,
      newId("cn_"),
      counterpartId,
      normalizeName(name),
      nameKind,
      source,
      now,
    );
  };

  const hasName = (owner: string, counterpartId: string, name: string): boolean =>
    one(
      "SELECT 1 AS yes FROM counterpart_names WHERE owner_id = ? AND counterpart_id = ? AND name = ? AND revoked_at IS NULL",
      owner,
      counterpartId,
      normalizeName(name),
    ) !== undefined;

  const setRelation = (
    owner: string,
    counterpartId: string,
    relation: CounterpartRelation | null,
    scopeLabel: string | null,
    basisText: string,
    now: number,
  ): void => {
    run(
      "UPDATE counterpart_relations SET status = 'revoked', valid_to = ? WHERE owner_id = ? AND counterpart_id = ? AND status = 'stated'",
      now,
      owner,
      counterpartId,
    );
    if (relation !== null) {
      run(
        "INSERT INTO counterpart_relations (owner_id, id, counterpart_id, relation, scope_label, basis_text, status, valid_from, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'stated', ?, ?)",
        owner,
        newId("cr_"),
        counterpartId,
        relation,
        scopeLabel,
        basisText,
        now,
        now,
      );
    }
  };

  const insertCounterpart = (
    owner: string,
    input: {
      displayName: string;
      kind: CounterpartKind;
      origin: "user" | "agent";
      relation?: { relation: CounterpartRelation; scopeLabel: string | null } | null;
      aliases: string[];
      basisText: string;
      now: number;
    },
  ): string => {
    const id = newId("cp_");
    run(
      "INSERT INTO counterparts (owner_id, id, kind, display_name, confirmation, origin, lifecycle, revision, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'live', 1, ?, ?)",
      owner,
      id,
      input.kind,
      input.displayName,
      input.origin === "agent" ? "stated" : "confirmed",
      input.origin,
      input.now,
      input.now,
    );
    addName(owner, id, input.displayName, "display", input.origin, input.now);
    for (const alias of input.aliases) {
      if (!hasName(owner, id, alias)) {
        addName(owner, id, alias, "alias", input.origin, input.now);
      }
    }
    if (input.relation) {
      setRelation(
        owner,
        id,
        input.relation.relation,
        input.relation.scopeLabel,
        input.basisText,
        input.now,
      );
    }
    return id;
  };

  const bump = (owner: string, id: string, now: number): void => {
    run(
      "UPDATE counterparts SET revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
      now,
      owner,
      id,
    );
  };

  return {
    counterpartRow,
    toCounterpart,
    isSelf,
    resolveName,
    addName,
    hasName,
    setRelation,
    insertCounterpart,
    bump,
    contactsOf,
    relationOf,
    aliasesOf,
  };
}

export type CounterpartCommon = ReturnType<typeof createCounterpartCommon>;
export const CONTACT_SOURCE_REF = CONTACT_SOURCE;
