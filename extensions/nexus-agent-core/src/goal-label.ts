// Pure helpers for the labels the Goals detail shows next to a pointer (Goals design 6.1): what the Task or claim an entry,
// a link or a metric points at looks like RIGHT NOW. No DOM and no SDK, so tests can run them directly.
import { tr, type Lang, type MsgKey } from "./i18n.js";
import type { GoalMetricRecord, GoalPointerState } from "./store/goal-types.js";

export type PointerTone = "ok" | "bad" | "pending" | "";
export type PointerLabel = { text: string; tone: PointerTone };

const CLAIM_TONE: Record<string, PointerTone> = {
  VERIFIED: "ok",
  SUPPORTED: "ok",
  REFUTED: "bad",
  ASSERTED: "",
  UNKNOWN: "",
};
const TASK_TONE: Record<string, PointerTone> = {
  succeeded: "ok",
  failed: "bad",
  cancelled: "bad",
  deleted: "bad",
  executing: "pending",
  awaiting_decision: "pending",
};

/** The pill for a pointer. A claim, when there is one, outranks the Task it belongs to. */
export function pointerLabel(
  lang: Lang,
  pointer: GoalPointerState,
  hasClaim: boolean,
): PointerLabel {
  if (pointer.taskGone) {
    return { text: tr(lang, "goal.ptr.taskGone"), tone: "" };
  }
  if (hasClaim) {
    if (pointer.claimGone || pointer.claimState === null) {
      return { text: tr(lang, "goal.ptr.claimGone"), tone: "" };
    }
    return {
      text: tr(lang, `goal.claim.${pointer.claimState}` as MsgKey),
      tone: CLAIM_TONE[pointer.claimState] ?? "",
    };
  }
  const status = pointer.taskStatus ?? "";
  return { text: tr(lang, "goal.ptr.task", { status }), tone: TASK_TONE[status] ?? "" };
}

const figure = (value: number): string =>
  Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);

/** "4 / 10 km", "4 km", "— / 10 km" or "—": the figure line of a metric. */
export function metricFigure(lang: Lang, metric: GoalMetricRecord): string {
  const unit = metric.unit === "" ? "" : ` ${metric.unit}`;
  if (metric.current === null && metric.target === null) {
    return tr(lang, "goal.metric.noFigure");
  }
  const current = metric.current === null ? "—" : figure(metric.current);
  if (metric.target === null) {
    return `${current}${unit}`;
  }
  return `${current} / ${figure(metric.target)}${unit}`;
}

/** 0..100 for an "at least" metric with a positive target; undefined when a bar would mean nothing. */
export function metricPercent(metric: GoalMetricRecord): number | undefined {
  if (
    metric.direction !== "up" ||
    metric.target === null ||
    metric.target <= 0 ||
    metric.current === null
  ) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.round((metric.current / metric.target) * 100)));
}

/** Is the target met in a way worth showing? A claim figure counts only once the claim is supported or verified. */
export function metricMet(metric: GoalMetricRecord): boolean {
  if (metric.target === null || metric.current === null) {
    return false;
  }
  const met =
    metric.direction === "up" ? metric.current >= metric.target : metric.current <= metric.target;
  if (!met) {
    return false;
  }
  return (
    metric.source === "manual" ||
    metric.pointer?.claimState === "SUPPORTED" ||
    metric.pointer?.claimState === "VERIFIED"
  );
}
