// Control UI module for the Nexus Agent Core plugin (built to dist/control-ui/<hash> by the package's assetScripts).
// The descriptor tab `nexus` (src/task-module.ts) stays the sidebar entry; registering a page with the same id makes the
// host render this page in place of the descriptor's iframe, so no second navigation item is registered for the tab itself.
// Work, Goals, People, Library and Status are separate destinations: fixed buttons of the host's left rail, directly below
// the Sessions button, each opening this page with its own `view` (design: nexus-work.html and its siblings). They point at
// a second page id (`nexus-rail`, same code): a navigation item aimed at `nexus` would make the host hide the Nexus tab.
import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { resolveLang, tr } from "../src/i18n.js";
import { createNexusPage, NEXUS_PAGE_ID, NEXUS_RAIL_PAGE_ID } from "./page.ts";

type RailDestination = {
  id: string;
  label: "nav.works" | "nav.goals" | "nav.rail.people" | "nav.rail.library" | "nav.rail.status";
  icon: string;
  params: Record<string, string>;
};

// The order of the design's rail: Work, Goals, People, Library, Status.
const RAIL_DESTINATIONS: readonly RailDestination[] = [
  { id: "work", label: "nav.works", icon: "listChecks", params: { view: "works" } },
  { id: "goals", label: "nav.goals", icon: "target", params: { view: "hub", hub: "goals" } },
  { id: "people", label: "nav.rail.people", icon: "users", params: { view: "people" } },
  {
    id: "library",
    label: "nav.rail.library",
    icon: "folder",
    params: { view: "hub", hub: "library" },
  },
  {
    id: "status",
    label: "nav.rail.status",
    icon: "activity",
    params: { view: "hub", hub: "status" },
  },
];

export default defineControlUiPlugin({
  id: "nexus-agent-core",
  activate(host) {
    const lang = resolveLang(host.locale);
    const disposers = [
      host.ui.registerPage({ id: NEXUS_PAGE_ID, label: "Nexus", mount: createNexusPage() }),
      host.ui.registerPage({
        id: NEXUS_RAIL_PAGE_ID,
        label: "Nexus",
        mount: createNexusPage(NEXUS_RAIL_PAGE_ID),
      }),
      ...RAIL_DESTINATIONS.map((destination, index) =>
        host.ui.registerNavigation({
          id: destination.id,
          label: tr(lang, destination.label),
          icon: destination.icon,
          page: { id: NEXUS_RAIL_PAGE_ID, params: destination.params },
          order: index,
          rail: "sessions",
        }),
      ),
    ];
    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  },
});
