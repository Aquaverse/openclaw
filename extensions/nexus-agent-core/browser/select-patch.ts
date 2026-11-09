import type { NexusRoute } from "./route.ts";
// Choosing another row of the Work or People list changes only the detail pane and which row is highlighted. Rebuilding the whole
// page for that (list, scroll position, search box) made the list flicker, so the page patches those two things in place when
// everything else in the list markup is the same. The click handler of the mounted page is delegated, so new nodes need no wiring.
import { sanitizeFragment } from "./sanitize.ts";

/**
 * The list pane's markup without which row is highlighted, or undefined when the markup is not a list page. Two pages with the same
 * signature differ only in the highlighted row and the detail pane.
 */
export function listSignature(html: string): string | undefined {
  const start = html.indexOf('<div class="nx-wlist"');
  const end = html.indexOf('<div class="nx-detail"');
  if (start < 0 || end < start) {
    return undefined;
  }
  return html.slice(start, end).replaceAll(' on"', '"');
}

/** Swaps the detail pane and moves the highlight; false when the mounted page is not shaped like a list page. */
export function patchSelection(
  main: HTMLElement,
  html: string,
  hrefOf: (route: NexusRoute) => string,
): boolean {
  const fresh = sanitizeFragment(html, hrefOf);
  const rootNew = fresh.querySelector(".nx-works");
  const rootOld = main.querySelector(".nx-works");
  const detailNew = fresh.querySelector(".nx-detail");
  const detailOld = main.querySelector(".nx-detail");
  if (!rootNew || !rootOld || !detailNew || !detailOld) {
    return false;
  }
  const on = new Set(
    [...rootNew.querySelectorAll("a.nx-wrow.on")].map((row) => row.getAttribute("href") ?? ""),
  );
  rootOld.className = rootNew.className;
  detailOld.replaceWith(detailNew);
  for (const row of rootOld.querySelectorAll("a.nx-wrow")) {
    row.classList.toggle("on", on.has(row.getAttribute("href") ?? ""));
  }
  return true;
}
