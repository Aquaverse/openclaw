import { MAX_JOINT_NAMES, parseAmbiguity } from "../commitment/joint.js";
// Commitment kernel, "who answers when the words named several people" (object-model design 6.8, W3c-2). A Commitment whose typed
// responsible words named several people or a group ("小王和小李一起做") has nobody responsible and carries `ambiguity_json`
// {kind:"joint"} until the user chooses. There are exactly two legal forms, and the user picks one:
//   * `lead`: one person answers for the Commitment, the others (optional) help; helpers are links, never a second owner;
//   * `each`: one Commitment per person: the existing one goes to the first, a copy of the same words, due date and Work
//     citations is made for each of the others. Nothing is copied that would be a second obligation for the same delivery.
// The choice is ONE transaction: it is checked first and written together, so a refusal leaves nothing half done. The console is
// the only writer; the Agent cannot choose (it does not know who the user meant).
import {
  COMMITMENT_LIMITS,
  COMMITMENT_PARTICIPANT_ROLES,
  type CommitmentParticipantRole,
  type CommitmentRecord,
  type DueSpec,
} from "../commitment/types.js";
import type { CommitmentCommon } from "./commitment-common.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

export type JointChoice =
  | { kind: "lead"; leadId: string; helperIds?: string[]; helperRole?: CommitmentParticipantRole }
  | { kind: "each"; counterpartIds: string[] };

type Problem = { outcome: "invalid"; code: string };

export type CommitmentJointDeps = {
  transaction: TransactionRunner;
  c: WorkCommon;
  k: CommitmentCommon;
  /** The ledger's own edit and create, run inside this transaction. */
  updateInTx: (input: {
    principal: Principal;
    commitmentId: string;
    changes: { responsible: { kind: "counterpart"; counterpartId: string } };
    actor: "user" | "agent";
    userStatementRef?: string;
    reason: string;
    now: number;
  }) => { outcome: string } & Record<string, unknown>;
  insertInTx: (input: {
    owner: string;
    spec: {
      requirementText: string;
      responsible: { kind: "counterpart"; counterpartId: string };
      due: DueSpec;
      contextMode: "personal" | "executive";
      nextStep: string | null;
      origin: { kind: CommitmentRecord["originKind"]; refId: string };
    };
    createdBy: "user" | "agent";
    actor: "user" | "agent";
    userStatementRef?: string;
    now: number;
  }) => Problem | { outcome: "inserted"; id: string };
  linkInTx: (
    owner: string,
    commitmentId: string,
    workId: string,
    role: "required" | "reference",
    actor: "user" | "agent",
    now: number,
  ) => void;
  reevaluate: (owner: string, commitmentId: string, now: number) => void;
  fetch: (owner: string, id: string, now: number) => CommitmentRecord | undefined;
  addHelperInTx: (input: {
    principal: Principal;
    commitmentId: string;
    counterpartId: string;
    role: CommitmentParticipantRole;
    actor?: "user" | "agent";
    userStatementRef?: string;
    now: number;
  }) => { outcome: string };
};

class Rejected extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const OPEN = new Set(["open", "waiting"]);

export function createCommitmentJointOps(deps: CommitmentJointDeps) {
  const { transaction, c, k } = deps;
  const { one } = c;

  const live = (owner: string, id: string): boolean => {
    const row = one("SELECT lifecycle FROM counterparts WHERE owner_id = ? AND id = ?", owner, id);
    return row !== undefined && String(row.lifecycle) === "live";
  };

  const stated = (owner: string, id: string): boolean => {
    const row = one(
      "SELECT confirmation FROM counterparts WHERE owner_id = ? AND id = ?",
      owner,
      id,
    );
    return row !== undefined && ["stated", "confirmed"].includes(String(row.confirmation));
  };

  const dueOf = (row: Row): DueSpec => {
    const state = String(row.due_state);
    return state === "known"
      ? { kind: "known", at: Number(row.due_at), tz: String(row.due_tz) }
      : { kind: state === "none" ? "none" : "pending" };
  };

  const commitmentResolveJoint = (input: {
    principal: Principal;
    commitmentId: string;
    choice: JointChoice;
    /** The Agent may apply a choice the USER stated in chat: it must quote the words, and may only name people the user stated. */
    actor?: "user" | "agent";
    userStatementRef?: string;
    now: number;
  }) => {
    const by = input.actor ?? "user";
    const ref = typeof input.userStatementRef === "string" ? input.userStatementRef.trim() : "";
    try {
      return transaction(() => {
        const owner = input.principal.ownerId;
        const row = k.commitmentRow(owner, input.commitmentId);
        if (!row) {
          return { outcome: "not_found" as const };
        }
        const lifecycle = String(row.lifecycle);
        if (!OPEN.has(lifecycle)) {
          return { outcome: "closed" as const, lifecycle };
        }
        if (!parseAmbiguity(row.ambiguity_json)) {
          return { outcome: "not_joint" as const };
        }
        const choice = input.choice;
        const people =
          choice.kind === "lead"
            ? [choice.leadId, ...(choice.helperIds ?? [])]
            : choice.kind === "each"
              ? choice.counterpartIds
              : [];
        const bad = (code: string): Problem => ({ outcome: "invalid", code });
        if (choice.kind !== "lead" && choice.kind !== "each") {
          return bad("bad_choice");
        }
        if (people.some((id) => typeof id !== "string" || id.length === 0)) {
          return bad("counterpart_not_found");
        }
        if (new Set(people).size !== people.length) {
          return bad("duplicate_person");
        }
        if (choice.kind === "lead") {
          const role = choice.helperRole ?? "participant";
          if (!(COMMITMENT_PARTICIPANT_ROLES as readonly string[]).includes(role)) {
            return bad("bad_role");
          }
          if ((choice.helperIds ?? []).length > COMMITMENT_LIMITS.participants) {
            return bad("too_many");
          }
        } else {
          if (people.length < 2 || people.length > MAX_JOINT_NAMES) {
            return bad("bad_people_count");
          }
          if (row.period_key !== null) {
            // A per-period Commitment cannot be copied: the period key is unique per request.
            return bad("period_commitment");
          }
        }
        if (by === "agent" && (ref.length === 0 || ref.length > COMMITMENT_LIMITS.ref)) {
          return bad("statement_ref_required");
        }
        if (!people.every((id) => live(owner, id))) {
          return bad("counterpart_not_found");
        }
        if (by === "agent" && !people.every((id) => stated(owner, id))) {
          return bad("counterpart_not_confirmed");
        }
        const first = people[0] as string;
        const reason =
          choice.kind === "lead"
            ? "分责：一人负责，其余协助"
            : "分责：每人一条承诺（各自负责自己的交付）";
        const edited = deps.updateInTx({
          principal: input.principal,
          commitmentId: input.commitmentId,
          changes: { responsible: { kind: "counterpart", counterpartId: first } },
          actor: by,
          ...(by === "agent" ? { userStatementRef: ref } : {}),
          reason,
          now: input.now,
        });
        if (edited.outcome !== "updated") {
          throw new Rejected("not_changed");
        }
        const ids = [input.commitmentId];
        if (choice.kind === "lead") {
          for (const helperId of choice.helperIds ?? []) {
            const added = deps.addHelperInTx({
              principal: input.principal,
              commitmentId: input.commitmentId,
              counterpartId: helperId,
              role: choice.helperRole ?? "participant",
              actor: by,
              ...(by === "agent" ? { userStatementRef: ref } : {}),
              now: input.now,
            });
            if (added.outcome !== "added") {
              throw new Rejected("helper_not_added");
            }
          }
        } else {
          const links = k.linkedWorks(owner, input.commitmentId);
          for (const other of people.slice(1)) {
            const made = deps.insertInTx({
              owner,
              spec: {
                requirementText: String(row.requirement_text),
                responsible: { kind: "counterpart", counterpartId: other },
                due: dueOf(row),
                contextMode: String(row.context_mode) === "executive" ? "executive" : "personal",
                nextStep: row.next_step === null ? null : String(row.next_step),
                origin: {
                  kind: String(row.origin_kind) as CommitmentRecord["originKind"],
                  refId: String(row.origin_ref_id),
                },
              },
              createdBy: by,
              actor: by,
              ...(by === "agent" ? { userStatementRef: ref } : {}),
              now: input.now,
            });
            if (made.outcome !== "inserted") {
              throw new Rejected(made.code);
            }
            k.appendEvent(
              owner,
              made.id,
              "edited",
              by,
              { changed: ["split_from"], from: input.commitmentId, reason },
              input.now,
            );
            for (const link of links) {
              // The Agent only ever cites a Work as a reference; making it a requirement stays with the user.
              deps.linkInTx(
                owner,
                made.id,
                link.workId,
                by === "agent" ? "reference" : link.role,
                by,
                input.now,
              );
            }
            ids.push(made.id);
          }
        }
        for (const id of ids) {
          deps.reevaluate(owner, id, input.now);
        }
        const commitments = ids
          .map((id) => deps.fetch(owner, id, input.now))
          .filter((record): record is CommitmentRecord => record !== undefined);
        const workIds = [
          ...new Set(ids.flatMap((id) => k.linkedWorks(owner, id).map((link) => link.workId))),
        ];
        return {
          outcome: "resolved" as const,
          form: choice.kind,
          commitments,
          workIds,
        };
      });
    } catch (error) {
      if (error instanceof Rejected) {
        return { outcome: "invalid" as const, code: error.code };
      }
      throw error;
    }
  };

  return { commitmentResolveJoint };
}
