import { describe, expect, it } from "vitest";
import { NAV_BASE, parseRoute, routeFromHref, routeParams } from "./route.ts";

describe("nexus route", () => {
  it("defaults to the task list and ignores unknown or malformed parameters", () => {
    expect(parseRoute({})).toEqual({ view: "tasks" });
    expect(parseRoute({ view: "nope" })).toEqual({ view: "tasks" });
    expect(parseRoute({ view: "task" })).toEqual({ view: "tasks" });
    expect(parseRoute({ view: "task", task: "../x/y" })).toEqual({ view: "tasks" });
  });

  it("round-trips every route through the host page parameters", () => {
    for (const route of [
      { view: "tasks" },
      { view: "task", taskId: "T1ABC" },
      { view: "preferences" },
      { view: "receipts" },
    ] as const) {
      expect(parseRoute(routeParams(route))).toEqual(route);
    }
  });

  it("maps only placeholder links to routes", () => {
    expect(routeFromHref(`${NAV_BASE}/`)).toEqual({ view: "tasks" });
    expect(routeFromHref(`${NAV_BASE}/tasks/T1ABC`)).toEqual({ view: "task", taskId: "T1ABC" });
    expect(routeFromHref(`${NAV_BASE}/preferences`)).toEqual({ view: "preferences" });
    expect(routeFromHref(`${NAV_BASE}/receipts`)).toEqual({ view: "receipts" });
    expect(routeFromHref(`${NAV_BASE}/tasks/a/b`)).toBeUndefined();
    expect(routeFromHref(`${NAV_BASE}/tasks/a b`)).toBeUndefined();
    expect(routeFromHref(`${NAV_BASE}/admin`)).toBeUndefined();
    expect(routeFromHref("https://evil.example/")).toBeUndefined();
    expect(routeFromHref("javascript:alert(1)")).toBeUndefined();
    expect(routeFromHref("/plugins/nexus-agent-core/ui/")).toBeUndefined();
  });
});
