// The Nexus page, mounted by the Control UI itself (same origin, same gateway connection). It replaces the iframe the
// descriptor tab would otherwise use: no cookie grant, no sandboxed frame, so it works inside the macOS app's WebView too.
// Read-only by construction: it calls list/get methods only.
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { resolveLang, tr, type Lang } from "../src/i18n.js";
import { EMPTY_FILTER, filterToParams, type TaskFilter } from "../src/task-query.js";
import { EMPTY_MODEL, runAction, type ActionNotice, type NexusModel } from "./actions.ts";
import { loadView, probeFeatures, type NexusFeatures } from "./data.ts";
import { createFileBar } from "./file-bar.ts";
import { createFilterBar } from "./filters.ts";
import { FILES_HOME, parseRoute, routeParams, TASKS_HOME, type NexusRoute } from "./route.ts";
import { mountSanitized } from "./sanitize.ts";
import { NEXUS_CSS } from "./style.ts";

export const NEXUS_PAGE_ID = "nexus";
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
];
const REFRESH_DEBOUNCE_MS = 400;

const target = (route: NexusRoute) => ({ id: NEXUS_PAGE_ID, params: routeParams(route) });

export function createNexusPage(): ControlUiView {
  // The last list filter, kept for as long as the module is loaded: a task detail, the preference tab or a reload of the
  // page hands the list back exactly as the user left it. Only "reset" and a new search change it.
  let remembered: TaskFilter = EMPTY_FILTER;
  return (container, initial) => {
    let context = initial;
    let features: NexusFeatures = { preferences: false, files: false };
    let probed = false;
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
    root.append(style, nav, notice, bar.element, main);
    container.replaceChildren(root);

    // Links back to the plain list (the tab, "back to list") come from another view: give them the remembered filter.
    // From the list itself the same link still means "start over".
    const resolve = (route: NexusRoute): NexusRoute =>
      route.view === "tasks" &&
      parseRoute(context.props).view !== "tasks" &&
      Object.keys(routeParams(route)).length === 0
        ? { view: "tasks", filter: remembered }
        : route;
    const hrefOf = (route: NexusRoute) => context.host.navigation.pageHref(target(resolve(route)));
    const open = (route: NexusRoute) => context.host.navigation.openPage(target(resolve(route)));

    const showNotice = (next: ActionNotice | undefined) => {
      notice.hidden = next === undefined;
      notice.className = next?.ok === false ? "nx-notice error" : "nx-notice ok";
      notice.textContent = next ? context.host.redact(next.text) : "";
    };

    const renderNav = (route: NexusRoute) => {
      const lang = currentLang();
      const items: Array<[string, NexusRoute, boolean]> = [
        [tr(lang, "nav.tasks"), TASKS_HOME, route.view === "tasks" || route.view === "task"],
        ...(features.preferences
          ? [
              [
                tr(lang, "nav.preferences"),
                { view: "preferences" },
                route.view === "preferences",
              ] as [string, NexusRoute, boolean],
            ]
          : []),
        ...(features.files === true
          ? [
              [tr(lang, "nav.files"), FILES_HOME, route.view === "files"] as [
                string,
                NexusRoute,
                boolean,
              ],
            ]
          : []),
        [tr(lang, "nav.receipts"), { view: "receipts" }, route.view === "receipts"],
      ];
      const links = items.map(([label, to, on]) => {
        const link = document.createElement("a");
        link.textContent = label;
        link.href = hrefOf(to);
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

    const showMessage = (text: string, className: string) => {
      unbindClicks?.();
      unbindClicks = undefined;
      fileBar.element.remove();
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
    // name or page size in the route changes, so a refresh never wipes what is being typed.
    const placeFileBar = (route: NexusRoute) => {
      const slot = route.view === "files" ? main.querySelector(".nx-filebar-slot") : null;
      if (route.view !== "files" || !slot) {
        fileBar.element.remove();
        fileBarKey = undefined;
        return;
      }
      slot.append(fileBar.element);
      const key = JSON.stringify([route.name, route.size]);
      if (key !== fileBarKey) {
        fileBarKey = key;
        fileBar.set(route);
      }
    };

    async function load(keepNotice = false): Promise<void> {
      const mine = ++sequence;
      const route = parseRoute(context.props);
      if (!keepNotice) {
        showNotice(undefined);
      }
      const lang = currentLang();
      bar.setLang(lang);
      fileBar.setLang(lang);
      if (route.view === "tasks") {
        remembered = route.filter;
      }
      renderNav(route);
      syncBar(route);
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
        const view = await loadView(context.host.request, route, features, {
          actions: context.host.connection.canWrite,
          lang,
        });
        if (mine !== sequence || context.signal.aborted) {
          return;
        }
        model = view.model;
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
                showNotice(result);
                void load(true);
              },
            },
            action,
          ),
        );
        placeFileBar(route);
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

    const scheduleRefresh = () => {
      clearTimeout(timer);
      // Server events follow our own writes; they must not wipe the "done" notice the user is reading.
      timer = setTimeout(() => void load(true), REFRESH_DEBOUNCE_MS);
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
        context.host.onEvent(`${EVENT_PREFIX}${name}`, scheduleRefresh),
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
          void load();
        }
      },
      dispose() {
        sequence += 1;
        clearTimeout(timer);
        unbindClicks?.();
        for (const dispose of disposers) {
          dispose();
        }
        container.replaceChildren();
      },
    };
  };
}
