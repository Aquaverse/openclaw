// The Nexus page, mounted by the Control UI itself (same origin, same gateway connection). It replaces the iframe the
// descriptor tab would otherwise use: no cookie grant, no sandboxed frame, so it works inside the macOS app's WebView too.
// Read-only by construction: it calls list/get methods only.
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { EMPTY_MODEL, runAction, type ActionNotice, type NexusModel } from "./actions.ts";
import { loadView, probeFeatures, type NexusFeatures } from "./data.ts";
import { parseRoute, routeParams, type NexusRoute } from "./route.ts";
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
];
const REFRESH_DEBOUNCE_MS = 400;

const target = (route: NexusRoute) => ({ id: NEXUS_PAGE_ID, params: routeParams(route) });

export function createNexusPage(): ControlUiView {
  return (container, initial) => {
    let context = initial;
    let features: NexusFeatures = { preferences: false };
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
    root.append(style, nav, notice, main);
    container.replaceChildren(root);

    const hrefOf = (route: NexusRoute) => context.host.navigation.pageHref(target(route));
    const open = (route: NexusRoute) => context.host.navigation.openPage(target(route));

    const showNotice = (next: ActionNotice | undefined) => {
      notice.hidden = next === undefined;
      notice.className = next?.ok === false ? "nx-notice error" : "nx-notice ok";
      notice.textContent = next ? context.host.redact(next.text) : "";
    };

    const renderNav = (route: NexusRoute) => {
      const items: Array<[string, NexusRoute, boolean]> = [
        ["事项", { view: "tasks" }, route.view === "tasks" || route.view === "task"],
        ...(features.preferences
          ? [
              ["偏好", { view: "preferences" }, route.view === "preferences"] as [
                string,
                NexusRoute,
                boolean,
              ],
            ]
          : []),
        ["清除回执", { view: "receipts" }, route.view === "receipts"],
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
      refresh.textContent = "刷新";
      refresh.addEventListener("click", () => void load());
      nav.replaceChildren(...links, spacer, refresh);
    };

    const showMessage = (text: string, className: string) => {
      unbindClicks?.();
      unbindClicks = undefined;
      const paragraph = document.createElement("p");
      paragraph.className = className;
      paragraph.textContent = context.host.redact(text);
      main.replaceChildren(paragraph);
    };

    async function load(keepNotice = false): Promise<void> {
      const mine = ++sequence;
      const route = parseRoute(context.props);
      if (!keepNotice) {
        showNotice(undefined);
      }
      renderNav(route);
      if (!context.host.connection.connected) {
        showMessage("正在连接网关…", "muted");
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
              model: () => model,
              changed: (result) => {
                showNotice(result);
                void load(true);
              },
            },
            action,
          ),
        );
      } catch (error) {
        if (mine === sequence && !context.signal.aborted) {
          showMessage(
            `Nexus 读取失败：${error instanceof Error ? error.message : String(error)}`,
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
