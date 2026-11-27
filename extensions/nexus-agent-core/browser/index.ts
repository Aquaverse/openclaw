// Control UI module for the Ask Pepio Agent Core plugin (built to dist/control-ui/<hash> by the package's assetScripts).
// The product destinations are fixed buttons in the host's left rail. The retired descriptor tab is deliberately not
// registered: it duplicated these destinations as an obsolete "Nexus" item in the overflow menu.
import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { resolveLang, tr, type Lang } from "../src/i18n.js";
import { createConnectionsPage, NEXUS_CONNECTIONS_PAGE_ID } from "./connections-page.ts";
import { createNexusPage, NEXUS_RAIL_PAGE_ID } from "./page.ts";

type RailDestination = {
  id: string;
  label:
    | "nav.rail.dashboard"
    | "nav.rail.works"
    | "nav.goals"
    | "nav.rail.people"
    | "nav.rail.library"
    | "nav.rail.connections";
  icon: string;
  page: { id: string; params?: Record<string, string> };
};

// The order follows the EA prototype. Collaboration is not the host's People
// page: it lists the people a commitment can point at, so it takes a single-figure icon instead of the two-figure `users`
// the host uses for its own People button.
const RAIL_DESTINATIONS: readonly RailDestination[] = [
  {
    id: "dashboard",
    label: "nav.rail.dashboard",
    icon: "dashboards",
    page: { id: NEXUS_RAIL_PAGE_ID, params: { view: "dashboard" } },
  },
  {
    id: "work",
    label: "nav.rail.works",
    icon: "listChecks",
    page: { id: NEXUS_RAIL_PAGE_ID, params: { view: "works" } },
  },
  {
    id: "people",
    label: "nav.rail.people",
    icon: "circleUser",
    page: { id: NEXUS_RAIL_PAGE_ID, params: { view: "people" } },
  },
  {
    id: "library",
    label: "nav.rail.library",
    icon: "folder",
    page: { id: NEXUS_RAIL_PAGE_ID, params: { view: "files" } },
  },
  {
    id: "goals",
    label: "nav.goals",
    icon: "target",
    page: { id: NEXUS_RAIL_PAGE_ID, params: { view: "goals" } },
  },
  {
    id: "connections",
    label: "nav.rail.connections",
    icon: "plug",
    page: { id: NEXUS_CONNECTIONS_PAGE_ID },
  },
];

export default defineControlUiPlugin({
  id: "nexus-agent-core",
  activate(host) {
    // A navigation label is a plain string fixed at registration, so a language switch replaces the four items rather
    // than leaving their buttons in the language the page was first opened in.
    let lang: Lang = resolveLang(host.locale);
    let navDisposers: (() => void)[] = [];
    const registerRail = () => {
      lang = resolveLang(host.locale);
      navDisposers = RAIL_DESTINATIONS.map((destination, index) =>
        host.ui.registerNavigation({
          id: destination.id,
          label: tr(lang, destination.label),
          icon: destination.icon,
          page: destination.page,
          order: index,
          rail: "sessions",
        }),
      );
    };
    const dropRail = () => {
      for (const dispose of navDisposers) {
        dispose();
      }
      navDisposers = [];
    };
    registerRail();

    const pages = [
      host.ui.registerPage({
        id: NEXUS_RAIL_PAGE_ID,
        label: "Ask Pepio",
        mount: createNexusPage(NEXUS_RAIL_PAGE_ID),
      }),
      host.ui.registerPage({
        id: NEXUS_CONNECTIONS_PAGE_ID,
        label: tr(lang, "nav.rail.connections"),
        mount: createConnectionsPage(),
      }),
    ];
    const unsubscribe = host.subscribe(() => {
      if (resolveLang(host.locale) === lang) {
        return;
      }
      dropRail();
      registerRail();
    });

    return () => {
      unsubscribe();
      dropRail();
      for (const dispose of pages) {
        dispose();
      }
    };
  },
});
