import { nextDueAfter, type Cadence } from "../schedule/cadence.js";
import type {
  BlockReason,
  DelegationPlanRecord,
  PauseSource,
  ScheduleRecord,
  ScheduleSpec,
  ScheduleStatus,
} from "../schedule/types.js";
import type { TransactionRunner } from "./kernel.js";
import { createScheduleCheckOps } from "./schedule-check-ledger.js";
import { badBlockReasons, createScheduleCommon, toTrigger } from "./schedule-common.js";
import { createScheduleExpiry, createScheduleFollowHooks } from "./schedule-follow-ledger.js";
import { createScheduleTriggerOps } from "./schedule-trigger-ledger.js";
import type { Principal } from "./types.js";
import type { WorkCommon } from "./work-ledger-common.js";

// Schedule kernel (object-model design 4.5.2): the state machine active / paused / blocked / ended / cancelled, the pause rules
// (a user's pause is never undone by the system, WK-04), the way a schedule is blocked and unblocked with real reasons (R-11),
// and the rows a plan writes when it is accepted. ended and cancelled are final: the database refuses a way back. Nothing here
// starts a check; the trigger ledger only RECORDS due times so that none creates a Task twice (slice W4b runs the dispatcher).
// Every method is ONE synchronous transaction and every statement filters on owner_id.

/** The reason a check_task schedule is blocked while no dispatcher is available (design 4.5.3, S-H1 degrade). */
export const HOST_DISPATCH_REASON: BlockReason = {
  code: "prerequisite_missing",
  ref: "host_capability:scheduled_dispatch",
  actor: "system",
};
const isHostOnly = (reasons: readonly BlockReason[]): boolean =>
  reasons.length > 0 && reasons.every((r) => r.ref === HOST_DISPATCH_REASON.ref);

const LIST_MAX = 200;

export function createScheduleLedger(transaction: TransactionRunner, c: WorkCommon) {
  const { one, all, run, newId } = c;
  const k = createScheduleCommon(c);

  /** Write the given columns, bump the revision and the update time. Column names come from this file only. */
  const patch = (
    owner: string,
    id: string,
    columns: Record<string, string | number | null>,
    now: number,
  ): void => {
    const names = Object.keys(columns);
    run(
      `UPDATE schedules SET ${names.map((name) => `${name} = ?`).join(", ")}, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?`,
      ...names.map((name) => columns[name] as string | number | null),
      now,
      owner,
      id,
    );
  };

  /** Why a schedule cannot run right now although its plan was accepted: missing plan, closed owner, missing carrier link. */
  const gapsOf = (owner: string, s: ScheduleRecord): Array<{ code: string; ref: string }> => {
    if (s.ownerType === "legacy_watch") {
      return [];
    }
    const gaps: Array<{ code: string; ref: string }> = [];
    const plan = s.planId ? k.plan(owner, s.planId) : undefined;
    if (!plan || plan.status !== "accepted") {
      gaps.push({ code: "plan_not_accepted", ref: s.planId ?? "none" });
      return gaps;
    }
    const problem = k.ownerProblem(owner, plan.planOwnerType, plan.planOwnerId);
    // While a plan wraps up after its commitment ended, the closed commitment is not a gap: checks already running may finish.
    if (problem && !(problem === "owner_closed" && plan.endRequestedAt !== null)) {
      gaps.push({ code: problem, ref: `${plan.planOwnerType}:${plan.planOwnerId}` });
    }
    if (!k.carrierLinked(owner, plan.planOwnerType, plan.planOwnerId, s.workId)) {
      gaps.push({ code: "carrier_link_missing", ref: `work:${s.workId}` });
    }
    return gaps;
  };

  /** Block a schedule with reasons (caller checked the status). */
  const blockInTx = (owner: string, id: string, reasons: BlockReason[], now: number): void => {
    patch(
      owner,
      id,
      {
        status: "blocked",
        pause_source: null,
        block_reasons_json: JSON.stringify(reasons),
        next_due_at: null,
        coverage_state: "unavailable",
      },
      now,
    );
  };

  /** Insert the schedule a plan writes when it is accepted. Returns its id. */
  const insertScheduleInTx = (input: {
    owner: string;
    plan: DelegationPlanRecord;
    spec: ScheduleSpec;
    cadence: Cadence;
    dispatchReady: boolean;
    startNow: boolean;
    now: number;
  }): string => {
    const { owner, plan, spec, cadence, now } = input;
    const executor = spec.executorKind ?? "check_task";
    const blocked = executor === "check_task" && !input.dispatchReady;
    // A plan accepted while the Work is paused starts paused: the pause is the Work's, and resuming the Work releases it.
    const workPaused =
      !blocked &&
      Boolean(
        one(
          "SELECT 1 AS found FROM work_controls WHERE owner_id = ? AND work_id = ? AND scope_kind = 'work' AND state <> 'released'",
          owner,
          plan.workId,
        ),
      );
    const first =
      cadence.kind === "once"
        ? cadence.at
        : input.startNow
          ? now
          : nextDueAfter(cadence, spec.tz, now, now);
    const id = newId("sc_");
    run(
      "INSERT INTO schedules (owner_id, id, work_id, owner_type, owner_ref, plan_id, plan_version, schedule_kind, purpose, expected_evidence_json, " +
        "cadence_json, tz, next_due_at, dispatch_window_ms, stop_json, notify_json, session_key, executor_kind, executor_ref, status, " +
        "block_reasons_json, coverage_state, created_via, revision, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'plan', 1, ?, ?)",
      owner,
      id,
      plan.workId,
      plan.planOwnerType,
      plan.planOwnerId,
      plan.id,
      plan.planVersion,
      spec.scheduleKind,
      spec.purpose.trim(),
      spec.expectedEvidence === undefined ? null : JSON.stringify(spec.expectedEvidence),
      JSON.stringify(cadence),
      spec.tz,
      blocked ? null : first,
      spec.dispatchWindowMs ?? null,
      spec.stop === undefined ? null : JSON.stringify(spec.stop),
      spec.notify === undefined ? null : JSON.stringify(spec.notify),
      spec.sessionKey ?? null,
      executor,
      executor === "watch" ? (spec.executorRef as string) : null,
      blocked ? "blocked" : "active",
      blocked ? JSON.stringify([HOST_DISPATCH_REASON]) : null,
      blocked ? "unavailable" : "on_plan",
      now,
      now,
    );
    if (workPaused) {
      patch(
        owner,
        id,
        {
          status: "paused",
          pause_source: "work_control",
          next_due_at: null,
          coverage_state: "unavailable",
        },
        now,
      );
    }
    return id;
  };

  /** End or cancel every schedule of a plan that is still live (the plan itself changed state in the caller's transaction). */
  const finishPlanSchedulesInTx = (
    owner: string,
    planId: string,
    status: "ended" | "cancelled",
    reason: string,
    now: number,
  ): string[] => {
    const rows = all(
      "SELECT id FROM schedules WHERE owner_id = ? AND plan_id = ? AND status IN ('active','paused','blocked')",
      owner,
      planId,
    );
    for (const row of rows) {
      patch(
        owner,
        String(row.id),
        {
          status,
          stop_reason: reason,
          ended_at: now,
          next_due_at: null,
          pause_source: null,
          block_reasons_json: null,
        },
        now,
      );
    }
    return rows.map((row) => String(row.id));
  };

  type Found =
    | { schedule: ScheduleRecord }
    | { outcome: "not_found" }
    | { outcome: "conflict"; schedule: ScheduleRecord };
  const load = (owner: string, id: string, expectedRevision: number | undefined): Found => {
    const schedule = k.schedule(owner, id);
    if (!schedule) {
      return { outcome: "not_found" };
    }
    if (expectedRevision !== undefined && expectedRevision !== schedule.revision) {
      return { outcome: "conflict", schedule };
    }
    return { schedule };
  };
  const fresh = (owner: string, id: string): ScheduleRecord =>
    k.schedule(owner, id) as ScheduleRecord;
  const isFinal = (status: ScheduleStatus): boolean => status === "ended" || status === "cancelled";

  // ------------------------------------------------------------------ read

  const scheduleGet = (input: { principal: Principal; scheduleId: string; triggers?: number }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const schedule = k.schedule(owner, input.scheduleId);
      if (!schedule) {
        return { outcome: "not_found" as const };
      }
      const limit = Math.min(Math.max(Math.trunc(input.triggers ?? 0), 0), 50);
      const triggers =
        limit === 0
          ? []
          : all(
              "SELECT * FROM schedule_triggers WHERE owner_id = ? AND schedule_id = ? ORDER BY planned_at DESC, created_at DESC LIMIT ?",
              owner,
              input.scheduleId,
              limit,
            ).map(toTrigger);
      return { outcome: "ok" as const, schedule, triggers, gaps: gapsOf(owner, schedule) };
    });

  /**
   * Every check record of one schedule, newest first, a page at a time. `before` is the `next` of the previous page; `next` is
   * absent on the last page. This is the full history behind the few recent records `scheduleGet` returns.
   */
  const scheduleTriggerList = (input: {
    principal: Principal;
    scheduleId: string;
    limit?: number;
    before?: string;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      if (!k.schedule(owner, input.scheduleId)) {
        return { outcome: "not_found" as const };
      }
      const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50);
      const cut = /^(\d+):(\d+):(.+)$/.exec(input.before ?? "");
      if (input.before !== undefined && !cut) {
        return { outcome: "invalid" as const, code: "bad_cursor" };
      }
      const rows = all(
        "SELECT * FROM schedule_triggers WHERE owner_id = ? AND schedule_id = ?" +
          (cut
            ? " AND (planned_at < ? OR (planned_at = ? AND (created_at < ? OR (created_at = ? AND id < ?))))"
            : "") +
          " ORDER BY planned_at DESC, created_at DESC, id DESC LIMIT ?",
        owner,
        input.scheduleId,
        ...(cut ? [Number(cut[1]), Number(cut[1]), Number(cut[2]), Number(cut[2]), cut[3]!] : []),
        limit + 1,
      );
      const page = rows.slice(0, limit).map(toTrigger);
      const last = page.at(-1);
      return {
        outcome: "ok" as const,
        triggers: page,
        ...(rows.length > limit && last
          ? { next: `${last.plannedAt}:${last.createdAt}:${last.id}` }
          : {}),
      };
    });

  const scheduleList = (input: {
    principal: Principal;
    workId?: string;
    ownerType?: string;
    ownerRef?: string;
    planId?: string;
    statuses?: ScheduleStatus[];
    limit?: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const where = ["owner_id = ?"];
      const params: (string | number)[] = [owner];
      for (const [column, value] of [
        ["work_id", input.workId],
        ["owner_type", input.ownerType],
        ["owner_ref", input.ownerRef],
        ["plan_id", input.planId],
      ] as const) {
        if (value !== undefined) {
          where.push(`${column} = ?`);
          params.push(value);
        }
      }
      if (input.statuses && input.statuses.length > 0) {
        where.push(`status IN (${input.statuses.map(() => "?").join(", ")})`);
        params.push(...input.statuses);
      }
      const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), LIST_MAX);
      const rows = all(
        `SELECT * FROM schedules WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id LIMIT ?`,
        ...params,
        limit,
      );
      return { schedules: rows.map((row) => k.schedule(owner, String(row.id)) as ScheduleRecord) };
    });

  // ------------------------------------------------------------------ pause / resume / cancel

  /** The pause rules on a loaded schedule; shared by the user's call and the Work-level control (schedule-follow-ledger.ts). */
  const pauseCore = (owner: string, s: ScheduleRecord, source: PauseSource, now: number) => {
    if (isFinal(s.status)) {
      return { outcome: "already_final" as const, schedule: s };
    }
    if (s.status === "blocked") {
      // A blocked schedule is waiting for a real fix; pausing it would hide the reason (R-11).
      return { outcome: "is_blocked" as const, schedule: s };
    }
    if (s.status === "paused") {
      if (source === "user" && s.pauseSource !== "user") {
        // The user's own pause wins: from now on only the user resumes it.
        patch(owner, s.id, { pause_source: "user" }, now);
        return { outcome: "paused" as const, schedule: fresh(owner, s.id) };
      }
      return { outcome: "unchanged" as const, schedule: s };
    }
    patch(
      owner,
      s.id,
      { status: "paused", pause_source: source, next_due_at: null, coverage_state: "unavailable" },
      now,
    );
    return { outcome: "paused" as const, schedule: fresh(owner, s.id) };
  };

  const schedulePause = (input: {
    principal: Principal;
    scheduleId: string;
    source: PauseSource;
    expectedRevision?: number;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const found = load(owner, input.scheduleId, input.expectedRevision);
      if ("outcome" in found) {
        return found;
      }
      return pauseCore(owner, found.schedule, input.source, input.now);
    });

  /** Resume rules on a loaded schedule (WK-04: the system and Work controls only undo their own pause). */
  const resumeCore = (
    owner: string,
    s: ScheduleRecord,
    by: PauseSource,
    dispatchReady: boolean | undefined,
    now: number,
  ) => {
    if (isFinal(s.status)) {
      return { outcome: "already_final" as const, schedule: s };
    }
    if (s.status !== "paused") {
      return { outcome: "not_paused" as const, schedule: s };
    }
    if (by !== "user" && s.pauseSource !== by) {
      // Work control or the system only undo their own pause, never one the user made (WK-04).
      return { outcome: "manual_pause_kept" as const, schedule: s };
    }
    // The commitment of this plan ended: the plan is only waiting for its last checks, nothing comes back (INV-10).
    if (s.planId && k.plan(owner, s.planId)?.endRequestedAt != null) {
      return { outcome: "wrapping_up" as const, schedule: s };
    }
    const gaps = gapsOf(owner, s);
    if (gaps.length > 0) {
      return { outcome: "gaps" as const, schedule: s, gaps };
    }
    if (s.executorKind === "check_task" && dispatchReady !== true) {
      blockInTx(owner, s.id, [HOST_DISPATCH_REASON], now);
      return { outcome: "resumed" as const, schedule: fresh(owner, s.id) };
    }
    const next =
      s.cadence.kind === "once" ? s.cadence.at : nextDueAfter(s.cadence, s.tz, now, s.createdAt);
    if (next === null || (s.cadence.kind === "once" && s.cadence.at <= now)) {
      // A one-time check whose time passed while it was paused is never turned into an immediate task (R-16).
      patch(
        owner,
        s.id,
        {
          status: "ended",
          stop_reason: "missed_window",
          ended_at: now,
          pause_source: null,
          next_due_at: null,
        },
        now,
      );
      return { outcome: "missed_window" as const, schedule: fresh(owner, s.id) };
    }
    patch(
      owner,
      s.id,
      { status: "active", pause_source: null, next_due_at: next, coverage_state: "on_plan" },
      now,
    );
    return { outcome: "resumed" as const, schedule: fresh(owner, s.id) };
  };

  const scheduleResume = (input: {
    principal: Principal;
    scheduleId: string;
    by: PauseSource;
    dispatchReady?: boolean;
    expectedRevision?: number;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const found = load(owner, input.scheduleId, input.expectedRevision);
      if ("outcome" in found) {
        return found;
      }
      if (
        input.by === "user" &&
        found.schedule.status === "paused" &&
        found.schedule.pauseSource === "work_control"
      ) {
        // The Work is paused: only releasing that pause lets its checks run again (WK-04), a click on the check itself does not.
        return { outcome: "work_paused" as const, schedule: found.schedule };
      }
      return resumeCore(owner, found.schedule, input.by, input.dispatchReady, input.now);
    });

  const cancelCore = (
    owner: string,
    s: ScheduleRecord,
    reasonText: string | undefined,
    now: number,
  ) => {
    if (isFinal(s.status)) {
      return { outcome: "already_final" as const, schedule: s };
    }
    const reason = (reasonText ?? "user_cancelled").trim().slice(0, 100) || "user_cancelled";
    patch(
      owner,
      s.id,
      {
        status: "cancelled",
        stop_reason: reason,
        ended_at: now,
        next_due_at: null,
        pause_source: null,
        block_reasons_json: null,
      },
      now,
    );
    return { outcome: "cancelled" as const, schedule: fresh(owner, s.id) };
  };

  const scheduleCancel = (input: {
    principal: Principal;
    scheduleId: string;
    reason?: string;
    expectedRevision?: number;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const found = load(owner, input.scheduleId, input.expectedRevision);
      if ("outcome" in found) {
        return found;
      }
      return cancelCore(owner, found.schedule, input.reason, input.now);
    });

  // ------------------------------------------------------------------ block / unblock

  const scheduleBlock = (input: {
    principal: Principal;
    scheduleId: string;
    reasons: BlockReason[];
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const found = load(owner, input.scheduleId, undefined);
      if ("outcome" in found) {
        return found;
      }
      const s = found.schedule;
      const bad = badBlockReasons(input.reasons);
      if (bad) {
        return { outcome: "invalid" as const, code: bad };
      }
      if (isFinal(s.status)) {
        return { outcome: "already_final" as const, schedule: s };
      }
      if (s.status === "paused") {
        // A pause is its own state: it is not rewritten as a block (R-11).
        return { outcome: "is_paused" as const, schedule: s };
      }
      blockInTx(owner, s.id, input.reasons, input.now);
      return { outcome: "blocked" as const, schedule: fresh(owner, s.id) };
    });

  /** Try to bring a blocked schedule back: every prerequisite is checked again, nothing old is replayed. */
  const unblockInTx = (owner: string, s: ScheduleRecord, dispatchReady: boolean, now: number) => {
    const gaps = gapsOf(owner, s);
    const reasons: BlockReason[] = gaps.map((gap) => ({
      code: "prerequisite_missing",
      ref: `${gap.code}:${gap.ref}`,
      actor: "system",
    }));
    if (s.executorKind === "check_task" && !dispatchReady) {
      reasons.push(HOST_DISPATCH_REASON);
    }
    if (reasons.length > 0) {
      patch(owner, s.id, { block_reasons_json: JSON.stringify(reasons) }, now);
      return { outcome: "still_blocked" as const, schedule: fresh(owner, s.id), reasons };
    }
    const next =
      s.cadence.kind === "once" ? s.cadence.at : nextDueAfter(s.cadence, s.tz, now, s.createdAt);
    if (next === null || (s.cadence.kind === "once" && s.cadence.at <= now)) {
      patch(
        owner,
        s.id,
        {
          status: "ended",
          stop_reason: "missed_window",
          ended_at: now,
          block_reasons_json: null,
          next_due_at: null,
        },
        now,
      );
      return { outcome: "missed_window" as const, schedule: fresh(owner, s.id), reasons: [] };
    }
    patch(
      owner,
      s.id,
      { status: "active", block_reasons_json: null, next_due_at: next, coverage_state: "on_plan" },
      now,
    );
    return { outcome: "unblocked" as const, schedule: fresh(owner, s.id), reasons: [] };
  };

  const scheduleUnblock = (input: {
    principal: Principal;
    scheduleId: string;
    dispatchReady?: boolean;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const found = load(owner, input.scheduleId, undefined);
      if ("outcome" in found) {
        return found;
      }
      if (found.schedule.status !== "blocked") {
        return { outcome: "not_blocked" as const, schedule: found.schedule };
      }
      return unblockInTx(owner, found.schedule, input.dispatchReady === true, input.now);
    });

  /**
   * The dispatcher became available or went away: bring back the schedules that only waited for it, and block the live
   * check_task ones when it is gone, so no schedule claims coverage nobody provides (design 4.5.3).
   */
  const scheduleSyncHost = (input: { principal: Principal; dispatchReady: boolean; now: number }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const unblocked: string[] = [];
      const blocked: string[] = [];
      const rows = all(
        "SELECT id FROM schedules WHERE owner_id = ? AND executor_kind = 'check_task' AND status IN ('active','blocked') ORDER BY created_at, id",
        owner,
      );
      for (const row of rows) {
        const s = fresh(owner, String(row.id));
        if (s.status === "blocked" && input.dispatchReady && isHostOnly(s.blockReasons)) {
          if (unblockInTx(owner, s, true, input.now).outcome === "unblocked") {
            unblocked.push(s.id);
          }
        } else if (s.status === "active" && !input.dispatchReady) {
          blockInTx(owner, s.id, [HOST_DISPATCH_REASON], input.now);
          blocked.push(s.id);
        }
      }
      return { unblocked, blocked };
    });

  const triggerOps = createScheduleTriggerOps({ transaction, c, k, patch, load, fresh });
  const checkOps = createScheduleCheckOps({
    transaction,
    c,
    k,
    patch,
    load,
    fresh,
    gapsOf,
    blockInTx,
  });

  const followUpHooks = createScheduleFollowHooks({
    c,
    schedule: k.schedule,
    pauseCore,
    resumeCore,
    cancelCore,
    patch,
  });

  const expiry = createScheduleExpiry(transaction, { c, schedule: k.schedule, patch });

  return {
    followUpHooks,
    kernel: {
      ...expiry,
      scheduleGet,
      scheduleTriggerList,
      scheduleList,
      schedulePause,
      scheduleResume,
      scheduleCancel,
      scheduleBlock,
      scheduleUnblock,
      scheduleSyncHost,
      ...triggerOps,
      ...checkOps,
    },
    /** Building blocks shared with delegation-ledger.ts (same transaction runner). Not worker operations. */
    internals: { common: k, insertScheduleInTx, finishPlanSchedulesInTx, patch, gapsOf },
  };
}

export type ScheduleLedger = ReturnType<typeof createScheduleLedger>;
