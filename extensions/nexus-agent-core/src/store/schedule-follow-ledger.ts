import {
  PLAN_WRAPUP_MS,
  type PauseSource,
  type PlanBody,
  type ScheduleRecord,
} from "../schedule/types.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { WorkCommon } from "./work-ledger-common.js";
import type { FollowUpHooks, FollowUpLine } from "./work-ledger-deps.js";

// What a Work-level control does to the Work's follow-up (design 6.6 cascade matrix, 10.4 WK-04). Pausing a Work pauses its
// running schedules with pause_source 'work_control'; resuming it undoes only those and never a pause the user made; stopping
// the Work ends its schedules and accepted plans; "stop following up" cancels the one schedule the user picked and ends its plan
// when that was the last live one. Every function here runs inside the caller's transaction (the Work ledger's), so the
// control and its effect on the schedules commit together or not at all.

type Core = {
  c: WorkCommon;
  schedule: (owner: string, id: string) => ScheduleRecord | undefined;
  pauseCore: (
    owner: string,
    s: ScheduleRecord,
    source: PauseSource,
    now: number,
  ) => { outcome: string };
  resumeCore: (
    owner: string,
    s: ScheduleRecord,
    by: PauseSource,
    dispatchReady: boolean | undefined,
    now: number,
  ) => { outcome: string };
  cancelCore: (
    owner: string,
    s: ScheduleRecord,
    reason: string | undefined,
    now: number,
  ) => { outcome: string };
  patch: (
    owner: string,
    id: string,
    columns: Record<string, string | number | null>,
    now: number,
  ) => void;
};

const LIVE_STATUSES = "('active','paused','blocked')";

/**
 * CD-04 (design 6.4): when the commitment a plan belongs to ends, the plan is not cut off. It is marked "ending" with a window of
 * at most 30 minutes, nothing new is dispatched, checks already running may finish (read-only evidence, no outgoing action), and
 * then the plan and its checks end for good. A commitment that is reopened later does not bring them back (INV-10).
 */
function createPlanWrapUp(
  c: WorkCommon,
  patch: (
    owner: string,
    id: string,
    columns: Record<string, string | number | null>,
    now: number,
  ) => void,
) {
  const { all, run } = c;
  const LIVE = LIVE_STATUSES;
  // ---- CD-04: the bounded wrap-up of a plan whose commitment ended (design 6.4)

  /** Checks of the plan that are fired and not yet finished: they may run on during the wrap-up window. */
  const runningChecks = (owner: string, planId: string): number =>
    all(
      "SELECT 1 AS found FROM schedule_triggers t JOIN schedules s ON s.owner_id = t.owner_id AND s.id = t.schedule_id " +
        "WHERE t.owner_id = ? AND s.plan_id = ? AND t.outcome = 'created' AND t.turn_state IN ('pending','scheduled','claimed') LIMIT 1",
      owner,
      planId,
    ).length;

  /** End the plan and its live schedules for good: `ended` when the commitment was fulfilled, `cancelled` when it was cancelled. */
  const finishPlan = (owner: string, planId: string, reason: string, now: number): string[] => {
    const finalStatus = reason === "commitment_cancelled" ? "cancelled" : "ended";
    const ids = all(
      `SELECT id FROM schedules WHERE owner_id = ? AND plan_id = ? AND status IN ${LIVE}`,
      owner,
      planId,
    ).map((row) => String(row.id));
    for (const id of ids) {
      patch(
        owner,
        id,
        {
          status: finalStatus,
          stop_reason: reason,
          ended_at: now,
          next_due_at: null,
          pause_source: null,
          block_reasons_json: null,
        },
        now,
      );
    }
    run(
      "UPDATE schedule_triggers SET slot_open = 0 WHERE owner_id = ? AND slot_open = 1 AND schedule_id IN (SELECT id FROM schedules WHERE owner_id = ? AND plan_id = ?)",
      owner,
      owner,
      planId,
    );
    run(
      "UPDATE delegation_plans SET status = 'ended', ended_at = ? WHERE owner_id = ? AND id = ? AND status = 'accepted'",
      now,
      owner,
      planId,
    );
    return ids;
  };

  const wrapUpInTx: FollowUpHooks["wrapUpInTx"] = (owner, commitmentId, reason, now) => {
    const plans = all(
      "SELECT id FROM delegation_plans WHERE owner_id = ? AND plan_owner_type = 'commitment' AND plan_owner_id = ? " +
        "AND status = 'accepted' AND end_requested_at IS NULL",
      owner,
      commitmentId,
    ).map((row) => String(row.id));
    const ended: string[] = [];
    for (const planId of plans) {
      run(
        "UPDATE delegation_plans SET end_requested_at = ?, end_reason = ?, wrapup_until = ? WHERE owner_id = ? AND id = ?",
        now,
        reason,
        now + PLAN_WRAPUP_MS,
        owner,
        planId,
      );
      // The dispatch gate is closed now: no due time is left to start anything new.
      for (const row of all(
        `SELECT id FROM schedules WHERE owner_id = ? AND plan_id = ? AND status IN ${LIVE} AND next_due_at IS NOT NULL`,
        owner,
        planId,
      )) {
        patch(owner, String(row.id), { next_due_at: null }, now);
      }
      if (runningChecks(owner, planId) === 0) {
        finishPlan(owner, planId, reason, now);
        ended.push(planId);
      }
    }
    return { plans, ended };
  };

  const plansOfCommitment: FollowUpHooks["plansOfCommitment"] = (owner, commitmentId) =>
    all(
      "SELECT id, purpose FROM delegation_plans WHERE owner_id = ? AND plan_owner_type = 'commitment' AND plan_owner_id = ? AND status = 'accepted'",
      owner,
      commitmentId,
    ).map((row) => ({ planId: String(row.id), purpose: String(row.purpose) }));

  return { runningChecks, finishPlan, wrapUpInTx, plansOfCommitment };
}

export function createScheduleFollowHooks(core: Core): FollowUpHooks {
  const { c, schedule, pauseCore, resumeCore, cancelCore, patch } = core;
  const { all, run } = c;
  const LIVE = "('active','paused','blocked')";

  const liveRows = (owner: string, workId: string) =>
    all(
      `SELECT id FROM schedules WHERE owner_id = ? AND work_id = ? AND status IN ${LIVE} ORDER BY created_at, id`,
      owner,
      workId,
    ).map((row) => schedule(owner, String(row.id)) as ScheduleRecord);

  const liveOfWork = (owner: string, workId: string): FollowUpLine[] =>
    liveRows(owner, workId).map((s) => ({
      id: s.id,
      purpose: s.purpose,
      status: s.status,
      pauseSource: s.pauseSource,
    }));

  const pauseInTx: FollowUpHooks["pauseInTx"] = (owner, workId, now) => {
    const paused: string[] = [];
    for (const s of liveRows(owner, workId)) {
      // A blocked schedule keeps its real reason (R-11); a paused one keeps whoever paused it.
      if (s.status === "active" && pauseCore(owner, s, "work_control", now).outcome === "paused") {
        paused.push(s.id);
      }
    }
    return paused;
  };

  const resumeInTx: FollowUpHooks["resumeInTx"] = (owner, workId, dispatchReady, now) => {
    const out = { resumed: [] as string[], ended: [] as string[], waiting: [] as string[] };
    for (const s of liveRows(owner, workId)) {
      if (s.status !== "paused" || s.pauseSource !== "work_control") {
        continue;
      }
      const result = resumeCore(owner, s, "work_control", dispatchReady, now).outcome;
      if (result === "resumed") {
        out.resumed.push(s.id);
      } else if (result === "missed_window") {
        out.ended.push(s.id);
      } else {
        // A missing prerequisite keeps it paused; the schedule row says why when the user looks.
        out.waiting.push(s.id);
      }
    }
    return out;
  };

  const endInTx: FollowUpHooks["endInTx"] = (owner, workId, reason, now) => {
    const schedules = liveRows(owner, workId).map((s) => {
      patch(
        owner,
        s.id,
        {
          status: "ended",
          stop_reason: reason,
          ended_at: now,
          next_due_at: null,
          pause_source: null,
          block_reasons_json: null,
        },
        now,
      );
      return s.id;
    });
    const plans = all(
      "SELECT id FROM delegation_plans WHERE owner_id = ? AND work_id = ? AND status IN ('accepted','draft')",
      owner,
      workId,
    ).map((row) => String(row.id));
    for (const planId of plans) {
      // An accepted plan ends; a draft nobody accepted is withdrawn. Neither is deleted.
      run(
        "UPDATE delegation_plans SET status = CASE status WHEN 'accepted' THEN 'ended' ELSE 'revoked' END, " +
          "ended_at = CASE status WHEN 'accepted' THEN ? ELSE ended_at END, " +
          "end_reason = CASE status WHEN 'accepted' THEN ? ELSE end_reason END, " +
          "end_requested_at = CASE status WHEN 'accepted' THEN ? ELSE end_requested_at END " +
          "WHERE owner_id = ? AND id = ?",
        now,
        reason,
        now,
        owner,
        planId,
      );
    }
    return { schedules, plans };
  };

  const stopOneInTx: FollowUpHooks["stopOneInTx"] = (owner, workId, scheduleId, now) => {
    const s = schedule(owner, scheduleId);
    if (!s || s.workId !== workId) {
      return { outcome: "not_found" };
    }
    if (cancelCore(owner, s, "user_stopped_follow_up", now).outcome !== "cancelled") {
      return { outcome: "already_final" };
    }
    let planEnded = false;
    if (s.planId) {
      const left = all(
        `SELECT 1 AS found FROM schedules WHERE owner_id = ? AND plan_id = ? AND status IN ${LIVE} LIMIT 1`,
        owner,
        s.planId,
      );
      if (left.length === 0) {
        run(
          "UPDATE delegation_plans SET status = 'ended', ended_at = ?, end_reason = 'follow_up_stopped', end_requested_at = ? " +
            "WHERE owner_id = ? AND id = ? AND status = 'accepted'",
          now,
          now,
          owner,
          s.planId,
        );
        planEnded = true;
      }
    }
    return { outcome: "stopped", planEnded };
  };

  const wrap = createPlanWrapUp(c, patch);
  const { wrapUpInTx, plansOfCommitment } = wrap;

  return { liveOfWork, pauseInTx, resumeInTx, endInTx, stopOneInTx, wrapUpInTx, plansOfCommitment };
}

/**
 * The end time a plan states ("until"): a live schedule whose accepted plan has passed it ends with the reason `until_reached`,
 * and the plan ends with its last live schedule. Called by the dispatcher's tick, so the end condition the user accepted is
 * really kept, not only shown. Other stop conditions (the commitment is resolved) are the bounded wrap-up of slice W4d.
 */
export function createScheduleExpiry(
  transaction: TransactionRunner,
  core: Pick<Core, "c" | "schedule" | "patch">,
) {
  const { c, schedule, patch } = core;
  const { all, run } = c;
  const untilOf = (planJson: unknown): number | null => {
    let body: PlanBody;
    try {
      body = JSON.parse(String(planJson)) as PlanBody;
    } catch {
      return null;
    }
    const times = (body.stopConditions ?? [])
      .filter((stop) => stop.kind === "until")
      .map((stop) => (stop as { at: number }).at);
    return times.length > 0 ? Math.min(...times) : null;
  };
  const scheduleExpireDue = (input: { principal: Principal; now: number }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const rows = all(
        "SELECT s.id AS sid, s.plan_id AS plan_id, p.plan_json AS plan_json FROM schedules s " +
          "JOIN delegation_plans p ON p.owner_id = s.owner_id AND p.id = s.plan_id " +
          "WHERE s.owner_id = ? AND s.status IN ('active','paused','blocked') AND p.status = 'accepted'",
        owner,
      );
      const ended: string[] = [];
      const plans = new Set<string>();
      for (const row of rows) {
        const until = untilOf(row.plan_json);
        if (until !== null && until <= input.now) {
          const s = schedule(owner, String(row.sid)) as ScheduleRecord;
          patch(
            owner,
            s.id,
            {
              status: "ended",
              stop_reason: "until_reached",
              ended_at: input.now,
              next_due_at: null,
              pause_source: null,
              block_reasons_json: null,
            },
            input.now,
          );
          ended.push(s.id);
          plans.add(String(row.plan_id));
        }
      }
      const endedPlans: string[] = [];
      for (const planId of plans) {
        const left = all(
          "SELECT 1 AS found FROM schedules WHERE owner_id = ? AND plan_id = ? AND status IN ('active','paused','blocked') LIMIT 1",
          owner,
          planId,
        );
        if (left.length === 0) {
          run(
            "UPDATE delegation_plans SET status = 'ended', ended_at = ?, end_reason = 'until_reached', end_requested_at = ? WHERE owner_id = ? AND id = ? AND status = 'accepted'",
            input.now,
            input.now,
            owner,
            planId,
          );
          endedPlans.push(planId);
        }
      }
      return { endedSchedules: ended, endedPlans };
    });
  const wrap = createPlanWrapUp(c, patch);
  /**
   * Run by the dispatcher's tick. First it registers the wrap-up for any plan whose commitment already ended without the
   * in-transaction hook having seen it (a commitment closed before this existed, or by another path); then it ends the plans
   * whose running checks are done or whose window (at most 30 minutes) has passed.
   */
  const scheduleWrapUpDue = (input: { principal: Principal; now: number }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const orphans = all(
        "SELECT p.plan_owner_id AS cid, m.lifecycle AS lifecycle FROM delegation_plans p " +
          "JOIN commitments m ON m.owner_id = p.owner_id AND m.id = p.plan_owner_id " +
          "WHERE p.owner_id = ? AND p.plan_owner_type = 'commitment' AND p.status = 'accepted' AND p.end_requested_at IS NULL " +
          "AND m.lifecycle IN ('resolved','cancelled')",
        owner,
      );
      for (const row of orphans) {
        wrap.wrapUpInTx(
          owner,
          String(row.cid),
          row.lifecycle === "resolved" ? "commitment_resolved" : "commitment_cancelled",
          input.now,
        );
      }
      const due = all(
        "SELECT id, end_reason, wrapup_until FROM delegation_plans WHERE owner_id = ? AND status = 'accepted' AND end_requested_at IS NOT NULL",
        owner,
      );
      const ended: string[] = [];
      for (const row of due) {
        const id = String(row.id);
        const late = row.wrapup_until !== null && Number(row.wrapup_until) <= input.now;
        if (late || wrap.runningChecks(owner, id) === 0) {
          wrap.finishPlan(owner, id, String(row.end_reason ?? "commitment_resolved"), input.now);
          ended.push(id);
        }
      }
      return { endedPlans: ended };
    });
  return { scheduleExpireDue, scheduleWrapUpDue };
}
