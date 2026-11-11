// The schedule dispatcher (design 4.5.3, S-H1 candidate B): one timer inside the gateway process that every minute
//   1. frees dispatch slots whose Task already ended,
//   2. looks at the active check_task schedules that are due and decides, per schedule, what to do with the due times (dispatch-plan.ts),
//   3. fires a check: gate (prerequisites, free slot) -> a NEW check Task (idempotent by occurrence key) -> the trigger record,
//   4. asks the host to run each fired check as a session turn, and gives up on turns that never started or never reported.
// Duplicates are stopped by the database (unique occurrence key, one open slot per schedule), never by "the timer fires once", so a
// restart, a replayed tick or a second plugin instance cannot create a second check. The host is reached through ONE small port.
import type { TaskStore } from "../store/host.js";
import type { Principal } from "../store/types.js";
import { newTaskId } from "../tools/task-tools.js";
import { planDue, TICK_MS, type DispatchAction } from "./dispatch-plan.js";
import type { ScheduleRecord } from "./types.js";

export const CHECK_TASK_KIND = "schedule_check";
export const CHECK_MARKER_PREFIX = "[nexus:check:";
export const CHECK_TAG_PREFIX = "nexus-check-";
/** A scheduled or running turn that has not reported within this long is closed as failed (a coverage gap, never "no change"). */
export const TURN_GRACE_MS = 30 * 60_000;
/** The host is asked to start the turn this long after it is fired (the host's own minimum is a few seconds). */
export const TURN_START_DELAY_MS = 5_000;
export const MAX_FIRES_PER_TICK = 5;

export const buildCheckMessage = (triggerId: string): string =>
  `${CHECK_MARKER_PREFIX}${triggerId}] Nexus follow-up check. Follow the [Nexus follow-up check] protocol and finish with exactly one call to nexus_schedule_check_report.`;

/**
 * One session per fired check (schedule + planned time), so a check never mixes with the user's chats and never carries the history
 * of earlier checks: a shared session grew from 17k to 48k prompt tokens in three checks, and a model that sees its own earlier
 * reports may answer in text instead of reporting again. Lower case on purpose: the host canonicalizes session keys to lower case,
 * so the key we record must already be one.
 */
export const checkSessionKey = (scheduleId: string, plannedAt: number): string =>
  `agent:main:nexus-check-${scheduleId}-${plannedAt}`.toLowerCase();

export type CheckTurnPort = {
  schedule(params: {
    sessionKey: string;
    delayMs: number;
    message: string;
    name: string;
    tag: string;
  }): Promise<{ id: string } | undefined>;
  unscheduleByTag(params: {
    sessionKey: string;
    tag: string;
  }): Promise<{ removed: number; failed: number }>;
};

export type DispatcherDeps = {
  getStore: () => Promise<TaskStore>;
  principal: () => Principal | undefined;
  turns: CheckTurnPort;
  now?: () => number;
  logger: { info(message: string): void; warn(message: string): void };
  /** Tell the console a Task or a Work changed (optional). */
  onTaskCreated?: (taskId: string) => void;
  onWorkChanged?: (workId: string) => void;
  newTaskId?: () => string;
  /** Process-wide state in production; a fresh one per dispatcher in tests. */
  state?: { running: boolean };
};

export type TickReport = {
  due: number;
  fired: number;
  skipped: number;
  missed: number;
  merged: number;
  blocked: number;
  turnsScheduled: number;
  turnsFailed: number;
};

const SHARED = Symbol.for("nexus-agent-core.schedule.dispatcher.state");
export function getSharedDispatcherState(): { running: boolean } {
  const root = globalThis as { [SHARED]?: { running: boolean } };
  return (root[SHARED] ??= { running: false });
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createDispatcher(deps: DispatcherDeps) {
  const now = deps.now ?? Date.now;
  const state = deps.state ?? { running: false };
  const makeTaskId = deps.newTaskId ?? newTaskId;

  const emptyReport = (): TickReport => ({
    due: 0,
    fired: 0,
    skipped: 0,
    missed: 0,
    merged: 0,
    blocked: 0,
    turnsScheduled: 0,
    turnsFailed: 0,
  });

  /** Record a missed or merged due time. The ledger moves the schedule's next due time on. */
  async function recordPassive(
    store: TaskStore,
    principal: Principal,
    schedule: ScheduleRecord,
    action: Extract<DispatchAction, { kind: "miss" | "merge" }>,
    at: number,
  ): Promise<void> {
    await store.scheduleRecordTrigger({
      principal,
      scheduleId: schedule.id,
      occurrenceKey: action.occurrenceKey,
      plannedAt: action.plannedAt,
      source: "catch_up",
      outcome: action.kind === "miss" ? "missed" : "merged",
      ...(action.kind === "merge" ? { mergedOccurrenceKeys: action.merged } : {}),
      now: at,
    });
  }

  /** Fire one check for a due time. Returns what happened, for the report. */
  async function fire(
    store: TaskStore,
    principal: Principal,
    schedule: ScheduleRecord,
    action: Extract<DispatchAction, { kind: "fire" }>,
  ): Promise<"fired" | "skipped" | "blocked" | "other"> {
    const begun = await store.scheduleDispatchBegin({
      principal,
      scheduleId: schedule.id,
      occurrenceKey: action.occurrenceKey,
      now: now(),
    });
    if (begun.outcome === "blocked") {
      return "blocked";
    }
    if (begun.outcome === "slot_busy") {
      // The previous check of this schedule is still open: this due time is skipped and said so (INV-12).
      await store.scheduleRecordTrigger({
        principal,
        scheduleId: schedule.id,
        occurrenceKey: action.occurrenceKey,
        plannedAt: action.plannedAt,
        source: action.source,
        outcome: "skipped",
        skipReason: "previous_check_open",
        now: now(),
      });
      return "skipped";
    }
    if (begun.outcome !== "go") {
      return "other";
    }
    const key = `schedcheck:${schedule.id}:${action.occurrenceKey}`;
    const title = `跟进检查 · ${schedule.purpose}`.slice(0, 190);
    const created = await store.create({
      principal,
      id: makeTaskId(),
      kind: CHECK_TASK_KIND,
      title,
      goal: { text: schedule.purpose, schedule: schedule.id, occurrence: action.occurrenceKey },
      entities: null,
      idempotencyKey: key,
      fingerprint: key,
      sessionKey: checkSessionKey(schedule.id, action.plannedAt),
      now: now(),
      work: { workId: schedule.workId, title, origin: "agent" },
    });
    if (created.outcome !== "created" && created.outcome !== "replayed") {
      // The Work is gone or closed: nothing can be checked for it (the ledger's gap check notices on the next due time).
      deps.logger.warn(
        `nexus: check not fired for schedule ${schedule.id}: ${created.outcome === "work_unusable" ? created.reason : created.outcome}`,
      );
      return "other";
    }
    const recorded = await store.scheduleRecordTrigger({
      principal,
      scheduleId: schedule.id,
      occurrenceKey: action.occurrenceKey,
      plannedAt: action.plannedAt,
      source: action.source,
      outcome: "created",
      taskId: created.task.id,
      now: now(),
    });
    if (created.outcome === "created") {
      deps.onTaskCreated?.(created.task.id);
    }
    if (recorded.outcome !== "recorded") {
      // slot_busy / duplicate / not_active between the gate and the record: the Task is bookkeeping only, close it.
      deps.logger.warn(
        `nexus: check trigger not recorded (${recorded.outcome}) for ${schedule.id}`,
      );
      if (created.outcome === "created" && recorded.outcome !== "duplicate") {
        await store.abort({ principal, taskId: created.task.id, now: now() });
      }
      return "other";
    }
    // The new Task joined the Work before its trigger existed; re-evaluate so nothing keeps counting it.
    await store.workEvaluate({ principal, workId: schedule.workId, now: now() });
    deps.onWorkChanged?.(schedule.workId);
    return "fired";
  }

  /** Ask the host to run every fired check whose turn is not scheduled yet. */
  async function startTurns(store: TaskStore, principal: Principal, report: TickReport) {
    const pending = await store.scheduleCheckPending({ principal, limit: 20 });
    for (const entry of pending.pending) {
      const sessionKey = checkSessionKey(entry.schedule.id, entry.trigger.plannedAt);
      const tag = `${CHECK_TAG_PREFIX}${entry.trigger.id}`;
      try {
        // Scheduling is not idempotent, unscheduling by tag is: drop anything an earlier try left behind first.
        await deps.turns.unscheduleByTag({ sessionKey, tag });
        const handle = await deps.turns.schedule({
          sessionKey,
          delayMs: TURN_START_DELAY_MS,
          message: buildCheckMessage(entry.trigger.id),
          name: `nexus-check-${entry.trigger.id}`,
          tag,
        });
        if (!handle) {
          await store.scheduleCheckTurnRefused({
            principal,
            triggerId: entry.trigger.id,
            reason: "host_refused",
            now: now(),
          });
          continue;
        }
        const marked = await store.scheduleCheckTurnScheduled({
          principal,
          triggerId: entry.trigger.id,
          jobId: handle.id,
          sessionKey,
          now: now(),
        });
        if (marked.outcome === "scheduled") {
          report.turnsScheduled += 1;
        } else {
          // Closed while we were scheduling: the job we just made belongs to nobody.
          await deps.turns.unscheduleByTag({ sessionKey, tag });
        }
      } catch (error) {
        deps.logger.warn(
          `nexus: could not start check turn ${entry.trigger.id}: ${messageOf(error)}`,
        );
        await store
          .scheduleCheckTurnRefused({
            principal,
            triggerId: entry.trigger.id,
            reason: "host_error",
            now: now(),
          })
          .catch(() => undefined);
      }
    }
  }

  /** One pass. Safe to call from a timer, a restart, or a test; overlapping calls are dropped, not queued. */
  async function tick(): Promise<TickReport | undefined> {
    if (state.running) {
      return undefined;
    }
    state.running = true;
    const report = emptyReport();
    try {
      const principal = deps.principal();
      if (!principal) {
        return report;
      }
      const store = await deps.getStore();
      await store.scheduleReconcileSlots({ principal, now: now() });
      const due = await store.scheduleDueList({ principal, now: now(), limit: 50 });
      report.due = due.schedules.length;
      let fires = 0;
      for (const schedule of due.schedules) {
        const actions = planDue(schedule, now());
        for (const action of actions) {
          try {
            if (action.kind === "fire") {
              if (fires >= MAX_FIRES_PER_TICK) {
                // Over the per-tick limit: left as it is, the next tick takes it while it is still inside its window.
                continue;
              }
              const result = await fire(store, principal, schedule, action);
              if (result === "fired") {
                fires += 1;
                report.fired += 1;
              } else if (result === "skipped") {
                report.skipped += 1;
              } else if (result === "blocked") {
                report.blocked += 1;
                break;
              }
            } else {
              await recordPassive(store, principal, schedule, action, now());
              if (action.kind === "miss") {
                report.missed += 1;
              } else {
                report.merged += 1;
              }
            }
          } catch (error) {
            deps.logger.warn(
              `nexus: dispatch failed for schedule ${schedule.id}: ${messageOf(error)}`,
            );
          }
        }
      }
      await startTurns(store, principal, report);
      const expired = await store.scheduleCheckExpire({
        principal,
        now: now(),
        graceMs: TURN_GRACE_MS,
      });
      report.turnsFailed = expired.failed.length;
      for (const trigger of expired.failed) {
        await deps.turns
          .unscheduleByTag({
            sessionKey: trigger.turnSessionKey ?? "",
            tag: `${CHECK_TAG_PREFIX}${trigger.id}`,
          })
          .catch(() => undefined);
      }
      return report;
    } catch (error) {
      deps.logger.warn(`nexus: dispatcher tick failed: ${messageOf(error)}`);
      return report;
    } finally {
      state.running = false;
    }
  }

  /** The service started (or the host's capability changed): bring back schedules that only waited for a dispatcher. */
  async function syncHost(ready: boolean): Promise<{ unblocked: string[]; blocked: string[] }> {
    const principal = deps.principal();
    if (!principal) {
      return { unblocked: [], blocked: [] };
    }
    const store = await deps.getStore();
    return store.scheduleSyncHost({ principal, dispatchReady: ready, now: now() });
  }

  return { tick, syncHost, tickMs: TICK_MS };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
