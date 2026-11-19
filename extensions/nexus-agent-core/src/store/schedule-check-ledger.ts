import { parseNotify, wantsNotice, type NoticeFacts } from "../schedule/notify.js";
import {
  CHECK_OUTCOMES,
  MANUAL_TRIGGER_COOLDOWN_MS,
  SCHEDULE_LIMITS,
  stopsAtFirstChange,
  type BlockReason,
  type CheckOutcome,
  type CheckReport,
  type NoticeRecord,
  type NotifySpec,
  type PlanBody,
  type ScheduleRecord,
  type TriggerRecord,
} from "../schedule/types.js";
import type { TransactionRunner } from "./kernel.js";
import { toTrigger, type ScheduleCommon } from "./schedule-common.js";
import type { Principal } from "./types.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

// The check side of a schedule (design 4.5.3, slice W4b): which schedules are due, the gate before a check is fired (INV-10 / INV-11
// prerequisites, a free dispatch slot), the life of one check turn (pending -> scheduled -> claimed -> reported / failed), and the
// ending of the check Task. A check Task is bookkeeping for ONE check: it never counts toward the Work's outcome (work-ledger.ts and
// work-facts.ts leave every Task that a trigger points at out of their sums). Every method is ONE synchronous transaction and
// every statement filters on owner_id; nothing here talks to the host.

/** A turn that was asked for this many times and never started is given up (the Task fails, the slot opens, coverage degrades). */
export const MAX_TURN_ATTEMPTS = 5;

/** The host folds session keys to lower case; our own keys are made lower case too, but compare without regard to case. */
const sameSession = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const CLOSED = "('succeeded','failed','cancelled','deleted','purging')";

type Load = (
  owner: string,
  id: string,
  expectedRevision: number | undefined,
) =>
  | { schedule: ScheduleRecord }
  | { outcome: "not_found" }
  | { outcome: "conflict"; schedule: ScheduleRecord };

export type CheckBrief = {
  triggerId: string;
  scheduleId: string;
  taskId: string;
  purpose: string;
  ownerType: string;
  ownerRef: string;
  ownerText: string | null;
  expectedEvidence: unknown;
  sources: string[];
  wontDo: string[];
  limits: string[];
  plannedAt: number;
  source: string;
};

export function createScheduleCheckOps(deps: {
  transaction: TransactionRunner;
  c: WorkCommon;
  k: ScheduleCommon;
  patch: (
    owner: string,
    id: string,
    columns: Record<string, string | number | null>,
    now: number,
  ) => void;
  load: Load;
  fresh: (owner: string, id: string) => ScheduleRecord;
  gapsOf: (owner: string, s: ScheduleRecord) => Array<{ code: string; ref: string }>;
  blockInTx: (owner: string, id: string, reasons: BlockReason[], now: number) => void;
}) {
  const { transaction, c, k, patch, load, fresh, gapsOf, blockInTx } = deps;
  const { one, all, run } = c;

  const triggerRow = (owner: string, id: string): Row | undefined =>
    one("SELECT * FROM schedule_triggers WHERE owner_id = ? AND id = ?", owner, id);
  const trigger = (owner: string, id: string): TriggerRecord =>
    toTrigger(triggerRow(owner, id) as Row);

  /**
   * End the check Task of a trigger (closed Tasks stay as they are) and open the dispatch slot. A check Task ends `succeeded` when
   * the check was done (whatever it saw), `failed` when it could not be done, `cancelled` when it was never wanted any more.
   */
  const endTaskInTx = (
    owner: string,
    taskId: string,
    status: "succeeded" | "failed" | "cancelled",
    summary: string | null,
    now: number,
  ): void => {
    run(
      `UPDATE nexus_tasks SET status = ?, ended_at = ?, summary = COALESCE(?, summary), updated_at = ? WHERE owner_id = ? AND id = ? AND status NOT IN ${CLOSED}`,
      status,
      now,
      summary,
      now,
      owner,
      taskId,
    );
  };

  /** Coverage of a live schedule after a check: a done check restores it, a failed one degrades it with a note. */
  const coverageAfterInTx = (owner: string, scheduleId: string, ok: boolean, now: number) => {
    const s = k.schedule(owner, scheduleId);
    if (!s || s.status !== "active") {
      return;
    }
    const wanted = ok ? "on_plan" : "degraded";
    const note = ok ? null : "check_failed";
    if (s.coverageState !== wanted || s.coverageNote !== note) {
      patch(owner, scheduleId, { coverage_state: wanted, coverage_note: note }, now);
    }
  };

  /**
   * The check's own "first change" stop (`stop_json`, set per check when the plan is made): a check that reports `changed` ends
   * itself (reason `first_change`), and the plan ends with its last live check. Other checks of the plan keep running. Only the
   * report of a done check gets here; a check never changes the Commitment or the Work, so those stay for the user to settle.
   */
  const stopOnFirstChangeInTx = (owner: string, scheduleId: string, now: number): void => {
    const s = k.schedule(owner, scheduleId);
    if (!s || !["active", "paused", "blocked"].includes(s.status)) {
      return;
    }
    const stored = one(
      "SELECT stop_json FROM schedules WHERE owner_id = ? AND id = ?",
      owner,
      s.id,
    );
    let stop: unknown;
    try {
      stop = stored?.stop_json ? JSON.parse(String(stored.stop_json)) : undefined;
    } catch {
      return;
    }
    if (!stopsAtFirstChange(stop)) {
      return;
    }
    patch(
      owner,
      s.id,
      {
        status: "ended",
        stop_reason: "first_change",
        ended_at: now,
        next_due_at: null,
        pause_source: null,
        block_reasons_json: null,
      },
      now,
    );
    if (!s.planId) {
      return;
    }
    const left = all(
      "SELECT 1 AS found FROM schedules WHERE owner_id = ? AND plan_id = ? AND status IN ('active','paused','blocked') LIMIT 1",
      owner,
      s.planId,
    );
    if (left.length === 0) {
      run(
        "UPDATE delegation_plans SET status = 'ended', ended_at = ?, end_reason = 'first_change', end_requested_at = ? WHERE owner_id = ? AND id = ? AND status = 'accepted'",
        now,
        now,
        owner,
        s.planId,
      );
    }
  };

  /** pending / scheduled / claimed -> failed, with the Task and the slot closed. Returns false when the turn was already settled. */
  const failInTx = (
    owner: string,
    row: Row,
    reason: string,
    now: number,
    taskStatus: "failed" | "cancelled" = "failed",
  ): boolean => {
    const state = String(row.turn_state);
    if (state !== "pending" && state !== "scheduled" && state !== "claimed") {
      return false;
    }
    run(
      "UPDATE schedule_triggers SET turn_state = 'failed', fail_reason = ?, slot_open = 0, turn_changed_at = ? WHERE owner_id = ? AND id = ?",
      reason.slice(0, 120),
      now,
      owner,
      String(row.id),
    );
    if (typeof row.task_id === "string") {
      endTaskInTx(owner, row.task_id, taskStatus, null, now);
    }
    if (taskStatus === "failed") {
      coverageAfterInTx(owner, String(row.schedule_id), false, now);
    }
    return true;
  };

  // ------------------------------------------------------------------ what is due, and the gate before a fire

  const scheduleDueList = (input: { principal: Principal; now: number; limit?: number }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200);
      const rows = all(
        "SELECT id FROM schedules WHERE owner_id = ? AND status = 'active' AND executor_kind = 'check_task' " +
          "AND next_due_at IS NOT NULL AND next_due_at <= ? ORDER BY next_due_at, id LIMIT ?",
        owner,
        input.now,
        limit,
      );
      return { schedules: rows.map((row) => fresh(owner, String(row.id))) };
    });

  /**
   * Is this due time allowed to start a check right now? A replayed key answers with its record; a schedule whose prerequisites
   * are gone is BLOCKED with the real gaps (INV-10 / INV-11, nothing is dispatched); a busy slot is reported so the caller records
   * a skip. A slot whose Task is already final is opened first. Writes only that and the block; the check itself is created by
   * the caller (Task) and recorded by scheduleRecordTrigger.
   */
  const scheduleDispatchBegin = (input: {
    principal: Principal;
    scheduleId: string;
    occurrenceKey: string;
    /** A check the user asked for now: it also has to respect the cooldown between manual checks. */
    manual?: boolean;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const found = load(owner, input.scheduleId, undefined);
      if ("outcome" in found) {
        return found;
      }
      const s = found.schedule;
      const same = one(
        "SELECT * FROM schedule_triggers WHERE owner_id = ? AND schedule_id = ? AND occurrence_key = ?",
        owner,
        s.id,
        input.occurrenceKey,
      );
      if (same) {
        return { outcome: "duplicate" as const, trigger: toTrigger(same), schedule: s };
      }
      if (s.status !== "active") {
        return { outcome: "not_active" as const, schedule: s };
      }
      if (s.executorKind !== "check_task") {
        return { outcome: "not_check_task" as const, schedule: s };
      }
      // Nothing new starts once the plan's commitment has ended; what is already running may finish (design 6.4).
      const wrapping = s.planId ? k.plan(owner, s.planId) : undefined;
      if (wrapping && wrapping.endRequestedAt !== null) {
        return { outcome: "wrapping_up" as const, schedule: s };
      }
      const gaps = gapsOf(owner, s);
      if (gaps.length > 0) {
        const reasons: BlockReason[] = gaps.map((gap) => ({
          code: "prerequisite_missing",
          ref: `${gap.code}:${gap.ref}`,
          actor: "system",
        }));
        blockInTx(owner, s.id, reasons, input.now);
        return { outcome: "blocked" as const, schedule: fresh(owner, s.id), reasons };
      }
      if (
        input.manual === true &&
        s.lastManualTriggerAt !== null &&
        input.now - s.lastManualTriggerAt < MANUAL_TRIGGER_COOLDOWN_MS
      ) {
        return {
          outcome: "cooldown" as const,
          schedule: s,
          retryAt: s.lastManualTriggerAt + MANUAL_TRIGGER_COOLDOWN_MS,
        };
      }
      const open = one(
        "SELECT id, task_id FROM schedule_triggers WHERE owner_id = ? AND schedule_id = ? AND slot_open = 1",
        owner,
        s.id,
      );
      if (open) {
        if (k.taskIsFinished(owner, String(open.task_id))) {
          run(
            "UPDATE schedule_triggers SET slot_open = 0 WHERE owner_id = ? AND id = ?",
            owner,
            String(open.id),
          );
        } else {
          return { outcome: "slot_busy" as const, schedule: s, openTaskId: String(open.task_id) };
        }
      }
      return { outcome: "go" as const, schedule: s };
    });

  // ------------------------------------------------------------------ the life of a check turn

  /** Fired triggers whose host turn has not been scheduled yet (or whose last try failed), oldest first. */
  const scheduleCheckPending = (input: { principal: Principal; limit?: number }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 100);
      const rows = all(
        "SELECT * FROM schedule_triggers WHERE owner_id = ? AND outcome = 'created' AND turn_state = 'pending' ORDER BY created_at, id LIMIT ?",
        owner,
        limit,
      );
      return {
        pending: rows.map((row) => ({
          trigger: toTrigger(row),
          schedule: fresh(owner, String(row.schedule_id)),
          attempts: Number(row.turn_attempts),
        })),
      };
    });

  /** The host accepted the turn: pending -> scheduled, remembering the host job so its start can be recognised. */
  const scheduleCheckTurnScheduled = (input: {
    principal: Principal;
    triggerId: string;
    jobId: string;
    sessionKey: string;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = triggerRow(owner, input.triggerId);
      if (!row) {
        return { outcome: "not_found" as const };
      }
      if (String(row.turn_state) !== "pending") {
        return { outcome: "not_pending" as const, trigger: toTrigger(row) };
      }
      run(
        "UPDATE schedule_triggers SET turn_state = 'scheduled', turn_job_id = ?, turn_session_key = ?, turn_changed_at = ?, turn_attempts = turn_attempts + 1 WHERE owner_id = ? AND id = ?",
        input.jobId,
        input.sessionKey,
        input.now,
        owner,
        input.triggerId,
      );
      return { outcome: "scheduled" as const, trigger: trigger(owner, input.triggerId) };
    });

  /** The host refused or lost the turn: count the try; after MAX_TURN_ATTEMPTS the check is given up. */
  const scheduleCheckTurnRefused = (input: {
    principal: Principal;
    triggerId: string;
    reason: string;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = triggerRow(owner, input.triggerId);
      if (!row || String(row.turn_state) !== "pending") {
        return { outcome: "not_pending" as const };
      }
      const attempts = Number(row.turn_attempts) + 1;
      if (attempts >= MAX_TURN_ATTEMPTS) {
        failInTx(owner, row, `turn_not_started:${input.reason}`, input.now);
        return { outcome: "given_up" as const, trigger: trigger(owner, input.triggerId) };
      }
      run(
        "UPDATE schedule_triggers SET turn_attempts = ?, turn_changed_at = ? WHERE owner_id = ? AND id = ?",
        attempts,
        input.now,
        owner,
        input.triggerId,
      );
      return { outcome: "retry" as const, attempts };
    });

  const briefOf = (owner: string, row: Row, s: ScheduleRecord): CheckBrief => {
    const plan = s.planId
      ? one("SELECT plan_json FROM delegation_plans WHERE owner_id = ? AND id = ?", owner, s.planId)
      : undefined;
    const body = ((): PlanBody => {
      try {
        return JSON.parse(String(plan?.plan_json ?? "{}")) as PlanBody;
      } catch {
        return {};
      }
    })();
    let ownerText: string | null = null;
    if (s.ownerType === "commitment") {
      const cm = one(
        "SELECT requirement_text FROM commitments WHERE owner_id = ? AND id = ?",
        owner,
        s.ownerRef,
      );
      ownerText = cm ? String(cm.requirement_text) : null;
    }
    const evidence = one(
      "SELECT expected_evidence_json FROM schedules WHERE owner_id = ? AND id = ?",
      owner,
      s.id,
    );
    const expectedEvidence = ((): unknown => {
      try {
        return evidence?.expected_evidence_json
          ? JSON.parse(String(evidence.expected_evidence_json))
          : null;
      } catch {
        return null;
      }
    })();
    const list = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    return {
      triggerId: String(row.id),
      scheduleId: s.id,
      taskId: String(row.task_id),
      purpose: s.purpose,
      ownerType: s.ownerType,
      ownerRef: s.ownerRef,
      ownerText,
      expectedEvidence,
      sources: list(body.sources),
      wontDo: list(body.wontDo),
      limits: list(body.limits),
      plannedAt: Number(row.planned_at),
      source: String(row.source),
    };
  };

  /**
   * A turn that carries our marker asks to run: it is ours only when the host job it runs under is the one recorded for this
   * exact trigger, still `scheduled`, and the schedule may still dispatch (prerequisites checked again, nothing old replayed).
   * Anything else is refused and the check is closed, so a stale or forged marker never gets tools.
   */
  const scheduleCheckClaim = (input: {
    principal: Principal;
    jobId: string;
    sessionKey: string;
    markerTriggerId: string;
    runId: string;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = one(
        "SELECT * FROM schedule_triggers WHERE owner_id = ? AND turn_job_id = ?",
        owner,
        input.jobId,
      );
      if (!row) {
        return { outcome: "unknown_job" as const };
      }
      if (String(row.id) !== input.markerTriggerId) {
        return { outcome: "marker_mismatch" as const };
      }
      if (!sameSession(String(row.turn_session_key), input.sessionKey)) {
        return { outcome: "session_mismatch" as const };
      }
      const state = String(row.turn_state);
      if (state !== "scheduled") {
        return { outcome: "stale" as const, state };
      }
      const s = fresh(owner, String(row.schedule_id));
      if (s.status === "ended" || s.status === "cancelled") {
        failInTx(owner, row, `schedule_${s.status}`, input.now, "cancelled");
        return { outcome: "refused" as const, reason: `schedule_${s.status}` };
      }
      if (s.status !== "active") {
        // Paused or blocked after the check was fired: the check does not run (the user's pause is honoured, R-11).
        failInTx(owner, row, `schedule_${s.status}`, input.now, "cancelled");
        return { outcome: "refused" as const, reason: `schedule_${s.status}` };
      }
      const gaps = gapsOf(owner, s);
      if (gaps.length > 0) {
        failInTx(owner, row, `prerequisite_missing:${gaps[0]?.code}`, input.now, "cancelled");
        return { outcome: "refused" as const, reason: "prerequisite_missing" };
      }
      run(
        "UPDATE schedule_triggers SET turn_state = 'claimed', turn_run_id = ?, turn_changed_at = ? WHERE owner_id = ? AND id = ?",
        input.runId,
        input.now,
        owner,
        String(row.id),
      );
      run(
        "UPDATE nexus_tasks SET status = 'planning', updated_at = ? WHERE owner_id = ? AND id = ? AND status = 'clarifying'",
        input.now,
        owner,
        String(row.task_id),
      );
      const task = one(
        "SELECT title FROM nexus_tasks WHERE owner_id = ? AND id = ?",
        owner,
        String(row.task_id),
      );
      return {
        outcome: "claimed" as const,
        brief: briefOf(owner, row, s),
        taskTitle: task ? String(task.title) : "",
        trigger: trigger(owner, String(row.id)),
      };
    });

  /** Is this run the authenticated turn of this trigger (the gate in front of nexus_schedule_check_report)? */
  const scheduleCheckGate = (input: {
    principal: Principal;
    triggerId: string;
    runId: string;
    sessionKey: string;
  }) =>
    transaction(() => {
      const row = triggerRow(input.principal.ownerId, input.triggerId);
      const ok =
        row !== undefined &&
        String(row.turn_state) === "claimed" &&
        String(row.turn_run_id) === input.runId &&
        sameSession(String(row.turn_session_key), input.sessionKey);
      return { ok };
    });

  /** The turn's one report: ends the check Task and opens the slot. A second report of the same turn is answered, not applied. */
  const scheduleCheckReport = (input: {
    principal: Principal;
    triggerId: string;
    /** Given by callers that know the run (the gate always checks it); a tool call only knows its session. */
    runId?: string;
    sessionKey: string;
    outcome: CheckOutcome;
    summary: string;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = triggerRow(owner, input.triggerId);
      if (!row) {
        return { outcome: "not_found" as const };
      }
      const summary = typeof input.summary === "string" ? input.summary.trim() : "";
      if (
        !(CHECK_OUTCOMES as readonly string[]).includes(input.outcome) ||
        summary.length === 0 ||
        summary.length > SCHEDULE_LIMITS.reportSummary
      ) {
        return { outcome: "invalid" as const, code: "bad_report" };
      }
      const state = String(row.turn_state);
      if (state === "reported") {
        return { outcome: "already_reported" as const, trigger: toTrigger(row) };
      }
      if (
        state !== "claimed" ||
        (input.runId !== undefined && String(row.turn_run_id) !== input.runId) ||
        !sameSession(String(row.turn_session_key), input.sessionKey)
      ) {
        return { outcome: "not_claimed" as const, state };
      }
      run(
        "UPDATE schedule_triggers SET turn_state = 'reported', report_json = ?, turn_changed_at = ?, slot_open = 0 WHERE owner_id = ? AND id = ?",
        JSON.stringify({ outcome: input.outcome, summary }),
        input.now,
        owner,
        input.triggerId,
      );
      const done = input.outcome !== "cannot_check";
      endTaskInTx(owner, String(row.task_id), done ? "succeeded" : "failed", summary, input.now);
      coverageAfterInTx(owner, String(row.schedule_id), done, input.now);
      if (input.outcome === "changed") {
        stopOnFirstChangeInTx(owner, String(row.schedule_id), input.now);
      }
      return { outcome: "reported" as const, trigger: trigger(owner, input.triggerId) };
    });

  /**
   * The host job of a turn is over (`finished` / `removed`). When no report arrived the check failed: that is a coverage gap, not
   * "nothing changed".
   */
  const scheduleCheckJobEnded = (input: {
    principal: Principal;
    jobId: string;
    /** The host's own account of how the job ended (status / error), appended to the failure reason. */
    detail?: string;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = one(
        "SELECT * FROM schedule_triggers WHERE owner_id = ? AND turn_job_id = ?",
        owner,
        input.jobId,
      );
      if (!row) {
        return { outcome: "noop" as const };
      }
      const reason = input.detail
        ? `turn_ended_without_report (${input.detail.slice(0, 200)})`
        : "turn_ended_without_report";
      return failInTx(owner, row, reason, input.now)
        ? { outcome: "failed" as const, trigger: trigger(owner, String(row.id)) }
        : { outcome: "noop" as const };
    });

  /** Turns that have been scheduled or running for longer than `graceMs` without a report (the host job never ran, or the process died). */
  const scheduleCheckExpire = (input: {
    principal: Principal;
    now: number;
    graceMs: number;
    limit?: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200);
      const rows = all(
        "SELECT * FROM schedule_triggers WHERE owner_id = ? AND turn_state IN ('scheduled','claimed') AND turn_changed_at < ? ORDER BY turn_changed_at LIMIT ?",
        owner,
        input.now - input.graceMs,
        limit,
      );
      const failed: TriggerRecord[] = [];
      for (const row of rows) {
        const reason =
          String(row.turn_state) === "claimed" ? "turn_not_finished" : "turn_never_started";
        if (failInTx(owner, row, reason, input.now)) {
          failed.push(trigger(owner, String(row.id)));
        }
      }
      return { failed };
    });

  const jsonOf = <T>(text: unknown): T | null => {
    if (typeof text !== "string") {
      return null;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  };

  /**
   * The notification this REPORTED check still owes, if the user chose one for it and this outcome is one they chose. `none` when
   * there is nothing to send, `done` when the record already says what happened (a notice is never sent twice).
   */
  const scheduleCheckNoticeGet = (input: { principal: Principal; triggerId: string }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = triggerRow(owner, input.triggerId);
      const report = row ? jsonOf<CheckReport>(row.report_json) : null;
      if (!row || !report || String(row.turn_state) !== "reported") {
        return { outcome: "none" as const };
      }
      if (report.notice) {
        return { outcome: "done" as const };
      }
      const s = one(
        "SELECT notify_json, purpose, tz, plan_id FROM schedules WHERE owner_id = ? AND id = ?",
        owner,
        String(row.schedule_id),
      );
      const notify = s ? parseNotify(jsonOf<unknown>(s.notify_json)) : null;
      if (!s || !notify || !wantsNotice(notify, report.outcome)) {
        return { outcome: "none" as const };
      }
      const planRow = s.plan_id
        ? one(
            "SELECT plan_json FROM delegation_plans WHERE owner_id = ? AND id = ?",
            owner,
            String(s.plan_id),
          )
        : undefined;
      const body = planRow ? (jsonOf<PlanBody>(planRow.plan_json) ?? {}) : {};
      const facts: Omit<NoticeFacts, "at"> = {
        outcome: report.outcome,
        summary: report.summary,
        purpose: String(s.purpose),
        sources: Array.isArray(body.sources)
          ? body.sources.filter((x) => typeof x === "string")
          : [],
        tz: String(s.tz),
      };
      return { outcome: "pending" as const, notify: notify satisfies NotifySpec, facts };
    });

  /** Keep what happened to the notification in the check's own record (the first answer stays; a second is ignored). */
  const scheduleCheckNoticeRecord = (input: {
    principal: Principal;
    triggerId: string;
    notice: NoticeRecord;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = triggerRow(owner, input.triggerId);
      const report = row ? jsonOf<CheckReport>(row.report_json) : null;
      if (!row || !report || report.notice) {
        return { outcome: "noop" as const };
      }
      run(
        "UPDATE schedule_triggers SET report_json = ? WHERE owner_id = ? AND id = ?",
        JSON.stringify({ ...report, notice: input.notice }),
        owner,
        input.triggerId,
      );
      return { outcome: "recorded" as const, trigger: trigger(owner, input.triggerId) };
    });

  return {
    scheduleDueList,
    scheduleDispatchBegin,
    scheduleCheckPending,
    scheduleCheckTurnScheduled,
    scheduleCheckTurnRefused,
    scheduleCheckClaim,
    scheduleCheckGate,
    scheduleCheckReport,
    scheduleCheckNoticeGet,
    scheduleCheckNoticeRecord,
    scheduleCheckJobEnded,
    scheduleCheckExpire,
  };
}
