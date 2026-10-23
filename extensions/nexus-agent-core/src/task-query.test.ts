// The Task list query: the SQL filters and paging in the store kernel, and the pure filter helpers both pages share.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { applyMigrations, createTaskKernel } from "./store/kernel.js";
import type { Principal } from "./store/types.js";
import {
  DEFAULT_PAGE_SIZE,
  EMPTY_FILTER,
  FILTER_FIELDS,
  filterFieldValue,
  filterIsActive,
  hasInvalidTime,
  filterToParams,
  filterToQuery,
  filterToRpc,
  pageInfo,
  pageWindow,
  parseTaskFilter,
  presetRange,
} from "./task-query.js";
import { fmtTime, tzLabel } from "./ui-render.js";

describe("task list query (store)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const tx = <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  applyMigrations(db, tx);
  const k = createTaskKernel(db, tx);
  const P: Principal = { ownerId: "local" };
  const Q: Principal = { ownerId: "other" };
  const DAY = 86_400_000;
  const BASE = Date.UTC(2026, 9, 1);

  const make = (
    principal: Principal,
    id: string,
    title: string,
    goal: unknown,
    now: number,
    entities: unknown = null,
  ) =>
    k.create({
      principal,
      id,
      kind: "flight",
      title,
      goal,
      entities,
      idempotencyKey: `op_${id}`,
      fingerprint: `fp_${id}`,
      sessionKey: "s",
      now,
    });

  // T1..T7, one per day; T7 is the newest.
  make(P, "T1ALPHA", "订东京机票", { dest: "tokyo" }, BASE, { pax: 2 });
  make(P, "T2BRAVO", "订大阪酒店", { dest: "osaka" }, BASE + DAY);
  make(P, "T3CHARLIE", "100% 完成的报告", { note: "a_b" }, BASE + 2 * DAY);
  make(P, "T4DELTA", "订东京酒店", { dest: "tokyo", nights: 3 }, BASE + 3 * DAY);
  make(P, "T5ECHO", "改签", { dest: "kyoto" }, BASE + 4 * DAY, { passenger: "Marvin" });
  make(P, "T6FOXTROT", "退票", { dest: "tokyo" }, BASE + 5 * DAY);
  make(P, "T7GOLF", "查天气", { dest: "paris" }, BASE + 6 * DAY);
  make(Q, "T8OTHER", "订东京机票", { dest: "tokyo" }, BASE);
  db.prepare(
    "UPDATE nexus_tasks SET status = 'succeeded' WHERE id IN ('T6FOXTROT','T7GOLF')",
  ).run();
  db.prepare("UPDATE nexus_tasks SET summary = '已改到周五' WHERE id = 'T5ECHO'").run();
  db.prepare(
    "UPDATE nexus_tasks SET status = 'deleted', deleted_at = 1 WHERE id = 'T2BRAVO'",
  ).run();

  const ids = (input: Partial<Parameters<typeof k.queryTasks>[0]> = {}) =>
    k
      .queryTasks({ principal: P, includeClosed: true, limit: 50, offset: 0, ...input })
      .tasks.map((task) => task.id);
  // Newest activity first. T2BRAVO is soft-deleted and never listed.
  const ALL = ["T7GOLF", "T6FOXTROT", "T5ECHO", "T4DELTA", "T3CHARLIE", "T1ALPHA"];

  it("returns the total with each page and pages in a stable order", () => {
    const first = k.queryTasks({ principal: P, includeClosed: true, limit: 4, offset: 0 });
    assert.equal(first.total, 6);
    assert.deepEqual(
      first.tasks.map((task) => task.id),
      ALL.slice(0, 4),
    );
    const second = k.queryTasks({ principal: P, includeClosed: true, limit: 4, offset: 4 });
    assert.equal(second.total, 6);
    assert.deepEqual(
      second.tasks.map((task) => task.id),
      ALL.slice(4),
    );
    const beyond = k.queryTasks({ principal: P, includeClosed: true, limit: 4, offset: 40 });
    assert.deepEqual(beyond, { tasks: [], total: 6 });
  });

  it("agrees with the older list on an unfiltered query", () => {
    assert.deepEqual(
      ids(),
      k.list({ principal: P, includeClosed: true, limit: 50 }).map((task) => task.id),
    );
  });

  it("filters by status", () => {
    assert.deepEqual(ids({ includeClosed: false }), ["T5ECHO", "T4DELTA", "T3CHARLIE", "T1ALPHA"]);
    assert.deepEqual(ids({ statuses: ["succeeded"] }), ["T7GOLF", "T6FOXTROT"]);
    assert.equal(
      k.queryTasks({
        principal: P,
        statuses: ["succeeded"],
        includeClosed: true,
        limit: 1,
        offset: 0,
      }).total,
      2,
    );
  });

  it("matches ids and titles by containment, ignoring ASCII case", () => {
    assert.deepEqual(ids({ idQuery: "t4" }), ["T4DELTA"]);
    assert.deepEqual(ids({ idQuery: "ELT" }), ["T4DELTA"]);
    assert.deepEqual(ids({ titleQuery: "东京" }), ["T4DELTA", "T1ALPHA"]);
    assert.deepEqual(ids({ titleQuery: "  东京  " }), ["T4DELTA", "T1ALPHA"]);
    assert.deepEqual(ids({ idQuery: "nope" }), []);
  });

  it("treats LIKE wildcards in a query as plain characters", () => {
    assert.deepEqual(ids({ titleQuery: "%" }), ["T3CHARLIE"]);
    assert.deepEqual(ids({ keyword: "a_b" }), ["T3CHARLIE"]);
    assert.deepEqual(ids({ keyword: "_" }), ["T3CHARLIE"]);
    assert.deepEqual(ids({ idQuery: "T_ALPHA" }), []);
    assert.deepEqual(ids({ keyword: "\\" }), []);
  });

  it("searches keywords across title, goal, summary and entities; every term must match", () => {
    assert.deepEqual(ids({ keyword: "tokyo" }), ["T6FOXTROT", "T4DELTA", "T1ALPHA"]);
    assert.deepEqual(ids({ keyword: "东京 tokyo" }), ["T4DELTA", "T1ALPHA"]);
    assert.deepEqual(ids({ keyword: "周五" }), ["T5ECHO"]);
    assert.deepEqual(ids({ keyword: "marvin" }), ["T5ECHO"]);
    assert.deepEqual(ids({ keyword: "tokyo osaka" }), []);
    assert.deepEqual(ids({ keyword: "   " }), ids());
  });

  it("filters by creation time: from is inclusive, to is exclusive", () => {
    assert.deepEqual(ids({ createdFrom: BASE + 4 * DAY }), ["T7GOLF", "T6FOXTROT", "T5ECHO"]);
    assert.deepEqual(ids({ createdTo: BASE + 2 * DAY }), ["T1ALPHA"]);
    assert.deepEqual(ids({ createdFrom: BASE + 3 * DAY, createdTo: BASE + 5 * DAY }), [
      "T5ECHO",
      "T4DELTA",
    ]);
  });

  it("combines every filter and keeps the total in step with them", () => {
    const result = k.queryTasks({
      principal: P,
      includeClosed: true,
      limit: 1,
      offset: 0,
      keyword: "tokyo",
      createdFrom: BASE + 2 * DAY,
      statuses: ["clarifying"],
    });
    assert.equal(result.total, 1);
    assert.deepEqual(
      result.tasks.map((task) => task.id),
      ["T4DELTA"],
    );
  });

  it("never crosses owners", () => {
    assert.deepEqual(
      k
        .queryTasks({ principal: Q, includeClosed: true, limit: 50, offset: 0, keyword: "tokyo" })
        .tasks.map((task) => task.id),
      ["T8OTHER"],
    );
    assert.equal(
      k.queryTasks({ principal: Q, includeClosed: true, limit: 50, offset: 0 }).total,
      1,
    );
  });
});

describe("task filter helpers", () => {
  it("defaults every field and ignores junk", () => {
    assert.deepEqual(
      parseTaskFilter(() => undefined),
      EMPTY_FILTER,
    );
    const junk = parseTaskFilter(
      (name) =>
        ({
          status: "bogus",
          from: "2026-02-30T10:00",
          to: "2026-10-15T25:00",
          page: "-3",
          size: "7",
          qid: "x".repeat(300),
        })[name],
    );
    assert.equal(junk.status, "");
    assert.equal(junk.from, "");
    assert.equal(junk.to, "");
    assert.equal(parseTaskFilter((n) => ({ to: "tomorrow" })[n]).to, "");
    assert.equal(junk.page, 1);
    assert.equal(junk.size, DEFAULT_PAGE_SIZE);
    assert.equal(junk.id.length, 64);
  });

  it("round-trips through parameters and keeps the plain list URL plain", () => {
    assert.equal(filterToQuery(EMPTY_FILTER), "");
    assert.equal(filterIsActive(EMPTY_FILTER), false);
    assert.equal(filterIsActive({ ...EMPTY_FILTER, page: 3, size: 50 }), false);
    const filter = {
      id: "T4",
      title: "东京",
      keyword: "a b",
      status: "open",
      from: "2026-10-01T08:30",
      to: "2026-10-15T18:45",
      page: 2,
      size: 50,
    };
    assert.equal(filterIsActive(filter), true);
    const params = filterToParams(filter);
    assert.deepEqual(
      parseTaskFilter((name) => params[name]),
      filter,
    );
    const query = new URLSearchParams(filterToQuery(filter));
    assert.deepEqual(
      parseTaskFilter((name) => query.get(name) ?? undefined),
      filter,
    );
  });

  it("maps a filter to the list RPC", () => {
    assert.deepEqual(filterToRpc(EMPTY_FILTER), { includeClosed: true, limit: 20, offset: 0 });
    assert.deepEqual(filterToRpc({ ...EMPTY_FILTER, status: "open", page: 3, size: 50 }), {
      includeClosed: false,
      limit: 50,
      offset: 100,
    });
    assert.deepEqual(filterToRpc({ ...EMPTY_FILTER, status: "closed" }).statuses, [
      "succeeded",
      "failed",
      "cancelled",
    ]);
    assert.deepEqual(filterToRpc({ ...EMPTY_FILTER, status: "planning" }).statuses, ["planning"]);
    const rpc = filterToRpc({
      ...EMPTY_FILTER,
      id: "T4",
      title: "东京",
      keyword: "x",
      from: "2026-10-01T08:30",
      to: "2026-10-15T18:45",
    });
    assert.equal(rpc.id, "T4");
    assert.equal(rpc.title, "东京");
    assert.equal(rpc.keyword, "x");
    // The controls hold local time; the database gets epoch milliseconds for that local moment.
    assert.equal(rpc.createdFrom, new Date(2026, 9, 1, 8, 30).getTime());
    // "to" includes its whole minute: the bound is exclusive, at the start of the next one.
    assert.equal(rpc.createdTo, new Date(2026, 9, 15, 18, 46).getTime());
    // A bare date (an older link) means the whole day.
    const day = filterToRpc({ ...EMPTY_FILTER, from: "2026-10-01", to: "2026-10-15" });
    assert.equal(day.createdFrom, new Date(2026, 9, 1).getTime());
    assert.equal(day.createdTo, new Date(2026, 9, 16).getTime());
    assert.equal(
      parseTaskFilter((n) => ({ from: "2026-10-01", to: "2026-10-15" })[n]).to,
      "2026-10-15T23:59",
    );
  });

  it("computes preset ranges in local dates", () => {
    const now = new Date(2026, 9, 15, 13, 30);
    assert.deepEqual(presetRange(now, "today"), {
      from: "2026-10-15T00:00",
      to: "2026-10-15T23:59",
    });
    assert.deepEqual(presetRange(now, "7d"), { from: "2026-10-09T00:00", to: "2026-10-15T23:59" });
    assert.deepEqual(presetRange(now, "30d"), { from: "2026-09-16T00:00", to: "2026-10-15T23:59" });
  });

  it("pages: counts, clamps and windows", () => {
    assert.deepEqual(pageInfo({ ...EMPTY_FILTER, page: 1 }, 0), {
      page: 1,
      pages: 1,
      first: 0,
      last: 0,
    });
    assert.deepEqual(pageInfo({ ...EMPTY_FILTER, page: 2 }, 45), {
      page: 2,
      pages: 3,
      first: 21,
      last: 40,
    });
    assert.deepEqual(pageInfo({ ...EMPTY_FILTER, page: 9 }, 45), {
      page: 3,
      pages: 3,
      first: 41,
      last: 45,
    });
    assert.deepEqual(pageWindow(1, 1), [1]);
    assert.deepEqual(pageWindow(1, 3), [1, 2, 3]);
    assert.deepEqual(pageWindow(10, 20), [1, null, 8, 9, 10, 11, 12, null, 20]);
    assert.deepEqual(pageWindow(3, 20), [1, 2, 3, 4, 5, null, 20]);
  });
});

describe("local time", () => {
  // Zone-independent on purpose: the expected values are built from the same machine's local calendar, so the tests hold
  // wherever they run (vitest workers cannot switch TZ at run time).
  const two = (n: number) => String(n).padStart(2, "0");
  const local = (d: Date) =>
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  const NOON_UTC = Date.UTC(2026, 9, 15, 12, 5, 9);

  it("shows times in the local zone, labelled by its offset", () => {
    assert.equal(fmtTime(NOON_UTC), local(new Date(NOON_UTC)));
    assert.ok(!fmtTime(NOON_UTC).endsWith("Z"));
    const label = tzLabel(new Date(NOON_UTC));
    assert.match(label, /^UTC[+-]\d{2}:\d{2}$/);
    const minutes = -new Date(NOON_UTC).getTimezoneOffset();
    const abs = Math.abs(minutes);
    assert.equal(
      label,
      `UTC${minutes < 0 ? "-" : "+"}${two(Math.floor(abs / 60))}:${two(abs % 60)}`,
    );
    assert.equal(fmtTime(null), "-");
    assert.equal(fmtTime(Number.NaN), "-");
  });

  it("turns local search times into the database's epoch milliseconds", () => {
    const rpc = filterToRpc({ ...EMPTY_FILTER, from: "2026-10-15T08:00", to: "2026-10-15T20:05" });
    assert.equal(rpc.createdFrom, new Date(2026, 9, 15, 8, 0).getTime());
    // Through the end of the 20:05 minute.
    assert.equal(rpc.createdTo, new Date(2026, 9, 15, 20, 5).getTime() + 60_000);
    // What the search sends back out is the same local moment the list displays.
    assert.ok(fmtTime(rpc.createdFrom).startsWith("2026-10-15 08:00:00"));
    assert.ok(fmtTime((rpc.createdTo ?? 0) - 1).startsWith("2026-10-15 20:05:59"));
  });

  it("rejects local times that do not exist or are out of range", () => {
    assert.equal(parseTaskFilter((n) => ({ from: "2026-10-15T24:00" })[n]).from, "");
    assert.equal(parseTaskFilter((n) => ({ from: "2026-10-15T10:60" })[n]).from, "");
    assert.equal(parseTaskFilter((n) => ({ from: "2026/10/15 10:00" })[n]).from, "");
    assert.equal(parseTaskFilter((n) => ({ from: "2026-10-15  10:00" })[n]).from, "");
    assert.equal(parseTaskFilter((n) => ({ from: "2026年10月15日" })[n]).from, "");
    assert.equal(parseTaskFilter((n) => ({ from: "2026-02-30T10:00" })[n]).from, "");
    // Only in zones with a spring-forward gap on that date: the skipped 02:30 is not a real moment.
    const gap = new Date(2026, 2, 8, 2, 30);
    const skipped = gap.getHours() !== 2;
    assert.equal(
      parseTaskFilter((n) => ({ from: "2026-03-08T02:30" })[n]).from,
      skipped ? "" : "2026-03-08T02:30",
    );
  });
});

describe("typed time boxes", () => {
  it("accepts a space or a T between date and time, and stores one canonical form", () => {
    for (const typed of ["2026-10-15 08:30", "2026-10-15T08:30"]) {
      const filter = parseTaskFilter((n) => ({ from: typed })[n]);
      assert.equal(filter.from, "2026-10-15T08:30");
      // The control shows the readable form, with a space.
      assert.equal(filterFieldValue(filter, "from"), "2026-10-15 08:30");
    }
    assert.equal(filterFieldValue(EMPTY_FILTER, "from"), "");
    assert.equal(filterFieldValue({ ...EMPTY_FILTER, id: "T1T2" }, "id"), "T1T2");
  });

  it("uses plain text boxes for the times, so the browser's own date format never shows", () => {
    for (const key of ["from", "to"] as const) {
      const field = FILTER_FIELDS.find((f) => f.key === key);
      assert.equal(field?.kind, "text");
      assert.equal(field?.placeholder, "f.date.ph");
    }
  });

  it("tells a typo from an empty box", () => {
    const read = (values: Record<string, string>) => (name: string) => values[name];
    assert.equal(hasInvalidTime(read({})), false);
    assert.equal(hasInvalidTime(read({ from: "", to: "  " })), false);
    assert.equal(hasInvalidTime(read({ from: "2026-10-15", to: "2026-10-16 09:00" })), false);
    assert.equal(hasInvalidTime(read({ from: "2026年10月15日" })), true);
    assert.equal(hasInvalidTime(read({ to: "2026-02-30" })), true);
    assert.equal(hasInvalidTime(read({ from: "2026-10-15", to: "soon" })), true);
  });
});
