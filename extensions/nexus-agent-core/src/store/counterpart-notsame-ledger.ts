import type { CounterpartCommon } from "./counterpart-common.js";
// Counterpart kernel, "not the same person" (W3c-4): the user looked at a "may be the same person" hint and said these two records
// are two people. The mark silences that hint for that pair and nothing else: no name, contact, commitment or merge rule changes.
// It can be taken back. Marks hold ids only, and clearing a person removes the marks that name them.
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { WorkCommon } from "./work-ledger-common.js";

export type CounterpartNotSameDeps = {
  transaction: TransactionRunner;
  c: WorkCommon;
  cp: CounterpartCommon;
};

export function createCounterpartNotSameOps(deps: CounterpartNotSameDeps) {
  const { transaction, c, cp } = deps;
  const { one, run } = c;

  const ordered = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

  const counterpartNotSame = (input: {
    principal: Principal;
    counterpartId: string;
    otherId: string;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      if (input.counterpartId === input.otherId) {
        return { outcome: "invalid" as const, code: "same_record" };
      }
      const rows = [input.counterpartId, input.otherId].map((id) => cp.counterpartRow(owner, id));
      if (!rows[0] || !rows[1]) {
        return { outcome: "not_found" as const };
      }
      if (cp.isSelf(owner, input.counterpartId) || cp.isSelf(owner, input.otherId)) {
        return { outcome: "forbidden" as const, code: "self_identity" };
      }
      for (const row of rows) {
        if (String(row?.lifecycle) !== "live") {
          return { outcome: "closed" as const, lifecycle: String(row?.lifecycle) };
        }
      }
      const [low, high] = ordered(input.counterpartId, input.otherId);
      const had = one(
        "SELECT 1 AS yes FROM counterpart_not_same WHERE owner_id = ? AND low_id = ? AND high_id = ?",
        owner,
        low,
        high,
      );
      if (had) {
        return { outcome: "exists" as const };
      }
      run(
        "INSERT INTO counterpart_not_same (owner_id, low_id, high_id, created_at) VALUES (?, ?, ?, ?)",
        owner,
        low,
        high,
        input.now,
      );
      return { outcome: "marked" as const };
    });

  const counterpartNotSameRestore = (input: {
    principal: Principal;
    counterpartId: string;
    otherId: string;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const [low, high] = ordered(input.counterpartId, input.otherId);
      const had = one(
        "SELECT 1 AS yes FROM counterpart_not_same WHERE owner_id = ? AND low_id = ? AND high_id = ?",
        owner,
        low,
        high,
      );
      if (!had) {
        return { outcome: "not_found" as const };
      }
      run(
        "DELETE FROM counterpart_not_same WHERE owner_id = ? AND low_id = ? AND high_id = ?",
        owner,
        low,
        high,
      );
      return { outcome: "restored" as const };
    });

  return { counterpartNotSame, counterpartNotSameRestore };
}
