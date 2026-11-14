import { describe, expect, it } from "vitest";
import type { ShellRouteState } from "./app-host-route-state.ts";
import { pluginRouteFoldsNavigation } from "./plugin-nav-fold.ts";

function route(routeId: ShellRouteState["routeId"], search = ""): ShellRouteState {
  return { routeId, location: { search, pathname: "/" } as never };
}

describe("pluginRouteFoldsNavigation", () => {
  it("folds the session list on the Nexus plugin pages", () => {
    expect(
      pluginRouteFoldsNavigation(route("plugin", "?plugin=nexus-agent-core&id=work"), ""),
    ).toBe(true);
  });

  it("leaves other plugins and other routes alone", () => {
    expect(pluginRouteFoldsNavigation(route("plugin", "?plugin=logbook&id=main"), "")).toBe(false);
    expect(pluginRouteFoldsNavigation(route("chat"), "")).toBe(false);
    expect(pluginRouteFoldsNavigation({}, "")).toBe(false);
  });
});
