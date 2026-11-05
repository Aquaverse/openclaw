import { PEOPLE_SEGS, PERSON_TABS, type PeopleSeg, type PersonTab } from "../src/people-ui.js";
// Page routing for the Nexus Control UI module. The state lives in the host's page parameters (`p.view`, `p.task`), so
// reload and the browser's back button work without any state of our own. The shared renderers (src/ui-render.ts) write
// their links against a placeholder base; this file maps those placeholder links to routes and back.
import {
  EMPTY_FILTER,
  filterToParams,
  parseTaskFilter,
  type TaskFilter,
} from "../src/task-query.js";
import {
  DEFAULT_FILE_QUERY,
  fileQueryToParams,
  parseFileQuery,
  type FileQuery,
} from "../src/vault-ui.js";
import { WORK_PRIMARY_STATES, type WorkPrimaryState } from "../src/work/types.js";

/** The Work page filter: one state segment and a keyword. Both optional; none means "all". */
export type WorkFilter = { state?: WorkPrimaryState; q?: string };

/** The People page: the segment of the list, a name search, the person shown and the tab of that person. All optional. */
export type PeopleQuery = { personId?: string; seg?: PeopleSeg; tab?: PersonTab; q?: string };

/** The prototype pages that only show their design for now; the host's left rail links to each. */
export const HUB_PAGES = ["goals", "library", "status"] as const;
export type HubPage = (typeof HUB_PAGES)[number];

export type NexusRoute =
  | { view: "tasks"; filter: TaskFilter }
  | { view: "hub"; hub: HubPage }
  | ({ view: "works" } & WorkFilter)
  | ({ view: "work"; workId: string } & WorkFilter)
  | { view: "task"; taskId: string }
  | ({ view: "people" } & PeopleQuery)
  | { view: "preferences" }
  | { view: "goals" }
  | { view: "receipts" }
  | ({ view: "files" } & FileQuery);

/** The unfiltered first page of the list. */
export const TASKS_HOME: NexusRoute = { view: "tasks", filter: EMPTY_FILTER };
/** The first page of the "all files" tab. */
export const FILES_HOME: Extract<NexusRoute, { view: "files" }> = {
  view: "files",
  ...DEFAULT_FILE_QUERY,
};

/** Placeholder link base handed to the renderers; the module rewrites every such link into a host navigation. */
export const NAV_BASE = "nexus-nav:";

const TASK_ID = /^[A-Za-z0-9._-]{1,64}$/;
const WORK_Q_MAX = 100;

/** The state and keyword of a Work page link; anything unknown is dropped rather than guessed. */
export function parseWorkFilter(get: (name: string) => string | undefined): WorkFilter {
  const state = WORK_PRIMARY_STATES.find((known) => known === get("state"));
  const q = (get("q") ?? "").trim().slice(0, WORK_Q_MAX);
  return { ...(state ? { state } : {}), ...(q ? { q } : {}) };
}

const workFilterParams = (filter: WorkFilter): Record<string, string> => ({
  ...(filter.state ? { state: filter.state } : {}),
  ...(filter.q ? { q: filter.q } : {}),
});

/** The segment and tab of a People page link; anything unknown is dropped rather than guessed. */
function parsePeopleQuery(
  get: (name: string) => string | undefined,
  personId: string | undefined,
): PeopleQuery {
  const seg = PEOPLE_SEGS.find((known) => known === get("seg"));
  const tab = PERSON_TABS.find((known) => known === get("tab"));
  const q = (get("q") ?? "").trim().slice(0, WORK_Q_MAX);
  return {
    ...(personId !== undefined && TASK_ID.test(personId) ? { personId } : {}),
    ...(seg ? { seg } : {}),
    ...(tab ? { tab } : {}),
    ...(q ? { q } : {}),
  };
}

const peopleParams = (route: PeopleQuery): Record<string, string> => ({
  ...(route.personId ? { person: route.personId } : {}),
  ...(route.seg ? { seg: route.seg } : {}),
  ...(route.tab ? { tab: route.tab } : {}),
  ...(route.q ? { q: route.q } : {}),
});

/** The People page with nothing chosen. */
export const PEOPLE_HOME: NexusRoute = { view: "people" };

/** The Work page with nothing chosen. */
export const WORKS_HOME: NexusRoute = { view: "works" };

export function parseRoute(props: Readonly<Record<string, string>>): NexusRoute {
  const task = props.task;
  if (props.view === "task" && task !== undefined && TASK_ID.test(task)) {
    return { view: "task", taskId: task };
  }
  if (props.view === "work" && props.work !== undefined && TASK_ID.test(props.work)) {
    return { view: "work", workId: props.work, ...parseWorkFilter((name) => props[name]) };
  }
  if (props.view === "works" || props.view === "work") {
    return { view: "works", ...parseWorkFilter((name) => props[name]) };
  }
  if (props.view === "people" || (props.view === "hub" && props.hub === "people")) {
    return { view: "people", ...parsePeopleQuery((name) => props[name], props.person) };
  }
  if (props.view === "hub") {
    const hub = HUB_PAGES.find((known) => known === props.hub);
    if (hub) {
      return { view: "hub", hub };
    }
  }
  if (props.view === "preferences") {
    return { view: "preferences" };
  }
  if (props.view === "receipts") {
    return { view: "receipts" };
  }
  if (props.view === "goals") {
    return { view: "goals" };
  }
  if (props.view === "files") {
    return { view: "files", ...parseFileQuery((name) => props[name]) };
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
    case "works":
      return { view: "works", ...workFilterParams(route) };
    case "work":
      return { view: "work", work: route.workId, ...workFilterParams(route) };
    case "files":
      return { view: "files", ...fileQueryToParams(route) };
    case "people":
      return { view: "people", ...peopleParams(route) };
    case "hub":
      return { view: "hub", hub: route.hub };
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
  if (first === "works" && segments.length === 1) {
    return { view: "works", ...parseWorkFilter((name) => query.get(name) ?? undefined) };
  }
  if (first === "works" && second !== undefined && segments.length === 2) {
    return TASK_ID.test(second)
      ? { view: "work", workId: second, ...parseWorkFilter((name) => query.get(name) ?? undefined) }
      : undefined;
  }
  if (first === "people" && segments.length <= 2) {
    const get = (name: string) => query.get(name) ?? undefined;
    if (second !== undefined && !TASK_ID.test(second)) {
      return undefined;
    }
    return { view: "people", ...parsePeopleQuery(get, second) };
  }
  if (first === "tasks" && second !== undefined && segments.length === 2) {
    return TASK_ID.test(second) ? { view: "task", taskId: second } : undefined;
  }
  if (
    segments.length === 1 &&
    (first === "preferences" || first === "receipts" || first === "goals")
  ) {
    return { view: first };
  }
  if (segments.length === 1 && first === "files") {
    return { view: "files", ...parseFileQuery((name) => query.get(name) ?? undefined) };
  }
  return undefined;
}
