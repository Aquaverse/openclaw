// The write side of the "Follow-up" block of the Work page: new / edit / start / not-now for a plan, and pause / resume / stop for one
// check. Every dialog is built from the plans and schedules the page itself loaded (the clicked marker carries only an id), says what
// will and will NOT happen, and then calls the existing operator.write RPC. A plan is a draft until the user confirms it, and a check
// only reads and reports. The RPC stays the authority: it re-checks versions and state, so a stale dialog can at worst be refused.
import { cadenceText, checkParts } from "../src/follow-ui.js";
import { tr, type Lang } from "../src/i18n.js";
import { MANUAL_TRIGGER_COOLDOWN_MS } from "../src/schedule/types.js";
import type {
  DelegationPlanRecord,
  PlanOwnerType,
  ScheduleRecord,
  TriggerRecord,
} from "../src/schedule/types.js";
import type { ActionContext } from "./actions.ts";
import { block, impactList, newRequestId, select, text } from "./commitment-form.ts";
import { openDialog, type DialogAction } from "./dialog.ts";
import {
  buildPlanFields,
  emptyForm,
  formFromPlan,
  formProblem,
  toPlan,
  type PlanForm,
} from "./follow-form.ts";
import { el } from "./goal-dom.ts";
import type { NexusAction } from "./sanitize.ts";

type PlanReply = {
  outcome?: string;
  plan?: DelegationPlanRecord;
  schedules?: ScheduleRecord[];
  gaps?: { code: string }[];
  code?: string;
};

/** A refusal in the page language. */
export function describeFollowError(lang: Lang, error: unknown): string {
  const t = text(error);
  if (t.includes("nexus_not_found")) {
    return tr(lang, "fu.err.gone");
  }
  if (t.includes("nexus_schedule_state")) {
    return tr(lang, "fu.err.state");
  }
  return tr(lang, "fu.err.generic", {
    message: error instanceof Error ? error.message : String(error),
  });
}

/** An error whose words are already the sentence for the user: shown as it is, without the generic prefix. */
class Said extends Error {}

// "bad_replaces": the plan this edit was meant to replace is no longer the running one (another window changed or ended it).
const isConflict = (error: unknown): boolean =>
  text(error).includes("nexus_revision_conflict") || text(error).includes("bad_replaces");

async function guarded(ctx: ActionContext, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (error instanceof Said) {
      throw error;
    }
    if (isConflict(error)) {
      ctx.changed({ ok: false, text: tr(ctx.lang, "fu.notice.stale") });
      return;
    }
    throw new Error(describeFollowError(ctx.lang, error), { cause: error });
  }
}

/** Confirm a draft; anything but an acceptance is thrown as a sentence, so the dialog stays open with the reason. */
async function confirmPlan(
  ctx: ActionContext,
  plan: { id: string; planVersion: number },
  replaces?: { planId: string; planVersion: number },
): Promise<void> {
  const lang = ctx.lang;
  const reply = await ctx.request<PlanReply>("nexus.delegation.confirm", {
    planId: plan.id,
    expectedPlanVersion: plan.planVersion,
    ...(replaces ? { replaces } : {}),
  });
  if (reply.outcome === "accepted" || reply.outcome === "already_accepted") {
    const blocked = (reply.schedules ?? []).some((s) => s.status === "blocked");
    ctx.changed({
      ok: true,
      text: tr(lang, blocked ? "fu.notice.startedBlocked" : "fu.notice.started"),
    });
    return;
  }
  if (reply.outcome === "gaps") {
    throw new Error(
      tr(lang, "fu.err.gaps", { gaps: (reply.gaps ?? []).map((g) => g.code).join(", ") }),
    );
  }
  if (reply.outcome === "plan_exists") {
    throw new Error(tr(lang, "fu.err.exists"));
  }
  if (reply.outcome === "invalid") {
    throw new Error(tr(lang, "fu.err.invalid", { code: String(reply.code ?? "") }));
  }
  ctx.changed({ ok: false, text: tr(lang, "fu.notice.stale") });
}

/** The five lines the user is accepting, plus the checks, as plain rows (the review before anything starts). */
export function planSummary(lang: Lang, plan: DelegationPlanRecord, now = Date.now()): HTMLElement {
  const body = plan.plan;
  const box = el("div");
  const pair = (label: string, value: string) => {
    const line = el("div", "nx-row");
    line.append(el("span", "nx-label", label), el("span", "", value));
    box.append(line);
  };
  const none = tr(lang, "fu.none");
  const sep = lang === "en" ? "; " : "；";
  pair(tr(lang, "fu.f.purpose"), plan.purpose);
  pair(tr(lang, "fu.k.look"), (body.sources ?? []).join(sep) || none);
  pair(
    tr(lang, "fu.k.often"),
    (body.schedules ?? [])
      .map((s) => `${s.purpose}（${cadenceText(lang, s.cadence as never, now)}）`)
      .join(sep) || none,
  );
  const until = (body.stopConditions ?? []).find((stop) => stop.kind === "until");
  pair(
    tr(lang, "fu.k.until"),
    until && until.kind === "until"
      ? tr(lang, "fu.until.at", { time: new Date(until.at).toLocaleString() })
      : tr(lang, "fu.until.open"),
  );
  pair(tr(lang, "fu.k.notify"), body.notifyText ?? tr(lang, "fu.notifyNone"));
  pair(tr(lang, "fu.k.wont"), (body.wontDo ?? []).join(sep) || none);
  return box;
}

const ownerKey = (type: PlanOwnerType, id: string) => `${type}:${id}`;

async function createDraft(
  ctx: ActionContext,
  workId: string,
  owner: { type: PlanOwnerType; id: string },
  form: PlanForm,
  replacesPlanId?: string,
): Promise<DelegationPlanRecord> {
  const made = toPlan(ctx.lang, form);
  const reply = await ctx.request<PlanReply>("nexus.delegation.create", {
    workId,
    planOwnerType: owner.type,
    planOwnerId: owner.id,
    purpose: made.purpose,
    plan: made.plan,
    startIntent: made.startIntent,
    ...(replacesPlanId ? { replacesPlanId } : {}),
    requestRef: newRequestId(),
  });
  if (reply.outcome !== "created" || !reply.plan) {
    throw new Error(tr(ctx.lang, "fu.err.invalid", { code: String(reply.outcome ?? "") }));
  }
  return reply.plan;
}

function planDialog(ctx: ActionContext, workId: string, existing?: DelegationPlanRecord): void {
  const lang = ctx.lang;
  const model = ctx.model();
  const current = existing?.status === "accepted" ? existing : undefined;
  const running = current !== undefined;
  const form = existing ? formFromPlan(lang, existing) : emptyForm(lang);
  // The owner of a new plan: the Work itself, or one of the commitments it requires and that is still open.
  const owners: { type: PlanOwnerType; id: string; label: string }[] = [
    { type: "work", id: workId, label: tr(lang, "fu.f.owner.work") },
    ...(model.commitments ?? [])
      .filter(
        (line) =>
          line.role === "required" &&
          (line.commitment.lifecycle === "open" || line.commitment.lifecycle === "waiting"),
      )
      .map((line) => ({
        type: "commitment" as const,
        id: line.commitment.id,
        label: line.commitment.requirementText.slice(0, 60),
      })),
  ];
  let chosen = owners[0]!;
  let problem = formProblem(form);
  // Editing a running plan (or saving a draft again) with nothing changed would only make a copy of itself.
  const initial = JSON.stringify(form);
  const edited = () => JSON.stringify(form) !== initial;
  const owner = existing ? { type: existing.planOwnerType, id: existing.planOwnerId } : undefined;
  const run =
    (start: boolean): (() => Promise<void>) =>
    () =>
      guarded(ctx, async () => {
        const target = owner ?? { type: chosen.type, id: chosen.id };
        if (existing && existing.status === "draft") {
          const made = toPlan(lang, form);
          const updated = await ctx.request<PlanReply>("nexus.delegation.update", {
            planId: existing.id,
            expectedPlanVersion: existing.planVersion,
            changes: { purpose: made.purpose, plan: made.plan, startIntent: made.startIntent },
          });
          if (updated.outcome !== "updated" || !updated.plan) {
            throw new Error(tr(lang, "fu.err.invalid", { code: String(updated.outcome ?? "") }));
          }
          if (start) {
            await confirmPlan(ctx, updated.plan);
          } else {
            ctx.changed({ ok: true, text: tr(lang, "fu.notice.saved") });
          }
          return;
        }
        const draft = await createDraft(ctx, workId, target, form, current?.id);
        if (start) {
          await confirmPlan(
            ctx,
            draft,
            current ? { planId: current.id, planVersion: current.planVersion } : undefined,
          );
        } else {
          ctx.changed({ ok: true, text: tr(lang, "fu.notice.saved") });
        }
      });
  const actions: DialogAction[] = [
    ...(running
      ? []
      : [
          {
            label: tr(lang, "fu.dlg.save"),
            tone: "plain" as const,
            enabled: () => problem === null && (!existing || edited()),
            run: run(false),
          },
        ]),
    {
      label: tr(lang, "fu.dlg.confirm"),
      tone: "primary",
      enabled: () => problem === null && (!running || edited()),
      run: run(true),
    },
  ];
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, existing ? (running ? "fu.dlg.editRunning" : "fu.dlg.edit") : "fu.dlg.new"),
    actions,
    build: (body, changed) => {
      const status = el("p", "error");
      const hint = el("p", "muted", tr(lang, "fu.dlg.noChange"));
      const recheck = () => {
        problem = formProblem(form);
        status.textContent = problem ? tr(lang, problem as never) : "";
        status.hidden = problem === null || form.purpose === "";
        hint.hidden = !running || problem !== null || edited();
        changed();
      };
      let extra: HTMLElement | undefined;
      if (!existing && owners.length > 1) {
        extra = block(
          tr(lang, "fu.f.owner"),
          select(
            owners.map((o) => [o.label, ownerKey(o.type, o.id)] as [string, string]),
            ownerKey(chosen.type, chosen.id),
            (v) => {
              chosen = owners.find((o) => ownerKey(o.type, o.id) === v) ?? chosen;
            },
          ),
        );
      }
      buildPlanFields(lang, body, form, recheck, extra);
      body.append(
        status,
        hint,
        el("p", "muted", tr(lang, running ? "fu.dlg.editRunningNote" : "fu.dlg.draftNote")),
      );
      recheck();
    },
  });
}

function startDialog(ctx: ActionContext, plan: DelegationPlanRecord): void {
  const lang = ctx.lang;
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "fu.dlg.startTitle"),
    actions: [
      {
        label: tr(lang, "fu.btn.start"),
        tone: "primary",
        run: () => guarded(ctx, () => confirmPlan(ctx, plan)),
      },
    ],
    build: (body) => {
      body.append(planSummary(lang, plan), el("p", "muted", tr(lang, "fu.dlg.startNote")));
    },
  });
}

const PAGE = 20;

/** The full list of check records of one check, newest first, a page at a time. Read only: it never changes anything. */
function historyDialog(ctx: ActionContext, schedule: ScheduleRecord): void {
  const lang = ctx.lang;
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "fu.hist.close"),
    title: tr(lang, "fu.hist.title", { purpose: schedule.purpose.slice(0, 80) }),
    actions: [],
    build: (body) => {
      const status = el("p", "muted", tr(lang, "fu.hist.loading"));
      const list = el("ul", "nx-fu-hist");
      const more = el("button", "nx-btn", tr(lang, "fu.hist.more"));
      more.type = "button";
      more.hidden = true;
      const tail = el("p", "muted");
      body.append(status, list, more, tail);
      let cursor: string | undefined;
      let shown = 0;
      const load = async () => {
        more.disabled = true;
        try {
          const reply = await ctx.request<{ triggers?: TriggerRecord[]; next?: string }>(
            "nexus.schedule.history",
            {
              scheduleId: schedule.id,
              limit: PAGE,
              ...(cursor ? { before: cursor } : {}),
            },
          );
          status.remove();
          for (const t of reply.triggers ?? []) {
            const p = checkParts(lang, t, Date.now());
            const item = el("li");
            const head = el(
              "div",
              "nx-fu-hh",
              [p.time, p.source].filter((x) => x !== "").join(" · "),
            );
            const what = el("div", `nx-fu-hw${p.bad ? " nx-fu-bad" : ""}`, p.what);
            item.append(head, what);
            if (p.note) {
              item.append(el("div", `nx-fu-hn${p.bad ? " nx-fu-bad" : ""}`, p.note));
            }
            list.append(item);
            shown++;
          }
          cursor = reply.next;
          more.hidden = cursor === undefined;
          tail.textContent =
            shown === 0
              ? tr(lang, "fu.hist.empty")
              : cursor === undefined
                ? tr(lang, "fu.hist.end")
                : "";
        } catch (error) {
          status.textContent = describeFollowError(lang, error);
        } finally {
          more.disabled = false;
        }
      };
      more.addEventListener("click", () => void load());
      void load();
    },
  });
}

/** The words for a manual check that did not start: each outcome the server can give has its own sentence. */
function checkRefusal(lang: Lang, reply: { outcome?: string; retryAt?: number }): string {
  switch (reply.outcome) {
    case "cooldown": {
      const at = reply.retryAt ? new Date(reply.retryAt) : undefined;
      const time = at
        ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
        : "";
      return tr(lang, "fu.check.cooldown", { time });
    }
    case "slot_busy":
      return tr(lang, "fu.check.busy");
    case "host_unavailable":
      return tr(lang, "fu.check.host");
    case "blocked":
      return tr(lang, "fu.check.blocked");
    case "wrapping_up":
      return tr(lang, "fu.check.wrapping");
    case "not_active":
    case "not_check_task":
      return tr(lang, "fu.check.notActive");
    default:
      return tr(lang, "fu.check.failed");
  }
}

function simple(
  ctx: ActionContext,
  title: string,
  bodyText: string,
  verb: string,
  danger: boolean,
  run: () => Promise<void>,
  extra: string[] = [],
): void {
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title,
    actions: [{ label: verb, tone: danger ? "danger" : "primary", run: () => guarded(ctx, run) }],
    build: (body) => {
      body.append(
        impactList([
          { tone: danger ? "stop" : "note", text: bodyText },
          ...extra.map((line) => ({ tone: "note" as const, text: line })),
        ]),
      );
    },
  });
}

export type FollowAction = Extract<NexusAction, { kind: `fu-${string}` }>;

/** Opens the dialog for an fu-* marker. The page's model decides what exists; an id it does not hold is reported as gone. */
export function runFollowAction(ctx: ActionContext, action: FollowAction): void {
  const lang = ctx.lang;
  const model = ctx.model();
  const data = model.followUp;
  const workId = model.work?.id;
  const gone = () => ctx.changed({ ok: false, text: tr(lang, "fu.err.gone") });
  if (!data || !workId) {
    return gone();
  }
  if (action.kind === "fu-new") {
    return action.id === workId ? planDialog(ctx, workId) : gone();
  }
  const plan = data.plans.find((p) => p.id === action.id);
  const schedule = data.schedules.find((s) => s.id === action.id);
  switch (action.kind) {
    case "fu-edit":
      return plan && (plan.status === "draft" || plan.status === "accepted")
        ? planDialog(ctx, workId, plan)
        : gone();
    case "fu-start":
      return plan?.status === "draft" ? startDialog(ctx, plan) : gone();
    case "fu-skip":
      return plan?.status === "draft"
        ? simple(
            ctx,
            tr(lang, "fu.dlg.skipTitle"),
            tr(lang, "fu.dlg.skipBody"),
            tr(lang, "fu.dlg.skipDo"),
            false,
            async () => {
              await ctx.request("nexus.delegation.revoke", {
                planId: plan.id,
                expectedPlanVersion: plan.planVersion,
              });
              ctx.changed({ ok: true, text: tr(lang, "fu.notice.skipped") });
            },
          )
        : gone();
    case "fu-end":
      return plan?.status === "accepted"
        ? simple(
            ctx,
            tr(lang, "fu.dlg.endTitle"),
            tr(lang, "fu.dlg.endBody"),
            tr(lang, "fu.dlg.endDo"),
            true,
            async () => {
              await ctx.request("nexus.delegation.end", {
                planId: plan.id,
                expectedPlanVersion: plan.planVersion,
                reason: "user_ended",
              });
              ctx.changed({ ok: true, text: tr(lang, "fu.notice.ended") });
            },
          )
        : gone();
    case "fu-history":
      return schedule ? historyDialog(ctx, schedule) : gone();
    case "fu-check":
      return schedule?.status === "active"
        ? simple(
            ctx,
            tr(lang, "fu.dlg.checkTitle"),
            tr(lang, "fu.dlg.checkBody", { minutes: String(MANUAL_TRIGGER_COOLDOWN_MS / 60_000) }),
            tr(lang, "fu.dlg.checkDo"),
            false,
            async () => {
              const reply = await ctx.request<{ outcome?: string; retryAt?: number }>(
                "nexus.schedule.checkNow",
                {
                  scheduleId: schedule.id,
                },
              );
              if (reply.outcome !== "started") {
                throw new Said(checkRefusal(lang, reply));
              }
              ctx.changed({ ok: true, text: tr(lang, "fu.notice.checkStarted") });
            },
          )
        : gone();
    case "fu-pause":
      return schedule?.status === "active"
        ? simple(
            ctx,
            tr(lang, "fu.dlg.pauseTitle"),
            tr(lang, "fu.dlg.pauseBody"),
            tr(lang, "fu.btn.pause"),
            false,
            async () => {
              await ctx.request("nexus.schedule.pause", {
                scheduleId: schedule.id,
                expectedRevision: schedule.revision,
              });
              ctx.changed({ ok: true, text: tr(lang, "fu.notice.paused") });
            },
          )
        : gone();
    case "fu-resume":
      return schedule?.status === "paused"
        ? simple(
            ctx,
            tr(lang, "fu.dlg.resumeTitle"),
            tr(lang, "fu.dlg.resumeBody"),
            tr(lang, "fu.btn.resume"),
            false,
            async () => {
              const reply = await ctx.request<{ outcome?: string; gaps?: { code: string }[] }>(
                "nexus.schedule.resume",
                {
                  scheduleId: schedule.id,
                  expectedRevision: schedule.revision,
                },
              );
              if (reply.outcome === "gaps") {
                throw new Error(
                  tr(lang, "fu.err.gaps", {
                    gaps: (reply.gaps ?? []).map((g) => g.code).join(", "),
                  }),
                );
              }
              ctx.changed({ ok: true, text: tr(lang, "fu.notice.resumed") });
            },
          )
        : gone();
    case "fu-stop": {
      if (!schedule || !["active", "paused", "blocked"].includes(schedule.status)) {
        return gone();
      }
      const others = data.schedules.filter(
        (s) =>
          s.planId === schedule.planId &&
          s.id !== schedule.id &&
          ["active", "paused", "blocked"].includes(s.status),
      );
      return simple(
        ctx,
        tr(lang, "fu.dlg.stopTitle"),
        tr(lang, "fu.dlg.stopBody"),
        tr(lang, "fu.btn.stop"),
        true,
        async () => {
          await ctx.request("nexus.work.control", {
            workId,
            action: "stop_follow_up",
            scheduleId: schedule.id,
          });
          ctx.changed({ ok: true, text: tr(lang, "fu.notice.stopped") });
        },
        others.length === 0 ? [tr(lang, "fu.dlg.stopLast")] : [],
      );
    }
  }
}
