// The People list pane after it is mounted: loads the next page of rows when the reader scrolls to the end, and replaces the
// rows in place when the search changes (so typing never rebuilds the page, the detail pane or the search box). The markup comes
// from the pure renderers and goes through the same sanitizer as the rest of the page; the click handler of the mounted page
// covers the rows added later because it is delegated on the page container.
import type { CounterpartSummary } from "../src/counterpart/types.js";
import { tr, type Lang } from "../src/i18n.js";
import { renderPeopleListRows, renderPeopleRows, renderPeopleSegs } from "../src/people-ui.js";
import type { NexusRequest } from "./data.ts";
import { attachPendingList } from "./pending-list.ts";
import { PEOPLE_PAGE_SIZE, readPeoplePage, type PeopleListInit } from "./people-data.ts";
import { NAV_BASE, type NexusRoute } from "./route.ts";
import { sanitizeFragment } from "./sanitize.ts";

export type PeopleList = {
  /** How many rows the pane shows now (a reload asks for at least this many, so the scroll position survives). */
  loaded(): number;
  /** Shows the list for another search without leaving the page. Resolves false when a newer search replaced this one. */
  refresh(q: string): Promise<boolean>;
  dispose(): void;
};

export function attachPeopleList(options: {
  root: HTMLElement;
  request: NexusRequest;
  hrefOf: (route: NexusRoute) => string;
  lang: Lang;
  init: PeopleListInit;
}): PeopleList | undefined {
  // The typed names wait in one answer: they page and search in the browser, with the same behaviour.
  if (options.init.seg === "pending") {
    return attachPendingList(options);
  }
  const { root, request, hrefOf, lang, init } = options;
  const rows = root.querySelector<HTMLElement>(".nx-rows");
  if (!rows) {
    return undefined;
  }
  let seg = root.querySelector<HTMLElement>(".nx-seg");
  let q = init.q;
  let total = init.total;
  let loaded = init.loaded;
  let busy = false;
  let failed = false;
  // Bumped by every refresh and by dispose: an answer that arrives for an older token is dropped.
  let token = 0;
  const rowOptions = () => ({
    lang,
    basePath: NAV_BASE,
    ...(init.seg ? { seg: init.seg } : {}),
    ...(q ? { q } : {}),
    ...(init.selected ? { selected: init.selected } : {}),
  });

  const sentinel = document.createElement("div");
  sentinel.className = "nx-wload";
  const button = document.createElement("button");
  button.type = "button";
  sentinel.append(button);

  const watcher =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              void more();
            }
          },
          { rootMargin: "240px" },
        )
      : undefined;
  const watch = () => {
    if (watcher && sentinel.isConnected && !failed) {
      // Observing again reports the current state, so a page that still ends inside the view asks for the next one.
      watcher.unobserve(sentinel);
      watcher.observe(sentinel);
    }
  };
  const paint = () => {
    if (loaded >= total) {
      watcher?.unobserve(sentinel);
      sentinel.remove();
      return;
    }
    button.disabled = busy;
    button.textContent = busy
      ? tr(lang, "work.more.loading")
      : failed
        ? tr(lang, "work.more.failed")
        : tr(lang, "work.more.load", { n: loaded, total });
    rows.append(sentinel);
  };
  button.addEventListener("click", () => {
    failed = false;
    void more();
  });

  async function more(): Promise<void> {
    if (busy || loaded >= total || !sentinel.isConnected) {
      return;
    }
    const mine = token;
    busy = true;
    failed = false;
    paint();
    try {
      const page = await readPeoplePage(request, { seg: init.seg, q }, loaded, PEOPLE_PAGE_SIZE);
      if (mine !== token) {
        return;
      }
      sentinel.before(sanitizeFragment(renderPeopleRows(page.items, rowOptions()), hrefOf));
      loaded += page.items.length;
      // An empty page ends the list however many rows the server promised, so it can never loop.
      total = page.items.length === 0 ? loaded : page.total;
    } catch {
      if (mine === token) {
        failed = true;
      }
    } finally {
      if (mine === token) {
        busy = false;
        paint();
        watch();
      }
    }
  }

  paint();
  watch();

  return {
    loaded: () => loaded,
    async refresh(next) {
      const mine = ++token;
      busy = false;
      failed = false;
      const page = await readPeoplePage(request, { seg: init.seg, q: next }, 0, PEOPLE_PAGE_SIZE);
      if (mine !== token) {
        return false;
      }
      q = next;
      loaded = page.items.length;
      total = page.total;
      const people: CounterpartSummary[] = page.items;
      const html = renderPeopleListRows(
        {
          items: people,
          pending: init.pending,
          ...(init.seg ? { seg: init.seg } : {}),
          ...(q ? { q } : {}),
        },
        lang,
        NAV_BASE,
        init.selected,
      );
      // The numbers beside the segments follow the search, so they are replaced with the rows.
      const fresh = sanitizeFragment(
        renderPeopleSegs(
          {
            items: people,
            counts: page.counts,
            pending: init.pending,
            ...(init.seg ? { seg: init.seg } : {}),
            ...(q ? { q } : {}),
          },
          lang,
          NAV_BASE,
        ),
        hrefOf,
      );
      const replacement = fresh.firstElementChild as HTMLElement | null;
      if (replacement) {
        seg?.replaceWith(fresh);
        seg = replacement;
      }
      rows.replaceChildren(sanitizeFragment(html, hrefOf));
      rows.scrollTop = 0;
      paint();
      watch();
      return true;
    },
    dispose() {
      token += 1;
      watcher?.disconnect();
      sentinel.remove();
    },
  };
}
