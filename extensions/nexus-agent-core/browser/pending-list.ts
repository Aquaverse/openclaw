// The "names to confirm" list pane after it is mounted (W3c-8): the same behaviour as the people list — rows come in pages of 50 as
// the reader scrolls to the end, and a new search replaces the rows in place without rebuilding the page, the detail pane or the
// search box. The typed names all arrive in one answer, so paging and searching work on what is already read; only the numbers
// beside the segments (which follow the search) are read again.
import { tr, type Lang } from "../src/i18n.js";
import {
  PENDING_PAGE_SIZE,
  pendingMatches,
  renderPendingListRows,
  renderPendingRows,
} from "../src/people-pending-ui.js";
import { renderPeopleSegs } from "../src/people-ui.js";
import type { NexusRequest } from "./data.ts";
import { readPeoplePage, type PeopleListInit } from "./people-data.ts";
import type { PeopleList } from "./people-list.ts";
import { NAV_BASE, type NexusRoute } from "./route.ts";
import { sanitizeFragment } from "./sanitize.ts";

export function attachPendingList(options: {
  root: HTMLElement;
  request: NexusRequest;
  hrefOf: (route: NexusRoute) => string;
  lang: Lang;
  init: PeopleListInit;
}): PeopleList | undefined {
  const { root, request, hrefOf, lang, init } = options;
  const rows = root.querySelector<HTMLElement>(".nx-rows");
  if (!rows) {
    return undefined;
  }
  let seg = root.querySelector<HTMLElement>(".nx-seg");
  let q = init.q;
  let found = pendingMatches(init.pending, q);
  let loaded = Math.min(init.loaded, found.length);
  // Bumped by every refresh and by dispose: an answer that arrives for an older token is dropped.
  let token = 0;
  const now = Date.now();
  const rowOptions = () => ({
    lang,
    base: NAV_BASE,
    now,
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
              more();
            }
          },
          { rootMargin: "240px" },
        )
      : undefined;
  const watch = () => {
    if (watcher && sentinel.isConnected) {
      // Observing again reports the current state, so a page that still ends inside the view asks for the next one.
      watcher.unobserve(sentinel);
      watcher.observe(sentinel);
    }
  };
  const paint = () => {
    if (loaded >= found.length) {
      watcher?.unobserve(sentinel);
      sentinel.remove();
      return;
    }
    button.textContent = tr(lang, "work.more.load", { n: loaded, total: found.length });
    rows.append(sentinel);
  };
  button.addEventListener("click", () => more());

  function more(): void {
    if (loaded >= found.length || !sentinel.isConnected) {
      return;
    }
    const page = found.slice(loaded, loaded + PENDING_PAGE_SIZE);
    sentinel.before(sanitizeFragment(renderPendingRows(page, rowOptions()), hrefOf));
    loaded += page.length;
    paint();
    watch();
  }

  paint();
  watch();

  return {
    loaded: () => loaded,
    async refresh(next) {
      const mine = ++token;
      // The numbers beside the segments follow the search.
      const page = await readPeoplePage(request, { q: next }, 0, 1);
      if (mine !== token) {
        return false;
      }
      q = next;
      found = pendingMatches(init.pending, q);
      loaded = Math.min(PENDING_PAGE_SIZE, found.length);
      const fresh = sanitizeFragment(
        renderPeopleSegs(
          {
            items: [],
            counts: page.counts,
            pending: init.pending,
            seg: "pending",
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
      rows.replaceChildren(
        found.length === 0
          ? sanitizeFragment(emptyText(), hrefOf)
          : sanitizeFragment(renderPendingRows(found.slice(0, loaded), rowOptions()), hrefOf),
      );
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

  function emptyText(): string {
    return renderPendingListRows({ pending: init.pending, q, now }, lang, NAV_BASE);
  }
}
