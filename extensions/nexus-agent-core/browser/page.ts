// The Nexus page, mounted by the Control UI itself (same origin, same gateway connection). It replaces the iframe the
// descriptor tab would otherwise use: no cookie grant, no sandboxed frame, so it works inside the macOS app's WebView too.
// Read-only by construction: it calls list/get methods only.
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { resolveLang, tr, type Lang } from "../src/i18n.js";
import { EMPTY_FILTER, filterToParams, type TaskFilter } from "../src/task-query.js";
import { EMPTY_MODEL, runAction, type ActionNotice, type NexusModel } from "./actions.ts";
import { goalsDueCount, loadView, probeFeatures, type NexusFeatures } from "./data.ts";
import { mountDesignPage } from "./design-view.ts";
import { createFileBar } from "./file-bar.ts";
import { createFilterBar } from "./filters.ts";
import { readGoalPrefs, writeGoalPrefs } from "./goal-prefs.ts";
import { refreshOpenGoalDetail } from "./goals-view.ts";
import { FILES_HOME, parseRoute, routeParams, TASKS_HOME, type NexusRoute } from "./route.ts";
import { mountSanitized } from "./sanitize.ts";
import { NEXUS_CSS } from "./style.ts";
import { createWorkBar } from "./work-bar.ts";
import { WORK_PAGE_SIZE } from "./work-data.ts";
import { attachWorkList, type WorkList } from "./work-list.ts";

export const NEXUS_PAGE_ID = "nexus";
/** The same page under a second id, for the host's left-rail buttons. They cannot use `nexus`: the host hides a descriptor tab
 * whenever a navigation item of its plugin points at the tab's id, and the Nexus sidebar entry has to stay. */
export const NEXUS_RAIL_PAGE_ID = "nexus-rail";
const EVENT_PREFIX = "plugin.nexus-agent-core.";
const CHANGE_EVENTS = [
  "task_changed",
  "decision_changed",
  "execution_changed",
  "claim_changed",
  "evidence_changed",
  "task_purged",
  "preference_changed",
  "watch_changed",
  "vault_changed",
  "goal_changed",
  "work_changed",
];
/** Events that can change what an open goal-detail dialog shows (its own goal, or the tasks and claims it points at). */
const DETAIL_EVENTS = new Set(["task_changed", "claim_changed", "goal_changed"]);
const REFRESH_DEBOUNCE_MS = 400;

type FilesRoute = Extract<NexusRoute, { view: "files" }>;
/** The Files tab link with nothing chosen: the only link that is replaced by the remembered query. */
const isPlainFiles = (route: FilesRoute) =>
  JSON.stringify(routeParams(route)) === JSON.stringify(routeParams(FILES_HOME));

export function createNexusPage(pageId: string = NEXUS_PAGE_ID): ControlUiView {
  const target = (route: NexusRoute) => ({ id: pageId, params: routeParams(route) });
  // The last list filter, kept for as long as the module is loaded: a task detail, the preference tab or a reload of the
  // page hands the list back exactly as the user left it. Only "reset" and a new search change it.
  let remembered: TaskFilter = EMPTY_FILTER;
  // The same for the Files tab: tab, name filter, page and page size come back after a visit to another tab.
  let rememberedFiles: FilesRoute = FILES_HOME;
  return (container, initial) => {
    let context = initial;
    let features: NexusFeatures = {
      preferences: false,
      files: false,
      goals: false,
      works: false,
    };
    let probed = false;
    // Goals due for a look-back; shown as a count on the Goals tab. Read again on every load.
    let goalsDue = 0;
    let sequence = 0;
    let unbindClicks: (() => void) | undefined;
    let model: NexusModel = EMPTY_MODEL;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastConnected = initial.host.connection.connected;

    const root = document.createElement("div");
    root.className = "nexus-page";
    const style = document.createElement("style");
    style.textContent = NEXUS_CSS;
    const nav = document.createElement("nav");
    // Everything right of the rail: the notice, the task filter bar and the page itself.
    const content = document.createElement("div");
    content.className = "nx-content";
    const notice = document.createElement("p");
    notice.setAttribute("role", "status");
    notice.hidden = true;
    const main = document.createElement("main");
    // The page text follows the host's locale, read afresh on every load so a language switch applies at once.
    const currentLang = (): Lang => resolveLang(context.host.locale);
    const bar = createFilterBar({
      lang: currentLang(),
      apply(filter) {
        const next: NexusRoute = { view: "tasks", filter };
        // Same filter, same URL: the host would not react, so searching again reloads in place.
        if (
          JSON.stringify(routeParams(next)) ===
          JSON.stringify(routeParams(parseRoute(context.props)))
        ) {
          void load();
          return;
        }
        open(next);
      },
      reset: () => open(TASKS_HOME),
    });
    bar.element.hidden = true;
    let barKey: string | undefined;
    // The file search row is rendered inside the files view (between its buttons and its tabs): the view leaves an empty
    // slot, and this one form is moved into it after each mount.
    const fileBar = createFileBar({
      lang: currentLang(),
      apply(change) {
        const current = parseRoute(context.props);
        const tab = current.view === "files" ? current.tab : FILES_HOME.tab;
        const next: NexusRoute = { ...FILES_HOME, tab, ...change, page: 1 };
        // Same query, same URL: the host would not react, so searching again reloads in place.
        if (JSON.stringify(routeParams(next)) === JSON.stringify(routeParams(current))) {
          void load();
          return;
        }
        open(next);
      },
      reset() {
        const current = parseRoute(context.props);
        open({ ...FILES_HOME, tab: current.view === "files" ? current.tab : FILES_HOME.tab });
      },
    });
    let fileBarKey: string | undefined;
    // The Work list pane after a mount (paging, in-place search), the filter it shows, and a route the page already shows
    // because a search changed it in place (the host's answer to that navigation must not reload the page).
    let workList: WorkList | undefined;
    let shownListKey: string | undefined;
    // The route of a search made in place. A search is a state of the list, not a place to go: it does not touch the address
    // (every navigation makes the host redraw and reset its scroll regions, which is what made the page jump while typing).
    // It stays in force until the address changes for another reason (a click on a row, a pill, another tab).
    let settling: NexusRoute | undefined;
    // The Work search box: the same idea, moved into the empty slot of the Work list header.
    const workBar = createWorkBar({
      lang: currentLang(),
      apply(q) {
        const here = settling ?? parseRoute(context.props);
        const state = here.view === "works" || here.view === "work" ? here.state : undefined;
        const filter = { ...(state ? { state } : {}), ...(q ? { q } : {}) };
        // A selected Work stays selected while the list changes beside it.
        const next: NexusRoute =
          here.view === "work"
            ? { view: "work", workId: here.workId, ...filter }
            : { view: "works", ...filter };
        // Same query, same URL: the host would not react, so searching again reloads in place.
        if (JSON.stringify(routeParams(next)) === JSON.stringify(routeParams(here))) {
          void load();
          return;
        }
        // The list pane swaps its rows itself (no rebuild of the page, so the box keeps its focus and nothing jumps).
        // Without a mounted list, or if the rows cannot be read, the route change loads the page as usual.
        const pane = workList;
        if (!pane) {
          open(next);
          return;
        }
        pane
          .refresh(filter)
          .then((shown) => {
            if (shown) {
              shownListKey = listKey(next);
              settling = next;
            }
          })
          .catch(() => open(next));
      },
    });
    content.append(notice, bar.element, main);
    root.append(style, nav, content);
    container.replaceChildren(root);

    // Links back to the plain list (the tab, "back to list") come from another view: give them the remembered filter.
    // From the list itself the same link still means "start over". The Files tab works the same way.
    const resolve = (route: NexusRoute): NexusRoute => {
      const here = parseRoute(context.props).view;
      if (
        route.view === "tasks" &&
        here !== "tasks" &&
        Object.keys(routeParams(route)).length === 0
      ) {
        return { view: "tasks", filter: remembered };
      }
      if (route.view === "files" && here !== "files" && isPlainFiles(route)) {
        return rememberedFiles;
      }
      return route;
    };
    const hrefOf = (route: NexusRoute) => context.host.navigation.pageHref(target(resolve(route)));
    const open = (route: NexusRoute) => {
      const to = resolve(route);
      // A link back to the address the host already has, while a search overrides it: the host would not react.
      if (
        settling &&
        JSON.stringify(routeParams(to)) === JSON.stringify(routeParams(parseRoute(context.props)))
      ) {
        settling = undefined;
        void load();
        return;
      }
      context.host.navigation.openPage(target(to));
    };

    const showNotice = (next: ActionNotice | undefined) => {
      notice.hidden = next === undefined;
      notice.className = next?.ok === false ? "nx-notice error" : "nx-notice ok";
      notice.textContent = next ? context.host.redact(next.text) : "";
    };

    const renderNav = (route: NexusRoute) => {
      const lang = currentLang();
      type Item = { label: string; to: NexusRoute; on: boolean; icon: string };
      const items: Item[] = [
        {
          label: tr(lang, "nav.tasks"),
          to: TASKS_HOME,
          on: route.view === "tasks" || route.view === "task",
          icon: "\u2630",
        },
        ...(features.goals === true
          ? [
              {
                label:
                  goalsDue > 0 ? `${tr(lang, "nav.goals")} (${goalsDue})` : tr(lang, "nav.goals"),
                to: { view: "goals" } as NexusRoute,
                on: route.view === "goals",
                icon: "\u25ce",
              },
            ]
          : []),
        ...(features.preferences
          ? [
              {
                label: tr(lang, "nav.preferences"),
                to: { view: "preferences" } as NexusRoute,
                on: route.view === "preferences",
                icon: "\u2699",
              },
            ]
          : []),
        ...(features.files === true
          ? [
              {
                label: tr(lang, "nav.files"),
                to: FILES_HOME,
                on: route.view === "files",
                icon: "\u25ad",
              },
            ]
          : []),
        {
          label: tr(lang, "nav.receipts"),
          to: { view: "receipts" } as NexusRoute,
          on: route.view === "receipts",
          icon: "\u2713",
        },
      ];
      const links = items.map(({ label, to, on, icon }) => {
        const link = document.createElement("a");
        link.textContent = label;
        link.href = hrefOf(to);
        link.dataset.icon = icon;
        if (on) {
          link.className = "on";
        }
        link.addEventListener("click", (event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
            return;
          }
          event.preventDefault();
          open(to);
        });
        return link;
      });
      const spacer = document.createElement("span");
      spacer.className = "spacer";
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.textContent = tr(lang, "nav.refresh");
      refresh.addEventListener("click", () => void load());
      nav.replaceChildren(...links, spacer, refresh);
    };

    // Lets go of everything a data view had mounted in the body before something else takes its place.
    const clearMain = () => {
      unbindClicks?.();
      unbindClicks = undefined;
      workList?.dispose();
      workList = undefined;
      fileBar.element.remove();
      workBar.element.remove();
    };

    const showMessage = (text: string, className: string) => {
      clearMain();
      const paragraph = document.createElement("p");
      paragraph.className = className;
      paragraph.textContent = context.host.redact(text);
      main.replaceChildren(paragraph);
    };

    // The controls follow the route's filter only when that filter changes, so a refresh never wipes what is being typed.
    const syncBar = (route: NexusRoute) => {
      if (route.view !== "tasks") {
        bar.element.hidden = true;
        barKey = undefined;
        return;
      }
      bar.element.hidden = false;
      const key = JSON.stringify(filterToParams({ ...route.filter, page: 1 } as TaskFilter));
      if (key !== barKey) {
        barKey = key;
        bar.set(route.filter);
      }
    };

    // Puts the file search form into the slot of the files view just mounted. Its values follow the route only when the
    // filters or page size in the route change, so a refresh never wipes what is being typed.
    const placeFileBar = (route: NexusRoute) => {
      const slot = route.view === "files" ? main.querySelector(".nx-filebar-slot") : null;
      if (route.view !== "files" || !slot) {
        fileBar.element.remove();
        fileBarKey = undefined;
        return;
      }
      slot.append(fileBar.element);
      const key = JSON.stringify([
        route.name,
        route.kind,
        route.favorite,
        route.sensitivity,
        route.size,
      ]);
      if (key !== fileBarKey) {
        fileBarKey = key;
        fileBar.set(route);
      }
    };

    // Puts the search box into the slot of the Work list just mounted; it shows the route's keyword only when that changes.
    const listKey = (route: NexusRoute): string | undefined =>
      route.view === "works" || route.view === "work"
        ? JSON.stringify([route.state ?? "", route.q ?? ""])
        : undefined;

    const placeWorkBar = (route: NexusRoute) => {
      const slot =
        route.view === "works" || route.view === "work"
          ? main.querySelector(".nx-search-slot")
          : null;
      if ((route.view !== "works" && route.view !== "work") || !slot) {
        workBar.element.remove();
        return;
      }
      slot.append(workBar.element);
      workBar.set(route.q ?? "");
      workBar.restoreFocus();
    };

    async function load(keepNotice = false): Promise<void> {
      const mine = ++sequence;
      const route = settling ?? parseRoute(context.props);
      if (!keepNotice) {
        showNotice(undefined);
      }
      const lang = currentLang();
      // A reload of the same list keeps the rows already scrolled in, and where the reader had scrolled to.
      const sameList = workList !== undefined && listKey(route) === shownListKey;
      const keepRows = sameList ? workList?.loaded() : undefined;
      const keepTop = sameList ? main.querySelector(".nx-rows")?.scrollTop : undefined;
      bar.setLang(lang);
      fileBar.setLang(lang);
      workBar.setLang(lang);
      if (route.view === "tasks") {
        remembered = route.filter;
      }
      if (route.view === "files") {
        rememberedFiles = route;
      }
      // Work and the prototype pages are reached from the host's left rail: they take the whole width and no inner navigation.
      const railView = route.view === "works" || route.view === "work" || route.view === "hub";
      root.classList.toggle("nx-split", railView);
      root.classList.toggle("nx-rail", railView);
      renderNav(route);
      syncBar(route);
      if (route.view === "hub") {
        // Static design only: nothing to read from the gateway, so it shows even while disconnected.
        clearMain();
        mountDesignPage(main, route.hub);
        return;
      }
      if (!context.host.connection.connected) {
        showMessage(tr(lang, "page.connecting"), "muted");
        return;
      }
      try {
        if (!probed) {
          features = await probeFeatures(context.host.request);
          probed = true;
          if (mine !== sequence || context.signal.aborted) {
            return;
          }
          renderNav(route);
        }
        // Asked alongside the page data (never waited for first): it only feeds the count on the Goals tab.
        const dueRead = features.goals === true ? goalsDueCount(context.host.request) : undefined;
        const view = await loadView(context.host.request, route, features, {
          actions: context.host.connection.canWrite,
          lang,
          goalPrefs: readGoalPrefs(),
          ...(keepRows && keepRows > WORK_PAGE_SIZE ? { workRows: keepRows } : {}),
        });
        const due = dueRead ? await dueRead : 0;
        if (mine !== sequence || context.signal.aborted) {
          return;
        }
        if (due !== goalsDue) {
          goalsDue = due;
          renderNav(route);
        }
        model = view.model;
        workList?.dispose();
        workList = undefined;
        unbindClicks?.();
        unbindClicks = mountSanitized(main, view.html, hrefOf, open, (action) =>
          runAction(
            {
              request: context.host.request,
              parent: root,
              signal: context.signal,
              redact: context.host.redact,
              lang,
              canWrite: context.host.connection.canWrite,
              model: () => model,
              changed: (result) => {
                showNotice(result.text === "" ? undefined : result);
                void load(true);
              },
              notify: showNotice,
              sessions: context.host.sessions,
              goalPrefs: { read: readGoalPrefs, write: writeGoalPrefs },
            },
            action,
          ),
        );
        placeFileBar(route);
        placeWorkBar(route);
        shownListKey = view.workList ? listKey(route) : undefined;
        if (view.workList) {
          workList = attachWorkList({
            root: main,
            request: context.host.request,
            hrefOf,
            lang,
            init: view.workList,
          });
          const rows = main.querySelector(".nx-rows");
          if (rows && keepTop !== undefined) {
            rows.scrollTop = keepTop;
          }
        }
      } catch (error) {
        if (mine === sequence && !context.signal.aborted) {
          showMessage(
            tr(lang, "page.loadFailed", {
              message: error instanceof Error ? error.message : String(error),
            }),
            "error",
          );
        }
      }
    }

    let detailStale = false;
    const scheduleRefresh = (name?: string) => {
      clearTimeout(timer);
      detailStale ||= name !== undefined && DETAIL_EVENTS.has(name);
      // Server events follow our own writes; they must not wipe the "done" notice the user is reading.
      timer = setTimeout(() => {
        void load(true);
        if (detailStale) {
          detailStale = false;
          refreshOpenGoalDetail(root);
        }
      }, REFRESH_DEBOUNCE_MS);
    };

    const disposers = [
      context.host.subscribe(() => {
        const connected = context.host.connection.connected;
        if (connected !== lastConnected) {
          lastConnected = connected;
          void load();
        }
      }),
      ...CHANGE_EVENTS.map((name) =>
        context.host.onEvent(`${EVENT_PREFIX}${name}`, () => scheduleRefresh(name)),
      ),
    ];
    void load();

    let lastProps = JSON.stringify(context.props);
    return {
      update(next) {
        context = next;
        const serialized = JSON.stringify(next.props);
        if (serialized !== lastProps) {
          lastProps = serialized;
          // The address changed for another reason: it decides again, and a search made in place is over.
          settling = undefined;
          void load();
        }
      },
      dispose() {
        sequence += 1;
        clearTimeout(timer);
        unbindClicks?.();
        workList?.dispose();
        for (const dispose of disposers) {
          dispose();
        }
        container.replaceChildren();
      },
    };
  };
}
