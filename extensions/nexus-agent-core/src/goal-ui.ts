// The Goals page markup and its pure helpers (Goals design 9.5). The Control UI module sanitises this markup against an
// allow-list, so every clickable thing is a `<button data-nx-act data-nx-id>` marker and every value goes through `esc`.
// Plain functions with no DOM and no SDK, so tests can run them directly.
import { DEFAULT_LANG, tr, type Lang, type MsgKey } from "./i18n.js";
import {
  GOAL_OPEN_CATEGORIES,
  type GoalCategory,
  type GoalEntryRecord,
  type GoalStatus,
  type GoalSummaryRecord,
} from "./store/goal-types.js";
import { esc } from "./ui-render.js";

export type GoalPageData = {
  /** Live goals with status `active`, both top-level and sub-goals. */
  active: readonly GoalSummaryRecord[];
  /** Live goals with status `proposed`. */
  proposed: readonly GoalSummaryRecord[];
};

export type GoalPageOptions = {
  /** Render the buttons. Off when the connection cannot write. */
  actions?: boolean;
  lang?: Lang;
  /** Show `current_state` under each title (page menu; default on). */
  showSubtitle?: boolean;
  /** "Sort automatically" is off: show up / down buttons so the user orders the list by hand. */
  manualSort?: boolean;
};

const CATEGORY_LABEL = {
  finance: "goals.cat.finance",
  interests: "goals.cat.interests",
  something_else: "goals.cat.something_else",
} as const satisfies Record<string, MsgKey>;
const CATEGORY_DESC = {
  finance: "goals.catDesc.finance",
  interests: "goals.catDesc.interests",
  something_else: "goals.catDesc.something_else",
} as const satisfies Record<string, MsgKey>;

/** The label of any category; categories that are not open in v1 fall back to their raw name. */
export function categoryLabel(lang: Lang, category: GoalCategory): string {
  return category in CATEGORY_LABEL
    ? tr(lang, CATEGORY_LABEL[category as keyof typeof CATEGORY_LABEL])
    : category;
}

export function statusLabel(lang: Lang, status: GoalStatus): string {
  return tr(lang, `goal.status.${status}` as MsgKey);
}

const marker = (act: string, id: string | undefined, className: string, inner: string): string =>
  `<button class="${className}" data-nx-act="${act}"${id ? ` data-nx-id="${esc(id)}"` : ""}>${inner}</button>`;

/** Top-level goals in the given order, each followed by its sub-goals; a sub-goal whose parent is not listed stands alone. */
export function nestGoals<T extends { id: string; parentId: string | null }>(
  goals: readonly T[],
): { goal: T; child: boolean }[] {
  const ids = new Set(goals.map((goal) => goal.id));
  const kids = new Map<string, T[]>();
  for (const goal of goals) {
    if (goal.parentId !== null && ids.has(goal.parentId)) {
      kids.set(goal.parentId, [...(kids.get(goal.parentId) ?? []), goal]);
    }
  }
  const out: { goal: T; child: boolean }[] = [];
  for (const goal of goals) {
    if (goal.parentId !== null && ids.has(goal.parentId)) {
      continue;
    }
    out.push({ goal, child: false });
    for (const kid of kids.get(goal.id) ?? []) {
      out.push({ goal: kid, child: true });
    }
  }
  return out;
}

export function renderGoalPage(data: GoalPageData, options: GoalPageOptions = {}): string {
  const lang = options.lang ?? DEFAULT_LANG;
  const withActions = options.actions === true;
  const subtitle = options.showSubtitle !== false;
  const sensitiveTag = (goal: GoalSummaryRecord) =>
    goal.sensitivity === "sensitive"
      ? ` <span class="pill">${esc(tr(lang, "goals.tag.sensitive"))}</span>`
      : "";

  const dueTag = (goal: GoalSummaryRecord) =>
    goal.review?.due === true
      ? ` <span class="pill pending">${esc(tr(lang, "goal.review.due"))}</span>`
      : "";

  const activeRows = nestGoals(data.active).map(({ goal, child }) => {
    const box = withActions
      ? marker(
          "goal-check",
          goal.id,
          "gl-box",
          `<span class="gl-sr">${esc(tr(lang, "goals.check"))}</span>`,
        )
      : '<span class="gl-box off"></span>';
    const state =
      subtitle && goal.currentState ? `<div class="gl-sub">${esc(goal.currentState)}</div>` : "";
    const order =
      withActions && options.manualSort === true
        ? `<div class="gl-order">${marker("goal-up", goal.id, "nx-btn", "\u25b2")}${marker("goal-down", goal.id, "nx-btn", "\u25bc")}</div>`
        : "";
    return (
      `<div class="gl-row${child ? " gl-child" : ""}">${box}` +
      `<div class="gl-main">${marker("goal-open", goal.id, "gl-title", esc(goal.title))}${sensitiveTag(goal)}${dueTag(goal)}${state}</div>${order}</div>`
    );
  });

  const pendingRows = data.proposed.map((goal) => {
    const line = goal.summary ?? goal.currentState;
    return (
      `<div class="gl-row gl-pending"><div class="gl-main">` +
      `${marker("goal-pending", goal.id, "gl-title", esc(goal.title))}${sensitiveTag(goal)}` +
      `${line ? `<div class="gl-sub">${esc(line)}</div>` : ""}</div>` +
      (withActions
        ? `<div class="gl-actions">${marker("goal-approve", goal.id, "nx-btn nx-primary", esc(tr(lang, "goal.pending.review")))}` +
          `${marker("goal-reject", goal.id, "nx-btn", esc(tr(lang, "goal.pending.reject")))}</div>`
        : "") +
      "</div>"
    );
  });

  const categories = GOAL_OPEN_CATEGORIES.filter(
    (category): category is keyof typeof CATEGORY_LABEL => category in CATEGORY_LABEL,
  ).map((category) =>
    withActions
      ? marker(
          "goal-create",
          category,
          "gl-cat",
          `<span class="gl-cat-name">${esc(tr(lang, CATEGORY_LABEL[category]))}</span>` +
            `<span class="gl-cat-desc">${esc(tr(lang, CATEGORY_DESC[category]))}</span>`,
        )
      : `<span class="gl-cat off"><span class="gl-cat-name">${esc(tr(lang, CATEGORY_LABEL[category]))}</span>` +
        `<span class="gl-cat-desc">${esc(tr(lang, CATEGORY_DESC[category]))}</span></span>`,
  );

  return [
    `<div class="gl-head"><div><h1>${esc(tr(lang, "title.goals"))}</h1>` +
      `<p class="muted">${esc(tr(lang, "goals.intro"))}</p></div>` +
      marker(
        "goal-menu",
        undefined,
        "nx-btn gl-more",
        `<span class="gl-sr">${esc(tr(lang, "goals.more"))}</span>⋯`,
      ) +
      "</div>",
    ...(pendingRows.length > 0
      ? [
          `<h2>${esc(tr(lang, "goals.pending"))} (${pendingRows.length})</h2>`,
          `<p class="muted">${esc(tr(lang, "goals.pendingHint"))}</p>`,
          `<div class="gl-list">${pendingRows.join("")}</div>`,
        ]
      : []),
    `<h2>${esc(tr(lang, "goals.active"))}${activeRows.length > 0 ? ` (${data.active.length})` : ""}</h2>`,
    activeRows.length > 0
      ? `<div class="gl-list">${activeRows.join("")}</div>`
      : `<p class="muted">${esc(tr(lang, "goals.empty"))}</p>`,
    `<h2>${esc(tr(lang, "goals.create"))}</h2>`,
    `<p class="muted">${esc(tr(lang, "goals.createHint"))}</p>`,
    `<div class="gl-cats">${categories.join("")}</div>`,
  ].join("\n");
}

// ------------------------------------------------------------------ grouping helpers (also used by the dialogs)

const two = (value: number) => String(value).padStart(2, "0");

/** `2026-10-27` in local time: the key that groups activity by day. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Entries by local day, newest day first and newest entry first inside a day; retracted entries stay (struck through). */
export function groupEntriesByDay(
  entries: readonly GoalEntryRecord[],
): { day: string; entries: GoalEntryRecord[] }[] {
  const sorted = [...entries].toSorted(
    (a, b) =>
      b.effectiveAt - a.effectiveAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id),
  );
  const groups: { day: string; entries: GoalEntryRecord[] }[] = [];
  for (const entry of sorted) {
    const day = dayKey(entry.effectiveAt);
    const last = groups.at(-1);
    if (last && last.day === day) {
      last.entries.push(entry);
    } else {
      groups.push({ day, entries: [entry] });
    }
  }
  return groups;
}

/** Completed goals by the month they were completed in, newest first. */
export function groupByCompletedMonth<T extends { completedAt: number | null; updatedAt: number }>(
  goals: readonly T[],
  lang: Lang = DEFAULT_LANG,
): { label: string; goals: T[] }[] {
  const at = (goal: T) => goal.completedAt ?? goal.updatedAt;
  const sorted = [...goals].toSorted((a, b) => at(b) - at(a));
  const groups: { key: string; label: string; goals: T[] }[] = [];
  for (const goal of sorted) {
    const d = new Date(at(goal));
    const key = `${d.getFullYear()}-${two(d.getMonth() + 1)}`;
    const last = groups.at(-1);
    if (last && last.key === key) {
      last.goals.push(goal);
    } else {
      groups.push({
        key,
        label: tr(lang, "goals.monthGroup", { year: d.getFullYear(), month: d.getMonth() + 1 }),
        goals: [goal],
      });
    }
  }
  return groups.map(({ label, goals: items }) => ({ label, goals: items }));
}
