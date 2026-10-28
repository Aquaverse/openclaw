import {
  categoryLabel,
  groupByCompletedMonth,
  groupEntriesByDay,
  statusLabel,
} from "../src/goal-ui.js";
// The Goals page's actions and dialogs (Goals design 9.5, 9.6). Everything is built from DOM nodes and textContent. The page
// markup only carries an id; each dialog reads the goal again through nexus.goal.get, and the RPCs stay the authority
// (state, revision, cap and the sensitive-value scan are checked there), so a stale dialog can at worst be refused.
import { tr, type MsgKey } from "../src/i18n.js";
import type {
  GoalCategory,
  GoalDetailRecord,
  GoalStatus,
  GoalSummaryRecord,
} from "../src/store/goal-types.js";
import type { ActionContext } from "./actions.ts";
import { openDialog } from "./dialog.ts";
import { deleteDialog, noteDialog, purgeDialog, renameDialog } from "./goal-dialogs.ts";
import { el, field, note } from "./goal-dom.ts";
import { describeGoalError, knownRefusal } from "./goal-errors.ts";
import { linkAddDialog, linkRemoveDialog, linksBlock } from "./goal-links.ts";
import { entryLine, metricDialog, metricsBlock } from "./goal-progress.ts";
import { reviewBlock } from "./goal-review.ts";

export { describeGoalError };

/** What the page needs from the Control UI host to open a chat (a slice of `host.sessions`). */
export type GoalSessions = {
  create: (params?: { agentId?: string; label?: string }) => Promise<string | null>;
  normalizeKey: (sessionKey: string) => string;
  open: (session: { sessionKey: string }) => void;
};

async function get(ctx: ActionContext, goalId: string): Promise<GoalDetailRecord | undefined> {
  try {
    return await ctx.request<GoalDetailRecord>("nexus.goal.get", { goalId });
  } catch {
    return undefined;
  }
}

const gone = (ctx: ActionContext, id: string) =>
  ctx.changed({ ok: false, text: tr(ctx.lang, "goal.err.gone", { id }) });

async function runOr(
  ctx: ActionContext,
  call: () => Promise<unknown>,
  doneKey: MsgKey,
): Promise<void> {
  try {
    await call();
    ctx.changed({ ok: true, text: tr(ctx.lang, doneKey) });
  } catch (error) {
    ctx.changed({ ok: false, text: describeGoalError(ctx.lang, error) });
  }
}

// ------------------------------------------------------------------ direct actions on the list

/** The goals that point at a vault file; shown in the file dialog and hidden quietly when there are none or goals are off. */
export async function goalsSection(
  ctx: ActionContext,
  file: { id: string },
  box: HTMLElement,
): Promise<void> {
  let reply: { goals?: { id: string; title: string; status: GoalStatus }[] };
  try {
    reply = await ctx.request("nexus.goal.forFile", { fileId: file.id });
  } catch {
    return;
  }
  const goals = reply.goals ?? [];
  if (ctx.signal.aborted || goals.length === 0) {
    return;
  }
  box.append(el("div", "nx-sub", `${tr(ctx.lang, "files.d.goalsHead")} (${goals.length})`));
  for (const goal of goals) {
    const row = el("div", "nx-link");
    row.append(
      el("span", "nx-value", ctx.redact(goal.title)),
      el("span", "muted", ` ${statusLabel(ctx.lang, goal.status)}`),
    );
    box.append(row);
  }
}

/** The checkbox: the user ticks the goal as done. */
export function goalCheck(ctx: ActionContext, id: string): Promise<void> {
  return runOr(ctx, () => ctx.request("nexus.goal.complete", { goalId: id }), "goal.notice.done");
}

/**
 * The checkbox on the list: one stray click must not finish a goal, so it asks first. The goal's title comes from the list the
 * page rendered; the RPC still decides whether the goal can be completed.
 */
export function goalCheckAsk(ctx: ActionContext, id: string): void {
  const goal = (ctx.model().goals ?? []).find((item) => item.id === id);
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "goal.check.title"),
    actions: [
      {
        label: tr(ctx.lang, "goal.menu.complete"),
        tone: "primary",
        run: async () => {
          await ctx.request("nexus.goal.complete", { goalId: id });
          ctx.changed({ ok: true, text: tr(ctx.lang, "goal.notice.done") });
        },
      },
    ],
    build: (body) => {
      if (goal) {
        body.append(el("p", "", goal.title));
      }
      note(body, tr(ctx.lang, "goal.check.note"));
    },
  });
}

export function goalReject(ctx: ActionContext, id: string): Promise<void> {
  return runOr(ctx, () => ctx.request("nexus.goal.delete", { goalId: id }), "goal.notice.rejected");
}

/** Move a goal one place up or down among its siblings (only offered when "sort automatically" is off). */
export async function goalMove(ctx: ActionContext, id: string, direction: -1 | 1): Promise<void> {
  const all = ctx.model().goals ?? [];
  const goal = all.find((item) => item.id === id);
  if (!goal) {
    return gone(ctx, id);
  }
  const siblings = all.filter(
    (item) => item.status === "active" && item.parentId === goal.parentId,
  );
  const from = siblings.findIndex((item) => item.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= siblings.length) {
    return;
  }
  const order = [...siblings];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved as GoalSummaryRecord);
  try {
    for (const [index, item] of order.entries()) {
      if (item.sortOrder !== index * 10) {
        await ctx.request("nexus.goal.update", {
          goalId: item.id,
          patch: { sortOrder: index * 10 },
        });
      }
    }
    ctx.changed({ ok: true, text: "" });
  } catch (error) {
    ctx.changed({ ok: false, text: describeGoalError(ctx.lang, error) });
  }
}

// ------------------------------------------------------------------ creation chat

function newKey(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `goal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * A category click (design 9.6): a fresh chat session, then the single-use creation grant for exactly that session, then the
 * opening sentence, then the chat view. The grant is the only thing that lets the Agent save the goal.
 */
export async function goalCreate(
  ctx: ActionContext,
  category: string,
  parentId?: string,
): Promise<void> {
  const sessions = ctx.sessions;
  if (!sessions) {
    ctx.changed({ ok: false, text: tr(ctx.lang, "goal.start.noSession") });
    return;
  }
  try {
    const parent = parentId ? await get(ctx, parentId) : undefined;
    // No label: the gateway keeps session labels unique, so a fixed one ("New goal") would make every click after the first
    // fail. The chat is titled from its opening sentence like any other.
    const key = await sessions.create();
    if (!key) {
      ctx.changed({ ok: false, text: tr(ctx.lang, "goal.start.noSession") });
      return;
    }
    await ctx.request("nexus.goal.startCreation", {
      category,
      sessionKey: sessions.normalizeKey(key),
      ...(parentId ? { parentId } : {}),
    });
    const opener = parent
      ? tr(ctx.lang, "goal.opener.sub", { title: parent.goal.title })
      : tr(ctx.lang, `goal.opener.${category}` as MsgKey);
    await ctx.request("chat.send", { sessionKey: key, message: opener, idempotencyKey: newKey() });
    sessions.open({ sessionKey: key });
  } catch (error) {
    ctx.changed({
      ok: false,
      text:
        knownRefusal(ctx.lang, error) ??
        tr(ctx.lang, "goal.start.failed", {
          message: error instanceof Error ? error.message : String(error),
        }),
    });
  }
}

// ------------------------------------------------------------------ small popup menu

type MenuItem = { label: string; tone?: "danger"; run: () => void };

function popupMenu(button: HTMLElement, items: MenuItem[]): HTMLElement {
  const wrap = el("div", "gl-menu-wrap");
  const menu = el("div", "gl-menu");
  menu.hidden = true;
  for (const item of items) {
    const entry = el(
      "button",
      item.tone === "danger" ? "gl-menu-item nx-danger" : "gl-menu-item",
      item.label,
    );
    entry.type = "button";
    entry.addEventListener("click", () => {
      menu.hidden = true;
      item.run();
    });
    menu.append(entry);
  }
  button.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
  });
  wrap.append(button, menu);
  return wrap;
}

// ------------------------------------------------------------------ detail

/** The goal-detail dialog that is open right now (at most one): the page refills it when the data behind it changes. */
type LiveDetail = {
  id: string;
  ctx: ActionContext;
  close: () => void;
  title: HTMLElement;
  body: HTMLElement;
};
let liveDetail: LiveDetail | undefined;
/** Only the newest detail request is drawn, so a slow answer cannot overwrite a newer one. */
let detailSeq = 0;

/**
 * Refills the open goal-detail dialog from fresh data. The dialog is a snapshot, so a claim that was retracted or a task
 * that finished after it opened would otherwise keep its old label until the user closes and reopens it. Another dialog
 * on top (a metric form, a note) is left alone: redrawing under it would lose what is being typed.
 */
export function refreshOpenGoalDetail(parent: HTMLElement): void {
  const live = liveDetail;
  if (!live || live.ctx.parent !== parent || parent.querySelectorAll(".nx-overlay").length !== 1) {
    return;
  }
  void goalDetail(live.ctx, live.id, { onlyIfOpen: true });
}

/** What has the keyboard focus inside `body`, in terms that survive a refill (the nodes themselves do not). */
function rememberFocus(body: HTMLElement): { tag: string; label: string; nth: number } | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !body.contains(active)) {
    return undefined;
  }
  const label = active.getAttribute("aria-label") ?? active.textContent ?? "";
  return {
    tag: active.tagName,
    label,
    nth: matchingNodes(body, active.tagName, label).indexOf(active),
  };
}

const matchingNodes = (body: HTMLElement, tag: string, label: string): HTMLElement[] =>
  Array.from(body.querySelectorAll<HTMLElement>(tag)).filter(
    (node) => (node.getAttribute("aria-label") ?? node.textContent ?? "") === label,
  );

function restoreFocus(body: HTMLElement, focus: ReturnType<typeof rememberFocus>): void {
  if (focus && focus.nth >= 0) {
    matchingNodes(body, focus.tag, focus.label)[focus.nth]?.focus({ preventScroll: true });
  }
}

/** Everything inside the detail dialog, built from one read of the goal. Called again, on the same body, to refresh it. */
function fillDetail(
  ctx: ActionContext,
  detail: GoalDetailRecord,
  body: HTMLElement,
  close: () => void,
): void {
  const id = detail.goal.id;
  const { goal } = detail;
  const canWrite = ctx.canWrite !== false;
  const items: MenuItem[] = [];
  if (canWrite) {
    items.push(
      goal.status === "completed"
        ? {
            label: tr(ctx.lang, "goal.menu.reopen"),
            run: () => {
              close();
              void runOr(
                ctx,
                () => ctx.request("nexus.goal.reopen", { goalId: id }),
                "goal.notice.reopened",
              );
            },
          }
        : {
            label: tr(ctx.lang, "goal.menu.complete"),
            run: () => {
              close();
              void goalCheck(ctx, id);
            },
          },
    );
    if (goal.parentId === null && goal.status === "active" && isOpenCategory(goal.category)) {
      items.push({
        label: tr(ctx.lang, "goal.menu.addSub"),
        run: () => {
          close();
          void goalCreate(ctx, goal.category, goal.id);
        },
      });
    }
    items.push(
      {
        label: tr(ctx.lang, "goal.menu.rename"),
        run: () => {
          close();
          renameDialog(ctx, goal);
        },
      },
      {
        label: tr(ctx.lang, "goal.menu.addNote"),
        run: () => {
          close();
          noteDialog(ctx, goal);
        },
      },
      {
        label: tr(ctx.lang, "goal.menu.delete"),
        tone: "danger",
        run: () => {
          close();
          deleteDialog(ctx, goal, detail.children.length > 0);
        },
      },
      {
        label: tr(ctx.lang, "goal.menu.purge"),
        tone: "danger",
        run: () => {
          close();
          purgeDialog(ctx, goal);
        },
      },
    );
  }
  if (items.length > 0) {
    const more = el("button", "nx-btn gl-more", "⋯");
    more.type = "button";
    more.setAttribute("aria-label", tr(ctx.lang, "goals.more"));
    const bar = el("div", "gl-detail-bar");
    bar.append(popupMenu(more, items));
    body.append(bar);
  }
  const meta = el("div", "gl-meta");
  meta.append(
    el("span", "pill", categoryLabel(ctx.lang, goal.category)),
    el("span", "pill", statusLabel(ctx.lang, goal.status)),
    ...(goal.sensitivity === "sensitive"
      ? [el("span", "pill", tr(ctx.lang, "goals.tag.sensitive"))]
      : []),
  );
  body.append(meta);
  if (detail.parent) {
    body.append(el("p", "muted", `${tr(ctx.lang, "goal.detail.parent")}: ${detail.parent.title}`));
  }
  const section = (labelKey: MsgKey, text: string | null, hintKey?: MsgKey) => {
    if (!text) {
      return;
    }
    const block = el("div", "gl-block");
    block.append(el("div", "gl-block-label", tr(ctx.lang, labelKey)));
    block.append(el("div", "gl-block-text", text));
    if (hintKey) {
      block.append(el("div", "muted gl-hint", tr(ctx.lang, hintKey)));
    }
    body.append(block);
  };
  section("goal.detail.userWords", goal.userWords);
  section(
    "goal.detail.summary",
    goal.summary,
    goal.origin === "user" ? "goal.detail.assistantNote" : undefined,
  );
  section("goal.detail.currentState", goal.currentState);
  if (detail.children.length > 0) {
    const block = el("div", "gl-block");
    block.append(el("div", "gl-block-label", tr(ctx.lang, "goal.detail.subGoals")));
    for (const child of detail.children.filter((item) => item.lifecycle === "live")) {
      const open = el("button", "gl-link", child.title);
      open.type = "button";
      open.addEventListener("click", () => {
        close();
        void goalDetail(ctx, child.id);
      });
      const row = el("div", "gl-subrow");
      row.append(open, el("span", "muted", ` ${statusLabel(ctx.lang, child.status)}`));
      block.append(row);
    }
    body.append(block);
  }
  const reopen = () => void goalDetail(ctx, id);
  // "Reviewed" and "later" change the goal without leaving the detail: it is refilled in place.
  const refill = () => void goalDetail(ctx, id, { onlyIfOpen: true });
  body.append(
    metricsBlock(ctx, goal, detail.metrics ?? [], {
      edit: (metric) => {
        close();
        metricDialog(ctx, goal, metric, reopen);
      },
      add: () => {
        close();
        metricDialog(ctx, goal, undefined, reopen);
      },
    }),
  );
  body.append(
    linksBlock(ctx, goal, detail.links, {
      add: () => {
        close();
        linkAddDialog(ctx, goal, reopen);
      },
      remove: (link) => {
        close();
        linkRemoveDialog(ctx, goal, link, reopen);
      },
    }),
  );
  const review = reviewBlock(ctx, goal, detail.review, refill);
  if (review) {
    body.append(review);
  }
  const activity = el("div", "gl-block");
  activity.append(el("div", "gl-block-label", tr(ctx.lang, "goal.detail.activity")));
  if (detail.entries.length === 0) {
    activity.append(el("div", "muted", tr(ctx.lang, "goal.detail.noActivity")));
  }
  const startId = detail.entriesTruncated
    ? undefined
    : detail.entries.findLast((entry) => entry.kind === "system")?.id;
  for (const group of groupEntriesByDay(detail.entries)) {
    activity.append(el("div", "gl-day", group.day));
    for (const entry of group.entries) {
      activity.append(entryLine(ctx, goal, entry, entry.id === startId));
    }
  }
  body.append(activity);
}

/**
 * Opens the goal's detail, or (when that goal's detail is already open) refills it where it stands: same window, same scroll
 * position and focus. `onlyIfOpen` is for refreshes: they never open a window the user has closed in the meantime.
 */
export async function goalDetail(
  ctx: ActionContext,
  id: string,
  options: { onlyIfOpen?: boolean } = {},
): Promise<void> {
  const seq = ++detailSeq;
  const detail = await get(ctx, id);
  if (seq !== detailSeq) {
    return;
  }
  const live = liveDetail?.id === id && liveDetail.body.isConnected ? liveDetail : undefined;
  if (options.onlyIfOpen && !live) {
    return;
  }
  if (!detail || detail.goal.lifecycle !== "live") {
    live?.close();
    return gone(ctx, id);
  }
  if (live) {
    live.ctx = ctx;
    const focus = rememberFocus(live.body);
    live.title.textContent = detail.goal.title;
    live.body.replaceChildren();
    fillDetail(ctx, detail, live.body, live.close);
    restoreFocus(live.body, focus);
    return;
  }
  // Only one detail dialog at a time: a second request replaces the one on screen instead of stacking.
  liveDetail?.close();
  let close: () => void = () => undefined;
  let mine: LiveDetail | undefined;
  close = openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: detail.goal.title,
    actions: [],
    onClose: () => {
      if (liveDetail === mine) {
        liveDetail = undefined;
      }
    },
    build: (body) => {
      const title = body.parentElement?.querySelector<HTMLElement>(".nx-title");
      if (title) {
        mine = { id, ctx, close: () => close(), title, body };
        liveDetail = mine;
      }
      fillDetail(ctx, detail, body, () => close());
    },
  });
}

const isOpenCategory = (category: GoalCategory): boolean =>
  category === "finance" || category === "interests" || category === "something_else";

// ------------------------------------------------------------------ pending goal

/** The confirmation card of an Agent's proposal: edit the title, answer its questions, approve or reject. */
export async function goalPending(ctx: ActionContext, id: string): Promise<void> {
  const detail = await get(ctx, id);
  if (!detail || detail.goal.status !== "proposed" || detail.goal.lifecycle !== "live") {
    return gone(ctx, id);
  }
  const { goal } = detail;
  let title = goal.title;
  const answers: string[] = goal.questions.map(() => "");
  const approve = async () => {
    await ctx.request("nexus.goal.confirm", {
      goalId: goal.id,
      ...(title.trim() !== goal.title ? { edits: { title: title.trim() } } : {}),
    });
    for (const [index, question] of goal.questions.entries()) {
      const answer = (answers[index] ?? "").trim();
      if (answer) {
        await ctx.request("nexus.goal.entry.add", {
          goalId: goal.id,
          kind: "note",
          text: `${question}\n${answer}`,
        });
      }
    }
    ctx.changed({ ok: true, text: tr(ctx.lang, "goal.notice.approved") });
  };
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "goal.pending.title"),
    actions: [
      {
        label: tr(ctx.lang, "goal.pending.approve"),
        tone: "primary",
        enabled: () => title.trim() !== "",
        run: approve,
      },
      {
        label: tr(ctx.lang, "goal.pending.reject"),
        tone: "danger",
        run: async () => {
          await ctx.request("nexus.goal.delete", { goalId: goal.id });
          ctx.changed({ ok: true, text: tr(ctx.lang, "goal.notice.rejected") });
        },
      },
    ],
    build: (body, changed) => {
      const input = el("input");
      input.value = title;
      input.maxLength = 200;
      input.addEventListener("input", () => {
        title = input.value;
        changed();
      });
      body.append(field(tr(ctx.lang, "goal.rename.label"), input));
      body.append(el("p", "muted", `${categoryLabel(ctx.lang, goal.category)}`));
      if (goal.summary) {
        body.append(el("p", "", goal.summary));
      }
      if (goal.currentState) {
        body.append(el("p", "muted", goal.currentState));
      }
      if (goal.questions.length > 0) {
        body.append(el("div", "gl-block-label", tr(ctx.lang, "goal.pending.questions")));
        for (const [index, question] of goal.questions.entries()) {
          body.append(el("p", "", question));
          const answer = el("textarea");
          answer.rows = 2;
          answer.maxLength = 1000;
          answer.placeholder = tr(ctx.lang, "goal.pending.answerPh");
          answer.addEventListener("input", () => {
            answers[index] = answer.value;
          });
          body.append(answer);
        }
      }
      note(body, tr(ctx.lang, "goal.pending.editNote"));
    },
  });
}

// ------------------------------------------------------------------ page menu and completed goals

export function goalMenu(ctx: ActionContext): void {
  const prefs = ctx.goalPrefs?.read();
  if (!prefs || !ctx.goalPrefs) {
    return;
  }
  const store = ctx.goalPrefs;
  let close: () => void = () => undefined;
  close = openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "goals.more"),
    actions: [],
    build: (body) => {
      const toggle = (key: "showSubtitle" | "autoSort", label: string) => {
        const line = el("label", "nx-row nx-check");
        const box = el("input");
        box.type = "checkbox";
        box.checked = prefs[key];
        box.addEventListener("change", () => {
          const next = { ...store.read(), [key]: box.checked };
          store.write(next);
          ctx.changed({ ok: true, text: "" });
        });
        line.append(box, el("span", "", label));
        body.append(line);
      };
      toggle("showSubtitle", tr(ctx.lang, "goals.menu.subtitle"));
      toggle("autoSort", tr(ctx.lang, "goals.menu.autoSort"));
      const completed = el("button", "nx-btn", tr(ctx.lang, "goals.menu.completed"));
      completed.type = "button";
      completed.addEventListener("click", () => {
        close();
        void goalCompleted(ctx);
      });
      body.append(completed);
    },
  });
}

export async function goalCompleted(ctx: ActionContext): Promise<void> {
  let goals: GoalSummaryRecord[] = [];
  try {
    goals = (
      await ctx.request<{ goals: GoalSummaryRecord[] }>("nexus.goal.list", {
        status: "completed",
        limit: 200,
      })
    ).goals;
  } catch (error) {
    ctx.changed({ ok: false, text: describeGoalError(ctx.lang, error) });
    return;
  }
  let close: () => void = () => undefined;
  close = openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "goals.completedTitle"),
    actions: [],
    build: (body) => {
      if (goals.length === 0) {
        note(body, tr(ctx.lang, "goals.completedEmpty"));
        return;
      }
      for (const group of groupByCompletedMonth(goals, ctx.lang)) {
        body.append(el("div", "gl-day", group.label));
        for (const goal of group.goals) {
          const row = el("div", "gl-row gl-done");
          const box = el("span", "gl-box on");
          const open = el("button", "gl-title", goal.title);
          open.type = "button";
          open.addEventListener("click", () => {
            close();
            void goalDetail(ctx, goal.id);
          });
          const main = el("div", "gl-main");
          main.append(open);
          row.append(box, main);
          if (ctx.canWrite !== false) {
            const more = el("button", "nx-btn gl-more", "⋯");
            more.type = "button";
            more.setAttribute("aria-label", tr(ctx.lang, "goals.more"));
            row.append(
              popupMenu(more, [
                {
                  label: tr(ctx.lang, "goal.menu.delete"),
                  tone: "danger",
                  run: () => {
                    close();
                    deleteDialog(ctx, goal, goal.childCount > 0);
                  },
                },
              ]),
            );
          }
          body.append(row);
        }
      }
    },
  });
}
