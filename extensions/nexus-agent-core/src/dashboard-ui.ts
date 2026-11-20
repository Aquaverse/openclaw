// The Dashboard of the Control UI (design: docs/nexus/apps/nexus-ea-prototype, S01). It observes and points: the greeting,
// the six numbers, what waits for a decision, what is blocked or overdue, what changed last, and the two side blocks
// (Goals, the people who have something waiting). Every number and row is a link to the page that acts on it, so no
// write ever starts here. Plain functions, no DOM: the module sanitises this markup against its allow-list.
import type { CounterpartSummary } from "./counterpart/types.js";
import { DEFAULT_LANG, tr, type Lang, type MsgKey } from "./i18n.js";
import type { DecisionRecord } from "./store/decision-types.js";
import type { GoalSummaryRecord } from "./store/goal-types.js";
import type { WorkView } from "./store/work-facts.js";
import { shortTime } from "./ui-kit.js";
import { clip, esc } from "./ui-render.js";
import type { WorkCounts } from "./work-ui.js";

export type DashboardData = {
  /** The five classes of the whole account (and the total). */
  counts: WorkCounts;
  /** Works read for the attention and "recently updated" blocks; the page never lists beyond them. */
  works: readonly WorkView[];
  /** Decisions still pending, newest deadline first. */
  decisions: readonly DecisionRecord[];
  goals: readonly GoalSummaryRecord[];
  counterparts: readonly CounterpartSummary[];
  now: number;
  /** The Goals feature: off means the block is not drawn at all. */
  goalsEnabled: boolean;
};

export type DashboardOptions = {
  lang?: Lang;
  /** Placeholder link base the module rewrites into host navigation. */
  basePath?: string;
};

/** How many rows a block shows before it points at the page that has the rest. */
const ATTENTION_MAX = 6;
const RECENT_MAX = 6;
const DECISIONS_MAX = 3;
const ASIDE_MAX = 4;

/** The greeting follows the hour of the day, never the record's timestamps. */
function greetingKey(now: number): MsgKey {
  const hour = new Date(now).getHours();
  if (hour < 11) {
    return "dash.greet.morning";
  }
  if (hour < 14) {
    return "dash.greet.noon";
  }
  return hour < 18 ? "dash.greet.afternoon" : "dash.greet.evening";
}

/** The day line under the greeting: the date, then only the numbers that are not zero. */
function dayText(now: number, lang: Lang): string {
  const d = new Date(now);
  return lang === "zh"
    ? `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${"日一二三四五六"[d.getDay()]}`
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short" });
}

const href = (base: string, path: string): string => esc(`${base}${path}`);

type Bag = { lang: Lang; base: string };

function kpi(
  value: number,
  label: string,
  hrefOf: string,
  tone: "" | "ok" | "warn" | "bad",
): string {
  return (
    `<a class="ea-kpi${tone === "" ? "" : ` ${tone}`}" href="${hrefOf}">` +
    `<span class="ea-kv">${value}</span><span class="ea-kl">${esc(label)}</span></a>`
  );
}

/** The first two facts of a decision, as a line: the record keeps them as label/value pairs of unknown shape. */
function factLine(facts: unknown): string {
  if (facts === null || facts === undefined || typeof facts !== "object") {
    return "";
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(facts as Record<string, unknown>)) {
    if (parts.length >= 2) {
      break;
    }
    if (value === null || value === undefined || typeof value === "object") {
      continue;
    }
    parts.push(`${esc(clip(key, 24))} ${esc(clip(String(value), 60))}`);
  }
  return parts.join(" · ");
}

/** The risk tiers the catalog knows; anything else is shown as the record has it. */
const RISK_TEXT: Record<string, MsgKey> = {
  low: "dash.risk.low",
  medium: "dash.risk.medium",
  high: "dash.risk.high",
};

function decisionCard(decision: DecisionRecord, bag: Bag, now: number): string {
  const facts = factLine(decision.facts);
  const due =
    decision.deadlineAt === null
      ? ""
      : `<span class="ea-meta-i">${esc(tr(bag.lang, "dash.decision.due", { when: shortTime(decision.deadlineAt, now, bag.lang) }))}</span>`;
  const tier =
    decision.riskTier === "" || decision.riskTier === "unknown"
      ? ""
      : `<span class="ea-meta-i">${esc(tr(bag.lang, "dash.decision.risk", { tier: riskText(bag.lang, decision.riskTier) }))}</span>`;
  return (
    `<a class="ea-dec" href="${href(bag.base, `/tasks/${escapePath(decision.taskId)}`)}">` +
    `<span class="ea-dec-q">${esc(clip(decision.question, 160))}</span>` +
    (facts === "" ? "" : `<span class="ea-dec-f">${facts}</span>`) +
    `<span class="ea-meta">${tier}${due}</span></a>`
  );
}

function riskText(lang: Lang, tier: string): string {
  const key = RISK_TEXT[tier];
  return key === undefined ? esc(tier) : tr(lang, key);
}

/** Ids reach a path segment: anything else is dropped rather than escaped into a broken link. */
function escapePath(id: string): string {
  return /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : "";
}

function attentionCard(view: WorkView, bag: Bag, now: number): string {
  const tone = view.state.primary === "blocked" ? " blocked" : " needs";
  const line = view.tasks[0]?.title ?? "";
  return (
    `<a class="ea-attn${tone}" href="${href(bag.base, `/works/${escapePath(view.work.id)}`)}">` +
    `<span class="ea-attn-top"><span class="ea-tag">${esc(tr(bag.lang, `work.seg.${view.state.primary}`))}</span>` +
    `<span class="ea-attn-time">${esc(shortTime(view.work.updatedAt, now, bag.lang))}</span></span>` +
    `<span class="ea-attn-title">${esc(view.work.title)}</span>` +
    (line === "" ? "" : `<span class="ea-attn-line">${esc(clip(line, 90))}</span>`) +
    `</a>`
  );
}

function workRow(view: WorkView, bag: Bag, now: number): string {
  const goal =
    view.goalId === null ? "" : `<span class="ea-tag goal">${esc(clip(view.goalId, 24))}</span>`;
  return (
    `<a class="ea-row" href="${href(bag.base, `/works/${escapePath(view.work.id)}`)}">` +
    `<span class="ea-row-dot"></span>` +
    `<span class="ea-row-main"><span class="ea-row-t">${esc(view.work.title)}</span>` +
    `<span class="ea-row-s">${esc(tr(bag.lang, `work.seg.${view.state.primary}`))}</span></span>` +
    `${goal}<span class="ea-row-time">${esc(shortTime(view.work.updatedAt, now, bag.lang))}</span></a>`
  );
}

function goalLine(goal: GoalSummaryRecord, bag: Bag): string {
  return (
    `<a class="ea-line" href="${href(bag.base, `/goals/${escapePath(goal.id)}`)}">` +
    `<span class="ea-line-t">${esc(goal.title)}</span>` +
    `<span class="ea-line-n">${esc(tr(bag.lang, "dash.aside.goals.links", { n: goal.linkCount }))}</span></a>`
  );
}

function personLine(person: CounterpartSummary, bag: Bag): string {
  const bits: string[] = [];
  if (person.needsConfirmation > 0) {
    bits.push(tr(bag.lang, "dash.aside.people.confirm", { n: person.needsConfirmation }));
  }
  if (person.overdue > 0) {
    bits.push(tr(bag.lang, "dash.aside.people.overdue", { n: person.overdue }));
  }
  return (
    `<a class="ea-line" href="${href(bag.base, `/people/${escapePath(person.id)}`)}">` +
    `<span class="ea-line-t">${esc(person.displayName)}</span>` +
    `<span class="ea-line-n">${esc(bits.join(" · "))}</span></a>`
  );
}

function sectionHead(lang: Lang, title: string, count: number, more?: string): string {
  return (
    `<div class="ea-sec-h"><h2>${esc(title)}</h2>` +
    (count === 0 ? "" : `<span class="ea-n">${count}</span>`) +
    (more === undefined
      ? ""
      : `<a class="ea-more" href="${more}">${esc(tr(lang, "dash.all"))}</a>`) +
    `</div>`
  );
}

export function renderDashboard(data: DashboardData, options: DashboardOptions = {}): string {
  const lang = options.lang ?? DEFAULT_LANG;
  const bag: Bag = { lang, base: options.basePath ?? "nexus-nav:" };
  const now = data.now;
  const counts = data.counts.counts;
  const summary = [
    dayText(now, lang),
    data.decisions.length > 0 ? tr(lang, "dash.sum.decisions", { n: data.decisions.length }) : "",
    tr(lang, "dash.sum.active", { n: counts.in_progress }),
    counts.ended_incomplete > 0 ? tr(lang, "dash.sum.overdue", { n: counts.ended_incomplete }) : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");

  // Six numbers, each one a link into the list that acts on it: the count alone never opens anything.
  const numbers: readonly {
    value: number;
    label: MsgKey;
    path: string;
    tone: "" | "ok" | "warn" | "bad";
  }[] = [
    {
      value: data.decisions.length,
      label: "dash.kpi.decisions",
      path: "/works?state=needs_you",
      tone: data.decisions.length > 0 ? "warn" : "",
    },
    {
      value: counts.needs_you,
      label: "dash.kpi.needs",
      path: "/works?state=needs_you",
      tone: counts.needs_you > 0 ? "warn" : "",
    },
    {
      value: counts.blocked,
      label: "dash.kpi.blocked",
      path: "/works?state=blocked",
      tone: counts.blocked > 0 ? "bad" : "",
    },
    {
      value: counts.in_progress,
      label: "dash.kpi.active",
      path: "/works?state=in_progress",
      tone: counts.in_progress > 0 ? "ok" : "",
    },
    { value: counts.done, label: "dash.kpi.done", path: "/works?state=done", tone: "" },
    { value: data.counts.total, label: "dash.kpi.total", path: "/works", tone: "" },
  ];
  const kpis = `<div class="ea-kpis">${numbers
    .map((one) => kpi(one.value, tr(lang, one.label), href(bag.base, one.path), one.tone))
    .join("")}</div>`;

  const decisions = data.decisions.slice(0, DECISIONS_MAX);
  const decisionBlock =
    `<div class="ea-sec">` +
    sectionHead(lang, tr(lang, "dash.decisions.title"), data.decisions.length) +
    (decisions.length === 0
      ? `<p class="ea-empty">${esc(tr(lang, "dash.decisions.empty"))}</p>`
      : decisions.map((decision) => decisionCard(decision, bag, now)).join("") +
        (data.decisions.length > decisions.length
          ? `<a class="ea-more-line" href="${href(bag.base, "/works?state=needs_you")}">${esc(
              tr(lang, "dash.decisions.more", { n: data.decisions.length - decisions.length }),
            )}</a>`
          : "")) +
    `</div>`;

  // Blocked first (it waits on something fixed), then what is waiting for the person.
  const attention = data.works
    .filter((view) => view.state.primary === "blocked" || view.state.primary === "needs_you")
    .toSorted(
      (a, b) => Number(b.state.primary === "blocked") - Number(a.state.primary === "blocked"),
    )
    .slice(0, ATTENTION_MAX);
  const attentionBlock =
    `<div class="ea-sec">` +
    sectionHead(
      lang,
      tr(lang, "dash.attention.title"),
      attention.length,
      href(bag.base, "/works"),
    ) +
    (attention.length === 0
      ? `<p class="ea-empty">${esc(tr(lang, "dash.attention.empty"))}</p>`
      : `<div class="ea-attns">${attention.map((view) => attentionCard(view, bag, now)).join("")}</div>`) +
    `</div>`;

  const recent = data.works
    .toSorted((a, b) => b.work.updatedAt - a.work.updatedAt)
    .slice(0, RECENT_MAX);
  const recentBlock =
    `<div class="ea-sec">` +
    sectionHead(lang, tr(lang, "dash.recent.title"), recent.length) +
    (recent.length === 0
      ? `<p class="ea-empty">${esc(tr(lang, "dash.recent.empty"))}</p>`
      : `<div class="ea-rows">${recent.map((view) => workRow(view, bag, now)).join("")}</div>`) +
    `</div>`;

  const goals = data.goals.slice(0, ASIDE_MAX);
  const goalsBlock =
    data.goalsEnabled === false
      ? ""
      : `<div class="ea-card ea-pad"><div class="ea-sec-h"><h2 class="ea-h3">${esc(tr(lang, "dash.aside.goals"))}</h2>` +
        (data.goals.length > 0
          ? `<a class="ea-more" href="${href(bag.base, "/goals")}">${esc(tr(lang, "dash.all"))}</a>`
          : "") +
        `</div>` +
        (goals.length === 0
          ? `<p class="ea-empty">${esc(tr(lang, "dash.aside.goals.empty"))}</p>`
          : goals.map((goal) => goalLine(goal, bag)).join("")) +
        `</div>`;

  const people = data.counterparts
    .filter((person) => person.needsConfirmation > 0 || person.overdue > 0)
    .slice(0, ASIDE_MAX);
  const peopleBlock =
    `<div class="ea-card ea-pad"><div class="ea-sec-h"><h2 class="ea-h3">${esc(tr(lang, "dash.aside.people"))}</h2>` +
    (people.length > 0
      ? `<a class="ea-more" href="${href(bag.base, "/people")}">${esc(tr(lang, "dash.all"))}</a>`
      : "") +
    `</div>` +
    (people.length === 0
      ? `<p class="ea-empty">${esc(tr(lang, "dash.aside.people.empty"))}</p>`
      : people.map((person) => personLine(person, bag)).join("")) +
    `</div>`;

  return (
    `<div class="ea-page">` +
    `<div class="ea-head"><div class="ea-head-txt">` +
    `<h1>${esc(tr(lang, greetingKey(now)))}</h1>` +
    `<p class="ea-sub">${esc(summary)}</p></div>` +
    `<a class="ea-btn primary" href="${href(bag.base, "/works")}">${esc(tr(lang, "dash.openWorkbench"))}</a>` +
    `</div>` +
    kpis +
    `<div class="ea-grid"><div class="ea-col">${decisionBlock}${attentionBlock}${recentBlock}</div>` +
    `<div class="ea-aside">${goalsBlock}${peopleBlock}</div></div>` +
    `</div>`
  );
}
