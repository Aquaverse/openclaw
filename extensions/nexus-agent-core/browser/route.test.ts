import { describe, expect, it } from "vitest";
import { EMPTY_FILTER } from "../src/task-query.js";
import { NAV_BASE, parseRoute, routeFromHref, routeParams, TASKS_HOME } from "./route.ts";

describe("nexus route", () => {
  it("defaults to the task list and ignores unknown or malformed parameters", () => {
    expect(parseRoute({})).toEqual(TASKS_HOME);
    expect(parseRoute({ view: "nope" })).toEqual(TASKS_HOME);
    expect(parseRoute({ view: "task" })).toEqual(TASKS_HOME);
    expect(parseRoute({ view: "task", task: "../x/y" })).toEqual(TASKS_HOME);
    expect(parseRoute({ view: "files", tab: "nope" })).toEqual({ view: "files", tab: "all" });
    expect(routeParams({ view: "files", tab: "all" })).toEqual({ view: "files" });
    expect(routeParams({ view: "files", tab: "trash" })).toEqual({ view: "files", tab: "trash" });
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
      { view: "files", tab: "all" },
      { view: "files", tab: "trash" },
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
    expect(routeFromHref(`${NAV_BASE}/files`)).toEqual({ view: "files", tab: "all" });
    expect(routeFromHref(`${NAV_BASE}/files?tab=inbox`)).toEqual({ view: "files", tab: "inbox" });
    expect(routeFromHref(`${NAV_BASE}/files?tab=../x`)).toEqual({ view: "files", tab: "all" });
    expect(routeFromHref(`${NAV_BASE}/files/F1`)).toBeUndefined();
    expect(routeFromHref(`${NAV_BASE}/tasks/a/b`)).toBeUndefined();
    expect(routeFromHref(`${NAV_BASE}/tasks/a b`)).toBeUndefined();
    expect(routeFromHref(`${NAV_BASE}/admin`)).toBeUndefined();
    expect(routeFromHref("https://evil.example/")).toBeUndefined();
    expect(routeFromHref("javascript:alert(1)")).toBeUndefined();
    expect(routeFromHref("/plugins/nexus-agent-core/ui/")).toBeUndefined();
  });
});
