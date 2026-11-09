// The People page markup (object-model design 9 and 11): the list pane (people, "to be confirmed" names, the inactive) and the
// detail pane of one person (what they owe, the Works they touch, history, contact notes) as one HTML string. The Control UI
// module sanitises this markup against an allow-list, so every clickable thing is a link to a route or a
// `<button data-nx-act data-nx-id>` marker, and every value goes through `esc`. Plain functions with no DOM and no SDK.
// A name is not a key: nothing here merges, guesses or contacts anyone. Contact values are notes the person kept for themselves.
import { renderCommitmentBox, type CommitmentLine } from "./commitment-ui.js";
import type {
  ContactRecord,
  CounterpartRecord,
  CounterpartSummary,
  DismissedName,
  PendingPersonGroup,
  PersonView,
} from "./counterpart/types.js";
import { DEFAULT_LANG, tr, type Lang, type MsgKey } from "./i18n.js";
import { callout, chip, marker, row, section, shortTime, type Tone } from "./ui-kit.js";
import { clip, esc } from "./ui-render.js";

export const PEOPLE_SEGS = ["attention", "pending"] as const;
export type PeopleSeg = (typeof PEOPLE_SEGS)[number];
export const PERSON_TABS = ["responsible", "related", "history"] as const;
export type PersonTab = (typeof PERSON_TABS)[number];

/** The facts the person dialogs are built from (never from the clicked markup). */
export type PersonActionModel = {
  id: string;
  name: string;
  kind: CounterpartRecord["kind"];
  revision: number;
  confirmation: CounterpartRecord["confirmation"];
  isSelf: boolean;
  lifecycle: CounterpartRecord["lifecycle"];
  aliases: readonly string[];
  relation: CounterpartRecord["relation"];
  contacts: readonly ContactRecord[];
  /** The commitments this person answers for (the split dialog offers them); `open` = still open or waiting. */
  commitments: ReadonlyArray<{ id: string; text: string; open: boolean }>;
};

export function personActionModel(
  c: CounterpartRecord,
  commitments: PersonActionModel["commitments"] = [],
): PersonActionModel {
  return {
    id: c.id,
    name: c.displayName,
    kind: c.kind,
    revision: c.revision,
    confirmation: c.confirmation,
    isSelf: c.isSelf,
    lifecycle: c.lifecycle,
    aliases: c.aliases,
    relation: c.relation,
    contacts: c.contacts,
    commitments,
  };
}

export type PeopleCounts = { all: number; attention: number };

export type PeoplePageData = {
  /** The live people loaded so far, most in need of attention first (the server's order); the attention segment holds only those. */
  items: readonly CounterpartSummary[];
  /** How many people each segment holds for the current search (everyone's when nothing is searched). Absent: counted from `items`. */
  counts?: PeopleCounts;
  /** The whole account's numbers, for the greeting (a search does not change what needs the reader's attention). Defaults to `counts`. */
  overall?: PeopleCounts;
  /** The name search of the list pane (blank: none). */
  q?: string;
  /** Typed names with open commitments that point at no one yet. */
  pending: readonly PendingPersonGroup[];
  /** Typed names the user said point at nobody; read only while the pending segment is open. */
  dismissed?: readonly DismissedName[];
  seg?: PeopleSeg;
  tab: PersonTab;
  /** The person shown in the detail pane, if any. */
  view: PersonView | null;
  /** The route named a person that could not be read. */
  missing: boolean;
  /** The route named the person itself (narrow screens then show the detail instead of the list). */
  picked: boolean;
  now: number;
};

export type PeoplePageOptions = {
  /** Render the write buttons. Off when the connection cannot write. */
  actions?: boolean;
  lang?: Lang;
  /** Placeholder link base the module rewrites into host navigation. */
  basePath?: string;
};

const needsLook = (p: CounterpartSummary) => p.overdue > 0 || p.needsConfirmation > 0;

const toneOf = (p: { overdue: number; needsConfirmation: number; unresolved: number }): Tone =>
  p.overdue > 0 ? "rose" : p.needsConfirmation > 0 ? "amber" : p.unresolved > 0 ? "blue" : "gray";

const kindText = (lang: Lang, kind: string): string => tr(lang, `pp.kind.${kind}` as MsgKey);
const relationText = (lang: Lang, c: Pick<CounterpartRecord, "relation">): string =>
  c.relation
    ? `${tr(lang, `pp.rel.${c.relation.relation}` as MsgKey)}${c.relation.scopeLabel ? ` · ${c.relation.scopeLabel}` : ""}`
    : "";

function href(
  base: string,
  id: string | undefined,
  query: { seg?: PeopleSeg | undefined; tab?: PersonTab | undefined; q?: string | undefined },
): string {
  const params = new URLSearchParams();
  if (query.seg) {
    params.set("seg", query.seg);
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

function summaryLine(lang: Lang, p: CounterpartSummary): string {
  const parts = [
    ...(p.unresolved === 0
      ? [tr(lang, "pp.row.none")]
      : [tr(lang, "pp.row.open", { n: p.unresolved })]),
    ...(p.overdue > 0 ? [tr(lang, "pp.row.late", { n: p.overdue })] : []),
    ...(p.needsConfirmation > 0 ? [tr(lang, "pp.row.confirm", { n: p.needsConfirmation })] : []),
    ...(p.confirmation === "stated" ? [tr(lang, "pp.row.stated")] : []),
  ];
  return parts.join(" · ");
}

function personRow(
  p: CounterpartSummary,
  lang: Lang,
  base: string,
  filter: { seg?: PeopleSeg | undefined; q?: string | undefined },
  selected: string | undefined,
): string {
  const meta = relationText(lang, p) || kindText(lang, p.kind);
  return (
    `<a class="nx-wrow nx-t-${toneOf(p)}${p.id === selected ? " on" : ""}" href="${href(base, p.id, filter)}">` +
    `<span class="nx-sd"></span><span class="nx-wm"><span class="nx-wt">` +
    `<span class="nx-wtt">${esc(p.displayName)}</span><span class="nx-wtm">${esc(meta)}</span></span>` +
    `<span class="nx-wnx">${esc(summaryLine(lang, p))}</span></span></a>`
  );
}

/** The person rows of the list pane (what a page of more rows, or a new search, puts in place). */
export function renderPeopleRows(
  people: readonly CounterpartSummary[],
  options: { lang?: Lang; basePath?: string; seg?: PeopleSeg; q?: string; selected?: string },
): string {
  const lang = options.lang ?? DEFAULT_LANG;
  const base = (options.basePath ?? "nexus-nav:").replace(/\/$/, "");
  const filter = { seg: options.seg, q: options.q };
  return people.map((p) => personRow(p, lang, base, filter, options.selected)).join("");
}

function pendingRow(
  group: PendingPersonGroup,
  index: number,
  lang: Lang,
  now: number,
  withActions: boolean,
): string {
  const parts = [
    tr(lang, "pp.row.open", { n: group.open }),
    ...(group.overdue > 0 ? [tr(lang, "pp.row.late", { n: group.overdue })] : []),
    ...(group.earliestDueAt !== null
      ? [tr(lang, "pp.pend.due", { time: shortTime(group.earliestDueAt, now, lang) })]
      : []),
  ];
  const hint =
    group.suggestions.length > 0
      ? `<span class="nx-wnx">${esc(tr(lang, "pp.pend.maybe", { names: group.suggestions.map((s) => s.displayName).join("、") }))}</span>`
      : "";
  return (
    `<div class="nx-wrow nx-prow nx-t-${group.overdue > 0 ? "rose" : "amber"}">` +
    `<span class="nx-sd"></span><span class="nx-wm"><span class="nx-wt">` +
    `<span class="nx-wtt">${esc(group.raw)}</span></span>` +
    `<span class="nx-wnx">${esc(parts.join(" · "))}</span>${hint}</span>` +
    (withActions
      ? marker("pp-claim", `g${index}`, "nx-btn", esc(tr(lang, "pp.pend.claim"))) +
        marker("pp-notperson", `g${index}`, "nx-btn", esc(tr(lang, "pp.pend.not")))
      : "") +
    `</div>`
  );
}

const fold = (text: string): string => text.normalize("NFKC").trim().toLowerCase();

/** The typed names a search leaves in "to confirm" (they are matched by the name as typed), each with its place in the full list. */
function pendingMatches<T extends { raw: string }>(
  all: readonly T[],
  q: string | undefined,
): Array<{ item: T; index: number }> {
  const needle = fold(q ?? "");
  return all
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => needle === "" || fold(item.raw).includes(needle));
}

/** The numbers beside the segments: the server's, or counted from what is loaded when a (test) server sends none. */
function peopleTotals(data: Pick<PeoplePageData, "items" | "counts">): PeopleCounts {
  return {
    all: data.counts?.all ?? data.items.length,
    attention: data.counts?.attention ?? data.items.filter(needsLook).length,
  };
}

/** The pill row of the list pane (what a new search replaces in place, so the numbers follow the search). */
export function renderPeopleSegs(
  data: Pick<PeoplePageData, "items" | "counts" | "pending" | "seg" | "q">,
  lang: Lang,
  base: string,
): string {
  const total = peopleTotals(data);
  const q = data.q || undefined;
  const pill = (to: PeopleSeg | undefined, label: string, count?: number) =>
    `<a class="${data.seg === to ? "on" : ""}" href="${href(base, undefined, { seg: to, q })}">${esc(label)}` +
    `${count === undefined ? "" : `<span class="nx-n">${count}</span>`}</a>`;
  return (
    `<div class="nx-seg">` +
    pill(undefined, tr(lang, "pp.seg.all"), total.all) +
    pill("attention", tr(lang, "pp.seg.attention"), total.attention) +
    pill("pending", tr(lang, "pp.seg.pending"), pendingMatches(data.pending, data.q).length) +
    `</div>`
  );
}

/** The rows of a people segment: the "typed names" note, the people or the empty text (what a new search puts in place). */
export function renderPeopleListRows(
  data: Pick<PeoplePageData, "items" | "pending" | "seg" | "q">,
  lang: Lang,
  base: string,
  selected: string | undefined,
): string {
  const seg = data.seg;
  const q = data.q || undefined;
  const shown = seg === "attention" ? data.items.filter(needsLook) : data.items;
  // From the full list, names that point at no one yet are one click away.
  const note =
    seg === undefined && !q && data.pending.length > 0
      ? `<a class="nx-wrow nx-t-amber" href="${href(base, undefined, { seg: "pending" })}"><span class="nx-sd"></span>` +
        `<span class="nx-wm"><span class="nx-wtt">${esc(tr(lang, "pp.pend.note", { n: data.pending.length }))}</span></span></a>`
      : "";
  const emptyKey: MsgKey = q
    ? "pp.empty.search"
    : seg === "attention"
      ? "pp.empty.attention"
      : "pp.empty.all";
  return (
    note +
    (shown.length === 0
      ? `<p class="nx-wempty">${esc(tr(lang, emptyKey))}` +
        // A search that finds no one offers the way back: the same segment without the search.
        (q
          ? ` <a href="${href(base, undefined, { seg })}">${esc(tr(lang, "pp.empty.clear"))}</a>`
          : "") +
        `</p>`
      : renderPeopleRows(shown, {
          lang,
          basePath: base,
          ...(seg ? { seg } : {}),
          ...(q ? { q } : {}),
          ...(selected ? { selected } : {}),
        }))
  );
}

function listPane(
  data: PeoplePageData,
  lang: Lang,
  base: string,
  selected: string | undefined,
  withActions: boolean,
): string {
  const seg = data.seg;
  const total = peopleTotals(data);
  const hello =
    (data.overall?.attention ?? total.attention) > 0
      ? tr(lang, "pp.hello.attention", { n: data.overall?.attention ?? total.attention })
      : tr(lang, "pp.hello.none");
  const segs = renderPeopleSegs(data, lang, base);
  let rows: string;
  if (seg === "pending") {
    const found = pendingMatches(data.pending, data.q);
    const q = data.q || undefined;
    rows =
      found.length === 0
        ? `<p class="nx-wempty">${esc(tr(lang, q ? "pp.empty.search" : "pp.pend.empty"))}` +
          // A search that finds no one offers the way back: the same segment without the search.
          (q
            ? ` <a href="${href(base, undefined, { seg: "pending" })}">${esc(tr(lang, "pp.empty.clear"))}</a>`
            : "") +
          `</p>`
        : found
            .map(({ item, index }) => pendingRow(item, index, lang, data.now, withActions))
            .join("");
    const ignored = pendingMatches(data.dismissed ?? [], data.q);
    if (ignored.length > 0) {
      rows +=
        `<p class="nx-hello">${esc(tr(lang, "pp.dis.title"))}</p>` +
        `<p class="nx-cm-hint">${esc(tr(lang, "pp.dis.note"))}</p>` +
        ignored
          .map(
            ({ item: entry, index }) =>
              `<div class="nx-wrow nx-prow"><span class="nx-wm"><span class="nx-wtt">${esc(entry.raw)}</span></span>` +
              (withActions
                ? marker("pp-undismiss", `d${index}`, "nx-btn", esc(tr(lang, "pp.dis.restore")))
                : "") +
              `</div>`,
          )
          .join("");
    }
  } else {
    rows = renderPeopleListRows(data, lang, base, selected);
  }
  return (
    `<div class="nx-wlist"><div class="nx-lh"><div class="nx-lhr"><h1>${esc(tr(lang, "pp.title"))}</h1>` +
    (withActions ? marker("pp-new", undefined, "nx-btn", esc(tr(lang, "pp.add"))) : "") +
    `</div><p class="nx-hello">${esc(hello)}</p>` +
    // The search box is built by the page (it is a form control) and moved into this empty slot after every mount. It stays on
    // every segment so switching segments does not move the layout; on "to confirm" it searches the typed names.
    `<div class="nx-search-slot"></div></div>${segs}` +
    `<div class="nx-rows">${rows}</div></div>`
  );
}

function contactRows(c: CounterpartRecord, lang: Lang, withActions: boolean): string[] {
  const rows = c.contacts.map((contact, index) =>
    row(
      `<span class="nx-grow">${esc(contact.label)}：${esc(contact.value)}</span>` +
        (withActions
          ? marker("pp-cmove", `c${index}`, "nx-btn", esc(tr(lang, "pp.btn.cmove"))) +
            marker("pp-cdel", `c${index}`, "nx-btn", esc(tr(lang, "pp.btn.cdel")))
          : ""),
    ),
  );
  return [
    ...rows,
    `<p class="nx-cm-hint">${esc(tr(lang, c.contacts.length === 0 ? "pp.contact.none" : "pp.contact.note"))}</p>`,
  ];
}

function boxes(
  lines: readonly CommitmentLine[],
  lang: Lang,
  now: number,
  base: string,
  withActions: boolean,
  emptyKey: MsgKey,
): string[] {
  return lines.length === 0
    ? [`<p class="nx-wempty">${esc(tr(lang, emptyKey))}</p>`]
    : lines.map((line) =>
        renderCommitmentBox(line, lang, now, withActions, { base, attach: true, linkWho: false }),
      );
}

const viaText = (lang: Lang, via: string) =>
  via === "commitment" || via === "participant" ? tr(lang, `pp.via.${via}` as MsgKey) : via;

function tabBody(
  view: PersonView,
  data: PeoplePageData,
  lang: Lang,
  base: string,
  withActions: boolean,
): string {
  const c = view.counterpart;
  const live = c.lifecycle === "live";
  const line = (record: CommitmentLine["commitment"]): CommitmentLine => ({
    commitment: record,
    role: null,
    linkId: null,
  });
  if (data.tab === "related") {
    const rows = view.related.map((work) =>
      row(
        `<span class="nx-grow"><a href="${esc(`${base}/works/${work.workId}`)}">${esc(clip(work.title, 120))}</a></span>` +
          `<span class="nx-meta">${esc(viaText(lang, work.via))} · ${esc(shortTime(work.updatedAt, data.now, lang))}</span>`,
      ),
    );
    return section(
      tr(lang, "pp.sec.related"),
      rows.length > 0 ? rows : [`<p class="nx-wempty">${esc(tr(lang, "pp.related.empty"))}</p>`],
    );
  }
  if (data.tab === "history") {
    return section(
      tr(lang, "pp.sec.history"),
      boxes(view.history.map(line), lang, data.now, base, withActions, "pp.history.empty"),
    );
  }
  const record =
    withActions && live ? marker("pp-record", c.id, "nx-btn", esc(tr(lang, "pp.btn.record"))) : "";
  return section(
    tr(lang, "pp.sec.resp"),
    boxes(view.responsible.map(line), lang, data.now, base, withActions, "pp.resp.empty"),
    record,
  );
}

function detailPane(data: PeoplePageData, lang: Lang, base: string, withActions: boolean): string {
  const back = `<a class="nx-back" href="${href(base, undefined, { seg: data.seg, q: data.q || undefined })}">${esc(tr(lang, "work.d.back"))}</a>`;
  const view = data.view;
  if (!view) {
    const text = data.missing
      ? tr(lang, "pp.d.missing")
      : data.seg === "pending"
        ? tr(lang, "pp.pend.explain")
        : (data.counts?.all ?? data.items.length) + data.pending.length === 0
          ? tr(lang, "pp.d.first")
          : tr(lang, "pp.d.pick");
    return `<div class="nx-detail"><div class="nx-dw"><div class="nx-top">${back}</div><p class="nx-wempty">${esc(text)}</p></div></div>`;
  }
  const { counterpart: c, counts } = view;
  const id = c.id;
  const live = c.lifecycle === "live";
  const ib = (act: string, key: MsgKey) => marker(act, id, "nx-ib", esc(tr(lang, key)));
  const top =
    withActions && !c.isSelf
      ? [
          ...(c.lifecycle === "merged" || c.lifecycle === "deleted"
            ? []
            : [ib("pp-edit", "pp.btn.edit")]),
          ...(live ? [ib("pp-merge", "pp.btn.merge"), ib("pp-split", "pp.btn.split")] : []),
          ...(live
            ? [ib("pp-off", "pp.btn.off")]
            : c.lifecycle === "inactive"
              ? [ib("pp-on", "pp.btn.on")]
              : []),
        ].join("")
      : "";
  const tone = toneOf(counts);
  const relation = relationText(lang, c);
  const stat = (n: number, key: MsgKey, late = false) =>
    `<div class="nx-pn${late && n > 0 ? " nx-pn-late" : ""}"><span class="nx-pnn">${n}</span><span class="nx-pnl">${esc(tr(lang, key))}</span></div>`;
  const notes: string[] = [];
  if (c.confirmation === "stated" && live) {
    notes.push(
      callout(
        "amber",
        `<p>${esc(tr(lang, "pp.stated.note"))}</p>` +
          (withActions
            ? `<p>${marker("pp-confirm", id, "nx-btn", esc(tr(lang, "pp.btn.confirm")))}</p>`
            : ""),
      ),
    );
  }
  if (c.lifecycle === "merged" && c.mergedInto) {
    notes.push(
      callout(
        "plain",
        `<p>${esc(tr(lang, "pp.merged.note"))}</p>` +
          `<p><a href="${href(base, c.mergedInto, {})}">${esc(tr(lang, "pp.merged.go"))}</a></p>`,
      ),
    );
  } else if (c.lifecycle === "deleted") {
    notes.push(callout("plain", `<p>${esc(tr(lang, "pp.purged.note"))}</p>`));
  } else if (!live) {
    notes.push(
      callout(
        "plain",
        `<p>${esc(tr(lang, "pp.off.note", { reason: c.inactiveReason ?? "-" }))}</p>`,
      ),
    );
  }
  const profile = [
    ...(c.aliases.length > 0
      ? [
          row(
            `<span class="nx-grow">${esc(tr(lang, "pp.alias", { names: c.aliases.join("、") }))}</span>`,
          ),
        ]
      : []),
    ...contactRows(c, lang, withActions && live),
  ];
  const addContact =
    withActions && live ? marker("pp-contact", id, "nx-btn", esc(tr(lang, "pp.btn.cadd"))) : "";
  const tab = (to: PersonTab, key: MsgKey, n: number) =>
    `<a class="${data.tab === to ? "on" : ""}" href="${href(base, id, { seg: data.seg, tab: to, q: data.q || undefined })}">${esc(tr(lang, key))}<span class="nx-n">${n}</span></a>`;
  return (
    `<div class="nx-detail"><div class="nx-dw">` +
    `<div class="nx-top">${back}<span>${esc(kindText(lang, c.kind))}</span>` +
    `<span>·</span><span>${esc(tr(lang, "work.d.updated", { time: shortTime(c.updatedAt, data.now, lang) }))}</span>` +
    `<span class="nx-sp"></span>${top}</div>` +
    `<h1 class="nx-wtitle">${esc(c.displayName)}</h1>` +
    `<div class="nx-why">` +
    (c.isSelf ? chip("accent", tr(lang, "pp.chip.self")) : "") +
    (c.confirmation === "confirmed"
      ? chip("green", tr(lang, "pp.chip.confirmed"))
      : chip("amber", tr(lang, "pp.chip.stated"))) +
    (live
      ? ""
      : c.lifecycle === "merged"
        ? chip("gray", tr(lang, "pp.chip.merged"))
        : chip("gray", tr(lang, "pp.chip.inactive"))) +
    (relation ? `<span>${esc(relation)}</span>` : "") +
    `</div>` +
    `<div class="nx-hero nx-pst nx-t-${tone}">` +
    stat(counts.unresolved, "pp.stat.open") +
    stat(counts.overdue, "pp.stat.late", true) +
    stat(counts.needsConfirmation, "pp.stat.confirm") +
    `</div>` +
    notes.join("") +
    section(tr(lang, "pp.sec.profile"), profile, addContact) +
    `<div class="nx-seg nx-ptabs">` +
    tab("responsible", "pp.tab.resp", view.responsible.length) +
    tab("related", "pp.tab.related", view.related.length) +
    tab("history", "pp.tab.history", view.history.length) +
    `</div>` +
    tabBody(view, data, lang, base, withActions) +
    `</div></div>`
  );
}

export function renderPeoplePage(data: PeoplePageData, options: PeoplePageOptions = {}): string {
  const lang = options.lang ?? DEFAULT_LANG;
  const base = (options.basePath ?? "nexus-nav:").replace(/\/$/, "");
  const withActions = options.actions === true;
  const selected = data.view?.counterpart.id;
  return (
    `<div class="nx-works nx-people ${data.picked ? "nx-picked" : "nx-auto"}">` +
    `${listPane(data, lang, base, selected, withActions)}${detailPane(data, lang, base, withActions)}</div>`
  );
}
