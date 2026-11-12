// Controls and end facts of a Work (design 5, WK-04): pause / resume (stacked, resume releases only the named control), stop,
// end partial, reopen, and the user's own "I did it" outcome record. Every method is one transaction.
import type { Principal } from "./types.js";
import type { Row, WorkActor } from "./work-ledger-common.js";
import { TERMINAL_TASK, type WorkOpsDeps } from "./work-ledger-deps.js";

export type WorkControlInput = {
  principal: Principal;
  workId: string;
  action: "pause" | "resume" | "stop_follow_up" | "stop_work" | "end_partial" | "reopen";
  scopeKind?: "work" | "task";
  scopeId?: string;
  reason?: string;
  controlId?: string;
  /** stop_follow_up: the one schedule the user picked. */
  scheduleId?: string;
  /** Whether the host can start scheduled checks right now; a schedule resumed without it is saved blocked, never active. */
  dispatchReady?: boolean;
  reconcileOnly?: boolean;
  /** The user decision that justifies stop_work / end_partial (a request id); required by the end-fact CHECK. */
  decisionRef?: string;
  reopenBasis?: string;
  dryRun?: boolean;
  actor: WorkActor;
  now: number;
};

export function createWorkControlOps(deps: WorkOpsDeps) {
  const { transaction, c, facts, requireLive, evaluateOutcomeInTx, followUp } = deps;
  const { one, all, run, newId, appendEvent, touch } = c;

  const openTasks = (owner: string, workId: string) =>
    all(
      "SELECT t.id, t.title, t.status FROM task_work_owner o JOIN nexus_tasks t ON t.owner_id = o.owner_id AND t.id = o.task_id " +
        `WHERE o.owner_id = ? AND o.work_id = ? AND t.deleted_at IS NULL AND t.status NOT IN ${TERMINAL_TASK} AND t.status NOT IN ('deleted','purging')`,
      owner,
      workId,
    ).map((row) => ({ id: String(row.id), title: String(row.title), status: String(row.status) }));

  /** Cancel every open Task of the Work through the same UPDATE the operator abort uses; optionally mark them as ended-partial. */
  const cancelOpenTasks = (
    owner: string,
    tasks: { id: string }[],
    partial: boolean,
    actor: WorkActor,
    now: number,
  ): void => {
    for (const task of tasks) {
      run(
        "UPDATE nexus_tasks SET status = 'cancelled', ended_at = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
        now,
        now,
        owner,
        task.id,
      );
      if (partial) {
        run(
          "INSERT INTO task_ext (owner_id, task_id, end_kind, end_reason, ended_by, revision, updated_at) VALUES (?, ?, 'partial', 'accept_partial', ?, 1, ?) " +
            "ON CONFLICT (owner_id, task_id) DO UPDATE SET end_kind = 'partial', end_reason = 'accept_partial', ended_by = excluded.ended_by, revision = revision + 1, updated_at = excluded.updated_at",
          owner,
          task.id,
          actor === "agent" ? "agent" : actor,
          now,
        );
      }
    }
  };

  const live = (owner: string, workId: string) => followUp.hooks?.liveOfWork(owner, workId) ?? [];

  /** Pauses of the whole Work still in force, not counting the one being released. */
  const workControlsLeft = (owner: string, workId: string, except: string | undefined): number =>
    Number(
      (
        one(
          "SELECT COUNT(*) AS c FROM work_controls WHERE owner_id = ? AND work_id = ? AND scope_kind = 'work' AND state <> 'released' AND id <> ?",
          owner,
          workId,
          except ?? "",
        ) as Row
      ).c,
    );

  const workControl = (input: WorkControlInput) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const found = requireLive(owner, input.workId);
      if (found.problem) {
        return { outcome: "not_found" as const };
      }
      const work = found.work;
      if (input.action === "pause") {
        const scopeKind = input.scopeKind ?? "work";
        if (
          scopeKind === "task" &&
          (!input.scopeId || c.workOfTask(owner, input.scopeId) !== work.id)
        ) {
          return { outcome: "invalid" as const, code: "task_not_in_work" };
        }
        const reason = input.reason ?? "user";
        const dup = one(
          "SELECT id FROM work_controls WHERE owner_id = ? AND work_id = ? AND scope_kind = ? AND COALESCE(scope_id,'') = ? AND COALESCE(reason,'') = ? AND state <> 'released'",
          owner,
          work.id,
          scopeKind,
          scopeKind === "work" ? "" : (input.scopeId ?? ""),
          reason,
        );
        if (dup) {
          return { outcome: "unchanged" as const, controlId: String(dup.id) };
        }
        if (input.dryRun) {
          return {
            outcome: "preview" as const,
            action: "pause",
            affectedTasks: openTasks(owner, work.id),
            schedulesToPause:
              scopeKind === "work"
                ? live(owner, work.id).filter((line) => line.status === "active")
                : [],
          };
        }
        const id = newId("wc_");
        run(
          "INSERT INTO work_controls (owner_id, id, work_id, scope_kind, scope_id, state, reason, initiated_by, reconcile_only, control_version, created_at) " +
            "VALUES (?, ?, ?, ?, ?, 'paused', ?, ?, ?, 1, ?)",
          owner,
          id,
          work.id,
          scopeKind,
          scopeKind === "work" ? null : (input.scopeId ?? null),
          reason,
          input.actor === "system" ? "system" : "user",
          input.reconcileOnly ? 1 : 0,
          input.now,
        );
        appendEvent(
          owner,
          work.id,
          "control_applied",
          input.actor,
          { controlId: id, scopeKind, reason },
          input.now,
        );
        // Pausing the whole Work pauses the follow-up it carries; a Task-level pause touches no schedule.
        const pausedSchedules =
          scopeKind === "work" ? (followUp.hooks?.pauseInTx(owner, work.id, input.now) ?? []) : [];
        touch(owner, work.id, input.now);
        return { outcome: "applied" as const, controlId: id, pausedSchedules };
      }
      if (input.action === "resume") {
        // Controls stack; resume releases exactly the one the caller named (or the plain user pause at work scope), nothing else.
        const target = input.controlId
          ? one(
              "SELECT id FROM work_controls WHERE owner_id = ? AND work_id = ? AND id = ? AND state <> 'released'",
              owner,
              work.id,
              input.controlId,
            )
          : one(
              "SELECT id FROM work_controls WHERE owner_id = ? AND work_id = ? AND scope_kind = 'work' AND reason = 'user' AND state <> 'released'",
              owner,
              work.id,
            );
        if (!target) {
          return { outcome: "no_such_control" as const };
        }
        if (input.dryRun) {
          return {
            outcome: "preview" as const,
            action: "resume",
            controlId: String(target.id),
            schedulesToResume:
              workControlsLeft(owner, work.id, String(target.id)) === 0
                ? live(owner, work.id).filter(
                    (line) => line.status === "paused" && line.pauseSource === "work_control",
                  )
                : [],
          };
        }
        run(
          "UPDATE work_controls SET state = 'released', released_at = ? WHERE owner_id = ? AND id = ?",
          input.now,
          owner,
          String(target.id),
        );
        appendEvent(
          owner,
          work.id,
          "control_released",
          input.actor,
          { controlId: String(target.id) },
          input.now,
        );
        touch(owner, work.id, input.now);
        const remaining = Number(
          (
            one(
              "SELECT COUNT(*) AS c FROM work_controls WHERE owner_id = ? AND work_id = ? AND state <> 'released'",
              owner,
              work.id,
            ) as Row
          ).c,
        );
        // The schedules come back only when no other pause of the whole Work is left (INV-22), and only the ones the Work paused.
        const followed =
          workControlsLeft(owner, work.id, undefined) === 0
            ? followUp.hooks?.resumeInTx(owner, work.id, input.dispatchReady === true, input.now)
            : undefined;
        return {
          outcome: "released" as const,
          controlId: String(target.id),
          stillControlled: remaining > 0,
          ...(followed ? { schedules: followed } : {}),
        };
      }
      if (input.action === "stop_follow_up") {
        const line = input.scheduleId
          ? live(owner, work.id).find((entry) => entry.id === input.scheduleId)
          : undefined;
        if (!input.scheduleId || !line) {
          const known = input.scheduleId
            ? one(
                "SELECT status FROM schedules WHERE owner_id = ? AND work_id = ? AND id = ?",
                owner,
                work.id,
                input.scheduleId,
              )
            : undefined;
          return known
            ? { outcome: "already_final" as const }
            : { outcome: "invalid" as const, code: "schedule_not_in_work" };
        }
        if (input.dryRun) {
          return { outcome: "preview" as const, action: "stop_follow_up", schedule: line };
        }
        const stopped = followUp.hooks?.stopOneInTx(owner, work.id, line.id, input.now);
        if (stopped?.outcome !== "stopped") {
          return { outcome: "already_final" as const };
        }
        touch(owner, work.id, input.now);
        return {
          outcome: "follow_up_stopped" as const,
          scheduleId: line.id,
          planEnded: stopped.planEnded,
        };
      }
      if (input.action === "stop_work" || input.action === "end_partial") {
        const open = one(
          "SELECT id FROM work_terminal_events WHERE owner_id = ? AND work_id = ? AND reopened_at IS NULL",
          owner,
          work.id,
        );
        if (open) {
          return { outcome: "already_ended" as const, terminalId: String(open.id) };
        }
        const tasks = openTasks(owner, work.id);
        if (input.dryRun) {
          return {
            outcome: "preview" as const,
            action: input.action,
            tasksToCancel: tasks,
            schedulesToEnd: live(owner, work.id),
          };
        }
        if (!input.decisionRef) {
          return { outcome: "needs_decision_ref" as const };
        }
        const partial = input.action === "end_partial";
        cancelOpenTasks(owner, tasks, partial, input.actor, input.now);
        const id = newId("wt_");
        run(
          "INSERT INTO work_terminal_events (owner_id, id, work_id, work_version, contract_version, criteria_snapshot_json, evidence_snapshot_json, " +
            "result_at_close, reason, decision_ref, stop_scope_json, recorded_at) VALUES (?, ?, ?, ?, 1, ?, '{}', ?, ?, ?, ?, ?)",
          owner,
          id,
          work.id,
          work.currentWorkVersion,
          JSON.stringify({ criteria: [{ kind: "task_completed" }] }),
          partial ? "partial" : "stopped_before_completion",
          partial ? "accept_partial" : "stop",
          input.decisionRef,
          JSON.stringify({ tasks: tasks.map((task) => task.id) }),
          input.now,
        );
        appendEvent(
          owner,
          work.id,
          "terminal_recorded",
          input.actor,
          { terminalId: id, reason: partial ? "accept_partial" : "stop" },
          input.now,
        );
        // Cancelling can withdraw nothing and achieve nothing here, but the evaluation also honours the new end fact.
        evaluateOutcomeInTx(owner, work.id, input.now);
        // The Work's own follow-up ends with it (design 6.6); a Commitment is never touched and a reopen does not bring it back.
        const followed = followUp.hooks?.endInTx(
          owner,
          work.id,
          partial ? "work_ended_partial" : "work_stopped",
          input.now,
        );
        touch(owner, work.id, input.now);
        return {
          outcome: "ended" as const,
          terminalId: id,
          cancelledTasks: tasks.map((task) => task.id),
          endedSchedules: followed?.schedules ?? [],
          endedPlans: followed?.plans ?? [],
        };
      }
      // reopen
      const open = one(
        "SELECT id FROM work_terminal_events WHERE owner_id = ? AND work_id = ? AND reopened_at IS NULL ORDER BY recorded_at DESC LIMIT 1",
        owner,
        work.id,
      );
      if (!open) {
        return { outcome: "not_ended" as const };
      }
      if (!input.reopenBasis) {
        return { outcome: "invalid" as const, code: "reopen_needs_basis" };
      }
      if (input.dryRun) {
        return { outcome: "preview" as const, action: "reopen", terminalId: String(open.id) };
      }
      const boundary = newId("wb_");
      run(
        "UPDATE work_terminal_events SET reopened_at = ?, reopen_basis = ?, new_boundary_id = ? WHERE owner_id = ? AND id = ?",
        input.now,
        input.reopenBasis,
        boundary,
        owner,
        String(open.id),
      );
      appendEvent(
        owner,
        work.id,
        "control_released",
        input.actor,
        { terminalId: String(open.id), reopened: true, boundary },
        input.now,
      );
      touch(owner, work.id, input.now);
      return { outcome: "reopened" as const, boundaryId: boundary };
    });

  /**
   * The user explicitly records that a migrated (or otherwise un-evented) Work is done. Written as a `legacy_backfill` user_report
   * event so counting excludes it and the original completion time is never invented (R-42 default). Continues the chain.
   */
  const workRecordOutcome = (input: {
    principal: Principal;
    workId: string;
    reason: string;
    actor: WorkActor;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const found = requireLive(owner, input.workId);
      if (found.problem) {
        return { outcome: "not_found" as const };
      }
      const work = found.work;
      const events = all(
        "SELECT * FROM work_outcome_events WHERE owner_id = ? AND work_id = ? AND original_result_id = ?",
        owner,
        work.id,
        work.originalResultId,
      );
      const head = facts.outcomeHead(events);
      if (head && (head.event_type === "achieved" || head.event_type === "reinstated")) {
        return { outcome: "already_done" as const };
      }
      const id = `oe_${work.id}_${events.length + 1}`;
      run(
        "INSERT INTO work_outcome_events (owner_id, id, work_id, original_result_id, work_version, contract_version, event_type, basis, provenance, " +
          "assessment_refs_json, previous_event_id, reason, recorded_at) VALUES (?, ?, ?, ?, ?, 1, ?, 'user_report', 'legacy_backfill', '{}', ?, ?, ?)",
        owner,
        id,
        work.id,
        work.originalResultId,
        work.currentWorkVersion,
        head ? "reinstated" : "achieved",
        head ? String(head.id) : null,
        input.reason,
        input.now,
      );
      appendEvent(
        owner,
        work.id,
        "outcome_recorded",
        input.actor,
        { outcomeEventId: id, provenance: "legacy_backfill" },
        input.now,
      );
      touch(owner, work.id, input.now);
      return { outcome: "recorded" as const, eventId: id };
    });

  return { workControl, workRecordOutcome };
}
