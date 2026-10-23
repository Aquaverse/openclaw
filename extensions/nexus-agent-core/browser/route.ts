// Page routing for the Nexus Control UI module. The state lives in the host's page parameters (`p.view`, `p.task`), so
// reload and the browser's back button work without any state of our own. The shared renderers (src/ui-render.ts) write
// their links against a placeholder base; this file maps those placeholder links to routes and back.
import {
  EMPTY_FILTER,
  filterToParams,
  parseTaskFilter,
  type TaskFilter,
} from "../src/task-query.js";
import { DEFAULT_FILE_TAB, parseFileTab, type FileTab } from "../src/vault-ui.js";

export type NexusRoute =
  | { view: "tasks"; filter: TaskFilter }
  | { view: "task"; taskId: string }
  | { view: "preferences" }
  | { view: "receipts" }
  | { view: "files"; tab: FileTab };

/** The unfiltered first page of the list. */
export const TASKS_HOME: NexusRoute = { view: "tasks", filter: EMPTY_FILTER };

/** Placeholder link base handed to the renderers; the module rewrites every such link into a host navigation. */
export const NAV_BASE = "nexus-nav:";

const TASK_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function parseRoute(props: Readonly<Record<string, string>>): NexusRoute {
  const task = props.task;
  if (props.view === "task" && task !== undefined && TASK_ID.test(task)) {
    return { view: "task", taskId: task };
  }
  if (props.view === "preferences") {
    return { view: "preferences" };
  }
  if (props.view === "receipts") {
    return { view: "receipts" };
  }
  if (props.view === "files") {
    return { view: "files", tab: parseFileTab(props.tab) };
  }
  return { view: "tasks", filter: parseTaskFilter((name) => props[name]) };
}

/** Host page parameters for a route; the unfiltered first page of the list has none. */
export function routeParams(route: NexusRoute): Record<string, string> {
  switch (route.view) {
    case "task":
      return { view: "task", task: route.taskId };
    case "tasks":
      return filterToParams(route.filter);
    case "files":
      return route.tab === DEFAULT_FILE_TAB ? { view: "files" } : { view: "files", tab: route.tab };
    default:
      return { view: route.view };
  }
}

/** Maps a renderer link (`nexus-nav:/tasks/T1`, `nexus-nav:/`) to a route; anything else is not ours. */
export function routeFromHref(href: string): NexusRoute | undefined {
  if (!href.startsWith(NAV_BASE)) {
    return undefined;
  }
  const rest = href.slice(NAV_BASE.length);
  const queryAt = rest.indexOf("?");
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const query = new URLSearchParams(queryAt === -1 ? "" : rest.slice(queryAt + 1));
  const segments = path.split("/").filter((segment) => segment !== "");
  const [first, second] = segments;
  if (segments.length === 0) {
    return { view: "tasks", filter: parseTaskFilter((name) => query.get(name) ?? undefined) };
  }
  if (first === "tasks" && second !== undefined && segments.length === 2) {
    return TASK_ID.test(second) ? { view: "task", taskId: second } : undefined;
  }
  if (segments.length === 1 && (first === "preferences" || first === "receipts")) {
    return { view: first };
  }
  if (segments.length === 1 && first === "files") {
    return { view: "files", tab: parseFileTab(query.get("tab")) };
  }
  return undefined;
}
