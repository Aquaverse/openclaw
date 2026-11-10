// The "names to confirm" segment of the People page (W3c-8). Typed names that point at no one yet are listed like people: one
// compact row each on the left (so a long list stays short), and the work to do with a name — its commitments as cards, "assign
// to…", "not a person", "decide who answers" — in the detail pane on the right. Plain functions with no DOM and no SDK.
import { renderCommitmentBox, type CommitmentLine } from "./commitment-ui.js";
import type { DismissedName, PendingPersonGroup } from "./counterpart/types.js";
import { tr, type Lang } from "./i18n.js";
import { peopleHref } from "./people-href.js";
import { callout, chip, marker, section, shortTime } from "./ui-kit.js";
import { esc } from "./ui-render.js";

/** Rows shown before the reader scrolls for more (the same page size as the people list). */
export const PENDING_PAGE_SIZE = 50;

/** The page data the "to confirm" segment needs. */
export type PendingPageData = {
  pending: readonly PendingPersonGroup[];
  dismissed?: readonly DismissedName[];
  q?: string;
  /** The key of the typed name shown in the detail pane. */
  pendingKey?: string;
  /** The cards of that name's commitments. */
  pendingLines?: readonly CommitmentLine[];
  /** How many rows the first render lists (default one page; a reload keeps the pages already scrolled in). */
  pendingRows?: number;
  now: number;
};

const fold = (text: string): string => text.normalize("NFKC").trim().toLowerCase();

/** The typed names a search leaves in "to confirm" (matched by the name as typed), each with its place in the full list. */
export function pendingMatches<T extends { raw: string }>(
  all: readonly T[],
  q: string | undefined,
): Array<{ item: T; index: number }> {
  const needle = fold(q ?? "");
  return all
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => needle === "" || fold(item.raw).includes(needle));
}

function metaText(group: PendingPersonGroup, lang: Lang, now: number): string {
  return [
    tr(lang, "pp.row.open", { n: group.open }),
    ...(group.overdue > 0 ? [tr(lang, "pp.row.late", { n: group.overdue })] : []),
    ...(group.earliestDueAt !== null
      ? [tr(lang, "pp.pend.due", { time: shortTime(group.earliestDueAt, now, lang) })]
      : []),
    ...(group.joint ? [tr(lang, "pp.row.joint")] : []),
  ].join(" · ");
}

/** The rows of the list: one line per typed name, a link that chooses it (what a page of more rows puts in place). */
export function renderPendingRows(
  entries: ReadonlyArray<{ item: PendingPersonGroup }>,
  options: { lang: Lang; base: string; now: number; q?: string | undefined; selected?: string },
): string {
  return entries
    .map(({ item: group }) => {
      const link = peopleHref(options.base, undefined, {
        seg: "pending",
        typed: group.key,
        q: options.q,
      });
      return (
        `<a class="nx-wrow nx-prow nx-t-${group.overdue > 0 ? "rose" : "amber"}${group.key === options.selected ? " on" : ""}" href="${link}">` +
        `<span class="nx-sd"></span><span class="nx-wm"><span class="nx-wt">` +
        `<span class="nx-wtt">${esc(group.raw)}</span></span>` +
        `<span class="nx-wnx">${esc(metaText(group, options.lang, options.now))}</span></span></a>`
      );
    })
    .join("");
}

/** The list pane's rows of the segment: the first page of the names the search leaves, or the empty text. */
export function renderPendingListRows(data: PendingPageData, lang: Lang, base: string): string {
  const found = pendingMatches(data.pending, data.q);
  const q = data.q || undefined;
  if (found.length === 0) {
    return (
      `<p class="nx-wempty">${esc(tr(lang, q ? "pp.empty.search" : "pp.pend.empty"))}` +
      // A search that finds no one offers the way back: the same segment without the search.
      (q
        ? ` <a href="${peopleHref(base, undefined, { seg: "pending" })}">${esc(tr(lang, "pp.empty.clear"))}</a>`
        : "") +
      `</p>`
    );
  }
  const shown = Math.max(PENDING_PAGE_SIZE, data.pendingRows ?? 0);
  return renderPendingRows(found.slice(0, shown), {
    lang,
    base,
    now: data.now,
    q,
    ...(data.pendingKey ? { selected: data.pendingKey } : {}),
  });
}

function dismissedBlock(data: PendingPageData, lang: Lang, withActions: boolean): string {
  const ignored = data.dismissed ?? [];
  if (ignored.length === 0) {
    return "";
  }
  return (
    `<p class="nx-hello">${esc(tr(lang, "pp.dis.title"))}</p>` +
    `<p class="nx-cm-hint">${esc(tr(lang, "pp.dis.note"))}</p>` +
    ignored
      .map(
        (entry, index) =>
          `<div class="nx-wrow nx-prow"><span class="nx-wm"><span class="nx-wtt">${esc(entry.raw)}</span></span>` +
          (withActions
            ? marker("pp-undismiss", `d${index}`, "nx-btn", esc(tr(lang, "pp.dis.restore")))
            : "") +
          `</div>`,
      )
      .join("")
  );
}

/** The detail pane of the segment: the chosen name with its commitments and buttons, or what to do here when none is chosen. */
export function renderPendingDetail(
  data: PendingPageData,
  lang: Lang,
  base: string,
  withActions: boolean,
): string {
  const back = `<a class="nx-back" href="${peopleHref(base, undefined, { seg: "pending", q: data.q || undefined })}">${esc(tr(lang, "work.d.back"))}</a>`;
  const index = data.pending.findIndex((group) => group.key === data.pendingKey);
  const group = index >= 0 ? data.pending[index] : undefined;
  if (!group) {
    return (
      `<div class="nx-detail"><div class="nx-dw"><div class="nx-top">${back}</div>` +
      `<p class="nx-wempty">${esc(tr(lang, data.pending.length === 0 ? "pp.pend.empty" : "pp.pend.pick"))}</p>` +
      `<p class="nx-cm-hint">${esc(tr(lang, "pp.pend.explain"))}</p>` +
      dismissedBlock(data, lang, withActions) +
      `</div></div>`
    );
  }
  const lines = data.pendingLines ?? [];
  const ib = (act: string, key: "pp.pend.claim" | "pp.pend.not") =>
    marker(act, `g${index}`, "nx-ib", esc(tr(lang, key)));
  // A name that stands for several people cannot be assigned to one person: "decide who answers" is on its commitments.
  const top =
    withActions && !group.joint
      ? ib("pp-claim", "pp.pend.claim") + ib("pp-notperson", "pp.pend.not")
      : "";
  const notes = group.joint
    ? callout("amber", `<p>${esc(tr(lang, "pp.pending.joint"))}</p>`)
    : group.suggestions.length > 0
      ? callout(
          "plain",
          `<p>${esc(tr(lang, "pp.pend.maybe", { names: group.suggestions.map((s) => s.displayName).join("、") }))}</p>`,
        )
      : "";
  // A "several people" name lists the ones that need "who answers"; the rest of it is counted by the server.
  const more = (group.joint ? (group.jointOpen ?? group.open) : group.open) - lines.length;
  const cards = [
    ...lines.map((line) =>
      renderCommitmentBox(line, lang, data.now, withActions, {
        base,
        attach: true,
        linkWho: false,
      }),
    ),
    ...(lines.length > 0 && more > 0
      ? [`<p class="nx-cm-hint">${esc(tr(lang, "pp.pend.cardsMore", { n: more }))}</p>`]
      : []),
  ];
  return (
    `<div class="nx-detail"><div class="nx-dw">` +
    `<div class="nx-top">${back}<span>${esc(tr(lang, "pp.pend.tag"))}</span><span class="nx-sp"></span>${top}</div>` +
    `<h1 class="nx-wtitle">${esc(group.raw)}</h1>` +
    `<div class="nx-why">${chip(group.overdue > 0 ? "rose" : "amber", tr(lang, "pp.pend.tag"))}` +
    `<span>${esc(metaText(group, lang, data.now))}</span></div>` +
    notes +
    (cards.length > 0 ? section(tr(lang, "pp.pend.sec"), cards) : "") +
    `</div></div>`
  );
}
