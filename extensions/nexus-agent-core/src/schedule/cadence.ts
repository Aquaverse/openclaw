// Schedule cadence (object-model design 4.5.2): the closed set of shapes a check can repeat in, the 15-minute floor the ledger
// REJECTS (never silently raises, so "real-time coverage" is never faked, CS-01), and the next due time in UTC for a shape in an
// IANA time zone. Plain functions with no database and no clock of their own.
export const MIN_INTERVAL_MINUTES = 15;
export const MAX_DAILY_TIMES = 8;

export type Cadence =
  | { kind: "once"; at: number }
  | { kind: "interval"; minutes: number; anchorAt?: number }
  | { kind: "daily"; times: string[]; weekdays?: number[] };

export type CadenceProblem =
  | "bad_cadence"
  | "bad_once"
  | "below_minimum"
  | "bad_times"
  | "bad_weekdays"
  | "bad_anchor"
  | "bad_timezone";

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) {
    return false;
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOfDay = (time: string): number => {
  const m = TIME.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};

/** Check a cadence the caller sent. Returns the normalised cadence (times sorted, weekdays sorted and unique) or the problem. */
export function normalizeCadence(
  input: unknown,
  tz: unknown,
): { ok: true; cadence: Cadence } | { ok: false; problem: CadenceProblem } {
  if (!isValidTimeZone(tz)) {
    return { ok: false, problem: "bad_timezone" };
  }
  if (typeof input !== "object" || input === null) {
    return { ok: false, problem: "bad_cadence" };
  }
  const raw = input as Record<string, unknown>;
  if (raw.kind === "once") {
    if (!Number.isSafeInteger(raw.at) || (raw.at as number) <= 0) {
      return { ok: false, problem: "bad_once" };
    }
    return { ok: true, cadence: { kind: "once", at: raw.at as number } };
  }
  if (raw.kind === "interval") {
    if (!Number.isSafeInteger(raw.minutes) || (raw.minutes as number) <= 0) {
      return { ok: false, problem: "bad_cadence" };
    }
    if ((raw.minutes as number) < MIN_INTERVAL_MINUTES) {
      return { ok: false, problem: "below_minimum" };
    }
    if (
      raw.anchorAt !== undefined &&
      (!Number.isSafeInteger(raw.anchorAt) || (raw.anchorAt as number) <= 0)
    ) {
      return { ok: false, problem: "bad_anchor" };
    }
    return {
      ok: true,
      cadence: {
        kind: "interval",
        minutes: raw.minutes as number,
        ...(raw.anchorAt !== undefined ? { anchorAt: raw.anchorAt as number } : {}),
      },
    };
  }
  if (raw.kind === "daily") {
    const times = raw.times;
    if (
      !Array.isArray(times) ||
      times.length === 0 ||
      times.length > MAX_DAILY_TIMES ||
      !times.every((t) => typeof t === "string" && TIME.test(t))
    ) {
      return { ok: false, problem: "bad_times" };
    }
    const sorted = [...new Set(times as string[])].toSorted();
    const mins = sorted.map(minutesOfDay);
    // Two times of the day closer than the floor are the same "faster than 15 minutes" check; the day wraps around too.
    for (let i = 0; i < mins.length; i += 1) {
      const next = i + 1 < mins.length ? mins[i + 1]! : mins[0]! + 24 * 60;
      if (sorted.length > 1 && next - mins[i]! < MIN_INTERVAL_MINUTES) {
        return { ok: false, problem: "below_minimum" };
      }
    }
    let weekdays: number[] | undefined;
    if (raw.weekdays !== undefined) {
      const days = raw.weekdays;
      if (
        !Array.isArray(days) ||
        days.length === 0 ||
        !days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
      ) {
        return { ok: false, problem: "bad_weekdays" };
      }
      weekdays = [...new Set(days as number[])].toSorted((a, b) => a - b);
    }
    return {
      ok: true,
      cadence: { kind: "daily", times: sorted, ...(weekdays ? { weekdays } : {}) },
    };
  }
  return { ok: false, problem: "bad_cadence" };
}

type LocalParts = { y: number; mo: number; d: number; h: number; mi: number; wd: number };
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(ms: number, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    y: Number(get("year")),
    mo: Number(get("month")),
    d: Number(get("day")),
    h: Number(get("hour")) % 24,
    mi: Number(get("minute")),
    wd: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** The UTC instant at which the wall clock in `tz` reads the given date and time (a time skipped by a clock change moves forward). */
function localToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const p = localParts(guess, tz);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    const next = guess + (wall - shown);
    if (next === guess) {
      break;
    }
    guess = next;
  }
  return guess;
}

/**
 * The first due time strictly after `after` (UTC ms), or null when there is none (a `once` time already passed). An interval counts
 * from its anchor, so a restart never shifts the beat.
 */
export function nextDueAfter(
  cadence: Cadence,
  tz: string,
  after: number,
  createdAt: number,
): number | null {
  if (cadence.kind === "once") {
    return cadence.at > after ? cadence.at : null;
  }
  if (cadence.kind === "interval") {
    const anchor = cadence.anchorAt ?? createdAt;
    const step = cadence.minutes * 60_000;
    if (after < anchor) {
      return anchor;
    }
    return anchor + (Math.floor((after - anchor) / step) + 1) * step;
  }
  const base = localParts(after, tz);
  let best: number | null = null;
  for (let offset = 0; offset <= 8 && best === null; offset += 1) {
    // Walk calendar days in UTC arithmetic on the local date; the weekday of that local date decides if the day counts.
    const day = new Date(Date.UTC(base.y, base.mo - 1, base.d + offset));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const wd = day.getUTCDay();
    if (cadence.weekdays && !cadence.weekdays.includes(wd)) {
      continue;
    }
    for (const time of cadence.times) {
      const at = localToUtc(
        y,
        mo,
        d,
        Math.floor(minutesOfDay(time) / 60),
        minutesOfDay(time) % 60,
        tz,
      );
      if (at > after && (best === null || at < best)) {
        best = at;
      }
    }
  }
  return best;
}

/** A stable key for one logical due time: the same schedule and the same planned time always give the same key (event replays are idempotent). */
export function occurrenceKey(scheduleId: string, plannedAt: number, shard = 0): string {
  return `${scheduleId}@${plannedAt}#${shard}`;
}
