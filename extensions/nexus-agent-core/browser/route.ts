// Page routing for the Nexus Control UI module. The state lives in the host's page parameters (`p.view`, `p.task`), so
// reload and the browser's back button work without any state of our own. The shared renderers (src/ui-render.ts) write
// their links against a placeholder base; this file maps those placeholder links to routes and back.
export type NexusRoute =
  | { view: "tasks" }
  | { view: "task"; taskId: string }
  | { view: "preferences" }
  | { view: "receipts" };

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
  return { view: "tasks" };
}

/** Host page parameters for a route; the default list view has none. */
export function routeParams(route: NexusRoute): Record<string, string> {
  switch (route.view) {
    case "task":
      return { view: "task", task: route.taskId };
    case "tasks":
      return {};
    default:
      return { view: route.view };
  }
}

/** Maps a renderer link (`nexus-nav:/tasks/T1`, `nexus-nav:/`) to a route; anything else is not ours. */
export function routeFromHref(href: string): NexusRoute | undefined {
  if (!href.startsWith(NAV_BASE)) {
    return undefined;
  }
  const segments = href
    .slice(NAV_BASE.length)
    .split("/")
    .filter((segment) => segment !== "");
  const [first, second] = segments;
  if (segments.length === 0) {
    return { view: "tasks" };
  }
  if (first === "tasks" && second !== undefined && segments.length === 2) {
    return TASK_ID.test(second) ? { view: "task", taskId: second } : undefined;
  }
  if (segments.length === 1 && (first === "preferences" || first === "receipts")) {
    return { view: first };
  }
  return undefined;
}
