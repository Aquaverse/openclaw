// Control UI module for the Nexus Agent Core plugin (built to dist/control-ui/<hash> by the package's assetScripts).
// The descriptor tab `nexus` (src/task-module.ts) stays the sidebar entry; registering a page with the same id makes the
// host render this page in place of the descriptor's iframe, so no second navigation item is registered for the tab itself.
// Work, Counterparts, Library and Goals are separate destinations: fixed buttons of the host's left rail, directly below the
// Sessions button, each opening this page with its own `view` (design: nexus-work.html and its siblings). They point at
// a second page id (`nexus-rail`, same code): a navigation item aimed at `nexus` would make the host hide the Nexus tab.
import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { resolveLang, tr, type Lang } from "../src/i18n.js";
import { createNexusPage, NEXUS_PAGE_ID, NEXUS_RAIL_PAGE_ID } from "./page.ts";

type RailDestination = {
  id: string;
  label:
    | "nav.rail.dashboard"
    | "nav.rail.works"
    | "nav.goals"
    | "nav.rail.people"
    | "nav.rail.library";
  icon: string;
  params: Record<string, string>;
};

// The order of the rail: Dashboard, Work, Collaboration, Library, Goals — the first three are the destinations of the new
// design (docs/nexus/apps/nexus-ea-prototype); Apps & connections is not built yet. Collaboration is not the host's People
// page: it lists the people a commitment can point at, so it takes a single-figure icon instead of the two-figure `users`
// the host uses for its own People button.
const RAIL_DESTINATIONS: readonly RailDestination[] = [
  {
    id: "dashboard",
    label: "nav.rail.dashboard",
    icon: "dashboards",
    params: { view: "dashboard" },
  },
  { id: "work", label: "nav.rail.works", icon: "listChecks", params: { view: "works" } },
  { id: "people", label: "nav.rail.people", icon: "circleUser", params: { view: "people" } },
  { id: "library", label: "nav.rail.library", icon: "folder", params: { view: "files" } },
  { id: "goals", label: "nav.goals", icon: "target", params: { view: "goals" } },
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
          page: { id: NEXUS_RAIL_PAGE_ID, params: destination.params },
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
      host.ui.registerPage({ id: NEXUS_PAGE_ID, label: "Nexus", mount: createNexusPage() }),
      host.ui.registerPage({
        id: NEXUS_RAIL_PAGE_ID,
        label: "Nexus",
        mount: createNexusPage(NEXUS_RAIL_PAGE_ID),
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
