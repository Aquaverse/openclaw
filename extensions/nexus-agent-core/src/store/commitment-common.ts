import {
  asksForEither,
  parseAmbiguity,
  readResponsibleWording,
  type JointAmbiguity,
} from "../commitment/joint.js";
// Commitment kernel, shared part: row mapping, the append-only event writer, responsibility snapshots, the owner's own identity row
// and the lookups every operation module needs. No transaction is opened here; the modules around it own theirs. Every statement
// filters on owner_id.
import type {
  CommitmentActor,
  CommitmentImpact,
  CommitmentParticipant,
  CommitmentRecord,
  ResponsibleSpec,
} from "../commitment/types.js";
import { createCounterpartCommon } from "./counterpart-common.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

/** How many people help with the commitment (a live link). Added to every select that builds a CommitmentRecord. */
export const PARTICIPANT_COUNT =
  "(SELECT COUNT(*) FROM commitment_participant_links pl WHERE pl.owner_id = c.owner_id AND pl.commitment_id = c.id AND pl.status <> 'revoked') AS participant_count";

export const COMMITMENT_SELECT =
  `SELECT c.*, cp.display_name AS responsible_name, ${PARTICIPANT_COUNT}, ` +
  "(oi.self_counterpart_id IS NOT NULL) AS responsible_self FROM commitments c " +
  "LEFT JOIN counterparts cp ON cp.owner_id = c.owner_id AND cp.id = c.responsible_counterpart_id " +
  "LEFT JOIN owner_identity oi ON oi.owner_id = c.owner_id AND oi.self_counterpart_id = c.responsible_counterpart_id";

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export function toCommitment(row: Row, now: number): CommitmentRecord {
  const lifecycle = String(row.lifecycle) as CommitmentRecord["lifecycle"];
  const dueAt = num(row.due_at);
  return {
    ownerId: String(row.owner_id),
    id: String(row.id),
    requirementText: String(row.requirement_text),
    responsibleCounterpartId: str(row.responsible_counterpart_id),
    responsibleRaw: str(row.responsible_raw),
    responsibleName: str(row.responsible_name),
    responsibleSelf: Number(row.responsible_self) === 1,
    responsibilityVersion: Number(row.responsibility_version),
    contextMode: String(row.context_mode) as CommitmentRecord["contextMode"],
    contextScopeId: String(row.context_scope_id),
    periodRequestId: str(row.period_request_id),
    periodKey: str(row.period_key),
    periodIndex: num(row.period_index),
    periodStart: num(row.period_start),
    periodEnd: num(row.period_end),
    periodTz: str(row.period_tz),
    originKind: String(row.origin_kind) as CommitmentRecord["originKind"],
    originRefId: String(row.origin_ref_id),
    dueState: String(row.due_state) as CommitmentRecord["dueState"],
    dueAt,
    dueTz: str(row.due_tz),
    communicationState: String(row.communication_state) as CommitmentRecord["communicationState"],
    communicationActionRef: str(row.communication_action_ref),
    communicationReceiptLevel: str(row.communication_receipt_level),
    communicationAt: num(row.communication_at),
    acceptanceState: String(row.acceptance_state) as CommitmentRecord["acceptanceState"],
    acceptanceBasisKind: str(row.acceptance_basis_kind) as CommitmentRecord["acceptanceBasisKind"],
    acceptanceBasis: str(row.acceptance_basis),
    acceptanceAt: num(row.acceptance_at),
    lifecycle,
    verification: String(row.verification) as CommitmentRecord["verification"],
    currentAssessmentId: str(row.current_assessment_id),
    verificationCommitVersion: Number(row.verification_commit_version),
    resolutionBasis: str(row.resolution_basis) as CommitmentRecord["resolutionBasis"],
    resolutionReason: str(row.resolution_reason),
    resolvedAt: num(row.resolved_at),
    cancelReason: str(row.cancel_reason),
    cancelledAt: num(row.cancelled_at),
    nextStep: str(row.next_step),
    createdBy: String(row.created_by) as CommitmentRecord["createdBy"],
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    overdue: dueAt !== null && dueAt < now && (lifecycle === "open" || lifecycle === "waiting"),
    ...(Number(row.participant_count) > 0
      ? { participantCount: Number(row.participant_count) }
      : {}),
    ...(parseAmbiguity(row.ambiguity_json)
      ? { ambiguity: parseAmbiguity(row.ambiguity_json) }
      : {}),
  };
}

export function toParticipant(row: Row): CommitmentParticipant {
  return {
    id: String(row.id),
    commitmentId: String(row.commitment_id),
    counterpartId: String(row.counterpart_id),
    displayName: String(row.display_name ?? ""),
    role: String(row.role) as CommitmentParticipant["role"],
    responsibilityVersion: Number(row.responsibility_version),
    purpose: str(row.purpose),
    createdAt: Number(row.created_at),
  };
}

export const COMMITMENT_EVENT_KINDS = [
  "created",
  "edited",
  "responsible_resolved",
  "responsible_changed",
  "due_changed",
  "standard_changed",
  "responsibility_versioned",
  "communication_changed",
  "acceptance_changed",
  "lifecycle_changed",
  "verification_changed",
  "assessment_committed",
  "resolved_source_verified",
  "resolved_manual",
  "cancelled",
  "reopened",
  "evidence_attached",
  "evidence_reassessed",
  "linked_to_work",
  "unlinked_from_work",
  "follow_up_started",
  "follow_up_stopped",
] as const;
export type CommitmentEventKind = (typeof COMMITMENT_EVENT_KINDS)[number];

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) {
    return false;
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
}

export function createCommitmentCommon(c: WorkCommon) {
  const { one, all, run, newId } = c;
  const names = createCounterpartCommon(c);

  const commitmentRow = (owner: string, id: string): Row | undefined =>
    one(`${COMMITMENT_SELECT} WHERE c.owner_id = ? AND c.id = ?`, owner, id);

  /** Append one timeline entry; `seq` is dense per Commitment. Returns the new event id. */
  const appendEvent = (
    owner: string,
    commitmentId: string,
    kind: CommitmentEventKind,
    actor: CommitmentActor,
    payload: Record<string, unknown>,
    now: number,
  ): string => {
    const seq =
      Number(
        (
          one(
            "SELECT COALESCE(MAX(seq), 0) AS m FROM commitment_events WHERE owner_id = ? AND commitment_id = ?",
            owner,
            commitmentId,
          ) as Row
        ).m,
      ) + 1;
    const id = newId("ce_");
    run(
      "INSERT INTO commitment_events (owner_id, id, commitment_id, seq, kind, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      owner,
      id,
      commitmentId,
      seq,
      kind,
      actor,
      JSON.stringify(payload),
      now,
    );
    return id;
  };

  /** Every owner has exactly one self identity row (INV-01); created on first use. */
  const ensureSelf = (owner: string, now: number): string => {
    const existing = one(
      "SELECT self_counterpart_id AS id FROM owner_identity WHERE owner_id = ?",
      owner,
    );
    if (existing) {
      return String(existing.id);
    }
    const id = newId("cp_");
    run(
      "INSERT INTO counterparts (owner_id, id, kind, display_name, confirmation, origin, lifecycle, revision, created_at, updated_at) " +
        "VALUES (?, ?, 'person', 'Me', 'confirmed', 'system', 'live', 1, ?, ?)",
      owner,
      id,
      now,
      now,
    );
    run(
      "INSERT INTO owner_identity (owner_id, self_counterpart_id, created_at) VALUES (?, ?, ?)",
      owner,
      id,
      now,
    );
    return id;
  };

  /**
   * Turn what the caller said into the two responsibility columns. An Agent may only name an existing, live counterpart whose
   * identity the user stated or confirmed (design 6.3); a person's own word stays as typed and is never guessed into a record.
   */
  const resolveResponsible = (
    owner: string,
    spec: ResponsibleSpec,
    actor: CommitmentActor,
    now: number,
  ):
    | { counterpartId: string | null; raw: string | null }
    | {
        problem: "responsible_required" | "counterpart_not_found" | "counterpart_not_confirmed";
      } => {
    if (spec.kind === "self") {
      return { counterpartId: ensureSelf(owner, now), raw: null };
    }
    if (spec.kind === "name") {
      const name = typeof spec.name === "string" ? spec.name.trim() : "";
      if (name.length === 0) {
        return { problem: "responsible_required" };
      }
      if (actor === "agent") {
        // Exactly one person the user stated or confirmed answers to this name: use it. Several or none: the typed name stays,
        // and the user picks the person later (a name is never a key).
        const found = names.resolveName(owner, name);
        if (found.match === "one") {
          return {
            counterpartId: found.candidates[0]?.id ?? null,
            raw: found.candidates[0] ? null : name,
          };
        }
      }
      return { counterpartId: null, raw: name };
    }
    const cp = one(
      "SELECT confirmation, lifecycle FROM counterparts WHERE owner_id = ? AND id = ?",
      owner,
      spec.counterpartId,
    );
    if (!cp || String(cp.lifecycle) !== "live") {
      return { problem: "counterpart_not_found" };
    }
    if (actor === "agent" && !["stated", "confirmed"].includes(String(cp.confirmation))) {
      return { problem: "counterpart_not_confirmed" };
    }
    return { counterpartId: spec.counterpartId, raw: null };
  };

  /**
   * What the typed words say about who answers (design 6.8): several people or a group are kept as typed and marked "joint" until
   * the user chooses; "any one of them is enough" is refused. A name the user already has wins over a split ("刘和平" is one person).
   */
  const wordingOf = (
    owner: string,
    spec: ResponsibleSpec,
    ...extra: Array<string | undefined>
  ): { problem: "either_responsible" } | { ambiguity: JointAmbiguity | null } => {
    const typed =
      spec.kind === "name" && typeof spec.name === "string" ? spec.name.trim() : undefined;
    if (asksForEither(typed, ...extra)) {
      return { problem: "either_responsible" };
    }
    const read = typed ? readResponsibleWording(typed) : null;
    if (
      !typed ||
      !read ||
      read.kind !== "joint" ||
      names.resolveName(owner, typed).match !== "none"
    ) {
      return { ambiguity: null };
    }
    return { ambiguity: { kind: "joint", names: read.names } };
  };

  /** Write (or clear) the "waiting for the user's choice" mark. */
  const markAmbiguity = (
    owner: string,
    commitmentId: string,
    ambiguity: JointAmbiguity | null,
  ): void => {
    run(
      "UPDATE commitments SET ambiguity_json = ? WHERE owner_id = ? AND id = ?",
      ambiguity ? JSON.stringify(ambiguity) : null,
      owner,
      commitmentId,
    );
  };

  /** Keep the previous responsibility version as a snapshot before the live row moves on (design 4.4.2). */
  const snapshotVersion = (owner: string, row: Row, reason: string, now: number): void => {
    run(
      "INSERT INTO commitment_responsibility_versions (owner_id, commitment_id, responsibility_version, responsible_counterpart_id, " +
        "responsible_raw, requirement_text, due_state, due_at, due_tz, contract_version, communication_state, communication_action_ref, " +
        "acceptance_state, acceptance_basis, superseded_at, superseded_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      owner,
      String(row.id),
      Number(row.responsibility_version),
      (row.responsible_counterpart_id as string | null) ?? null,
      (row.responsible_raw as string | null) ?? null,
      String(row.requirement_text),
      String(row.due_state),
      (row.due_at as number | null) ?? null,
      (row.due_tz as string | null) ?? null,
      Number(row.contract_version),
      String(row.communication_state),
      (row.communication_action_ref as string | null) ?? null,
      String(row.acceptance_state),
      (row.acceptance_basis as string | null) ?? null,
      now,
      reason,
    );
  };

  /** Works that point at this Commitment through an active link (design 6.5). Deleted or purging Works are left out. */
  const linkedWorks = (owner: string, commitmentId: string): CommitmentImpact["works"] =>
    all(
      "SELECT l.id AS link_id, l.work_id, l.role, w.title FROM work_links l JOIN works w ON w.owner_id = l.owner_id AND w.id = l.work_id " +
        "WHERE l.owner_id = ? AND l.target_kind = 'commitment' AND l.target_id = ? AND l.ended_at IS NULL " +
        "AND w.lifecycle IN ('live','archived') ORDER BY w.updated_at DESC",
      owner,
      commitmentId,
    ).map((row) => ({
      workId: String(row.work_id),
      title: String(row.title),
      role: String(row.role) as "required" | "reference",
      linkId: String(row.link_id),
    }));

  /**
   * INV-08: the responsible one is never also a helper. When a person becomes responsible (an edit, a claim, a merge, a split),
   * the links that name them as a helper on that commitment end, with the time. `scope` narrows it to one commitment or one person.
   */
  const endHelperWhoIsResponsible = (
    owner: string,
    now: number,
    scope: { commitmentId?: string; counterpartId?: string },
  ): void => {
    run(
      "UPDATE commitment_participant_links SET status = 'revoked', revoked_at = ?, valid_to = ? " +
        "WHERE owner_id = ? AND status <> 'revoked' " +
        (scope.commitmentId !== undefined ? "AND commitment_id = ? " : "") +
        (scope.counterpartId !== undefined ? "AND counterpart_id = ? " : "") +
        "AND EXISTS (SELECT 1 FROM commitments c WHERE c.owner_id = commitment_participant_links.owner_id " +
        "AND c.id = commitment_participant_links.commitment_id " +
        "AND c.responsible_counterpart_id = commitment_participant_links.counterpart_id)",
      now,
      now,
      owner,
      ...(scope.commitmentId !== undefined ? [scope.commitmentId] : []),
      ...(scope.counterpartId !== undefined ? [scope.counterpartId] : []),
    );
  };

  /** The people who help with a commitment (live links), oldest first. */
  const helpersOf = (owner: string, commitmentId: string): CommitmentParticipant[] =>
    all(
      "SELECT l.*, cp.display_name FROM commitment_participant_links l " +
        "JOIN counterparts cp ON cp.owner_id = l.owner_id AND cp.id = l.counterpart_id " +
        "WHERE l.owner_id = ? AND l.commitment_id = ? AND l.status <> 'revoked' ORDER BY l.created_at, l.id",
      owner,
      commitmentId,
    ).map(toParticipant);

  const impactOf = (owner: string, commitmentId: string): CommitmentImpact => ({
    works: linkedWorks(owner, commitmentId),
    // Follow-up plans arrive with slice W4: until then no plan can be owned by a commitment.
    plansToWrapUp: [],
    helpers: helpersOf(owner, commitmentId).map((h) => ({
      counterpartId: h.counterpartId,
      displayName: h.displayName,
      role: h.role,
    })),
  });

  return {
    commitmentRow,
    appendEvent,
    ensureSelf,
    resolveResponsible,
    wordingOf,
    markAmbiguity,
    snapshotVersion,
    linkedWorks,
    impactOf,
    endHelperWhoIsResponsible,
    helpersOf,
  };
}

export type CommitmentCommon = ReturnType<typeof createCommitmentCommon>;
