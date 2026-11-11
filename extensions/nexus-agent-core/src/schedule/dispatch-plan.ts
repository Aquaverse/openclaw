// What to do with a schedule whose due time has come (design 4.5.3, R-16): plain functions, no database and no clock of their own.
// The newest overdue time is checked once if it is still inside the dispatch window, otherwise it is recorded as missed; every
// older overdue time is folded into ONE merged record. Nothing is replayed time by time and a once-schedule never turns into an
// instant task. The decisions here are only proposals: the ledger still refuses a duplicate, a busy slot or a stale schedule.
import { nextDueAfter, occurrenceKey } from "./cadence.js";
import type { ScheduleRecord, TriggerSource } from "./types.js";

export const TICK_MS = 60_000;
/** A due time reached by the running timer is "scheduled"; later than this it is a catch-up after a pause or restart. */
export const ON_TIME_MS = 2.5 * TICK_MS;
export const DEFAULT_DISPATCH_WINDOW_MS = 60 * 60_000;
export const MAX_DISPATCH_WINDOW_MS = 24 * 60 * 60_000;
export const MAX_MERGED_REFS = 50;
const SCAN_CAP = 500;

export type DispatchAction =
  | { kind: "fire"; occurrenceKey: string; plannedAt: number; source: TriggerSource }
  | { kind: "miss"; occurrenceKey: string; plannedAt: number }
  | { kind: "merge"; occurrenceKey: string; plannedAt: number; merged: string[] };

export const windowOf = (schedule: Pick<ScheduleRecord, "dispatchWindowMs">): number =>
  Math.min(schedule.dispatchWindowMs ?? DEFAULT_DISPATCH_WINDOW_MS, MAX_DISPATCH_WINDOW_MS);

/** Every due time of the schedule that is not after `now`, oldest first, starting at its own next_due_at. */
export function overdueTimes(
  schedule: Pick<ScheduleRecord, "cadence" | "tz" | "createdAt" | "nextDueAt">,
  now: number,
): { times: number[]; truncated: boolean } {
  const first = schedule.nextDueAt;
  if (first === null || first > now) {
    return { times: [], truncated: false };
  }
  const times: number[] = [first];
  while (times.length < SCAN_CAP) {
    const next = nextDueAfter(
      schedule.cadence,
      schedule.tz,
      times[times.length - 1] as number,
      schedule.createdAt,
    );
    if (next === null || next > now) {
      return { times, truncated: false };
    }
    times.push(next);
  }
  // A very old schedule (a paused machine, a long gap): jump to the last day instead of walking every missed time.
  const tail: number[] = [];
  let at = nextDueAfter(schedule.cadence, schedule.tz, now - 25 * 60 * 60_000, schedule.createdAt);
  while (at !== null && at <= now && tail.length < SCAN_CAP) {
    tail.push(at);
    at = nextDueAfter(schedule.cadence, schedule.tz, at, schedule.createdAt);
  }
  return { times: [first, ...tail.filter((value) => value > first)], truncated: true };
}

export function mergedKey(scheduleId: string, first: number, last: number): string {
  return `${scheduleId}@merged#${first}-${last}`;
}

/** The newest overdue time first (checked or missed), then one merge record for everything older. */
export function planDue(
  schedule: Pick<
    ScheduleRecord,
    "id" | "cadence" | "tz" | "createdAt" | "nextDueAt" | "dispatchWindowMs"
  >,
  now: number,
): DispatchAction[] {
  const { times } = overdueTimes(schedule, now);
  if (times.length === 0) {
    return [];
  }
  const latest = times[times.length - 1] as number;
  const older = times.slice(0, -1);
  const actions: DispatchAction[] = [];
  const late = now - latest;
  if (late <= windowOf(schedule)) {
    actions.push({
      kind: "fire",
      occurrenceKey: occurrenceKey(schedule.id, latest),
      plannedAt: latest,
      source: late <= ON_TIME_MS ? "scheduled" : "catch_up",
    });
  } else {
    actions.push({
      kind: "miss",
      occurrenceKey: occurrenceKey(schedule.id, latest),
      plannedAt: latest,
    });
  }
  if (older.length > 0) {
    actions.push({
      kind: "merge",
      occurrenceKey: mergedKey(schedule.id, older[0] as number, older[older.length - 1] as number),
      plannedAt: older[older.length - 1] as number,
      merged: older.slice(-MAX_MERGED_REFS).map((at) => occurrenceKey(schedule.id, at)),
    });
  }
  return actions;
}
