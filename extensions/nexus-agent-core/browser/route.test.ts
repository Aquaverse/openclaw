import { describe, expect, it } from "vitest";
import { EMPTY_FILTER } from "../src/task-query.js";
import {
  CLEANUP_HOME,
  FILES_HOME,
  NAV_BASE,
  parseRoute,
  routeFromHref,
  routeParams,
  TASKS_HOME,
  WORKS_HOME,
} from "./route.ts";

describe("nexus route", () => {
  it("defaults to the task list and ignores unknown or malformed parameters", () => {
    expect(parseRoute({})).toEqual(TASKS_HOME);
    expect(parseRoute({ view: "nope" })).toEqual(TASKS_HOME);
    expect(parseRoute({ view: "task" })).toEqual(TASKS_HOME);
    expect(parseRoute({ view: "task", task: "../x/y" })).toEqual(TASKS_HOME);
    expect(parseRoute({ view: "files", tab: "nope" })).toEqual(FILES_HOME);
    expect(parseRoute({ view: "goals" })).toEqual({ view: "goals" });
    expect(routeParams({ view: "goals" })).toEqual({ view: "goals" });
    expect(routeParams(FILES_HOME)).toEqual({ view: "files" });
    expect(routeParams({ ...FILES_HOME, tab: "trash" })).toEqual({ view: "files", tab: "trash" });
    expect(parseRoute({ view: "files", qname: "  发票\n", page: "0", size: "7" })).toEqual({
      ...FILES_HOME,
      name: "发票",
    });
  });

  it("round-trips every route through the host page parameters", () => {
    for (const route of [
      TASKS_HOME,
      {
        view: "tasks",
        filter: { ...EMPTY_FILTER, keyword: "发票 2026", status: "open", page: 3, size: 50 },
      },
      {
        view: "tasks",
        filter: { ...EMPTY_FILTER, from: "2026-10-01T08:30", to: "2026-10-15T18:45" },
      },
      { view: "task", taskId: "T1ABC" },
      { view: "preferences" },
      { view: "receipts" },
      { view: "goals" },
      FILES_HOME,
      { ...FILES_HOME, tab: "trash" },
      {
        view: "files",
        tab: "inbox",
        name: "合同 2026",
        kind: "pdf",
        favorite: true,
        sensitivity: "normal",
        page: 3,
        size: 50,
      },
    ] as const) {
      expect(parseRoute(routeParams(route))).toEqual(route);
    }
  });

  it("keeps the list filter in the host parameters, and only the non-default parts", () => {
    expect(routeParams(TASKS_HOME)).toEqual({});
    expect(
      routeParams({ view: "tasks", filter: { ...EMPTY_FILTER, id: "T4", page: 2, size: 50 } }),
    ).toEqual({ qid: "T4", page: "2", size: "50" });
    // Malformed values fall back to the defaults instead of reaching an RPC.
    expect(parseRoute({ status: "x", page: "0", size: "999", from: "2026-13-40" })).toEqual(
      TASKS_HOME,
    );
  });

  it("reads the filter from a list link's query", () => {
    expect(routeFromHref(`${NAV_BASE}/?qkw=%E5%8F%91%E7%A5%A8&page=2`)).toEqual({
      view: "tasks",
      filter: { ...EMPTY_FILTER, keyword: "发票", page: 2 },
    });
    expect(routeFromHref(`${NAV_BASE}/?page=zzz`)).toEqual(TASKS_HOME);
    // A query belongs to the list only.
    expect(routeFromHref(`${NAV_BASE}/tasks/T1ABC?page=2`)).toEqual({
      view: "task",
      taskId: "T1ABC",
    });
  });

  it("maps only placeholder links to routes", () => {
    expect(routeFromHref(`${NAV_BASE}/`)).toEqual(TASKS_HOME);
    expect(routeFromHref(`${NAV_BASE}/tasks/T1ABC`)).toEqual({ view: "task", taskId: "T1ABC" });
    expect(routeFromHref(`${NAV_BASE}/preferences`)).toEqual({ view: "preferences" });
    expect(routeFromHref(`${NAV_BASE}/receipts`)).toEqual({ view: "receipts" });
    expect(routeFromHref(`${NAV_BASE}/files`)).toEqual(FILES_HOME);
    expect(routeFromHref(`${NAV_BASE}/files?tab=inbox`)).toEqual({ ...FILES_HOME, tab: "inbox" });
    expect(routeFromHref(`${NAV_BASE}/files?tab=../x`)).toEqual(FILES_HOME);
    expect(
      routeFromHref(
        `${NAV_BASE}/files?tab=vault&qname=a%20b&qkind=image&qfav=1&qsens=sensitive&page=2&size=50`,
      ),
    ).toEqual({
      view: "files",
      tab: "vault",
      name: "a b",
      kind: "image",
      favorite: true,
      sensitivity: "sensitive",
      page: 2,
      size: 50,
    });
    expect(routeFromHref(`${NAV_BASE}/files?qkind=exe&qfav=yes&qsens=all`)).toEqual(FILES_HOME);
    expect(routeFromHref(`${NAV_BASE}/files/F1`)).toBeUndefined();
    expect(routeFromHref(`${NAV_BASE}/tasks/a/b`)).toBeUndefined();
    expect(routeFromHref(`${NAV_BASE}/tasks/a b`)).toBeUndefined();
    expect(routeFromHref(`${NAV_BASE}/admin`)).toBeUndefined();
    expect(routeFromHref("https://evil.example/")).toBeUndefined();
    expect(routeFromHref("javascript:alert(1)")).toBeUndefined();
    expect(routeFromHref("/plugins/nexus-agent-core/ui/")).toBeUndefined();
  });
});

describe("nexus work routes", () => {
  it("parses the work page, the selected work and the filter; unknown values are dropped", () => {
    expect(parseRoute({ view: "works" })).toEqual({ view: "works" });
    expect(parseRoute({ view: "works", state: "needs_you", q: "  机票 " })).toEqual({
      view: "works",
      state: "needs_you",
      q: "机票",
    });
    expect(parseRoute({ view: "works", state: "running" })).toEqual({ view: "works" });
    expect(parseRoute({ view: "work", work: "w_T1", state: "done" })).toEqual({
      view: "work",
      workId: "w_T1",
      state: "done",
    });
    // A malformed id is not a selection: the page falls back to the list.
    expect(parseRoute({ view: "work", work: "../x" })).toEqual({ view: "works" });
    expect(parseRoute({ view: "work" })).toEqual({ view: "works" });
  });

  it("round-trips through the host parameters and the placeholder links", () => {
    for (const route of [
      WORKS_HOME,
      { view: "works", state: "blocked", q: "报价" },
      { view: "work", workId: "w_T1" },
      { view: "work", workId: "w_T1", state: "in_progress", q: "x y" },
    ] as const) {
      expect(parseRoute(routeParams(route))).toEqual(route);
    }
    expect(routeParams({ view: "work", workId: "w_T1", state: "done" })).toEqual({
      view: "work",
      work: "w_T1",
      state: "done",
    });
    expect(routeFromHref(`${NAV_BASE}/works`)).toEqual({ view: "works" });
    expect(routeFromHref(`${NAV_BASE}/works?state=done&q=a%20b`)).toEqual({
      view: "works",
      state: "done",
      q: "a b",
    });
    expect(routeFromHref(`${NAV_BASE}/works/w_T1?state=needs_you`)).toEqual({
      view: "work",
      workId: "w_T1",
      state: "needs_you",
    });
    expect(routeFromHref(`${NAV_BASE}/works/..%2Fx`)).toBeUndefined();
    expect(routeFromHref(`${NAV_BASE}/works/a/b`)).toBeUndefined();
  });
  it("opens the rail pages that only show their design, and drops an unknown one", () => {
    for (const hub of ["goals", "library", "status"] as const) {
      expect(routeParams({ view: "hub", hub })).toEqual({ view: "hub", hub });
      expect(parseRoute({ view: "hub", hub })).toEqual({ view: "hub", hub });
    }
    expect(parseRoute({ view: "hub", hub: "nowhere" })).toEqual(TASKS_HOME);
    expect(parseRoute({ view: "hub" })).toEqual(TASKS_HOME);
    // A renderer link never reaches them: they have no data to link to.
    expect(routeFromHref(`${NAV_BASE}/hub`)).toBeUndefined();
  });

  it("opens the People page with a segment, a person and a tab, and drops what it does not know", () => {
    expect(parseRoute({ view: "people" })).toEqual({ view: "people" });
    expect(routeParams({ view: "people" })).toEqual({ view: "people" });
    // The old design link still lands on the real page.
    expect(parseRoute({ view: "hub", hub: "people" })).toEqual({ view: "people" });
    const route = { view: "people", personId: "cp_AB12", seg: "pending", tab: "history" } as const;
    expect(routeParams(route)).toEqual({
      view: "people",
      person: "cp_AB12",
      seg: "pending",
      tab: "history",
    });
    expect(
      parseRoute({ view: "people", person: "cp_AB12", seg: "pending", tab: "history" }),
    ).toEqual(route);
    expect(parseRoute({ view: "people", person: "../x", seg: "nope", tab: "nope" })).toEqual({
      view: "people",
    });
  });

  it("carries the People name search in the address, trimmed and bounded", () => {
    expect(parseRoute({ view: "people", q: "  钱经理 " })).toEqual({ view: "people", q: "钱经理" });
    expect(parseRoute({ view: "people", q: "   " })).toEqual({ view: "people" });
    expect(parseRoute({ view: "people", q: "x".repeat(300) })).toEqual({
      view: "people",
      q: "x".repeat(100),
    });
    expect(routeParams({ view: "people", seg: "attention", q: "钱" })).toEqual({
      view: "people",
      seg: "attention",
      q: "钱",
    });
    expect(routeFromHref(`${NAV_BASE}/people/cp_AB12?q=%E9%92%B1&seg=inactive`)).toEqual({
      view: "people",
      personId: "cp_AB12",
      q: "钱",
    });
  });

  it("carries the typed name chosen on the to-confirm segment, and only there", () => {
    const route = { view: "people", seg: "pending", typed: "钱经理和孙工一起", q: "钱" } as const;
    expect(routeParams(route)).toEqual({
      view: "people",
      seg: "pending",
      q: "钱",
      typed: "钱经理和孙工一起",
    });
    expect(
      parseRoute({ view: "people", seg: "pending", q: "钱", typed: "钱经理和孙工一起" }),
    ).toEqual(route);
    // a typed name means nothing on the other segments, and is bounded
    expect(parseRoute({ view: "people", seg: "attention", typed: "钱" })).toEqual({
      view: "people",
      seg: "attention",
    });
    expect(parseRoute({ view: "people", seg: "pending", typed: "x".repeat(300) })).toEqual({
      view: "people",
      seg: "pending",
      typed: "x".repeat(100),
    });
    expect(routeFromHref(`${NAV_BASE}/people?seg=pending&typed=%E8%80%81%E8%B5%B5`)).toEqual({
      view: "people",
      seg: "pending",
      typed: "老赵",
    });
  });

  it("maps people links to routes and refuses a path that is not an id", () => {
    expect(routeFromHref(`${NAV_BASE}/people`)).toEqual({ view: "people" });
    expect(routeFromHref(`${NAV_BASE}/people?seg=pending`)).toEqual({
      view: "people",
      seg: "pending",
    });
    expect(routeFromHref(`${NAV_BASE}/people/cp_AB12?seg=attention&tab=related`)).toEqual({
      view: "people",
      personId: "cp_AB12",
      seg: "attention",
      tab: "related",
    });
    expect(routeFromHref(`${NAV_BASE}/people/..%2Fx`)).toBeUndefined();
    expect(routeFromHref(`${NAV_BASE}/people/a/b`)).toBeUndefined();
  });

  it("keeps the clear-people page's search, page and size in the address, with 50 to a page unless chosen", () => {
    expect(parseRoute({ view: "cleanup" })).toEqual(CLEANUP_HOME);
    expect(CLEANUP_HOME).toEqual({ view: "cleanup", page: 1, size: 50 });
    expect(routeParams(CLEANUP_HOME)).toEqual({ view: "cleanup" });
    expect(parseRoute({ view: "cleanup", q: "  钱\n", page: "3", size: "100" })).toEqual({
      view: "cleanup",
      q: "钱",
      page: 3,
      size: 100,
    });
    // nonsense falls back to the defaults
    expect(parseRoute({ view: "cleanup", page: "0", size: "7" })).toEqual(CLEANUP_HOME);
    expect(parseRoute({ view: "cleanup", page: "abc", size: "x" })).toEqual(CLEANUP_HOME);
    expect(routeParams({ view: "cleanup", q: "钱", page: 3, size: 20 })).toEqual({
      view: "cleanup",
      q: "钱",
      page: "3",
      size: "20",
    });
    expect(routeParams({ view: "cleanup", page: 1, size: 50 })).toEqual({ view: "cleanup" });
    expect(routeFromHref(`${NAV_BASE}/cleanup?page=2&size=20`)).toEqual({
      view: "cleanup",
      page: 2,
      size: 20,
    });
    expect(routeFromHref(`${NAV_BASE}/cleanup/x`)).toBeUndefined();
  });
});
