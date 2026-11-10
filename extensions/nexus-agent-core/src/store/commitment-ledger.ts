import type { JointAmbiguity } from "../commitment/joint.js";
import {
  COMMITMENT_LIMITS,
  type CommitmentActor,
  type CommitmentChanges,
  type CommitmentRecord,
  type CommitmentSpec,
  type DueSpec,
  type PeriodSpec,
} from "../commitment/types.js";
import { createCommitmentAssistOps } from "./commitment-assist-ledger.js";
import { createCommitmentBackfillOps } from "./commitment-backfill-ledger.js";
import {
  COMMITMENT_SELECT,
  createCommitmentCommon,
  toCommitment,
  validTimeZone,
} from "./commitment-common.js";
import { createCommitmentFlowOps } from "./commitment-flow-ledger.js";
import { createCommitmentJointOps } from "./commitment-joint-ledger.js";
import { createCommitmentReadOps } from "./commitment-read-ledger.js";
import { createCommitmentRoleOps } from "./commitment-role-ledger.js";
// Commitment kernel (object-model design 4.4, 6, 10.2): create, read, list, edit with responsibility versions and the impact
// preview. The four state lines (communication, acceptance, lifecycle, verification) move in commitment-flow-ledger.ts.
// Every method is ONE synchronous transaction and every statement filters on owner_id. What holds across the files:
//   * history is append-only (commitment_events); a material edit (who, what, when) snapshots the old responsibility version and
//     bumps `responsibility_version`, which resets communication and acceptance: a fact about the old version is never reused;
//   * `overdue` is computed at read time; the Agent can only record what the user said (userStatementRef) and never accepts,
//     resolves, cancels or restores;
//   * a change reaches the Works that cite the Commitment through re-evaluation, never by writing their state.
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { WorkActor } from "./work-ledger-common.js";
import type { WorkLedger } from "./work-ledger.js";

type CreatedBy = "user" | "agent" | "review_batch";
type Problem = { outcome: "invalid"; code: string };

const clean = (text: unknown): string => (typeof text === "string" ? text.trim() : "");
const workActor = (actor: CommitmentActor): WorkActor =>
  actor === "agent" ? "agent" : actor === "user" ? "user" : "system";

function normalizeDue(
  due: DueSpec | undefined,
): { state: string; at: number | null; tz: string | null } | null {
  const spec = due ?? { kind: "pending" as const };
  if (spec.kind === "known") {
    if (!Number.isSafeInteger(spec.at) || spec.at <= 0 || !validTimeZone(spec.tz)) {
      return null;
    }
    return { state: "known", at: spec.at, tz: spec.tz };
  }
  if (spec.kind === "pending" || spec.kind === "none") {
    return { state: spec.kind, at: null, tz: null };
  }
  return null;
}

export function createCommitmentLedger(
  transaction: TransactionRunner,
  work: WorkLedger["internals"],
) {
  const c = work.common;
  const { one, run, newId } = c;
  const k = createCommitmentCommon(c);

  /** Re-evaluate every Work that requires this Commitment, and refresh the list order of every Work that cites it. */
  const reevaluate = (owner: string, commitmentId: string, now: number): void => {
    const linked = k.linkedWorks(owner, commitmentId);
    for (const link of linked) {
      if (link.role === "required") {
        work.evaluateOutcomeInTx(owner, link.workId, now);
      }
      c.touch(owner, link.workId, now);
    }
  };

  const fetch = (owner: string, id: string, now: number): CommitmentRecord | undefined => {
    const row = k.commitmentRow(owner, id);
    return row ? toCommitment(row, now) : undefined;
  };

  // ------------------------------------------------------------------ create

  type InsertInput = {
    owner: string;
    spec: CommitmentSpec;
    createdBy: CreatedBy;
    actor: CommitmentActor;
    userStatementRef?: string;
    period?: { requestId: string; spec: PeriodSpec };
    now: number;
  };

  /** Validate and insert one Commitment row plus its `created` event. Caller owns the transaction. */
  const insertInTx = (input: InsertInput): Problem | { outcome: "inserted"; id: string } => {
    const { owner, spec, now } = input;
    const text = clean(spec.requirementText);
    if (text.length === 0 || text.length > COMMITMENT_LIMITS.requirement) {
      return { outcome: "invalid", code: "bad_requirement" };
    }
    const nextStep =
      spec.nextStep === undefined || spec.nextStep === null ? null : clean(spec.nextStep);
    if (nextStep !== null && nextStep.length > COMMITMENT_LIMITS.nextStep) {
      return { outcome: "invalid", code: "bad_next_step" };
    }
    if (input.createdBy === "agent") {
      const ref = clean(input.userStatementRef);
      if (ref.length === 0 || ref.length > COMMITMENT_LIMITS.ref) {
        return { outcome: "invalid", code: "statement_ref_required" };
      }
    }
    let originKind = spec.origin.kind;
    let originRef = clean(spec.origin.refId);
    if (input.createdBy === "agent") {
      // An Agent record is a native record of what the user said; its origin is that statement, never a Task or a job.
      originKind = "native_record";
      originRef = clean(input.userStatementRef);
    }
    if (originRef.length === 0 || originRef.length > COMMITMENT_LIMITS.ref) {
      return { outcome: "invalid", code: "bad_origin" };
    }
    if (
      originKind === "task_run" &&
      !one("SELECT 1 AS found FROM nexus_tasks WHERE owner_id = ? AND id = ?", owner, originRef)
    ) {
      return { outcome: "invalid", code: "origin_not_found" };
    }
    const due = input.period
      ? normalizeDue({ kind: "known", at: input.period.spec.dueAt, tz: input.period.spec.tz })
      : normalizeDue(spec.due);
    if (!due) {
      return { outcome: "invalid", code: "bad_due" };
    }
    const responsible = k.resolveResponsible(owner, spec.responsible, input.actor, now);
    if ("problem" in responsible) {
      return { outcome: "invalid", code: responsible.problem };
    }
    if (responsible.raw !== null && responsible.raw.length > COMMITMENT_LIMITS.responsibleRaw) {
      return { outcome: "invalid", code: "bad_responsible" };
    }
    const wording = k.wordingOf(owner, spec.responsible, text, clean(input.userStatementRef));
    if ("problem" in wording) {
      return { outcome: "invalid", code: wording.problem };
    }
    const mode = spec.contextMode === "executive" ? "executive" : "personal";
    const scope = c.ensureContextRoot(owner, mode, now);
    const id = newId("cm_");
    const period = input.period?.spec;
    run(
      "INSERT INTO commitments (owner_id, id, requirement_text, responsible_counterpart_id, responsible_raw, responsibility_version, " +
        "context_mode, context_scope_id, context_semantic_version, period_request_id, period_key, period_index, period_start, period_end, " +
        "period_tz, origin_kind, origin_ref_id, origin_source_json, due_state, due_at, due_tz, next_step, created_by, revision, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
      owner,
      id,
      text,
      responsible.counterpartId,
      responsible.raw,
      mode,
      scope,
      input.period?.requestId ?? null,
      period?.key ?? null,
      period?.index ?? null,
      period?.start ?? null,
      period?.end ?? null,
      period?.tz ?? null,
      originKind,
      originRef,
      spec.origin.source ? JSON.stringify(spec.origin.source) : null,
      due.state,
      due.at,
      due.tz,
      nextStep,
      input.createdBy,
      now,
      now,
    );
    k.appendEvent(
      owner,
      id,
      "created",
      input.actor,
      {
        requirement: text,
        responsibleCounterpartId: responsible.counterpartId,
        responsibleRaw: responsible.raw,
        dueState: due.state,
        dueAt: due.at,
        origin: { kind: originKind, ref: originRef },
        ...(wording.ambiguity ? { ambiguity: wording.ambiguity } : {}),
        ...(period ? { period: { requestId: input.period?.requestId, key: period.key } } : {}),
      },
      now,
    );
    if (wording.ambiguity) {
      k.markAmbiguity(owner, id, wording.ambiguity);
    }
    return { outcome: "inserted", id };
  };

  const linkInTx = (
    owner: string,
    commitmentId: string,
    workId: string,
    role: "required" | "reference",
    actor: CommitmentActor,
    now: number,
  ): void => {
    const linked = work.linkAddInTx({
      principal: { ownerId: owner } as Principal,
      workId,
      role,
      targetKind: "commitment",
      targetId: commitmentId,
      actor: workActor(actor),
      now,
    });
    void linked; // the link ledger writes the Commitment's linked_to_work event itself
  };

  const commitmentCreate = (input: {
    principal: Principal;
    spec: CommitmentSpec;
    createdBy: CreatedBy;
    userStatementRef?: string;
    workId?: string;
    workRole?: "required" | "reference";
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const actor: CommitmentActor = input.createdBy === "agent" ? "agent" : "user";
      if (input.workId !== undefined && work.requireLive(owner, input.workId).problem) {
        return { outcome: "work_not_found" as const };
      }
      const text = clean(input.spec.requirementText);
      // A retried native record (same statement, same words) returns the one that exists instead of a second obligation.
      const refId = clean(
        input.createdBy === "agent" ? input.userStatementRef : input.spec.origin.refId,
      );
      if (input.spec.origin.kind === "native_record" || input.createdBy === "agent") {
        const dup = one(
          `${COMMITMENT_SELECT} WHERE c.owner_id = ? AND c.origin_kind = 'native_record' AND c.origin_ref_id = ? AND c.requirement_text = ? AND c.period_key IS NULL AND c.lifecycle <> 'cancelled'`,
          owner,
          refId,
          text,
        );
        if (dup) {
          return { outcome: "exists" as const, commitment: toCommitment(dup, input.now) };
        }
      }
      const inserted = insertInTx({
        owner,
        spec: input.spec,
        createdBy: input.createdBy,
        actor,
        ...(input.userStatementRef !== undefined
          ? { userStatementRef: input.userStatementRef }
          : {}),
        now: input.now,
      });
      if (inserted.outcome === "invalid") {
        return inserted;
      }
      if (input.workId !== undefined) {
        linkInTx(owner, inserted.id, input.workId, input.workRole ?? "required", actor, input.now);
        reevaluate(owner, inserted.id, input.now);
      }
      return {
        outcome: "created" as const,
        commitment: fetch(owner, inserted.id, input.now) as CommitmentRecord,
      };
    });

  /** R-28: one request creates up to 12 per-period Commitments; request id + period key make a retry harmless. */
  const commitmentGeneratePeriods = (input: {
    principal: Principal;
    requestId: string;
    spec: CommitmentSpec;
    periods: PeriodSpec[];
    createdBy: CreatedBy;
    userStatementRef?: string;
    workId?: string;
    workRole?: "required" | "reference";
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const actor: CommitmentActor = input.createdBy === "agent" ? "agent" : "user";
      const requestId = clean(input.requestId);
      if (requestId.length === 0 || requestId.length > COMMITMENT_LIMITS.ref) {
        return { outcome: "invalid" as const, code: "bad_request_id" };
      }
      const periods = input.periods;
      if (!Array.isArray(periods) || periods.length === 0) {
        return { outcome: "invalid" as const, code: "no_periods" };
      }
      if (periods.length > COMMITMENT_LIMITS.periods) {
        return {
          outcome: "invalid" as const,
          code: "too_many_periods",
          max: COMMITMENT_LIMITS.periods,
        };
      }
      const keys = new Set<string>();
      const indexes = new Set<number>();
      for (const period of periods) {
        const key = clean(period.key);
        if (
          key.length === 0 ||
          key.length > 64 ||
          keys.has(key) ||
          !Number.isInteger(period.index) ||
          period.index < 1 ||
          period.index > COMMITMENT_LIMITS.periods ||
          indexes.has(period.index) ||
          !Number.isSafeInteger(period.start) ||
          !Number.isSafeInteger(period.end) ||
          period.end <= period.start ||
          !Number.isSafeInteger(period.dueAt) ||
          !validTimeZone(period.tz)
        ) {
          return { outcome: "invalid" as const, code: "bad_period" };
        }
        keys.add(key);
        indexes.add(period.index);
      }
      if (input.workId !== undefined && work.requireLive(owner, input.workId).problem) {
        return { outcome: "work_not_found" as const };
      }
      const created: CommitmentRecord[] = [];
      const existing: CommitmentRecord[] = [];
      for (const period of periods) {
        const found = one(
          `${COMMITMENT_SELECT} WHERE c.owner_id = ? AND c.period_request_id = ? AND c.period_key = ?`,
          owner,
          requestId,
          clean(period.key),
        );
        if (found) {
          existing.push(toCommitment(found, input.now));
          continue;
        }
        const inserted = insertInTx({
          owner,
          spec: input.spec,
          createdBy: input.createdBy,
          actor,
          ...(input.userStatementRef !== undefined
            ? { userStatementRef: input.userStatementRef }
            : {}),
          period: { requestId, spec: { ...period, key: clean(period.key) } },
          now: input.now,
        });
        if (inserted.outcome === "invalid") {
          // Fail the whole request: nothing is half-created (the transaction is rolled back by the throw below).
          throw new PeriodsRejected(inserted.code);
        }
        if (input.workId !== undefined) {
          linkInTx(
            owner,
            inserted.id,
            input.workId,
            input.workRole ?? "required",
            actor,
            input.now,
          );
          reevaluate(owner, inserted.id, input.now);
        }
        created.push(fetch(owner, inserted.id, input.now) as CommitmentRecord);
      }
      return { outcome: "generated" as const, created, existing };
    });

  class PeriodsRejected extends Error {
    code: string;
    constructor(code: string) {
      super(`periods rejected: ${code}`);
      this.code = code;
    }
  }
  /** Run the period generator and translate the rollback signal into a plain result. */
  const generatePeriods: typeof commitmentGeneratePeriods = (input) => {
    try {
      return commitmentGeneratePeriods(input);
    } catch (error) {
      if (error instanceof PeriodsRejected) {
        return { outcome: "invalid" as const, code: error.code };
      }
      throw error;
    }
  };

  // ------------------------------------------------------------------ edit

  type UpdateInput = {
    principal: Principal;
    commitmentId: string;
    changes: CommitmentChanges;
    expectedRevision?: number;
    actor: "user" | "agent";
    userStatementRef?: string;
    reason?: string;
    now: number;
  };

  /** The edit itself; the caller owns the transaction (the joint-responsibility choice edits inside its own). */
  const updateInTx = (input: UpdateInput) => {
    const owner = input.principal.ownerId;
    const row = k.commitmentRow(owner, input.commitmentId);
    if (!row) {
      return { outcome: "not_found" as const };
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== Number(row.revision)) {
      return { outcome: "revision_conflict" as const, revision: Number(row.revision) };
    }
    const lifecycle = String(row.lifecycle);
    if (lifecycle === "resolved" || lifecycle === "cancelled") {
      return { outcome: "closed" as const, lifecycle };
    }
    if (input.actor === "agent") {
      const ref = clean(input.userStatementRef);
      if (ref.length === 0 || ref.length > COMMITMENT_LIMITS.ref) {
        return { outcome: "invalid" as const, code: "statement_ref_required" };
      }
    }
    const reason = clean(input.reason);
    if (reason.length > COMMITMENT_LIMITS.reason) {
      return { outcome: "invalid" as const, code: "bad_reason" };
    }
    const changes = input.changes;
    let requirement = String(row.requirement_text);
    let counterpartId = (row.responsible_counterpart_id as string | null) ?? null;
    let raw = (row.responsible_raw as string | null) ?? null;
    let dueState = String(row.due_state);
    let dueAt = (row.due_at as number | null) ?? null;
    let dueTz = (row.due_tz as string | null) ?? null;
    let nextStep = (row.next_step as string | null) ?? null;
    const changed: string[] = [];
    if (changes.requirementText !== undefined) {
      const text = clean(changes.requirementText);
      if (text.length === 0 || text.length > COMMITMENT_LIMITS.requirement) {
        return { outcome: "invalid" as const, code: "bad_requirement" };
      }
      if (text !== requirement) {
        requirement = text;
        changed.push("requirement");
      }
    }
    let ambiguity: JointAmbiguity | null | undefined;
    if (changes.responsible !== undefined || changes.requirementText !== undefined) {
      const wording = k.wordingOf(
        owner,
        changes.responsible ?? { kind: "counterpart", counterpartId: "" },
        requirement,
      );
      if ("problem" in wording) {
        return { outcome: "invalid" as const, code: wording.problem };
      }
      ambiguity = changes.responsible === undefined ? undefined : wording.ambiguity;
    }
    if (changes.responsible !== undefined) {
      const resolved = k.resolveResponsible(owner, changes.responsible, input.actor, input.now);
      if ("problem" in resolved) {
        return { outcome: "invalid" as const, code: resolved.problem };
      }
      if (resolved.raw !== null && resolved.raw.length > COMMITMENT_LIMITS.responsibleRaw) {
        return { outcome: "invalid" as const, code: "bad_responsible" };
      }
      if (resolved.counterpartId !== counterpartId || resolved.raw !== raw) {
        counterpartId = resolved.counterpartId;
        raw = resolved.raw;
        changed.push("responsible");
      }
    }
    if (changes.due !== undefined) {
      const due = normalizeDue(changes.due);
      if (!due) {
        return { outcome: "invalid" as const, code: "bad_due" };
      }
      if (due.state !== dueState || due.at !== dueAt || due.tz !== dueTz) {
        dueState = due.state;
        dueAt = due.at;
        dueTz = due.tz;
        changed.push("due");
      }
    }
    let softChange = false;
    if (changes.nextStep !== undefined) {
      const step = changes.nextStep === null ? null : clean(changes.nextStep);
      if (step !== null && step.length > COMMITMENT_LIMITS.nextStep) {
        return { outcome: "invalid" as const, code: "bad_next_step" };
      }
      if ((step === "" ? null : step) !== nextStep) {
        nextStep = step === "" ? null : step;
        softChange = true;
      }
    }
    // A note on its own is a change too: the reason is the record of why, and the person may add it after the fact.
    const noteOnly = changed.length === 0 && !softChange && reason !== "";
    if (changed.length === 0 && !softChange && !noteOnly) {
      return {
        outcome: "unchanged" as const,
        commitment: toCommitment(row, input.now),
      };
    }
    const material = changed.length > 0;
    const version = Number(row.responsibility_version);
    if (material) {
      k.snapshotVersion(owner, row, changed.join("+"), input.now);
    }
    run(
      "UPDATE commitments SET requirement_text = ?, responsible_counterpart_id = ?, responsible_raw = ?, due_state = ?, due_at = ?, due_tz = ?, " +
        "next_step = ?, responsibility_version = ?, " +
        (material
          ? "communication_state = 'draft', communication_action_ref = NULL, communication_receipt_level = NULL, communication_at = NULL, " +
            "acceptance_state = 'unknown', acceptance_basis_kind = NULL, acceptance_basis = NULL, acceptance_at = NULL, " +
            "lifecycle = CASE lifecycle WHEN 'waiting' THEN 'open' ELSE lifecycle END, "
          : "") +
        "revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
      requirement,
      counterpartId,
      raw,
      dueState,
      dueAt,
      dueTz,
      nextStep,
      material ? version + 1 : version,
      input.now,
      owner,
      input.commitmentId,
    );
    if (changed.includes("responsible")) {
      k.endHelperWhoIsResponsible(owner, input.now, { commitmentId: input.commitmentId });
    }
    if (ambiguity !== undefined && (ambiguity !== null || row.ambiguity_json)) {
      k.markAmbiguity(owner, input.commitmentId, ambiguity);
    }
    const actor: CommitmentActor = input.actor;
    k.appendEvent(
      owner,
      input.commitmentId,
      "edited",
      actor,
      {
        changed: softChange ? [...changed, "next_step"] : noteOnly ? ["note"] : changed,
        reason: reason || null,
      },
      input.now,
    );
    if (changed.includes("responsible")) {
      k.appendEvent(
        owner,
        input.commitmentId,
        "responsible_changed",
        actor,
        {
          from: {
            counterpartId: row.responsible_counterpart_id ?? null,
            raw: row.responsible_raw ?? null,
          },
          to: { counterpartId, raw },
        },
        input.now,
      );
    }
    if (changed.includes("due")) {
      k.appendEvent(
        owner,
        input.commitmentId,
        "due_changed",
        actor,
        {
          from: { state: row.due_state, at: row.due_at ?? null },
          to: { state: dueState, at: dueAt },
        },
        input.now,
      );
    }
    if (changed.includes("requirement")) {
      k.appendEvent(
        owner,
        input.commitmentId,
        "standard_changed",
        actor,
        { from: row.requirement_text, to: requirement },
        input.now,
      );
    }
    if (material) {
      k.appendEvent(
        owner,
        input.commitmentId,
        "responsibility_versioned",
        actor,
        { from: version, to: version + 1, resetCommunication: true, resetAcceptance: true },
        input.now,
      );
    }
    reevaluate(owner, input.commitmentId, input.now);
    return {
      outcome: "updated" as const,
      commitment: fetch(owner, input.commitmentId, input.now) as CommitmentRecord,
      versioned: material,
    };
  };

  const commitmentUpdate = (input: UpdateInput) => transaction(() => updateInTx(input));

  const { commitmentSetRole } = createCommitmentRoleOps({ transaction, c, work });
  const flow = createCommitmentFlowOps({ transaction, c, k, reevaluate, fetch });
  const read = createCommitmentReadOps({ transaction, c, k, fetch });
  const { assistAddInTx, ...assist } = createCommitmentAssistOps({ transaction, c, k });
  const joint = createCommitmentJointOps({
    transaction,
    c,
    k,
    updateInTx,
    insertInTx,
    linkInTx,
    reevaluate,
    fetch,
    addHelperInTx: assistAddInTx,
  });

  const backfill = createCommitmentBackfillOps({ transaction, c, k });

  return {
    commitmentCreate,
    commitmentGeneratePeriods: generatePeriods,
    commitmentUpdate,
    commitmentSetRole,
    ...read,
    ...flow,
    ...assist,
    ...joint,
    ...backfill,
  };
}

export type CommitmentLedger = ReturnType<typeof createCommitmentLedger>;
