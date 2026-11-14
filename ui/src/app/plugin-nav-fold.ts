import { pluginTabRefFromSearch } from "../pages/plugin/route.tsx";
import type { ShellRouteState } from "./app-host-route-state.ts";

/**
 * Plugin pages that are full-width workspaces (they bring their own list and detail columns). The session list
 * starts folded away on them, so a refresh does not put a second list beside the page's own. The sidebar toggle
 * still opens it for this tab, and the saved collapse preference is never changed by that.
 */
const NAV_FOLDING_PLUGIN_IDS: ReadonlySet<string> = new Set(["nexus-agent-core"]);

export function pluginRouteFoldsNavigation(routeState: ShellRouteState, basePath: string): boolean {
  if (routeState.routeId !== "plugin") {
    return false;
  }
  const ref = pluginTabRefFromSearch(
    routeState.location?.search ?? "",
    routeState.location?.pathname,
    basePath,
  );
  return NAV_FOLDING_PLUGIN_IDS.has(ref.pluginId);
}
