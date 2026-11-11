// Cadence rules (design 4.5.2): the 15-minute floor is a rejection, time zones decide the wall clock, an interval keeps its beat.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { nextDueAfter, normalizeCadence, occurrenceKey, type Cadence } from "./cadence.js";

const ok = (input: unknown, tz = "Asia/Shanghai"): Cadence => {
  const out = normalizeCadence(input, tz);
  if (!out.ok) {
    throw new Error(JSON.stringify(out));
  }
  return out.cadence;
};
const bad = (input: unknown, tz = "Asia/Shanghai") => {
  const out = normalizeCadence(input, tz);
  assert.equal(out.ok, false);
  return out.ok ? "" : out.problem;
};

describe("normalizeCadence", () => {
  it("rejects intervals under 15 minutes instead of raising them", () => {
    assert.equal(bad({ kind: "interval", minutes: 14 }), "below_minimum");
    assert.equal(bad({ kind: "interval", minutes: 1 }), "below_minimum");
    assert.deepEqual(ok({ kind: "interval", minutes: 15 }), { kind: "interval", minutes: 15 });
  });
  it("rejects daily times closer than 15 minutes, including across midnight", () => {
    assert.equal(bad({ kind: "daily", times: ["09:00", "09:10"] }), "below_minimum");
    assert.equal(bad({ kind: "daily", times: ["23:55", "00:05"] }), "below_minimum");
    assert.deepEqual(ok({ kind: "daily", times: ["18:00", "09:00", "09:00"] }), {
      kind: "daily",
      times: ["09:00", "18:00"],
    });
  });
  it("checks the shape, the weekdays and the time zone", () => {
    assert.equal(bad({ kind: "daily", times: ["9:00"] }), "bad_times");
    assert.equal(bad({ kind: "daily", times: [] }), "bad_times");
    assert.equal(bad({ kind: "daily", times: ["09:00"], weekdays: [7] }), "bad_weekdays");
    assert.equal(bad({ kind: "once", at: -1 }), "bad_once");
    assert.equal(bad({ kind: "hourly" }), "bad_cadence");
    assert.equal(bad(null), "bad_cadence");
    assert.equal(bad({ kind: "interval", minutes: 30 }, "Mars/Base"), "bad_timezone");
  });
});

describe("nextDueAfter", () => {
  it("once is due only while it lies ahead", () => {
    const c = ok({ kind: "once", at: 5000 });
    assert.equal(nextDueAfter(c, "UTC", 4000, 0), 5000);
    assert.equal(nextDueAfter(c, "UTC", 5000, 0), null);
  });
  it("an interval keeps its beat from the anchor", () => {
    const c = ok({ kind: "interval", minutes: 30, anchorAt: 1_000_000 });
    assert.equal(nextDueAfter(c, "UTC", 500_000, 0), 1_000_000);
    assert.equal(nextDueAfter(c, "UTC", 1_000_000, 0), 1_000_000 + 30 * 60_000);
    assert.equal(nextDueAfter(c, "UTC", 1_000_000 + 31 * 60_000, 0), 1_000_000 + 60 * 60_000);
  });
  it("daily reads the wall clock of its own zone", () => {
    const c = ok({ kind: "daily", times: ["09:00"] });
    // 2026-11-10 00:30 UTC is 08:30 in Shanghai (UTC+8): the next 09:00 there is the same day, 01:00 UTC.
    const after = Date.UTC(2026, 10, 10, 0, 30);
    assert.equal(nextDueAfter(c, "Asia/Shanghai", after, 0), Date.UTC(2026, 10, 10, 1, 0));
    // The same instant is 19:30 the day before in New York (UTC-5): the next 09:00 there is 14:00 UTC the same UTC day.
    assert.equal(nextDueAfter(c, "America/New_York", after, 0), Date.UTC(2026, 10, 10, 14, 0));
  });
  it("daily follows the clock change of the zone", () => {
    const c = ok({ kind: "daily", times: ["09:00"] });
    // New York leaves summer time on 2026-11-01: before it 09:00 is UTC-4 (13:00 UTC), after it UTC-5 (14:00 UTC).
    const before = Date.UTC(2026, 10, 1, 0, 0);
    assert.equal(nextDueAfter(c, "America/New_York", before, 0), Date.UTC(2026, 10, 1, 14, 0));
    assert.equal(
      nextDueAfter(c, "America/New_York", Date.UTC(2026, 9, 31, 12, 0), 0),
      Date.UTC(2026, 9, 31, 13, 0),
    );
  });
  it("daily honours weekdays", () => {
    // 2026-11-10 is a Tuesday. Mondays only: the next is 2026-11-16.
    const c = ok({ kind: "daily", times: ["09:00"], weekdays: [1] });
    assert.equal(
      nextDueAfter(c, "UTC", Date.UTC(2026, 10, 10, 12, 0), 0),
      Date.UTC(2026, 10, 16, 9, 0),
    );
  });
});

describe("occurrenceKey", () => {
  it("is stable for the same schedule and time", () => {
    assert.equal(occurrenceKey("s1", 100), occurrenceKey("s1", 100));
    assert.notEqual(occurrenceKey("s1", 100), occurrenceKey("s1", 101));
  });
});
