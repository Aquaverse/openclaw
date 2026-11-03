// Commitment state lines (object-model design 6.1-6.4): communication, acceptance, lifecycle (manual resolve, cancel, restore,
// reopen) and the engine's atomic verification commit. Each transition writes one commitment_events row, and every change that
// can move a citing Work re-evaluates it afterwards. Who may do what is decided here, not by the caller (design 6.3):
//   * `accepted` needs a basis and is never written by the Agent; the user's word is stored as `user_report`;
//   * resolve (manual), cancel and restore are the user's alone; `source_verified` is written only by commitCommitmentVerification.
import {
  COMMITMENT_LIMITS,
  type AcceptanceState,
  type CommitmentImpact,
  type CommitmentRecord,
  type CommunicationState,
} from "../commitment/types.js";
import type { CommitmentCommon } from "./commitment-common.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

export type CommitmentFlowDeps = {
  transaction: TransactionRunner;
  c: WorkCommon;
  k: CommitmentCommon;
  reevaluate: (owner: string, commitmentId: string, now: number) => void;
  fetch: (owner: string, id: string, now: number) => CommitmentRecord | undefined;
};

const clean = (text: unknown): string => (typeof text === "string" ? text.trim() : "");
const OPEN = new Set(["open", "waiting"]);

export function createCommitmentFlowOps(deps: CommitmentFlowDeps) {
  const { transaction, c, k, reevaluate, fetch } = deps;
  const { run, one, newId } = c;

  type Loaded = { row: Row; lifecycle: string };
  /** The row, or why the caller cannot act on it (not found / stale revision). */
  const load = (
    owner: string,
    id: string,
    expectedRevision: number | undefined,
  ):
    | { problem: { outcome: "not_found" } | { outcome: "revision_conflict"; revision: number } }
    | Loaded => {
    const row = k.commitmentRow(owner, id);
    if (!row) {
      return { problem: { outcome: "not_found" } };
    }
    if (expectedRevision !== undefined && expectedRevision !== Number(row.revision)) {
      return { problem: { outcome: "revision_conflict", revision: Number(row.revision) } };
    }
    return { row, lifecycle: String(row.lifecycle) };
  };

  // ------------------------------------------------------------------ communication

  /** A fact about telling the responsible person, bound to the CURRENT responsibility version (design 6.1). */
  const commitmentCommunication = (input: {
    principal: Principal;
    commitmentId: string;
    state: Exclude<CommunicationState, "draft">;
    actionRef?: string;
    receiptLevel?: string;
    actor: "user" | "agent" | "system";
    expectedRevision?: number;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const loaded = load(owner, input.commitmentId, input.expectedRevision);
      if ("problem" in loaded) {
        return loaded.problem;
      }
      if (!OPEN.has(loaded.lifecycle)) {
        return { outcome: "closed" as const, lifecycle: loaded.lifecycle };
      }
      if (!["submitted", "confirmed", "unknown", "failed"].includes(input.state)) {
        return { outcome: "invalid" as const, code: "bad_state" };
      }
      const actionRef = clean(input.actionRef);
      const receipt = clean(input.receiptLevel);
      if (actionRef.length > COMMITMENT_LIMITS.ref || receipt.length > 64) {
        return { outcome: "invalid" as const, code: "bad_receipt" };
      }
      if (input.actor !== "user" && actionRef.length === 0) {
        // An Agent or the system may only record what a delivery receipt shows (design 6.3).
        return { outcome: "invalid" as const, code: "receipt_required" };
      }
      const toWaiting =
        loaded.lifecycle === "open" && (input.state === "submitted" || input.state === "confirmed");
      run(
        "UPDATE commitments SET communication_state = ?, communication_action_ref = ?, communication_receipt_level = ?, communication_at = ?, " +
          `lifecycle = CASE WHEN ? = 1 THEN 'waiting' ELSE lifecycle END, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?`,
        input.state,
        actionRef || null,
        receipt || (input.actor === "user" ? "user_report" : null),
        input.now,
        toWaiting ? 1 : 0,
        input.now,
        owner,
        input.commitmentId,
      );
      k.appendEvent(
        owner,
        input.commitmentId,
        "communication_changed",
        input.actor,
        {
          from: String(loaded.row.communication_state),
          to: input.state,
          actionRef: actionRef || null,
          responsibilityVersion: Number(loaded.row.responsibility_version),
        },
        input.now,
      );
      if (toWaiting) {
        k.appendEvent(
          owner,
          input.commitmentId,
          "lifecycle_changed",
          input.actor,
          { from: "open", to: "waiting" },
          input.now,
        );
      }
      reevaluate(owner, input.commitmentId, input.now);
      return {
        outcome: "updated" as const,
        commitment: fetch(owner, input.commitmentId, input.now) as CommitmentRecord,
      };
    });

  // ------------------------------------------------------------------ acceptance

  /** Whether the responsible person agreed. Needs a basis; silence, reading, "got it" never count (design 6.1, R-09). */
  const commitmentAcceptance = (input: {
    principal: Principal;
    commitmentId: string;
    state: AcceptanceState;
    basisKind?: "counterpart_source" | "user_report";
    basis?: string;
    actor: "user" | "agent" | "system";
    expectedRevision?: number;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const loaded = load(owner, input.commitmentId, input.expectedRevision);
      if ("problem" in loaded) {
        return loaded.problem;
      }
      if (!OPEN.has(loaded.lifecycle)) {
        return { outcome: "closed" as const, lifecycle: loaded.lifecycle };
      }
      if (!["unknown", "accepted", "declined", "needs_clarification"].includes(input.state)) {
        return { outcome: "invalid" as const, code: "bad_state" };
      }
      if (input.actor === "agent" && (input.state === "accepted" || input.state === "unknown")) {
        // The Agent can relay a refusal or a question with its source, but never writes an acceptance (design 6.3).
        return { outcome: "forbidden" as const, code: "agent_cannot_accept" };
      }
      const basis = clean(input.basis);
      let basisKind: "counterpart_source" | "user_report" | null = null;
      if (input.state !== "unknown") {
        if (basis.length === 0 || basis.length > COMMITMENT_LIMITS.basis) {
          return { outcome: "invalid" as const, code: "basis_required" };
        }
        basisKind = input.basisKind ?? "user_report";
        if (basisKind === "counterpart_source" && input.actor !== "system") {
          // A person's own report is never presented as the other side's source record.
          return { outcome: "invalid" as const, code: "basis_kind_not_allowed" };
        }
      }
      run(
        "UPDATE commitments SET acceptance_state = ?, acceptance_basis_kind = ?, acceptance_basis = ?, acceptance_at = ?, " +
          "revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
        input.state,
        basisKind,
        input.state === "unknown" ? null : basis,
        input.state === "unknown" ? null : input.now,
        input.now,
        owner,
        input.commitmentId,
      );
      k.appendEvent(
        owner,
        input.commitmentId,
        "acceptance_changed",
        input.actor,
        {
          from: String(loaded.row.acceptance_state),
          to: input.state,
          basisKind,
          responsibilityVersion: Number(loaded.row.responsibility_version),
        },
        input.now,
      );
      reevaluate(owner, input.commitmentId, input.now);
      return {
        outcome: "updated" as const,
        commitment: fetch(owner, input.commitmentId, input.now) as CommitmentRecord,
      };
    });

  // ------------------------------------------------------------------ lifecycle (user only)

  type CloseInput = {
    principal: Principal;
    commitmentId: string;
    reason: string;
    /** True: report what would be reached and change nothing (design 6.5). */
    dryRun?: boolean;
    expectedRevision?: number;
    now: number;
  };

  const closeWith = (
    input: CloseInput,
    kind: "resolve" | "cancel",
  ):
    | { outcome: "not_found" }
    | { outcome: "revision_conflict"; revision: number }
    | { outcome: "not_open"; lifecycle: string }
    | { outcome: "invalid"; code: string }
    | { outcome: "preview"; impact: CommitmentImpact }
    | {
        outcome: "resolved" | "cancelled";
        commitment: CommitmentRecord;
        impact: CommitmentImpact;
      } => {
    const owner = input.principal.ownerId;
    const loaded = load(owner, input.commitmentId, input.expectedRevision);
    if ("problem" in loaded) {
      return loaded.problem;
    }
    if (!OPEN.has(loaded.lifecycle)) {
      return { outcome: "not_open", lifecycle: loaded.lifecycle };
    }
    const reason = clean(input.reason);
    if (reason.length === 0 || reason.length > COMMITMENT_LIMITS.reason) {
      return { outcome: "invalid", code: "reason_required" };
    }
    const impact = k.impactOf(owner, input.commitmentId);
    if (input.dryRun) {
      return { outcome: "preview", impact };
    }
    if (kind === "resolve") {
      // The verification value stays what it really is: a manual close is not a verified fulfilment (design 6.2).
      run(
        "UPDATE commitments SET lifecycle = 'resolved', resolution_basis = 'manual_override', resolution_reason = ?, resolved_at = ?, " +
          "revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
        reason,
        input.now,
        input.now,
        owner,
        input.commitmentId,
      );
      k.appendEvent(
        owner,
        input.commitmentId,
        "resolved_manual",
        "user",
        { reason, from: loaded.lifecycle, impact: impact.works.length },
        input.now,
      );
    } else {
      run(
        "UPDATE commitments SET lifecycle = 'cancelled', cancel_reason = ?, cancelled_at = ?, revision = revision + 1, updated_at = ? " +
          "WHERE owner_id = ? AND id = ?",
        reason,
        input.now,
        input.now,
        owner,
        input.commitmentId,
      );
      k.appendEvent(
        owner,
        input.commitmentId,
        "cancelled",
        "user",
        { reason, from: loaded.lifecycle, impact: impact.works.length },
        input.now,
      );
    }
    reevaluate(owner, input.commitmentId, input.now);
    return {
      outcome: kind === "resolve" ? "resolved" : "cancelled",
      commitment: fetch(owner, input.commitmentId, input.now) as CommitmentRecord,
      impact,
    };
  };

  const commitmentResolve = (input: CloseInput) => transaction(() => closeWith(input, "resolve"));
  const commitmentCancel = (input: CloseInput) => transaction(() => closeWith(input, "cancel"));

  /** cancelled -> open. Only an explicit user act revives a cancelled obligation (design 6.2). */
  const commitmentRestore = (input: {
    principal: Principal;
    commitmentId: string;
    expectedRevision?: number;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const loaded = load(owner, input.commitmentId, input.expectedRevision);
      if ("problem" in loaded) {
        return loaded.problem;
      }
      if (loaded.lifecycle !== "cancelled") {
        return { outcome: "not_cancelled" as const, lifecycle: loaded.lifecycle };
      }
      run(
        "UPDATE commitments SET lifecycle = 'open', cancelled_at = NULL, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
        input.now,
        owner,
        input.commitmentId,
      );
      k.appendEvent(
        owner,
        input.commitmentId,
        "reopened",
        "user",
        { from: "cancelled", previousReason: loaded.row.cancel_reason ?? null },
        input.now,
      );
      reevaluate(owner, input.commitmentId, input.now);
      return {
        outcome: "restored" as const,
        commitment: fetch(owner, input.commitmentId, input.now) as CommitmentRecord,
      };
    });

  /**
   * resolved -> open / waiting (design 6.2). A manual close can be taken back by the user; a verified one is taken back when new
   * conflicting evidence arrives (engine, later slice). Plans that were wrapped up are NOT revived (INV-10).
   */
  const commitmentReopen = (input: {
    principal: Principal;
    commitmentId: string;
    reason?: string;
    dryRun?: boolean;
    expectedRevision?: number;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const loaded = load(owner, input.commitmentId, input.expectedRevision);
      if ("problem" in loaded) {
        return loaded.problem;
      }
      if (loaded.lifecycle !== "resolved") {
        return { outcome: "not_resolved" as const, lifecycle: loaded.lifecycle };
      }
      const impact = k.impactOf(owner, input.commitmentId);
      if (input.dryRun) {
        return { outcome: "preview" as const, impact };
      }
      const verified = String(loaded.row.resolution_basis) === "source_verified";
      const communicated = ["submitted", "confirmed"].includes(
        String(loaded.row.communication_state),
      );
      const next = communicated ? "waiting" : "open";
      if (verified) {
        run(
          "UPDATE commitment_assessments SET superseded_at = ? WHERE owner_id = ? AND commitment_id = ? AND superseded_at IS NULL",
          input.now,
          owner,
          input.commitmentId,
        );
      }
      run(
        "UPDATE commitments SET lifecycle = ?, resolution_basis = NULL, resolution_reason = NULL, resolved_at = NULL, " +
          (verified ? "verification = 'unverified', current_assessment_id = NULL, " : "") +
          "revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
        next,
        input.now,
        owner,
        input.commitmentId,
      );
      k.appendEvent(
        owner,
        input.commitmentId,
        "reopened",
        "user",
        {
          from: "resolved",
          to: next,
          basis: loaded.row.resolution_basis ?? null,
          reason: clean(input.reason) || null,
        },
        input.now,
      );
      reevaluate(owner, input.commitmentId, input.now);
      return {
        outcome: "reopened" as const,
        commitment: fetch(owner, input.commitmentId, input.now) as CommitmentRecord,
        impact,
      };
    });

  // ------------------------------------------------------------------ verification commit (engine only)

  /**
   * The ONLY writer of `resolved(source_verified)` (design 6.2, INV-18). The assessment, the verification value and the resolution
   * land in one transaction behind a compare-and-set on `verification_commit_version`; a stale caller gets `stale`. No public
   * gateway method or Agent tool calls this: the verification engine (a later slice) does.
   */
  const commitmentCommitVerification = (input: {
    principal: Principal;
    commitmentId: string;
    expectedCommitVersion: number;
    overall: "met" | "not_met" | "insufficient_evidence" | "conflicting_evidence";
    evidenceSetHash: string;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const loaded = load(owner, input.commitmentId, undefined);
      if ("problem" in loaded) {
        return loaded.problem;
      }
      if (Number(loaded.row.verification_commit_version) !== input.expectedCommitVersion) {
        return { outcome: "stale" as const };
      }
      if (!OPEN.has(loaded.lifecycle)) {
        return { outcome: "not_open" as const, lifecycle: loaded.lifecycle };
      }
      const hash = clean(input.evidenceSetHash);
      if (hash.length === 0 || hash.length > 128) {
        return { outcome: "invalid" as const, code: "bad_evidence_hash" };
      }
      const previous = one(
        "SELECT COALESCE(MAX(assessment_version), 0) AS m FROM commitment_assessments WHERE owner_id = ? AND commitment_id = ?",
        owner,
        input.commitmentId,
      ) as Row;
      run(
        "UPDATE commitment_assessments SET superseded_at = ? WHERE owner_id = ? AND commitment_id = ? AND superseded_at IS NULL",
        input.now,
        owner,
        input.commitmentId,
      );
      const assessmentId = newId("ca_");
      run(
        "INSERT INTO commitment_assessments (owner_id, id, commitment_id, assessment_version, responsibility_version, contract_version, evidence_set_hash, overall, assessed_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        owner,
        assessmentId,
        input.commitmentId,
        Number(previous.m) + 1,
        Number(loaded.row.responsibility_version),
        Number(loaded.row.contract_version),
        hash,
        input.overall,
        input.now,
      );
      const verification =
        input.overall === "met"
          ? "verified_complete"
          : input.overall === "not_met"
            ? "verified_exception"
            : input.overall === "conflicting_evidence"
              ? "conflicting_evidence"
              : "unverified";
      const resolve = input.overall === "met";
      run(
        "UPDATE commitments SET verification = ?, current_assessment_id = ?, verification_commit_version = verification_commit_version + 1, " +
          (resolve
            ? "lifecycle = 'resolved', resolution_basis = 'source_verified', resolved_at = ?, "
            : "") +
          "revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
        verification,
        assessmentId,
        ...(resolve ? [input.now] : []),
        input.now,
        owner,
        input.commitmentId,
      );
      k.appendEvent(
        owner,
        input.commitmentId,
        "assessment_committed",
        "engine",
        { assessmentId, overall: input.overall },
        input.now,
      );
      k.appendEvent(
        owner,
        input.commitmentId,
        "verification_changed",
        "engine",
        { from: String(loaded.row.verification), to: verification },
        input.now,
      );
      if (resolve) {
        k.appendEvent(
          owner,
          input.commitmentId,
          "resolved_source_verified",
          "engine",
          { assessmentId },
          input.now,
        );
      }
      reevaluate(owner, input.commitmentId, input.now);
      return {
        outcome: "committed" as const,
        commitment: fetch(owner, input.commitmentId, input.now) as CommitmentRecord,
      };
    });

  return {
    commitmentCommunication,
    commitmentAcceptance,
    commitmentResolve,
    commitmentCancel,
    commitmentRestore,
    commitmentReopen,
    commitmentCommitVerification,
  };
}
