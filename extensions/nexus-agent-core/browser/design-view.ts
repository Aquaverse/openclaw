// The four prototype pages that have no function yet (Goals, People, Library, Status), shown as the design draws them
// (docs/prd/design/nexus-*.html). They are static: the markup in design-pages.generated.ts is a snapshot of the prototype with its
// rail, scripts and handlers removed, so nothing here reads or writes data. The host's left rail carries the navigation.
import { DESIGN_PAGES } from "./design-pages.generated.ts";
import type { HubPage } from "./route.ts";

// The prototype's colours are its own :root variables; point them at the page tokens so the pages follow light and dark mode.
// The rail column of the prototype grid is gone, so the grid is the list pane and the detail only.
export const DESIGN_WRAP_CSS = `
.nx-dz{--bg:var(--nx-bg);--panel:var(--nx-panel);--line:var(--nx-line);--soft:var(--nx-soft);--text:var(--nx-text);--sub:var(--nx-sub);--mute:var(--nx-mute);--accent:var(--nx-accent);--accent-soft:var(--nx-accent-soft);--amber:var(--nx-amber);--amber-soft:var(--nx-amber-soft);--rose:var(--nx-rose);--rose-soft:var(--nx-rose-soft);--blue:var(--nx-blue);--blue-soft:var(--nx-blue-soft);--green:var(--nx-green);--green-soft:var(--nx-green-soft);--gray:var(--nx-gray);--gray-soft:var(--nx-gray-soft);height:auto;overflow:visible;background:var(--nx-bg);color:var(--nx-text)}
.nx-dz .nx-dz-sprite{display:none}
.nx-dz .app{grid-template-columns:380px minmax(0,1fr);height:100vh}
@media (max-width:1200px){.nx-dz .app{grid-template-columns:320px minmax(0,1fr)}}
@media (max-width:860px){.nx-dz .app{grid-template-columns:minmax(0,1fr);height:auto}.nx-dz .list{max-height:60vh;overflow:auto}}
`;

/** Replaces the page body with the snapshot of one prototype page. */
export function mountDesignPage(main: HTMLElement, page: HubPage): void {
  const { css, html } = DESIGN_PAGES[page];
  const wrap = document.createElement("div");
  wrap.className = "nx-dz";
  const style = document.createElement("style");
  style.textContent = css + DESIGN_WRAP_CSS;
  // Trusted markup: generated at build time from the prototype and bundled with the plugin; no user data goes through it.
  const template = document.createElement("template");
  template.innerHTML = html;
  wrap.append(style, template.content);
  main.replaceChildren(wrap);
}
