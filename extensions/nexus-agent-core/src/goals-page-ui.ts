import { categoryLabel, groupEntriesByDay, marker, nestGoals, statusLabel } from "./goal-ui.js";
// The Goals destination of the host's left rail, laid out like the prototype (docs/prd/design/nexus-goals.html): a list
// pane (title, hello line, in-progress / done segments, rows with a category tile) and a detail pane for the chosen goal
// (what the user wants, where they are, sub-goals, updates, metrics, links). The Control UI module sanitises this markup
// against an allow-list, so every clickable thing is a `<button data-nx-act data-nx-id>` marker or a `nexus-nav:` link,
// and every value goes through `esc`. Plain functions, no DOM and no SDK.
import { DEFAULT_LANG, tr, type Lang, type MsgKey } from "./i18n.js";
import type {
  GoalCategory,
  GoalDetailRecord,
  GoalEntryAuthor,
  GoalEntryRecord,
  GoalStatus,
  GoalSummaryRecord,
} from "./store/goal-types.js";
import { clip, esc } from "./ui-render.js";

/** The two segments of the list: goals in progress, and the ones already completed. */
export type GoalsSeg = "active" | "done";

export type GoalsPageData = {
  seg: GoalsSeg;
  /** The rows of the chosen segment; sub-goals are nested under their parent when the list pane renders it. */
  goals: readonly GoalSummaryRecord[];
  /** Segment counts, so the pills read like the prototype ("in progress 5"). */
  counts: { active: number; done: number };
  /** Live proposals waiting for the user; they are not rows you open, they are questions you answer. */
  proposed: readonly GoalSummaryRecord[];
  /** The goal the detail pane shows; absent when none is chosen. */
  detail?: GoalDetailRecord;
};

export type GoalsPageOptions = {
  /** Render the buttons. Off when the connection cannot write. */
  actions?: boolean;
  lang?: Lang;
  /** Placeholder link base the module rewrites into host navigation. */
  basePath?: string;
  /** "Sort automatically" is off: the detail pane offers up / down so the user orders the list by hand. */
  manualSort?: boolean;
};

const CATEGORY_TONE: Record<GoalCategory, string> = {
  finance: "amber",
  interests: "accent",
  health: "green",
  career: "blue",
  relationships: "rose",
  productivity: "blue",
  something_else: "gray",
};

/** The prototype's one-character category tile: the Chinese initial, or the initial of the English label. */
const GLYPH: Record<GoalCategory, string> = {
  finance: "财",
  interests: "学",
  health: "健",
  career: "职",
  relationships: "亲",
  productivity: "效",
  something_else: "其",
};
const glyphOf = (lang: Lang, category: GoalCategory): string =>
  lang === "zh" ? GLYPH[category] : categoryLabel(lang, category).slice(0, 1).toUpperCase();

const AUTHOR: Record<GoalEntryAuthor, MsgKey> = {
  user: "goal.author.user",
  agent: "goal.author.agent",
  system: "goal.author.system",
};

const STATUS_TONE: Record<GoalStatus, string> = {
  active: "nx-accent",
  completed: "nx-green",
  proposed: "nx-amber",
};

const two = (value: number) => String(value).padStart(2, "0");
/** `10-28`: the short date the prototype prints beside a title. */
const mmdd = (ms: number): string => {
  const d = new Date(ms);
  return `${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};

export function goalsHref(base: string, seg: GoalsSeg, goalId?: string): string {
  const path = goalId === undefined ? `${base}/goals` : `${base}/goals/${goalId}`;
  return esc(seg === "done" ? `${path}?seg=done` : path);
}

function tile(lang: Lang, category: GoalCategory, extra = ""): string {
  return `<span class="nx-gtile nx-t-${CATEGORY_TONE[category]}${extra}">${esc(glyphOf(lang, category))}</span>`;
}

function statusChip(lang: Lang, status: GoalStatus): string {
  return `<span class="nx-chip ${STATUS_TONE[status]}">${esc(statusLabel(lang, status))}</span>`;
}

/** One row: the category tile, the title with its date, the latest line about it, and the category / sub-goal meta. */
function row(
  goal: GoalSummaryRecord,
  lang: Lang,
  base: string,
  seg: GoalsSeg,
  selected: string | undefined,
  child: boolean,
): string {
  const line = goal.currentState ?? goal.summary ?? "";
  const meta = [
    categoryLabel(lang, goal.category),
    goal.childCount > 0 ? tr(lang, "goals.meta.sub", { n: goal.childCount }) : "",
    goal.status === "completed" ? statusLabel(lang, "completed") : "",
    // A goal that is due for its look-back is said in words on the row, not only in the detail pane.
    goal.review?.due === true ? tr(lang, "goal.review.due") : "",
  ].filter((part) => part !== "");
  return (
    `<a class="nx-wrow${child ? " nx-gchild" : ""}${goal.id === selected ? " on" : ""}" href="${goalsHref(base, seg, goal.id)}">` +
    tile(lang, goal.category) +
    `<span class="nx-wm"><span class="nx-wt">` +
    `<span class="nx-wtt">${esc(goal.title)}</span>` +
    `<span class="nx-wtm">${esc(mmdd(goal.lastEntryAt ?? goal.updatedAt))}</span></span>` +
    (line === "" ? "" : `<span class="nx-wnx">${esc(clip(line, 90))}</span>`) +
    `<span class="nx-gmeta">${meta.map((part) => esc(part)).join(" · ")}</span>` +
    `</span></a>`
  );
}

/** A proposal: a question to answer, so it opens the confirmation card instead of a detail pane. */
function pendingRow(goal: GoalSummaryRecord, lang: Lang, withActions: boolean): string {
  const line = goal.summary ?? goal.currentState ?? "";
  return (
    `<div class="nx-wrow nx-gpending">` +
    tile(lang, goal.category) +
    `<span class="nx-wm"><span class="nx-wt">` +
    `<span class="nx-wtt">${esc(goal.title)}</span></span>` +
    `<span class="nx-gmeta">${esc(tr(lang, "goals.tag.proposal"))}</span>` +
    (line === "" ? "" : `<span class="nx-wnx">${esc(clip(line, 90))}</span>`) +
    `</span>` +
    (withActions
      ? marker("goal-pending", goal.id, "nx-ib", esc(tr(lang, "goals.menu.review")))
      : "") +
    `</div>`
  );
}

function listPane(
  data: GoalsPageData,
  options: Required<Pick<GoalsPageOptions, "actions" | "lang">> & { base: string },
): string {
  const { lang, actions, base } = options;
  const segLink = (seg: GoalsSeg, label: string, n: number) => {
    const on = data.seg === seg ? ' class="on"' : "";
    return `<a${on} href="${goalsHref(base, seg)}">${esc(label)}<span class="nx-n">${n}</span></a>`;
  };
  const rows: string[] = [];
  if (data.seg === "active") {
    for (const goal of data.proposed) {
      rows.push(pendingRow(goal, lang, actions));
    }
  }
  for (const { goal, child } of nestGoals(data.goals)) {
    rows.push(row(goal, lang, base, data.seg, data.detail?.goal.id, child));
  }
  const empty =
    data.seg === "done"
      ? tr(lang, "goals.completedEmpty")
      : data.proposed.length > 0
        ? tr(lang, "goals.list.onlyProposals")
        : tr(lang, "goals.empty");
  const body = rows.length > 0 ? rows.join("") : `<p class="nx-wempty">${esc(empty)}</p>`;
  // Creating needs a category, so the three the page opens sit above the rows, where the prototype puts its tiled cards.
  const create = actions
    ? `<div class="nx-gfoot"><span class="nx-gfoot-t">${esc(tr(lang, "goals.create"))}</span>` +
      (["finance", "interests", "something_else"] as const)
        .map((category) =>
          marker(
            "goal-create",
            category,
            "nx-gcat",
            `<span class="nx-gcat-name">${esc(tr(lang, `goals.cat.${category}` as MsgKey))}</span>`,
          ),
        )
        .join("") +
      `</div>`
    : "";
  return (
    `<div class="nx-wlist"><div class="nx-lh"><div class="nx-lh-head">` +
    `<h1>${esc(tr(lang, "title.goals"))}</h1>` +
    (actions ? marker("goal-menu", undefined, "nx-ib", "⋯") : "") +
    `</div><p class="nx-hello">${esc(tr(lang, "goals.page.hello"))}</p></div>` +
    `<div class="nx-seg">${segLink("active", tr(lang, "goals.active"), data.counts.active)}` +
    `${segLink("done", tr(lang, "goal.status.completed"), data.counts.done)}</div>` +
    create +
    `<div class="nx-rows">${body}</div></div>`
  );
}

function entryLine(entry: GoalEntryRecord, lang: Lang): string {
  return (
    `<div class="nx-ev${entry.retractedAt === null ? "" : " nx-gretracted"}">` +
    `<span class="nx-ev-when">${esc(mmdd(entry.effectiveAt))}</span>` +
    `<span class="nx-ev-text">${esc(clip(entry.text, 400))}</span>` +
    `<span class="nx-ev-tag">${esc(tr(lang, AUTHOR[entry.author]))}</span></div>`
  );
}

function entriesBlock(detail: GoalDetailRecord, lang: Lang): string {
  const groups = groupEntriesByDay(detail.entries).slice(0, 6);
  const html =
    groups.length === 0
      ? `<p class="nx-muted">${esc(tr(lang, "goal.detail.noActivity"))}</p>`
      : groups
          .map(
            (group) =>
              `<div class="nx-box">${group.entries
                .slice(0, 12)
                .map((entry) => entryLine(entry, lang))
                .join("")}</div>`,
          )
          .join("");
  return section(tr(lang, "goals.d.entries"), html);
}

function metricsBlock(detail: GoalDetailRecord, lang: Lang): string {
  if (detail.metrics.length === 0) {
    return "";
  }
  const items = detail.metrics.map((metric) => {
    const figure =
      metric.current === null
        ? tr(lang, "goal.metric.noFigure")
        : `${metric.current}${metric.unit}`;
    const target = metric.target === null ? "" : ` / ${metric.target}${metric.unit}`;
    const pct =
      metric.current === null || metric.target === null || metric.target === 0
        ? undefined
        : Math.max(0, Math.min(100, Math.round((metric.current / metric.target) * 100)));
    return (
      `<div class="nx-li"><span class="nx-grow">${esc(metric.name)}` +
      `<span class="nx-gmetric">${esc(figure)}${esc(target)}</span>` +
      (pct === undefined
        ? ""
        : `<span class="nx-gbar"><i class="nx-p${Math.round(pct / 5) * 5}"></i></span>`) +
      `</span></div>`
    );
  });
  return section(tr(lang, "goal.metric.title"), `<div class="nx-box">${items.join("")}</div>`);
}

function linksBlock(detail: GoalDetailRecord, lang: Lang, base: string): string {
  if (detail.links.length === 0) {
    return "";
  }
  const KIND: Record<string, MsgKey> = {
    task: "goals.link.task",
    vault_file: "goals.link.file",
    preference: "goals.link.preference",
    watch: "goals.link.watch",
  };
  const items = detail.links.map((link) => {
    const label = tr(lang, KIND[link.kind] ?? "goals.link.task");
    const name = link.kind === "task" ? (link.task?.title ?? link.refId) : (link.refId ?? "");
    const text = `${label} · ${name}`;
    const href =
      link.kind === "vault_file"
        ? `${base}/files?file=${encodeURIComponent(link.refId)}`
        : link.kind === "task"
          ? `${base}/tasks/${encodeURIComponent(link.refId)}`
          : undefined;
    const body =
      href === undefined ? `<span>${esc(text)}</span>` : `<a href="${esc(href)}">${esc(text)}</a>`;
    return `<div class="nx-li">${body}</div>`;
  });
  return section(tr(lang, "goal.detail.links"), `<div class="nx-box">${items.join("")}</div>`);
}

function subGoalsBlock(detail: GoalDetailRecord, lang: Lang, base: string, seg: GoalsSeg): string {
  if (detail.children.length === 0) {
    return "";
  }
  const items = detail.children.map(
    (child) =>
      `<a class="nx-li nx-gsub" href="${goalsHref(base, seg, child.id)}">` +
      `<span class="nx-grow">${esc(child.title)}</span>` +
      statusChip(lang, child.status) +
      `</a>`,
  );
  return section(tr(lang, "goal.detail.subGoals"), `<div class="nx-box">${items.join("")}</div>`);
}

function section(title: string, body: string): string {
  return `<div class="nx-sec"><div class="nx-sec-h"><h2>${esc(title)}</h2></div>${body}</div>`;
}

function detailPane(
  data: GoalsPageData,
  options: Required<Pick<GoalsPageOptions, "actions" | "lang">> & {
    base: string;
    manualSort: boolean;
  },
): string {
  const { lang, actions, base } = options;
  const detail = data.detail;
  if (!detail) {
    return (
      `<div class="nx-detail"><div class="nx-dw nx-gempty">` +
      `<p class="nx-muted">${esc(tr(lang, "goals.d.pick"))}</p></div></div>`
    );
  }
  const goal = detail.goal;
  const want = goal.userWords ?? goal.summary ?? "";
  const state = goal.currentState ?? "";
  const lastAt = detail.entries.reduce<number | undefined>(
    (newest, entry) =>
      newest === undefined || entry.effectiveAt > newest ? entry.effectiveAt : newest,
    undefined,
  );
  const stats = [
    [
      `${detail.entries.length}${detail.entriesTruncated ? "+" : ""}`,
      tr(lang, "goals.stat.entries"),
    ],
    [String(detail.children.length), tr(lang, "goals.stat.sub")],
    [String(detail.links.length), tr(lang, "goals.stat.links")],
  ]
    .map(
      ([n, label]) =>
        `<div><span class="nx-gstat-n">${esc(n)}</span><span class="nx-gstat-l">${esc(label)}</span></div>`,
    )
    .join("");
  const topActions = [
    goal.status === "active" && actions && options.manualSort
      ? marker("goal-up", goal.id, "nx-ib", "▲") + marker("goal-down", goal.id, "nx-ib", "▼")
      : "",
    goal.status === "active" && actions
      ? marker("goal-check", goal.id, "nx-pb", esc(tr(lang, "goal.menu.complete")))
      : "",
    // The detail dialog is available on a read-only console too: it shows the fields and disables its write items there.
    marker("goal-open", goal.id, "nx-ib", esc(tr(lang, "goals.more"))),
  ]
    .filter((part) => part !== "")
    .join("");
  return (
    `<div class="nx-detail"><div class="nx-dw">` +
    `<div class="nx-top"><span>${esc(categoryLabel(lang, goal.category))}</span><span>·</span>` +
    `<span>${esc(tr(lang, "goals.d.since", { date: mmdd(goal.createdAt) }))}</span>` +
    `<span class="nx-sp"></span>${topActions}</div>` +
    `<div class="nx-gtitle">${tile(lang, goal.category, " lg")}<div class="nx-gtitle-m">` +
    `<h1 class="nx-wtitle">${esc(goal.title)}</h1>` +
    `<div class="nx-why">${statusChip(lang, goal.status)}` +
    (lastAt !== undefined
      ? `<span>${esc(tr(lang, "goals.d.recent", { date: mmdd(lastAt) }))}</span>`
      : "") +
    `</div></div></div>` +
    `<div class="nx-hero nx-ghero nx-t-${CATEGORY_TONE[goal.category]}"><div class="nx-hero-t">` +
    (want === ""
      ? ""
      : `<div class="nx-k">${esc(tr(lang, "goals.d.want"))}</div><div class="nx-v">${esc(clip(want, 600))}</div>`) +
    (state === ""
      ? ""
      : `<div class="nx-k">${esc(tr(lang, "goals.d.now"))}</div><div class="nx-v">${esc(clip(state, 400))}</div>`) +
    `</div><div class="nx-gstats">${stats}</div></div>` +
    subGoalsBlock(detail, lang, base, data.seg) +
    entriesBlock(detail, lang) +
    metricsBlock(detail, lang) +
    linksBlock(detail, lang, base) +
    `</div></div>`
  );
}

/** The Goals page: list pane and detail pane, or just the list when no goal is chosen. */
export function renderGoalsPage(data: GoalsPageData, options: GoalsPageOptions = {}): string {
  const resolved = {
    actions: options.actions === true,
    lang: options.lang ?? DEFAULT_LANG,
    base: options.basePath ?? "nexus-nav:",
    manualSort: options.manualSort === true,
  };
  return (
    `<div class="nx-works ${data.detail ? "nx-picked" : "nx-auto"}">` +
    `${listPane(data, resolved)}${detailPane(data, resolved)}</div>`
  );
}
