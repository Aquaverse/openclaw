// The "Periodic review" block of a goal's detail (Goals G3a): how often the user wants to look back, when the next look-back is
// due, and the two buttons "reviewed" and "later". It is a reminder only: nothing runs in the background, and the reminder
// shows up when the user opens this page or starts a chat. The RPCs stay the authority (state, ownership, the date maths).
import { tr, type MsgKey } from "../src/i18n.js";
import {
  GOAL_REVIEW_CADENCES,
  type GoalRecord,
  type GoalReviewCadence,
  type GoalReviewPlan,
} from "../src/store/goal-types.js";
import type { ActionContext } from "./actions.ts";
import { el } from "./goal-dom.ts";
import { describeGoalError } from "./goal-errors.ts";

const OFF = "off";
const CADENCE_KEY: Record<GoalReviewCadence, MsgKey> = {
  weekly: "goal.review.weekly",
  biweekly: "goal.review.biweekly",
  monthly: "goal.review.monthly",
};
const day = (ms: number): string => new Date(ms).toLocaleDateString();

/** The sentence for a refusal on this block; a state refusal here means the goal is no longer in progress. */
function reviewError(ctx: ActionContext, error: unknown): string {
  const text = `${(error as { code?: string } | undefined)?.code ?? ""} ${error instanceof Error ? error.message : String(error)}`;
  if (text.includes("not allowed while the goal is")) {
    return tr(ctx.lang, "goal.review.notActive");
  }
  if (text.includes("has no review cadence")) {
    return tr(ctx.lang, "goal.review.noPlan");
  }
  return describeGoalError(ctx.lang, error);
}

export function reviewBlock(
  ctx: ActionContext,
  goal: GoalRecord,
  review: GoalReviewPlan | undefined,
  reopen: () => void,
): HTMLElement | undefined {
  if (goal.status !== "active" || goal.lifecycle !== "live") {
    return undefined;
  }
  const writable = ctx.canWrite !== false;
  if (!writable && !review) {
    return undefined;
  }
  const block = el("div", "gl-block gl-review");
  block.append(el("div", "gl-block-label", tr(ctx.lang, "goal.review.title")));

  /** Run one call, show the notice, and draw the detail again from the server. */
  const run = async (
    method: string,
    params: Record<string, unknown>,
    notice: (payload: { review?: GoalReviewPlan | null }) => string,
  ) => {
    let payload: { review?: GoalReviewPlan | null };
    try {
      payload = (await ctx.request(method, { goalId: goal.id, ...params })) as typeof payload;
    } catch (error) {
      ctx.changed({ ok: false, text: reviewError(ctx, error) });
      return;
    }
    ctx.changed({ ok: true, text: notice(payload) });
    reopen();
  };

  const pick = el("select");
  pick.setAttribute("aria-label", tr(ctx.lang, "goal.review.cadence"));
  for (const value of [OFF, ...GOAL_REVIEW_CADENCES]) {
    const option = el(
      "option",
      "",
      value === OFF
        ? tr(ctx.lang, "goal.review.off")
        : tr(ctx.lang, CADENCE_KEY[value as GoalReviewCadence]),
    );
    option.value = value;
    pick.append(option);
  }
  pick.value = review?.cadence ?? OFF;
  pick.disabled = !writable;
  pick.addEventListener("change", () => {
    const cadence = pick.value === OFF ? null : (pick.value as GoalReviewCadence);
    void run("nexus.goal.review.set", { cadence }, (payload) =>
      payload.review
        ? tr(ctx.lang, "goal.review.setNotice", {
            cadence: tr(ctx.lang, CADENCE_KEY[payload.review.cadence]),
            date: day(payload.review.nextDueAt),
          })
        : tr(ctx.lang, "goal.review.clearedNotice"),
    );
  });
  const line = el("div", "gl-review-line");
  line.append(pick);
  if (review?.due) {
    line.append(el("span", "pill pending", tr(ctx.lang, "goal.review.due")));
  }
  block.append(line);

  if (review) {
    const snoozed = review.snoozedUntil !== null && review.snoozedUntil > Date.now();
    block.append(
      el(
        "div",
        "muted",
        snoozed
          ? tr(ctx.lang, "goal.review.snoozedTo", { date: day(review.snoozedUntil as number) })
          : tr(ctx.lang, "goal.review.next", { date: day(review.nextDueAt) }),
      ),
    );
    if (review.lastReviewedAt !== null) {
      block.append(
        el("div", "muted", tr(ctx.lang, "goal.review.last", { date: day(review.lastReviewedAt) })),
      );
    }
    if (writable) {
      const buttons = el("div", "gl-review-buttons");
      const done = el("button", "nx-btn", tr(ctx.lang, "goal.review.done"));
      done.type = "button";
      done.addEventListener(
        "click",
        () =>
          void run("nexus.goal.review.act", { action: "done", lang: ctx.lang }, (payload) =>
            tr(ctx.lang, "goal.review.doneNotice", {
              date: day(payload.review?.nextDueAt ?? Date.now()),
            }),
          ),
      );
      const later = el("button", "nx-btn", tr(ctx.lang, "goal.review.later"));
      later.type = "button";
      later.addEventListener(
        "click",
        () =>
          void run("nexus.goal.review.act", { action: "snooze" }, (payload) =>
            tr(ctx.lang, "goal.review.laterNotice", {
              date: day(payload.review?.snoozedUntil ?? Date.now()),
            }),
          ),
      );
      buttons.append(done, later);
      block.append(buttons);
    }
  }
  block.append(el("div", "muted gl-hint", tr(ctx.lang, "goal.review.hint")));
  return block;
}
