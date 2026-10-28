// What a goal is linked to (Goals design 5.1, 9.1): the "Linked" block of the detail, and the two small dialogs that add or
// remove a link. A link is the strong claim ("this Task belongs to this goal", at most one goal per Task); the Task a note
// points at is only that note's source and is not a link. The RPCs stay the authority (state, one goal per Task, limits).
import { pointerLabel } from "../src/goal-label.js";
import { tr } from "../src/i18n.js";
import type { GoalLinkRecord, GoalRecord } from "../src/store/goal-types.js";
import type { ActionContext } from "./actions.ts";
import { openDialog } from "./dialog.ts";
import { el, note } from "./goal-dom.ts";
import { describeGoalError } from "./goal-errors.ts";
import { pointerPicker } from "./goal-progress.ts";

/** Closing either dialog (done or cancelled) returns to the detail, unless the whole page is going away. */
function backToDetail(ctx: ActionContext, reopen: () => void): void {
  if (!ctx.signal.aborted) {
    reopen();
  }
}

function linkRow(ctx: ActionContext, link: GoalLinkRecord, remove: (() => void) | undefined) {
  const row = el("div", "gl-linkrow");
  if (link.kind === "task" && link.task && !link.targetGone) {
    row.append(el("span", "", `${link.task.title} `));
    const label = pointerLabel(
      ctx.lang,
      {
        taskGone: false,
        taskStatus: link.task.status,
        taskTitle: link.task.title,
        claimState: null,
        claimGone: false,
      },
      false,
    );
    row.append(el("span", `pill ${label.tone}`.trim(), label.text));
  } else {
    row.append(
      el(
        "span",
        "",
        `${link.kind} ${link.refId}${link.targetGone ? ` (${tr(ctx.lang, "goal.detail.gone")})` : ""}`,
      ),
    );
  }
  if (remove) {
    const button = el("button", "gl-link", tr(ctx.lang, "goal.link.remove"));
    button.type = "button";
    button.addEventListener("click", remove);
    row.append(button);
  }
  return row;
}

export function linksBlock(
  ctx: ActionContext,
  goal: GoalRecord,
  links: readonly GoalLinkRecord[],
  hooks: { add: () => void; remove: (link: GoalLinkRecord) => void },
): HTMLElement {
  const block = el("div", "gl-block");
  block.append(el("div", "gl-block-label", tr(ctx.lang, "goal.detail.links")));
  if (links.length === 0) {
    block.append(el("div", "muted", tr(ctx.lang, "goal.detail.noLinks")));
  }
  const writable = ctx.canWrite !== false && goal.status !== "proposed";
  for (const link of links) {
    block.append(linkRow(ctx, link, writable ? () => hooks.remove(link) : undefined));
  }
  if (writable) {
    const add = el("button", "nx-btn", tr(ctx.lang, "goal.link.add"));
    add.type = "button";
    add.addEventListener("click", hooks.add);
    block.append(add);
  }
  return block;
}

/** Link one Task to the goal; `reopen` brings the detail back afterwards. */
export function linkAddDialog(ctx: ActionContext, goal: GoalRecord, reopen: () => void): void {
  const pick = { taskId: "", claimId: "" };
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "goal.link.addTitle"),
    onClose: () => backToDetail(ctx, reopen),
    actions: [
      {
        label: tr(ctx.lang, "goal.link.save"),
        tone: "primary",
        enabled: () => pick.taskId !== "",
        run: async () => {
          try {
            await ctx.request("nexus.goal.link.add", {
              goalId: goal.id,
              kind: "task",
              refId: pick.taskId,
            });
          } catch (error) {
            throw new Error(describeGoalError(ctx.lang, error), { cause: error });
          }
          ctx.changed({ ok: true, text: tr(ctx.lang, "goal.link.added") });
        },
      },
    ],
    build: (body, changed) => {
      note(body, tr(ctx.lang, "goal.link.addNote"));
      pointerPicker(ctx, body, pick, {
        claimRequired: false,
        taskOnly: true,
        taskLabel: "goal.metric.task",
        changed,
      });
    },
  });
}

/** Ask once, then remove the link. The Task itself is untouched. */
export function linkRemoveDialog(
  ctx: ActionContext,
  goal: GoalRecord,
  link: GoalLinkRecord,
  reopen: () => void,
): void {
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "goal.link.removeTitle"),
    onClose: () => backToDetail(ctx, reopen),
    actions: [
      {
        label: tr(ctx.lang, "goal.link.remove"),
        tone: "danger",
        run: async () => {
          try {
            await ctx.request("nexus.goal.link.remove", { goalId: goal.id, linkId: link.id });
          } catch (error) {
            throw new Error(describeGoalError(ctx.lang, error), { cause: error });
          }
          ctx.changed({ ok: true, text: tr(ctx.lang, "goal.link.removed") });
        },
      },
    ],
    build: (body) => {
      body.append(el("p", "", link.task?.title ?? `${link.kind} ${link.refId}`));
      note(body, tr(ctx.lang, "goal.link.removeNote"));
    },
  });
}
