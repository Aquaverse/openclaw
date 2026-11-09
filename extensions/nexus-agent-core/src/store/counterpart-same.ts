// "May be the same person" (W3c-3): who else in the book looks like this person, and why. A hint for the user, never a decision:
// nothing is merged, hidden or re-pointed because of it. Three reasons, all exact, none guessed from similar-looking names:
//   * name:    both records are called the same (display names match);
//   * alias:   a name or alias of one is a name or alias of the other (they answer to a common name);
//   * contact: both hold the same contact method (a shared mailbox does not count: many people use one).
// Only live, stated or confirmed records of the same kind are compared; the owner's own record never takes part.
import type { PossibleSame, PossibleSameReason } from "../counterpart/types.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

const ORDER: readonly PossibleSameReason[] = ["name", "alias", "contact"];

export function createPossibleSame(c: WorkCommon) {
  const { all } = c;

  /** For every live person who has at least one lookalike: the lookalikes with their reasons, in a stable order. */
  return (owner: string): Map<string, PossibleSame[]> => {
    const eligible = new Map<string, { displayName: string; kind: string }>();
    for (const row of all(
      "SELECT id, display_name, kind FROM counterparts WHERE owner_id = ? AND lifecycle = 'live' AND confirmation IN ('stated','confirmed') " +
        "AND id NOT IN (SELECT self_counterpart_id FROM owner_identity WHERE owner_id = ?)",
      owner,
      owner,
    )) {
      eligible.set(String(row.id), {
        displayName: String(row.display_name),
        kind: String(row.kind),
      });
    }
    const found = new Map<string, Map<string, Set<PossibleSameReason>>>();
    const note = (x: string, y: string, reason: PossibleSameReason) => {
      const a = eligible.get(x);
      const b = eligible.get(y);
      if (!a || !b || a.kind !== b.kind || x === y) {
        return;
      }
      for (const [from, to] of [
        [x, y],
        [y, x],
      ] as const) {
        const per = found.get(from) ?? new Map<string, Set<PossibleSameReason>>();
        const reasons = per.get(to) ?? new Set<PossibleSameReason>();
        reasons.add(reason);
        per.set(to, reasons);
        found.set(from, per);
      }
    };
    const pairs = (rows: Row[]) => rows.map((row) => [String(row.x), String(row.y), row] as const);
    // Common names: each unordered pair once (x < y). Two display names that match is "name", anything else is "alias".
    for (const [x, y, row] of pairs(
      all(
        "SELECT a.counterpart_id AS x, b.counterpart_id AS y, MAX(a.name_kind = 'display' AND b.name_kind = 'display') AS both_display " +
          "FROM counterpart_names a JOIN counterpart_names b ON b.owner_id = a.owner_id AND b.name = a.name " +
          "AND b.counterpart_id > a.counterpart_id AND b.revoked_at IS NULL AND b.name_kind IN ('display','alias') " +
          "WHERE a.owner_id = ? AND a.revoked_at IS NULL AND a.name_kind IN ('display','alias') " +
          "GROUP BY a.counterpart_id, b.counterpart_id",
        owner,
      ),
    )) {
      note(x, y, Number(row.both_display) === 1 ? "name" : "alias");
    }
    // The same contact held by two people: one endpoint with two live links, or two endpoints of the same type and value (a typed
    // contact makes an endpoint per person). A shared mailbox is left out; so are contacts that have ended.
    for (const [x, y] of pairs(
      all(
        "SELECT DISTINCT a.counterpart_id AS x, b.counterpart_id AS y FROM identity_links a " +
          "JOIN counterpart_endpoints ea ON ea.owner_id = a.owner_id AND ea.id = a.endpoint_id " +
          "JOIN identity_links b ON b.owner_id = a.owner_id AND b.counterpart_id > a.counterpart_id AND b.status <> 'revoked' " +
          "JOIN counterpart_endpoints eb ON eb.owner_id = b.owner_id AND eb.id = b.endpoint_id " +
          "WHERE a.owner_id = ? AND a.status <> 'revoked' AND ea.endpoint_type <> 'shared_mailbox' AND eb.endpoint_type <> 'shared_mailbox' " +
          "AND ea.valid_to IS NULL AND eb.valid_to IS NULL AND (ea.id = eb.id OR " +
          "(ea.endpoint_type = eb.endpoint_type AND ea.handle IS NOT NULL AND lower(ea.handle) = lower(eb.handle)))",
        owner,
      ),
    )) {
      note(x, y, "contact");
    }
    const out = new Map<string, PossibleSame[]>();
    for (const [id, per] of found) {
      out.set(
        id,
        [...per.entries()]
          .map(([other, reasons]) => ({
            id: other,
            displayName: eligible.get(other)?.displayName ?? "",
            reasons: ORDER.filter((r) => reasons.has(r)),
          }))
          .toSorted(
            (p, q) => p.displayName.localeCompare(q.displayName, "zh") || p.id.localeCompare(q.id),
          ),
      );
    }
    return out;
  };
}
