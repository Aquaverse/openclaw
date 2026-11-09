// The list of the clear-people page (people who were deleted), built with DOM calls only (the sanitizer admits no form controls):
// a name search, the page size (50 unless chosen), previous / next, tick boxes with "select this page", and the confirmation
// dialog that says what would be cleared before anything is. The selection lives in a map the page owns, so it survives paging,
// searching and the reload that follows a change. Paging and searching are route changes (back button, reload).
import { CLEANUP_PAGE_SIZES } from "../src/cleanup-ui.js";
import type { CounterpartSummary, PurgeImpact } from "../src/counterpart/types.js";
import { tr, type Lang } from "../src/i18n.js";
import type { ActionContext } from "./actions.ts";
import { impactList } from "./commitment-form.ts";
import { openDialog } from "./dialog.ts";
import { el } from "./goal-dom.ts";
import type { CleanupQuery, NexusRoute } from "./route.ts";

export type CleanupInit = {
  items: CounterpartSummary[];
  total: number;
  page: number;
  size: number;
  q: string;
};
/** Who is ticked: person id to display name (the name is what the dialog lists). */
export type CleanupPicked = Map<string, string>;
type CleanupRoute = Extract<NexusRoute, { view: "cleanup" }>;

type PurgeReply = {
  outcome?: string;
  items?: { id: string; displayName: string; impact: PurgeImpact }[];
  purged?: { id: string }[];
  skipped?: { id: string; reason: string }[];
  total?: PurgeImpact;
};

const NAMES_SHOWN = 8;

function tick(onChange: (on: boolean) => void): HTMLInputElement {
  const box = el("input");
  box.type = "checkbox";
  box.addEventListener("change", () => onChange(box.checked));
  return box;
}

/** The lines the dialog shows for what would go and what stays. */
function impactLines(lang: Lang, total: PurgeImpact, skipped: number) {
  const lines: { tone: "stop" | "keep"; text: string }[] = [];
  if (total.contacts > 0) {
    lines.push({
      tone: "stop",
      text: tr(lang, "cl.imp.contacts", { n: total.contacts, links: total.links }),
    });
  }
  if (total.sharedContacts > 0) {
    lines.push({ tone: "keep", text: tr(lang, "cl.imp.shared", { n: total.sharedContacts }) });
  }
  if (total.aliases > 0) {
    lines.push({ tone: "stop", text: tr(lang, "cl.imp.aliases", { n: total.aliases }) });
  }
  if (total.relations > 0) {
    lines.push({ tone: "stop", text: tr(lang, "cl.imp.relations", { n: total.relations }) });
  }
  if (total.contacts + total.aliases + total.relations + total.sharedContacts === 0) {
    lines.push({ tone: "keep", text: tr(lang, "cl.imp.nothing") });
  }
  lines.push(
    {
      tone: "keep",
      text: tr(lang, "cl.imp.keep", { n: total.commitmentsKept, m: total.participantLinksKept }),
    },
    { tone: "keep", text: tr(lang, "cl.imp.receipt") },
    { tone: "stop", text: tr(lang, "cl.imp.final") },
  );
  if (skipped > 0) {
    lines.push({ tone: "keep", text: tr(lang, "cl.skip", { n: skipped }) });
  }
  return lines;
}

function purgeDialog(ctx: ActionContext, picked: CleanupPicked): void {
  const lang = ctx.lang;
  const ids = [...picked.keys()];
  const names = [...picked.values()];
  let preview: PurgeReply | undefined;
  let acknowledged = false;
  let slot: HTMLElement | undefined;
  let refresh = () => {};
  const shownNames = () =>
    names.length > NAMES_SHOWN
      ? tr(lang, "cl.dlg.namesMore", {
          names: names.slice(0, NAMES_SHOWN).join("、"),
          n: names.length,
        })
      : names.join("、");
  const ready = () => preview?.outcome === "preview" && acknowledged;
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "cl.dlg.title", { n: ids.length }),
    actions: [
      {
        label: tr(lang, "cl.btn.go"),
        tone: "danger",
        enabled: ready,
        run: async () => {
          const reply = await ctx.request<PurgeReply>("nexus.counterpart.purge", {
            counterpartIds: ids,
            confirmCount: ids.length,
          });
          if (reply.outcome !== "purged" || !reply.total || !reply.purged) {
            picked.clear();
            ctx.changed({ ok: false, text: tr(lang, "cl.err.nothing") });
            return;
          }
          const skipped = reply.skipped?.length ?? 0;
          picked.clear();
          ctx.changed({
            ok: true,
            text:
              tr(lang, "cl.done", {
                n: reply.purged.length,
                contacts: reply.total.contacts,
                aliases: reply.total.aliases,
                relations: reply.total.relations,
              }) + (skipped > 0 ? tr(lang, "cl.done.skipped", { n: skipped }) : ""),
          });
        },
      },
    ],
    build: (body, changed) => {
      refresh = changed;
      body.append(
        el("p", "", tr(lang, "cl.dlg.intro")),
        el("p", "muted", tr(lang, "cl.dlg.names", { names: shownNames() })),
      );
      slot = el("div");
      slot.append(el("p", "muted", tr(lang, "cl.dlg.loading")));
      const ack = el("label", "nx-row nx-check");
      const box = tick((on) => {
        acknowledged = on;
        refresh();
      });
      ack.append(box, el("span", "", tr(lang, "cl.ack")));
      body.append(slot, ack);
      void (async () => {
        try {
          const reply = await ctx.request<PurgeReply>("nexus.counterpart.purge", {
            counterpartIds: ids,
            dryRun: true,
          });
          preview = reply;
          slot?.replaceChildren(
            reply.outcome === "preview" && reply.total
              ? impactList(impactLines(lang, reply.total, reply.skipped?.length ?? 0))
              : el("p", "error", tr(lang, "cl.err.nothing")),
          );
        } catch (failure) {
          slot?.replaceChildren(
            el(
              "p",
              "error",
              ctx.redact(
                tr(lang, "cl.err.read", {
                  message: failure instanceof Error ? failure.message : String(failure),
                }),
              ),
            ),
          );
        }
        refresh();
      })();
    },
  });
}

export function attachCleanup(options: {
  root: HTMLElement;
  ctx: ActionContext;
  init: CleanupInit;
  picked: CleanupPicked;
  /** Move to another page, search or size (a route change; the page decides whether it is a reload in place). */
  go: (route: CleanupRoute) => void;
}): void {
  const { root, ctx, init, picked, go } = options;
  const slot = root.querySelector<HTMLElement>(".nx-cleanup-slot");
  if (!slot) {
    return;
  }
  const lang = ctx.lang;
  const canWrite = ctx.canWrite !== false;
  const pages = Math.max(1, Math.ceil(init.total / init.size));
  const route = (over: Partial<CleanupQuery>): CleanupRoute => {
    const q = "q" in over ? over.q : init.q;
    return {
      view: "cleanup",
      ...(q ? { q } : {}),
      page: over.page ?? 1,
      size: over.size ?? init.size,
    };
  };

  // search and page size
  const bar = el("form", "nx-filebar nx-cl-bar");
  bar.noValidate = true;
  const search = el("input");
  search.type = "search";
  search.name = "q";
  search.maxLength = 100;
  search.value = init.q;
  search.placeholder = tr(lang, "cl.search.ph");
  const submit = el("button", "nx-btn nx-primary", tr(lang, "cl.search.btn"));
  submit.type = "submit";
  bar.append(search, submit);
  if (init.q) {
    const clear = el("button", "nx-btn", tr(lang, "cl.search.clear"));
    clear.type = "button";
    clear.addEventListener("click", () => go(route({ q: "" })));
    bar.append(clear);
  }
  const size = el("select");
  for (const n of CLEANUP_PAGE_SIZES) {
    const option = el("option", "", tr(lang, "cl.size.option", { n }));
    option.value = String(n);
    size.append(option);
  }
  size.value = String(init.size);
  size.addEventListener("change", () => go(route({ size: Number(size.value) })));
  const sizeLabel = el("label", "");
  sizeLabel.append(`${tr(lang, "cl.size.label")} `, size);
  bar.append(sizeLabel);
  bar.addEventListener("submit", (event) => {
    event.preventDefault();
    go(route({ q: search.value.trim() }));
  });

  // the selection bar
  const selection = el("div", "nx-cl-sel");
  const pageBox = tick((on) => {
    for (const item of init.items) {
      if (on) {
        picked.set(item.id, item.displayName);
      } else {
        picked.delete(item.id);
      }
    }
    sync();
  });
  const pageLabel = el("label", "nx-check");
  pageLabel.append(pageBox, el("span", "", tr(lang, "cl.pickPage")));
  const count = el("span", "muted");
  const drop = el("button", "nx-btn", tr(lang, "cl.pickClear"));
  drop.type = "button";
  drop.addEventListener("click", () => {
    picked.clear();
    sync();
  });
  const purge = el("button", "nx-btn nx-danger");
  purge.type = "button";
  purge.addEventListener("click", () => {
    if (picked.size > 0 && canWrite) {
      purgeDialog(ctx, picked);
    }
  });
  selection.append(pageLabel, count, drop, purge);

  // the rows
  const list = el("div", "nx-cl-list");
  const boxes = new Map<string, HTMLInputElement>();
  for (const item of init.items) {
    const line = el("label", "nx-cl-row");
    const box = tick((on) => {
      if (on) {
        picked.set(item.id, item.displayName);
      } else {
        picked.delete(item.id);
      }
      sync();
    });
    boxes.set(item.id, box);
    const info = el("span", "nx-cl-info");
    info.append(
      el("span", "nx-cl-name", item.displayName),
      el(
        "span",
        "muted nx-cl-meta",
        tr(lang, "cl.meta", { contacts: item.contacts.length, aliases: item.aliases.length }) +
          (item.inactiveReason
            ? ` · ${tr(lang, "cl.meta.reason", { reason: item.inactiveReason })}`
            : ""),
      ),
    );
    line.append(box, info);
    list.append(line);
  }
  if (init.items.length === 0) {
    list.append(
      el("p", "muted", init.q ? tr(lang, "cl.empty.search", { q: init.q }) : tr(lang, "cl.empty")),
    );
  }

  // previous / next
  const pager = el("p", "pager nx-cl-pager");
  const prev = el("button", "nx-btn", tr(lang, "cl.prev"));
  prev.type = "button";
  prev.disabled = init.page <= 1;
  prev.addEventListener("click", () => go(route({ page: init.page - 1 })));
  const next = el("button", "nx-btn", tr(lang, "cl.next"));
  next.type = "button";
  next.disabled = init.page >= pages;
  next.addEventListener("click", () => go(route({ page: init.page + 1 })));
  pager.append(
    el("span", "", tr(lang, "cl.page", { page: init.page, pages, total: init.total })),
    prev,
    next,
  );

  function sync(): void {
    for (const [id, box] of boxes) {
      box.checked = picked.has(id);
      box.disabled = !canWrite;
    }
    const onPage = init.items.filter((item) => picked.has(item.id)).length;
    pageBox.checked = init.items.length > 0 && onPage === init.items.length;
    pageBox.indeterminate = onPage > 0 && onPage < init.items.length;
    pageBox.disabled = !canWrite || init.items.length === 0;
    count.textContent = tr(lang, "cl.picked", { n: picked.size });
    drop.disabled = picked.size === 0;
    purge.textContent = tr(lang, "cl.btn.purge", { n: picked.size });
    purge.disabled = picked.size === 0 || !canWrite;
    purge.title = canWrite ? "" : tr(lang, "cl.err.readonly");
  }
  sync();
  slot.replaceChildren(bar, selection, list, pager);
}
