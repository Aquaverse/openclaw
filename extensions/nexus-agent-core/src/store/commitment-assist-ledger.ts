// Commitment kernel, "the people who help" (object-model design 6.8, W3c-1). A Commitment has ONE responsible person
// (`commitments.responsible_counterpart_id`); anyone else who takes part is a link in `commitment_participant_links` with a role:
// participant, approver or recipient. Rules that hold here:
//   * the responsible person is never a helper (INV-08): adding them is refused, and when someone becomes responsible the link
//     that named them as a helper ends (`endHelperWhoIsResponsible`, called wherever responsibility moves);
//   * a helper does not answer for the Commitment and is not a sending authorization: nothing here touches communication,
//     acceptance, lifecycle, verification or any grant, and the responsibility version does not change;
//   * links are never deleted: removing one marks it revoked with the time (`valid_to`), so history can still say who helped;
//   * a link remembers the responsibility version it was added under; when responsibility moves on, the link stays (it says who
//     else is involved, which is still true) and the page shows it so the user can keep or remove it.
// One synchronous transaction per call; every statement filters on owner_id. The console is the only writer (status 'confirmed').
import {
  COMMITMENT_LIMITS,
  COMMITMENT_PARTICIPANT_ROLES,
  type CommitmentParticipant,
  type CommitmentParticipantRole,
} from "../commitment/types.js";
import type { CommitmentCommon } from "./commitment-common.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { WorkCommon } from "./work-ledger-common.js";

export type CommitmentAssistDeps = {
  transaction: TransactionRunner;
  c: WorkCommon;
  k: CommitmentCommon;
};

const clean = (text: unknown): string => (typeof text === "string" ? text.trim() : "");
const OPEN = new Set(["open", "waiting"]);

export function createCommitmentAssistOps(deps: CommitmentAssistDeps) {
  const { transaction, c, k } = deps;
  const { one, run, newId } = c;

  type AddInput = {
    principal: Principal;
    commitmentId: string;
    counterpartId: string;
    role: CommitmentParticipantRole;
    purpose?: string;
    now: number;
  };

  /** The add itself; the caller owns the transaction (the joint-responsibility choice adds helpers inside its own). */
  const addInTx = (input: AddInput) => {
    const owner = input.principal.ownerId;
    const row = k.commitmentRow(owner, input.commitmentId);
    if (!row) {
      return { outcome: "not_found" as const };
    }
    const lifecycle = String(row.lifecycle);
    if (!OPEN.has(lifecycle)) {
      return { outcome: "closed" as const, lifecycle };
    }
    if (!(COMMITMENT_PARTICIPANT_ROLES as readonly string[]).includes(input.role)) {
      return { outcome: "invalid" as const, code: "bad_role" };
    }
    const purpose = clean(input.purpose);
    if (purpose.length > COMMITMENT_LIMITS.purpose) {
      return { outcome: "invalid" as const, code: "bad_purpose" };
    }
    const person = one(
      "SELECT lifecycle FROM counterparts WHERE owner_id = ? AND id = ?",
      owner,
      input.counterpartId,
    );
    if (!person || String(person.lifecycle) !== "live") {
      return { outcome: "invalid" as const, code: "counterpart_not_found" };
    }
    if (String(row.responsible_counterpart_id ?? "") === input.counterpartId) {
      return { outcome: "invalid" as const, code: "is_responsible" };
    }
    const same = one(
      "SELECT id FROM commitment_participant_links WHERE owner_id = ? AND commitment_id = ? AND counterpart_id = ? AND role = ? AND status <> 'revoked'",
      owner,
      input.commitmentId,
      input.counterpartId,
      input.role,
    );
    if (same) {
      const found = k.helpersOf(owner, input.commitmentId).find((h) => h.id === String(same.id));
      return { outcome: "exists" as const, helper: found as CommitmentParticipant };
    }
    if (k.helpersOf(owner, input.commitmentId).length >= COMMITMENT_LIMITS.participants) {
      return { outcome: "invalid" as const, code: "too_many" };
    }
    const id = newId("cpl_");
    run(
      "INSERT INTO commitment_participant_links (owner_id, id, commitment_id, counterpart_id, role, responsibility_version, purpose, basis_text, status, valid_from, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'added by the user in the console', 'confirmed', ?, ?)",
      owner,
      id,
      input.commitmentId,
      input.counterpartId,
      input.role,
      Number(row.responsibility_version),
      purpose === "" ? null : purpose,
      input.now,
      input.now,
    );
    k.appendEvent(
      owner,
      input.commitmentId,
      "edited",
      "user",
      {
        changed: ["helper_added"],
        helper: { linkId: id, counterpartId: input.counterpartId, role: input.role },
      },
      input.now,
    );
    const helper = k.helpersOf(owner, input.commitmentId).find((h) => h.id === id);
    return { outcome: "added" as const, helper: helper as CommitmentParticipant };
  };

  const commitmentAssistAdd = (input: AddInput) => transaction(() => addInTx(input));

  const commitmentAssistRemove = (input: {
    principal: Principal;
    commitmentId: string;
    linkId: string;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      if (!k.commitmentRow(owner, input.commitmentId)) {
        return { outcome: "not_found" as const };
      }
      const helper = k.helpersOf(owner, input.commitmentId).find((h) => h.id === input.linkId);
      if (!helper) {
        return { outcome: "not_found" as const };
      }
      run(
        "UPDATE commitment_participant_links SET status = 'revoked', revoked_at = ?, valid_to = ? WHERE owner_id = ? AND id = ? AND commitment_id = ?",
        input.now,
        input.now,
        owner,
        input.linkId,
        input.commitmentId,
      );
      k.appendEvent(
        owner,
        input.commitmentId,
        "edited",
        "user",
        {
          changed: ["helper_removed"],
          helper: { linkId: helper.id, counterpartId: helper.counterpartId, role: helper.role },
        },
        input.now,
      );
      return { outcome: "removed" as const, helper };
    });

  return { commitmentAssistAdd, commitmentAssistRemove, assistAddInTx: addInTx };
}
