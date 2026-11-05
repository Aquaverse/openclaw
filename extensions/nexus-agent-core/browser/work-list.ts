// The Work list pane after it is mounted: loads the next page of rows when the reader scrolls to the end, and replaces the
// pills and rows in place when the search changes (so typing never rebuilds the page, the detail pane or the search box).
// The markup still comes from the pure renderers and goes through the same sanitizer as the rest of the page; the click
// handler of the mounted page covers the rows added later because it is delegated on the page container.
import { tr, type Lang } from "../src/i18n.js";
import { renderWorkList, renderWorkRows } from "../src/work-ui.js";
import type { WorkPrimaryState } from "../src/work/types.js";
import type { NexusRequest } from "./data.ts";
import { NAV_BASE, type NexusRoute, type WorkFilter } from "./route.ts";
import { sanitizeFragment } from "./sanitize.ts";
import { readWorkCounts, readWorkPage, WORK_PAGE_SIZE, type WorkListInit } from "./work-data.ts";

export type WorkList = {
  /** How many rows the pane shows now (a reload asks for at least this many, so the scroll position survives). */
  loaded(): number;
  /** Shows the list for another filter without leaving the page. Rejects when the rows cannot be read. */
  refresh(filter: WorkFilter): Promise<boolean>;
  dispose(): void;
};

export function attachWorkList(options: {
  root: HTMLElement;
  request: NexusRequest;
  hrefOf: (route: NexusRoute) => string;
  lang: Lang;
  init: WorkListInit;
}): WorkList | undefined {
  const { root, request, hrefOf, lang, init } = options;
  const rows = root.querySelector<HTMLElement>(".nx-rows");
  let seg = root.querySelector<HTMLElement>(".nx-seg");
  if (!rows || !seg) {
    return undefined;
  }
  let filter = init.filter;
  let counts = init.counts;
  let total = init.total;
  let loaded = init.loaded;
  // The state of the final row decides whether the next page starts with a group heading.
  let last: WorkPrimaryState | undefined = init.last;
  let busy = false;
  let failed = false;
  // Bumped by every refresh and by dispose: an answer that arrives for an older token is dropped.
  let token = 0;

  const rowsData = () => ({
    now: init.now,
    decisions: init.decisions,
    ...(filter.state ? { state: filter.state } : {}),
    ...(filter.q ? { q: filter.q } : {}),
  });
  const listOptions = () => ({
    lang,
    basePath: NAV_BASE,
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
    // Rows go before the "hidden works" footer, the sentinel after the last row.
    rows.insertBefore(sentinel, rows.querySelector(".nx-wfoot"));
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
      const page = await readWorkPage(request, filter, loaded, WORK_PAGE_SIZE);
      if (mine !== token) {
        return;
      }
      const next = renderWorkRows(page.works, rowsData(), {
        ...listOptions(),
        ...(last ? { after: last } : {}),
      });
      sentinel.before(sanitizeFragment(next.html, hrefOf));
      loaded += page.works.length;
      // An empty page ends the list however many rows the server promised, so it can never loop.
      total = page.works.length === 0 ? loaded : (page.total ?? total);
      last = next.last;
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
      // The numbers beside the segments follow the search, so they are read with the rows. They are only a label: a
      // failure to read them leaves the old ones rather than losing the rows.
      const [page, searched] = await Promise.all([
        readWorkPage(request, next, 0, WORK_PAGE_SIZE),
        readWorkCounts(request, next.q).catch(() => undefined),
      ]);
      if (mine !== token) {
        return false;
      }
      filter = next;
      counts = searched ?? counts;
      loaded = page.works.length;
      total = page.total ?? loaded;
      last = page.works.at(-1)?.state.primary;
      const list = renderWorkList({ counts, works: page.works, ...rowsData() }, listOptions());
      const fresh = sanitizeFragment(list.seg, hrefOf);
      const replacement = fresh.firstElementChild as HTMLElement | null;
      if (replacement) {
        seg?.replaceWith(fresh);
        seg = replacement;
      }
      rows.replaceChildren(sanitizeFragment(list.rows, hrefOf));
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
