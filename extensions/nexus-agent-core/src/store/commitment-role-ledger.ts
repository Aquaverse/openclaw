// Commitment kernel, "how a Work cites a Commitment" (design 6.6): required <-> reference in one step. Split out of
// commitment-ledger.ts to keep that file under its line cap; behavior is unchanged. One synchronous transaction per call.
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { WorkActor } from "./work-ledger-common.js";
import type { WorkLedger } from "./work-ledger.js";

const workActor = (actor: "user" | "agent"): WorkActor => (actor === "agent" ? "agent" : "user");

export function createCommitmentRoleOps(deps: {
  transaction: TransactionRunner;
  c: WorkLedger["internals"]["common"];
  work: WorkLedger["internals"];
}) {
  const { transaction, c, work } = deps;
  const { all, run } = c;

  /**
   * Change how a Work cites a Commitment (required <-> reference) in one step: the old link ends, the new one starts. Making a
   * required Commitment a mere reference can make the Work look finished, so the caller must acknowledge that gap (design 6.6).
   */
  const commitmentSetRole = (input: {
    principal: Principal;
    workId: string;
    commitmentId: string;
    role: "required" | "reference";
    acknowledgeGap?: boolean;
    actor: "user" | "agent";
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      if (work.requireLive(owner, input.workId).problem) {
        return { outcome: "work_not_found" as const };
      }
      if (input.role !== "required" && input.role !== "reference") {
        return { outcome: "invalid" as const, code: "bad_role" };
      }
      // Normally one link; a Work that cited the same Commitment twice (as required and as a reference) has two, and a
      // role change folds them into one.
      const links = all(
        "SELECT id, role FROM work_links WHERE owner_id = ? AND work_id = ? AND target_kind = 'commitment' AND target_id = ? AND ended_at IS NULL ORDER BY created_at, id",
        owner,
        input.workId,
        input.commitmentId,
      );
      if (links.length === 0) {
        return { outcome: "not_linked" as const };
      }
      if (links.length === 1 && String(links[0]!.role) === input.role) {
        return { outcome: "unchanged" as const };
      }
      if (
        input.role === "reference" &&
        links.some((l) => String(l.role) === "required") &&
        input.acknowledgeGap !== true
      ) {
        return { outcome: "gap_ack_required" as const };
      }
      const keep = links.find((l) => String(l.role) === input.role);
      for (const link of links) {
        if (link === keep) {
          continue;
        }
        run(
          "UPDATE work_links SET ended_at = ?, end_basis = 'role_changed' WHERE owner_id = ? AND id = ?",
          input.now,
          owner,
          String(link.id),
        );
      }
      const linked = keep
        ? { linkId: String(keep.id) }
        : work.linkAddInTx({
            principal: input.principal,
            workId: input.workId,
            role: input.role,
            targetKind: "commitment",
            targetId: input.commitmentId,
            actor: workActor(input.actor),
            now: input.now,
          });
      work.evaluateOutcomeInTx(owner, input.workId, input.now);
      return {
        outcome: "changed" as const,
        linkId: (linked as { linkId?: string }).linkId ?? null,
      };
    });

  return { commitmentSetRole };
}
