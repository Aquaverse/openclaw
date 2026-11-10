// The link of a People page state (segment, search, tab, the person or the typed name chosen). Shared by the people and the
// "names to confirm" renderers so both build addresses the same way. Always HTML-escaped, ready for an `href` attribute.
import type { PeopleSeg, PersonTab } from "./people-ui.js";
import { esc } from "./ui-render.js";

export type PeopleLink = {
  seg?: PeopleSeg | undefined;
  tab?: PersonTab | undefined;
  q?: string | undefined;
  /** The key of the typed name chosen on the "to confirm" segment. */
  typed?: string | undefined;
};

export function peopleHref(base: string, id: string | undefined, query: PeopleLink): string {
  const params = new URLSearchParams();
  if (query.seg) {
    params.set("seg", query.seg);
  }
  if (query.typed) {
    params.set("typed", query.typed);
  }
  if (query.q) {
    params.set("q", query.q);
  }
  if (query.tab && query.tab !== "responsible") {
    params.set("tab", query.tab);
  }
  const text = params.toString();
  return esc(`${base}/people${id ? `/${id}` : ""}${text ? `?${text}` : ""}`);
}
