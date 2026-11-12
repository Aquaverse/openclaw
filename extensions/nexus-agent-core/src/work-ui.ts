// The Work page markup (object-model design 11.2 and 11.3): the list pane and the detail pane as one HTML string. The
// Control UI module sanitises this markup against an allow-list, so every clickable thing is a link to a route or a
// `<button data-nx-act data-nx-id>` marker, and every value goes through `esc`. Plain functions with no DOM and no SDK.
// States are written in words (the enum values never reach the screen) and every text is a catalog key.
import { renderCommitmentSection, type CommitmentLine } from "./commitment-ui.js";
import { renderFollowSection, type FollowUpData } from "./follow-ui.js";
import { allMessageKeys, DEFAULT_LANG, tr, type Lang, type MsgKey } from "./i18n.js";
import type { DecisionRecord } from "./store/decision-types.js";
import type { WorkView } from "./store/work-facts.js";
import {
  callout,
  chip,
  kv,
  marker,
  row,
  section,
  shortTime,
  timeline,
  type Tone,
} from "./ui-kit.js";
import { clip, esc } from "./ui-render.js";
import type { NextStep, WorkPrimaryState, WorkState } from "./work/types.js";

export type WorkLinkLine = {
  id: string;
  role: string;
  targetKind: string;
  targetId: string;
  /** The name of what the link points at (a Work's title, a Commitment's requirement, ...); null when it cannot be read. */
  targetTitle?: string | null;
  purpose: string | null;
  createdAt: number;
  endedAt: number | null;
  endBasis: string | null;
};
export type WorkEventLine = {
  id: string;
  seq: number;
  kind: string;
  actor: string;
  createdAt: number;
};
export type WorkControlLine = {
  id: string;
  scopeKind: string;
  scopeId: string | null;
  state: string;
  reason: string | null;
  reconcileOnly: boolean;
  createdAt: number;
};
/** What `nexus.work.get` returns: the Work view plus its links, history and the controls still in force. */
export type WorkDetail = WorkView & {
  /** The title of the Goal this Work serves, when there is one. */
  goalTitle?: string | null;
  links: WorkLinkLine[];
  events: WorkEventLine[];
  controls: WorkControlLine[];
  /** The Commitments this Work cites; absent when commitments are not switched on (the block is then not drawn). */
  commitments?: readonly CommitmentLine[];
  /** The follow-up plans and schedules of this Work; absent when plans are not available (the block is then not drawn). */
  followUp?: FollowUpData;
};

/** The facts the action dialogs are built from (never from the clicked markup). */
export type WorkActionModel = {
  id: string;
  title: string;
  revision: number;
  hidden: boolean;
  primary: WorkPrimaryState;
  ended: boolean;
  controls: readonly WorkControlLine[];
};

export function workActionModel(detail: WorkDetail): WorkActionModel {
  return {
    id: detail.work.id,
    title: detail.work.title,
    revision: detail.work.revision,
    hidden: detail.work.hidden,
    primary: detail.state.primary,
    ended: detail.terminal !== null,
    controls: detail.controls,
  };
}

export type WorkCounts = {
  total: number;
  counts: Record<WorkPrimaryState, number>;
  hiddenCount: number;
};

/** The part of a pending decision the Work page shows (the decision dialog reads the full record from the page model). */
export type WorkDecisionLine = Pick<
  DecisionRecord,
  "id" | "taskId" | "question" | "facts" | "deadlineAt" | "riskTier"
>;

export type WorksPageData = {
  /** The numbers beside the segments: what the current search finds (the whole account's when nothing is searched). */
  counts: WorkCounts;
  /** The whole account's numbers, for the greeting; defaults to `counts`. */
  overall?: WorkCounts;
  works: readonly WorkView[];
  /** Decisions waiting for the person, across all the listed Works (a row and the ask card read them). */
  decisions?: readonly WorkDecisionLine[];
  /** The route's filter. */
  state?: WorkPrimaryState;
  q?: string;
  /** The Work shown in the detail pane, if any. */
  detail: WorkDetail | null;
  /** The route named a Work that could not be read. */
  missing: boolean;
  /** The route named the Work itself (narrow screens then show the detail instead of the list). */
  picked: boolean;
  now: number;
};

export type WorksPageOptions = {
  /** Render the write buttons. Off when the connection cannot write. */
  actions?: boolean;
  lang?: Lang;
  /** Placeholder link base the module rewrites into host navigation. */
  basePath?: string;
};

const GROUP_ORDER = ["needs_you", "blocked", "in_progress", "done", "ended_incomplete"] as const;
const SEGMENTS = [undefined, ...GROUP_ORDER] as const;
/** How many label / value facts the ask card shows (the dialog has the rest). */
const MAX_FACTS = 6;
const KEYS = new Set<string>(allMessageKeys());

/** A catalog text chosen by a runtime code; a code this version does not know shows as itself instead of failing. */
function coded(
  lang: Lang,
  prefix: string,
  code: string,
  vars: Record<string, string | number> = {},
) {
  const key = `${prefix}${code}`;
  return KEYS.has(key) ? tr(lang, key as MsgKey, vars) : code;
}

function nextStepText(lang: Lang, step: NextStep, now: number): string {
  return step.kind === "wait_until"
    ? tr(lang, "work.next.wait_until", { time: shortTime(step.at, now, lang) })
    : coded(lang, "work.next.", step.kind);
}

function progressText(lang: Lang, view: WorkView): string {
  const steps = view.tasks.filter((task) => !task.superseded);
  if (steps.length === 0) {
    return tr(lang, "work.progress.none");
  }
  const done = steps.filter((task) => task.phase === "completed").length;
  return tr(lang, "work.progress.steps", { done, total: steps.length });
}

/** The tone of a state: the colour of the list dot, the pill and the progress ring. */
function toneOf(state: WorkState): Tone {
  switch (state.primary) {
    case "done":
      return "green";
    case "ended_incomplete":
      return "gray";
    case "needs_you":
      return "amber";
    case "blocked":
      return state.blockedKind === "paused"
        ? "gray"
        : state.blockedKind === "reconciling"
          ? "amber"
          : "rose";
    default:
      return "blue";
  }
}

/** The word of the pill. A blocked Work shows its real first cause (paused / being checked / blocked). */
function stateLabel(lang: Lang, state: WorkState): string {
  switch (state.primary) {
    case "done":
      return tr(lang, "work.chip.done");
    case "ended_incomplete":
      return tr(lang, "work.chip.ended");
    case "needs_you":
      return tr(lang, "work.chip.needs_you");
    case "blocked":
      return state.blockedKind === "paused"
        ? tr(lang, "work.chip.paused")
        : state.blockedKind === "reconciling"
          ? tr(lang, "work.chip.reconciling")
          : tr(lang, "work.chip.blocked");
    default:
      return tr(lang, "work.chip.in_progress");
  }
}

const stateChip = (lang: Lang, state: WorkState): string =>
  chip(toneOf(state), stateLabel(lang, state));

const terminalText = (lang: Lang, reason: string) => coded(lang, "work.terminal.", reason);

/** One sentence about the state, without the closing full stop. */
function statusLine(lang: Lang, view: WorkView, now: number): string {
  const { state } = view;
  let text: string;
  switch (state.primary) {
    case "needs_you":
      text =
        state.nextStep.kind === "none"
          ? progressText(lang, view)
          : nextStepText(lang, state.nextStep, now);
      break;
    case "blocked": {
      const first = state.reasons[0];
      text = first ? coded(lang, "work.reason.", first.code) : progressText(lang, view);
      break;
    }
    case "done":
      text = view.outcome
        ? tr(lang, "work.means.achieved", {
            time: shortTime(view.outcome.firstAchievedAt ?? view.outcome.recordedAt, now, lang),
          })
        : progressText(lang, view);
      break;
    case "ended_incomplete":
      text = view.terminal ? terminalText(lang, view.terminal.reason) : progressText(lang, view);
      break;
    default:
      text = progressText(lang, view);
  }
  return text.replace(/[。.]$/u, "");
}

/** The decisions of the page that belong to one of the Work's steps. */
function pendingFor(
  view: WorkView,
  decisions: readonly WorkDecisionLine[] | undefined,
): WorkDecisionLine[] {
  if (!decisions || decisions.length === 0) {
    return [];
  }
  const ids = new Set(view.tasks.map((task) => task.id));
  return decisions.filter((decision) => ids.has(decision.taskId));
}

/** Flat label / value facts of a decision, as the person should read them (nested values are left to the dialog). */
function factPairs(facts: unknown): [string, string][] {
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
    return [];
  }
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(facts)) {
    if (out.length >= MAX_FACTS) {
      break;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out.push([clip(key, 40), esc(clip(String(value), 160))]);
    }
  }
  return out;
}

function link(base: string, path: string, filter: { state?: string; q?: string }): string {
  const query = new URLSearchParams();
  if (filter.state) {
    query.set("state", filter.state);
  }
  if (filter.q) {
    query.set("q", filter.q);
  }
  const text = query.toString();
  return esc(`${base}${path}${text ? `?${text}` : ""}`);
}

type RowsData = Pick<WorksPageData, "decisions" | "now" | "state" | "q">;

function renderRow(
  view: WorkView,
  data: RowsData,
  lang: Lang,
  base: string,
  selected: string | undefined,
): string {
  // A waiting decision is the most useful line a row can carry: it says what the person is asked, not that they are asked.
  const asked =
    view.state.primary === "needs_you" ? pendingFor(view, data.decisions)[0]?.question : undefined;
  const line = asked ? clip(asked, 80) : statusLine(lang, view, data.now);
  return (
    `<a class="nx-wrow nx-t-${toneOf(view.state)}${view.work.id === selected ? " on" : ""}" href="${link(base, `/works/${view.work.id}`, data)}">` +
    `<span class="nx-sd"></span><span class="nx-wm"><span class="nx-wt">` +
    `<span class="nx-wtt">${esc(view.work.title)}</span>` +
    `<span class="nx-wtm">${esc(shortTime(view.work.updatedAt, data.now, lang))}</span></span>` +
    `<span class="nx-wnx">${esc(line)}</span></span></a>`
  );
}

export type WorkListOptions = {
  lang?: Lang;
  /** Placeholder link base the module rewrites into host navigation. */
  basePath?: string;
  /** The Work shown in the detail pane (its row is marked). */
  selected?: string;
};

/**
 * Rows of some Works. The list arrives ordered by state, so a group heading is written wherever the state changes; `after`
 * is the state of the row above (when the rows continue an earlier page) so a heading is not repeated. With a state chosen
 * there are no headings. `last` is the state of the final row, for the next page.
 */
export function renderWorkRows(
  works: readonly WorkView[],
  data: RowsData,
  options: WorkListOptions & { after?: WorkPrimaryState } = {},
): { html: string; last: WorkPrimaryState | undefined } {
  const lang = options.lang ?? DEFAULT_LANG;
  const base = options.basePath ?? "nexus-nav:";
  let last = options.after;
  let html = "";
  for (const view of works) {
    if (!data.state && view.state.primary !== last) {
      html += `<div class="nx-gh">${esc(tr(lang, `work.group.${view.state.primary}`))}</div>`;
    }
    last = view.state.primary;
    html += renderRow(view, data, lang, base, options.selected);
  }
  return { html, last };
}

/** The pill row and the rows of the list pane (what a search or a page of more rows replaces in place). */
export function renderWorkList(
  data: Pick<WorksPageData, "counts" | "works" | "state" | "q" | "decisions" | "now">,
  options: WorkListOptions = {},
): { seg: string; rows: string } {
  const lang = options.lang ?? DEFAULT_LANG;
  const base = options.basePath ?? "nexus-nav:";
  const segments = SEGMENTS.map((state) => {
    const n = state === undefined ? data.counts.total : data.counts.counts[state];
    const label = tr(lang, state === undefined ? "work.seg.all" : `work.seg.${state}`);
    const on = data.state === state ? ' class="on"' : "";
    return `<a${on} href="${link(base, "/works", { ...(state ? { state } : {}), ...(data.q ? { q: data.q } : {}) })}">${esc(label)}<span class="nx-n">${n}</span></a>`;
  }).join("");
  let body: string;
  if (data.works.length === 0) {
    body =
      data.counts.total === 0 && !data.q && !data.state
        ? `<p class="nx-wempty">${esc(tr(lang, "work.empty.none"))}</p>`
        : `<p class="nx-wempty">${esc(tr(lang, "work.empty.filtered"))} <a href="${link(base, "/works", {})}">${esc(tr(lang, "work.empty.clear"))}</a></p>`;
  } else {
    body = renderWorkRows(data.works, data, options).html;
  }
  const hidden =
    data.counts.hiddenCount > 0
      ? `<p class="nx-wfoot">${esc(tr(lang, "work.hidden", { n: data.counts.hiddenCount }))}</p>`
      : "";
  return { seg: `<div class="nx-seg">${segments}</div>`, rows: `${body}${hidden}` };
}

function listPane(
  data: WorksPageData,
  lang: Lang,
  base: string,
  selected: string | undefined,
): string {
  const list = renderWorkList(data, { lang, basePath: base, ...(selected ? { selected } : {}) });
  const waiting = (data.overall ?? data.counts).counts.needs_you;
  const hello =
    waiting > 0 ? tr(lang, "work.hello.needs", { n: waiting }) : tr(lang, "work.hello.none");
  // The search box is built by the page (it is a form control) and moved into this empty slot after every mount.
  return (
    `<div class="nx-wlist"><div class="nx-lh"><h1>${esc(tr(lang, "work.list.title"))}</h1>` +
    `<p class="nx-hello">${esc(hello)}</p><div class="nx-search-slot"></div></div>` +
    `${list.seg}<div class="nx-rows">${list.rows}</div></div>`
  );
}

function meansText(lang: Lang, detail: WorkDetail, now: number): string {
  if (detail.terminal) {
    return tr(lang, "work.means.ended", {
      time: shortTime(detail.terminal.recordedAt, now, lang),
      reason: terminalText(lang, detail.terminal.reason),
    });
  }
  if (detail.outcome) {
    return tr(lang, "work.means.achieved", {
      time: shortTime(detail.outcome.firstAchievedAt ?? detail.outcome.recordedAt, now, lang),
    });
  }
  return tr(lang, "work.means.migrated");
}

/** How a step reads as a completion criterion: met, in the person's or the world's hands, not started, or missed. */
function criterionOf(phase: string): "ok" | "wait" | "todo" | "miss" {
  switch (phase) {
    case "completed":
      return "ok";
    case "failed":
    case "cancelled":
    case "partial":
      return "miss";
    case "running":
    case "waiting_input":
    case "waiting_approval":
    case "blocked":
      return "wait";
    default:
      return "todo";
  }
}

const CRITERION_MARK = { ok: "✓", miss: "✕", wait: "", todo: "" } as const;

function criteriaSection(detail: WorkDetail, lang: Lang, base: string): string {
  const steps = detail.tasks.filter((task) => !task.superseded);
  const rows =
    steps.length > 0
      ? steps.map((task) => {
          const kind = criterionOf(task.phase);
          return row(
            `<span class="nx-ck nx-ck-${kind}">${CRITERION_MARK[kind]}</span>` +
              `<span class="nx-grow"><a class="nx-step-t" href="${esc(`${base}/tasks/${task.id}`)}">${esc(task.title)}</a></span>` +
              `<span class="nx-meta">${esc(coded(lang, "work.phase.", task.phase))}</span>`,
          );
        })
      : [row(`<span class="nx-meta">${esc(tr(lang, "work.progress.none"))}</span>`)];
  return section(
    tr(lang, "work.sec.criteria"),
    rows,
    `<span class="nx-hint">${esc(tr(lang, "work.criteria.hint"))}</span>`,
  );
}

/** The one thing the person is asked to do, if anything: a waiting decision, or the Work's own next step. */
function askCard(
  detail: WorkDetail,
  data: WorksPageData,
  lang: Lang,
  base: string,
  withActions: boolean,
): string {
  const { state } = detail;
  const pending = pendingFor(detail, data.decisions);
  const first = pending[0];
  if (first) {
    const pairs = factPairs(first.facts);
    const more =
      pending.length > 1
        ? `<span class="nx-note">${esc(tr(lang, "work.ask.moreDecisions", { n: pending.length - 1 }))}</span>`
        : "";
    const until =
      first.deadlineAt !== null
        ? `<span class="nx-note">${esc(tr(lang, "work.ask.until", { time: shortTime(first.deadlineAt, data.now, lang) }))}</span>`
        : "";
    return (
      `<div class="nx-ask"><p class="nx-lab">${esc(tr(lang, "work.ask.decide"))}</p>` +
      `<p class="nx-askt">${esc(clip(first.question, 280))}</p>` +
      (pairs.length > 0 ? `<div class="nx-askf">${kv(pairs)}</div>` : "") +
      `<div class="nx-acts">${withActions ? marker("decision", first.id, "nx-pb", esc(tr(lang, "work.ask.open"))) : ""}${until}${more}</div></div>`
    );
  }
  if (state.primary !== "needs_you" || state.nextStep.kind === "none") {
    return "";
  }
  const waiting = detail.tasks.find(
    (task) =>
      !task.superseded && (task.phase === "waiting_input" || task.phase === "waiting_approval"),
  );
  return (
    `<div class="nx-ask"><p class="nx-lab">${esc(
      tr(lang, state.nextStep.kind === "provide_input" ? "work.ask.input" : "work.ask.other"),
    )}</p><p class="nx-askt">${esc(nextStepText(lang, state.nextStep, data.now))}</p>` +
    (waiting
      ? `<div class="nx-acts"><a class="nx-pb" href="${esc(`${base}/tasks/${waiting.id}`)}">${esc(tr(lang, "work.ask.openStep"))}</a></div>`
      : "") +
    `</div>`
  );
}

/** What the person wanted, in words: the stated result, else the request; arguments an agent stored as JSON are not words. */
function wantedText(detail: WorkDetail): string {
  const spoken = (text: string | null) => (text && !/^\s*[{[]/u.test(text) ? text : undefined);
  return spoken(detail.work.outcomeText) ?? spoken(detail.work.requestText) ?? detail.work.title;
}

function detailPane(data: WorksPageData, lang: Lang, base: string, withActions: boolean): string {
  const { detail, now } = data;
  const back = `<a class="nx-back" href="${link(base, "/works", data)}">${esc(tr(lang, "work.d.back"))}</a>`;
  if (!detail) {
    const text = data.missing
      ? tr(lang, "work.d.missing")
      : data.works.length === 0
        ? ""
        : tr(lang, "work.d.pick");
    return `<div class="nx-detail"><div class="nx-dw"><div class="nx-top">${back}</div>${text ? `<p class="nx-wempty">${esc(text)}</p>` : ""}</div></div>`;
  }
  const { state } = detail;
  const id = detail.work.id;
  const ib = (act: string, key: MsgKey) => marker(act, id, "nx-ib", esc(tr(lang, key)));
  const open = detail.terminal === null && state.primary !== "done";
  const topButtons = withActions
    ? [
        ...(open && detail.controls.length === 0 ? [ib("work-pause", "work.ctl.pause")] : []),
        ...(open ? [ib("work-stop", "work.ctl.stop")] : []),
        ...(detail.terminal ? [ib("work-reopen", "work.ctl.reopen")] : []),
      ].join("")
    : "";
  const want = clip(wantedText(detail), 280);
  const steps = detail.tasks.filter((task) => !task.superseded);
  const finished = steps.filter((task) => task.phase === "completed").length;
  const percent =
    steps.length === 0
      ? state.primary === "done"
        ? 100
        : 0
      : Math.round((finished / steps.length) * 20) * 5;
  const flags = state.flags
    .filter((flag) => KEYS.has(`work.flag.${flag}`))
    .map((flag) => chip("gray", coded(lang, "work.flag.", flag)))
    .join("");
  const reasonLines = state.reasons
    .map((reason) => `<p>${esc(coded(lang, "work.reason.", reason.code))}</p>`)
    .join("");
  // "Needs you" is said by the pill and the ask card; only a blocked Work gets a bar naming its causes.
  const attention =
    state.primary === "blocked" && reasonLines
      ? callout(
          state.blockedKind === "paused"
            ? "plain"
            : state.blockedKind === "reconciling"
              ? "amber"
              : "rose",
          reasonLines,
        )
      : "";
  // What "done" means is worth saying once it has happened (or never will); while it is open the criteria say it.
  const means =
    detail.terminal || detail.outcome || detail.work.migratedOutcome === "succeeded"
      ? callout("plain", `<p>${esc(meansText(lang, detail, now))}</p>`)
      : "";

  const linkName = (entry: WorkLinkLine): string => {
    const name = entry.targetTitle ? esc(entry.targetTitle) : `<code>${esc(entry.targetId)}</code>`;
    const to =
      entry.targetKind === "work"
        ? `${base}/works/${entry.targetId}`
        : entry.targetKind === "task_output"
          ? `${base}/tasks/${entry.targetId}`
          : undefined;
    return to ? `<a href="${esc(to)}">${name}</a>` : name;
  };
  const links = [
    ...(detail.goalId
      ? [
          row(
            `<span class="nx-grow">${esc(tr(lang, "work.link.goal"))}</span>` +
              marker(
                "goal-open",
                detail.goalId,
                "gl-link",
                detail.goalTitle ? esc(detail.goalTitle) : `<code>${esc(detail.goalId)}</code>`,
              ),
          ),
        ]
      : []),
    ...detail.links
      .filter((entry) => entry.endedAt === null)
      .map((entry) =>
        row(
          `<span class="nx-grow">${linkName(entry)}</span><span class="nx-meta">${esc(
            coded(lang, "work.lr.", entry.role),
          )} · ${esc(coded(lang, "work.lk.", entry.targetKind))}</span>`,
        ),
      ),
  ];
  const feed =
    detail.events.length > 0
      ? `<div class="nx-sec nx-feed"><div class="nx-sec-h"><h2>${esc(tr(lang, "work.sec.feed"))}</h2></div>${timeline(
          detail.events
            .toSorted((a, b) => b.seq - a.seq)
            .slice(0, 20)
            .map((event) => ({
              when: shortTime(event.createdAt, now, lang),
              text: coded(lang, "work.ev.", event.kind),
              tag: event.actor,
            })),
        )}</div>`
      : "";
  const paused = detail.controls.map((control) =>
    row(
      `<span class="nx-grow">${esc(
        control.reason
          ? tr(lang, "work.ctl.active", { reason: control.reason })
          : tr(lang, "work.ctl.activeNoReason"),
      )}</span>` +
        (withActions
          ? marker("work-resume", control.id, "nx-btn", esc(tr(lang, "work.ctl.resume")))
          : ""),
    ),
  );
  const btn = (act: string, key: MsgKey, extra = "") =>
    marker(act, id, `nx-btn${extra}`, esc(tr(lang, key)));
  const manage = [
    ...(open ? [btn("work-endpartial", "work.ctl.endPartial")] : []),
    btn("work-rename", "work.ctl.rename"),
    btn("work-hide", detail.work.hidden ? "work.ctl.unhide" : "work.ctl.hide"),
    btn("work-archive", "work.ctl.archive"),
    btn("work-delete", "work.ctl.delete", " nx-danger"),
  ];
  return (
    `<div class="nx-detail"><div class="nx-dw">` +
    `<div class="nx-top">${back}<span>${esc(tr(lang, detail.work.contextMode === "executive" ? "work.ctx.executive" : "work.ctx.personal"))}</span>` +
    `<span>·</span><span>${esc(tr(lang, "work.d.updated", { time: shortTime(detail.work.updatedAt, now, lang) }))}</span>` +
    `<span class="nx-sp"></span>${topButtons}</div>` +
    `<h1 class="nx-wtitle">${esc(detail.work.title)}</h1>` +
    `<div class="nx-why">${stateChip(lang, state)}${flags}<span>${esc(statusLine(lang, detail, now))}</span></div>` +
    `<div class="nx-hero nx-t-${toneOf(state)}"><div class="nx-ring nx-p${percent}"><span class="nx-ring-in">` +
    `<span class="nx-ring-n">${steps.length === 0 ? "-" : `${finished}/${steps.length}`}</span>` +
    `<span class="nx-ring-s">${esc(tr(lang, "work.ring.steps"))}</span></span></div>` +
    `<div class="nx-hero-t"><div class="nx-k">${esc(tr(lang, "work.d.want"))}</div><div class="nx-v">${esc(want)}</div>` +
    `<div class="nx-k">${esc(tr(lang, "work.d.progress"))}</div><div class="nx-v">${esc(progressText(lang, detail))}</div>` +
    // The ask card already says what is needed from the person; the hero names the next step only for the other states.
    (state.nextStep.kind === "none" || state.primary === "needs_you"
      ? ""
      : `<div class="nx-k">${esc(tr(lang, "work.d.next"))}</div><div class="nx-v">${esc(nextStepText(lang, state.nextStep, now))}</div>`) +
    `</div></div>` +
    attention +
    means +
    askCard(detail, data, lang, base, withActions) +
    (paused.length > 0 ? section(tr(lang, "work.ctl.activeNoReason"), paused) : "") +
    criteriaSection(detail, lang, base) +
    renderCommitmentSection(detail.commitments, { lang, now, workId: id, withActions, base }) +
    renderFollowSection(detail.followUp, { lang, now, workId: id, withActions }) +
    (links.length > 0 ? section(tr(lang, "work.sec.links"), links) : "") +
    feed +
    (withActions
      ? section(tr(lang, "work.sec.manage"), [`<div class="nx-manage">${manage.join("")}</div>`])
      : "") +
    `</div></div>`
  );
}

export function renderWorksPage(data: WorksPageData, options: WorksPageOptions = {}): string {
  const lang = options.lang ?? DEFAULT_LANG;
  const base = options.basePath ?? "nexus-nav:";
  const selected = data.detail?.work.id;
  return (
    `<div class="nx-works ${data.picked ? "nx-picked" : "nx-auto"}">` +
    `${listPane(data, lang, base, selected)}${detailPane(data, lang, base, options.actions === true)}</div>`
  );
}
