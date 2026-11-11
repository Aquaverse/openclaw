import { nextDueAfter } from "../schedule/cadence.js";
import {
  MANUAL_TRIGGER_COOLDOWN_MS,
  TRIGGER_OUTCOMES,
  TRIGGER_SOURCES,
  type ScheduleRecord,
  type TriggerOutcome,
  type TriggerSource,
} from "../schedule/types.js";
import type { TransactionRunner } from "./kernel.js";
import { toTrigger, type ScheduleCommon } from "./schedule-common.js";
import type { Principal } from "./types.js";
import type { WorkCommon } from "./work-ledger-common.js";

// Schedule trigger records (object-model design 4.5.3, INV-12). A due time is recorded ONCE under a stable occurrence key, so a
// replayed event, a restart or a catch-up never creates a second check Task; the dispatch slot keeps at most one fired Task open
// per schedule; a once-schedule ends after its single dispatch or when its window passed (it never turns into an instant task).
// This ledger records what a dispatcher decided and gates it; the dispatcher itself is slice W4b.

type Load = (
  owner: string,
  id: string,
  expectedRevision: number | undefined,
) =>
  | { schedule: ScheduleRecord }
  | { outcome: "not_found" }
  | { outcome: "conflict"; schedule: ScheduleRecord };

export function createScheduleTriggerOps(deps: {
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
}) {
  const { transaction, c, k, patch, load, fresh } = deps;
  const { one, all, run, newId } = c;

  const scheduleRecordTrigger = (input: {
    principal: Principal;
    scheduleId: string;
    occurrenceKey: string;
    plannedAt: number;
    source: TriggerSource;
    outcome: TriggerOutcome;
    taskId?: string;
    skipReason?: string;
    mergedOccurrenceKeys?: string[];
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const found = load(owner, input.scheduleId, undefined);
      if ("outcome" in found) {
        return found;
      }
      const s = found.schedule;
      if (
        !(TRIGGER_SOURCES as readonly string[]).includes(input.source) ||
        !(TRIGGER_OUTCOMES as readonly string[]).includes(input.outcome) ||
        typeof input.occurrenceKey !== "string" ||
        input.occurrenceKey.length === 0 ||
        input.occurrenceKey.length > 200 ||
        !Number.isSafeInteger(input.plannedAt) ||
        input.plannedAt <= 0
      ) {
        return { outcome: "invalid" as const, code: "bad_trigger" };
      }
      const same = one(
        "SELECT * FROM schedule_triggers WHERE owner_id = ? AND schedule_id = ? AND occurrence_key = ?",
        owner,
        s.id,
        input.occurrenceKey,
      );
      if (same) {
        // A replayed event: the record that already exists answers it.
        return { outcome: "duplicate" as const, trigger: toTrigger(same), schedule: s };
      }
      const final = s.status === "ended" || s.status === "cancelled";
      // A late trigger of a schedule that already ended is kept as evidence and creates nothing (NX-04).
      const outcome: TriggerOutcome = final ? "quarantined" : input.outcome;
      let taskId: string | null = null;
      if (outcome === "created") {
        if (s.status !== "active") {
          return { outcome: "not_active" as const, schedule: s };
        }
        taskId = typeof input.taskId === "string" && input.taskId !== "" ? input.taskId : null;
        if (taskId === null) {
          return { outcome: "invalid" as const, code: "task_required" };
        }
        if (c.workOfTask(owner, taskId) !== s.workId) {
          return { outcome: "task_not_owned" as const };
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
            return { outcome: "slot_busy" as const, openTaskId: String(open.task_id) };
          }
        }
        if (
          input.source === "manual" &&
          s.lastManualTriggerAt !== null &&
          input.now - s.lastManualTriggerAt < MANUAL_TRIGGER_COOLDOWN_MS
        ) {
          return {
            outcome: "cooldown" as const,
            retryAt: s.lastManualTriggerAt + MANUAL_TRIGGER_COOLDOWN_MS,
          };
        }
      }
      if (outcome === "merged") {
        const keys = input.mergedOccurrenceKeys;
        if (!Array.isArray(keys) || keys.length === 0 || keys.some((x) => typeof x !== "string")) {
          return { outcome: "invalid" as const, code: "merged_keys_required" };
        }
      }
      const id = newId("tg_");
      run(
        "INSERT INTO schedule_triggers (owner_id, id, schedule_id, schedule_revision, occurrence_key, plan_version, source, planned_at, outcome, " +
          "skip_reason, merged_occurrence_keys_json, task_id, slot_open, fired_at, created_at, turn_state, turn_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        owner,
        id,
        s.id,
        s.revision,
        input.occurrenceKey,
        s.planVersion ?? 0,
        input.source,
        input.plannedAt,
        outcome,
        (final ? s.status : (input.skipReason ?? null)) as string | null,
        outcome === "merged" ? JSON.stringify(input.mergedOccurrenceKeys) : null,
        taskId,
        outcome === "created" ? 1 : 0,
        outcome === "created" ? input.now : null,
        input.now,
        outcome === "created" ? "pending" : "none",
        outcome === "created" ? input.now : null,
      );
      if (!final) {
        if (input.source === "manual") {
          // A manual run is an extra check: it does not move the schedule's own beat.
          if (outcome === "created") {
            patch(owner, s.id, { last_manual_trigger_at: input.now }, input.now);
          }
        } else if (s.cadence.kind === "once") {
          if (outcome === "created" || outcome === "missed") {
            patch(
              owner,
              s.id,
              {
                status: "ended",
                stop_reason: outcome === "created" ? "dispatched_once" : "missed_window",
                ended_at: input.now,
                next_due_at: null,
                pause_source: null,
                block_reasons_json: null,
              },
              input.now,
            );
          }
        } else if (s.status === "active") {
          // The next due time counts from now when the planned one is long past: missed times are merged, not replayed one by one.
          const next = nextDueAfter(
            s.cadence,
            s.tz,
            Math.max(input.plannedAt, input.now),
            s.createdAt,
          );
          // A fired check restores coverage, a missed one degrades it; a skip or a merge record changes nothing about it.
          patch(
            owner,
            s.id,
            {
              next_due_at: next,
              ...(outcome === "created"
                ? { coverage_state: "on_plan", coverage_note: null }
                : outcome === "missed"
                  ? { coverage_state: "degraded", coverage_note: "missed_window" }
                  : {}),
            },
            input.now,
          );
        }
      }
      const row = one("SELECT * FROM schedule_triggers WHERE owner_id = ? AND id = ?", owner, id);
      return {
        outcome: "recorded" as const,
        trigger: toTrigger(row as Record<string, unknown>),
        schedule: fresh(owner, s.id),
      };
    });

  /** The Task of a fired trigger reached a final state: its schedule's dispatch slot is free again. */
  const scheduleReleaseSlot = (input: { principal: Principal; taskId: string; now: number }) =>
    transaction(() => {
      const released = run(
        "UPDATE schedule_triggers SET slot_open = 0 WHERE owner_id = ? AND task_id = ? AND slot_open = 1",
        input.principal.ownerId,
        input.taskId,
      );
      return { released };
    });

  /** Free every slot whose Task is already final (the integrity repair of design 12.6; nexus_tasks cannot call back). */
  const scheduleReconcileSlots = (input: { principal: Principal; now: number }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const rows = all(
        "SELECT id, task_id FROM schedule_triggers WHERE owner_id = ? AND slot_open = 1",
        owner,
      );
      let released = 0;
      for (const row of rows) {
        if (k.taskIsFinished(owner, String(row.task_id))) {
          released += run(
            "UPDATE schedule_triggers SET slot_open = 0 WHERE owner_id = ? AND id = ?",
            owner,
            String(row.id),
          );
        }
      }
      return { released };
    });

  return { scheduleRecordTrigger, scheduleReleaseSlot, scheduleReconcileSlots };
}
