// Control UI module for the Nexus Agent Core plugin (built to dist/control-ui/<hash> by the package's assetScripts).
// The descriptor tab `nexus` (src/task-module.ts) stays the sidebar entry; registering a page with the same id makes the
// host render this page in place of the descriptor's iframe, so no second navigation item is registered here.
import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createNexusPage, NEXUS_PAGE_ID } from "./page.ts";

export default defineControlUiPlugin({
  id: "nexus-agent-core",
  activate(host) {
    return host.ui.registerPage({ id: NEXUS_PAGE_ID, label: "Nexus", mount: createNexusPage() });
  },
});
