// The write side of the Work page: pause, resume, stop, end with a partial result, reopen, rename, hide, archive, delete.
// Every action opens a confirmation dialog built from the Work the page itself loaded (never from the clicked markup,
// which only carries an id). The ones that change running steps first ask the server what they would affect
// (`dryRun`), and the impact list shows exactly that, never a guess. The RPC stays the authority: it re-checks the
// revision and the state, so a stale dialog can at worst be refused.
import { tr, type Lang, type MsgKey } from "../src/i18n.js";
import type { WorkActionModel } from "../src/work-ui.js";
import type { ActionContext } from "./actions.ts";
import { openDialog, type DialogAction } from "./dialog.ts";
import { el, field, note } from "./goal-dom.ts";
import type { NexusAction } from "./sanitize.ts";

type ControlAction = "pause" | "resume" | "stop_work" | "end_partial" | "reopen";
type TaskRef = { id: string; title: string; status: string };
type ControlReply = {
  outcome?: string;
  affectedTasks?: TaskRef[];
  tasksToCancel?: TaskRef[];
  /** The follow-up checks the action would pause, bring back or end (design 6.6, WK-04). */
  schedulesToPause?: ScheduleRef[];
  schedulesToResume?: ScheduleRef[];
  schedulesToEnd?: ScheduleRef[];
};
type ScheduleRef = { id: string; purpose: string };
type Impact = { tone: "keep" | "stop" | "note"; text: string };

const MARK = { keep: "✓", stop: "✕", note: "!" } as const;

function impactList(items: readonly Impact[]): HTMLElement {
  const list = el("div", "nx-imp");
  for (const item of items) {
    const line = el("div", `nx-imp-li ${item.tone}`);
    line.append(el("span", "nx-imp-i", MARK[item.tone]), el("span", "", item.text));
    list.append(line);
  }
  return list;
}

/** A refused call, in the page language. Revision conflicts are handled by the caller (they close the dialog). */
function describeWorkError(lang: Lang, error: unknown): string {
  const text = `${(error as { code?: string } | undefined)?.code ?? ""} ${
    error instanceof Error ? error.message : String(error)
  }`;
  if (text.includes("nexus_work_has_active_tasks")) {
    return tr(lang, "work.err.hasActive");
  }
  if (text.includes("nexus_not_found")) {
    return tr(lang, "work.err.gone");
  }
  return tr(lang, "work.err.generic", {
    message: error instanceof Error ? error.message : String(error),
  });
}

const isConflict = (error: unknown): boolean =>
  `${(error as { code?: string } | undefined)?.code ?? ""} ${error instanceof Error ? error.message : ""}`.includes(
    "nexus_revision_conflict",
  );

/** Runs a write; a stale revision reloads with a notice instead of leaving the dialog open on old data. */
async function guarded(ctx: ActionContext, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (isConflict(error)) {
      ctx.changed({ ok: false, text: tr(ctx.lang, "work.notice.stale") });
      return;
    }
    throw new Error(describeWorkError(ctx.lang, error), { cause: error });
  }
}

const TITLES = {
  pause: "work.dlg.pause",
  resume: "work.dlg.resume",
  stop_work: "work.dlg.stop",
  end_partial: "work.dlg.endPartial",
  reopen: "work.dlg.reopen",
} as const satisfies Record<ControlAction, MsgKey>;
const VERBS = {
  pause: "work.ctl.pause",
  resume: "work.ctl.resume",
  stop_work: "work.ctl.stop",
  end_partial: "work.ctl.endPartial",
  reopen: "work.ctl.reopen",
} as const satisfies Record<ControlAction, MsgKey>;
const DONE = {
  pause: "work.notice.paused",
  resume: "work.notice.resumed",
  stop_work: "work.notice.stopped",
  end_partial: "work.notice.ended",
  reopen: "work.notice.reopened",
} as const satisfies Record<ControlAction, MsgKey>;
const APPLIED = new Set(["applied", "released", "ended", "reopened"]);
const SCHEDULE_IMPACT = {
  pause: ["schedulesToPause", "work.imp.pauseSchedule"],
  resume: ["schedulesToResume", "work.imp.resumeSchedule"],
  stop_work: ["schedulesToEnd", "work.imp.endSchedule"],
  end_partial: ["schedulesToEnd", "work.imp.endSchedule"],
} as const;

/** What the server said the action would touch, as the impact list. */
function impactsOf(lang: Lang, action: ControlAction, reply: ControlReply): Impact[] {
  const out: Impact[] = [];
  const lines =
    action in SCHEDULE_IMPACT ? SCHEDULE_IMPACT[action as keyof typeof SCHEDULE_IMPACT] : undefined;
  if (lines) {
    for (const item of reply[lines[0]] ?? []) {
      out.push({
        tone: action === "pause" || action === "resume" ? "note" : "stop",
        text: tr(lang, lines[1], { title: item.purpose }),
      });
    }
  }
  if (action === "pause") {
    for (const task of reply.affectedTasks ?? []) {
      out.push({ tone: "note", text: tr(lang, "work.imp.pauseTask", { title: task.title }) });
    }
  }
  if (action === "stop_work" || action === "end_partial") {
    for (const task of reply.tasksToCancel ?? []) {
      out.push({ tone: "stop", text: tr(lang, "work.imp.cancelTask", { title: task.title }) });
    }
    if (action === "end_partial") {
      out.push({ tone: "keep", text: tr(lang, "work.imp.partial") });
    }
  }
  if (action === "resume") {
    out.push({ tone: "note", text: tr(lang, "work.imp.resume") });
  }
  out.push({ tone: "keep", text: tr(lang, "work.imp.kept") });
  return out;
}

function controlDialog(
  ctx: ActionContext,
  work: WorkActionModel,
  action: ControlAction,
  controlId?: string,
): void {
  const lang = ctx.lang;
  let loaded = false;
  let reason = "";
  let basis = "";
  const base = {
    workId: work.id,
    action,
    ...(controlId ? { controlId } : {}),
  };
  const danger = action === "stop_work" || action === "end_partial";
  const actions: DialogAction[] = [
    {
      label: tr(lang, VERBS[action]),
      tone: danger ? "danger" : "primary",
      enabled: () => loaded && (action !== "reopen" || basis.trim() !== ""),
      run: () =>
        guarded(ctx, async () => {
          const reply = await ctx.request<ControlReply>("nexus.work.control", {
            ...base,
            ...(action === "pause" && reason.trim() ? { reason: reason.trim() } : {}),
            ...(action === "reopen" ? { reopenBasis: basis.trim() } : {}),
          });
          if (reply.outcome && APPLIED.has(reply.outcome)) {
            ctx.changed({ ok: true, text: tr(lang, DONE[action], { title: work.title }) });
          } else {
            // Already paused / already ended / the pause was released elsewhere: nothing was applied.
            ctx.changed({ ok: false, text: tr(lang, "work.notice.stale") });
          }
        }),
    },
  ];
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, TITLES[action], { title: work.title }),
    actions,
    build: (body, changed) => {
      if (action === "pause") {
        const input = el("input");
        input.maxLength = 100;
        input.addEventListener("input", () => {
          reason = input.value;
        });
        body.append(field(tr(lang, "work.dlg.reason"), input));
      }
      if (action === "reopen") {
        const input = el("textarea");
        input.rows = 3;
        input.maxLength = 400;
        input.addEventListener("input", () => {
          basis = input.value;
          changed();
        });
        body.append(field(tr(lang, "work.dlg.basis"), input));
      }
      const slot = el("div");
      body.append(slot);
      const status = el("p", "muted", tr(lang, "work.dlg.loading"));
      body.append(status);
      if (danger) {
        note(body, tr(lang, "work.foot.stop"));
      } else if (action === "reopen") {
        note(body, tr(lang, "work.foot.reopen"));
      }
      // The reopen preview needs some basis to get past validation; it changes nothing (dryRun).
      void ctx
        .request<ControlReply>("nexus.work.control", {
          ...base,
          dryRun: true,
          ...(action === "reopen" ? { reopenBasis: "preview" } : {}),
        })
        .then((reply) => {
          if (reply.outcome !== "preview") {
            ctx.changed({ ok: false, text: tr(lang, "work.notice.stale") });
            return;
          }
          status.remove();
          slot.replaceChildren(impactList(impactsOf(lang, action, reply)));
          loaded = true;
          changed();
        })
        .catch((error: unknown) => {
          status.textContent = describeWorkError(lang, error);
        });
    },
  });
}

function renameDialog(ctx: ActionContext, work: WorkActionModel): void {
  let title = work.title;
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "work.dlg.rename"),
    actions: [
      {
        label: tr(ctx.lang, "dlg.save"),
        tone: "primary",
        enabled: () => title.trim() !== "" && title.trim() !== work.title,
        run: () =>
          guarded(ctx, async () => {
            await ctx.request("nexus.work.update", {
              workId: work.id,
              title: title.trim(),
              expectedRevision: work.revision,
            });
            ctx.changed({ ok: true, text: tr(ctx.lang, "work.notice.renamed") });
          }),
      },
    ],
    build: (body, changed) => {
      const input = el("input");
      input.value = title;
      input.maxLength = 300;
      input.addEventListener("input", () => {
        title = input.value;
        changed();
      });
      body.append(field(tr(ctx.lang, "work.dlg.title"), input));
    },
  });
}

type SimpleKind = "hide" | "archive" | "delete";

function simpleDialog(ctx: ActionContext, work: WorkActionModel, kind: SimpleKind): void {
  const lang = ctx.lang;
  const unhide = kind === "hide" && work.hidden;
  const titleKey: MsgKey =
    kind === "delete"
      ? "work.dlg.delete"
      : kind === "archive"
        ? "work.dlg.archive"
        : unhide
          ? "work.dlg.unhide"
          : "work.dlg.hide";
  const verbKey: MsgKey =
    kind === "delete"
      ? "work.ctl.delete"
      : kind === "archive"
        ? "work.ctl.archive"
        : unhide
          ? "work.ctl.unhide"
          : "work.ctl.hide";
  const doneKey: MsgKey =
    kind === "delete"
      ? "work.notice.deleted"
      : kind === "archive"
        ? "work.notice.archived"
        : unhide
          ? "work.notice.unhidden"
          : "work.notice.hidden";
  const impacts: Impact[] =
    kind === "delete"
      ? [
          { tone: "stop", text: tr(lang, "work.imp.delete") },
          { tone: "stop", text: tr(lang, "work.imp.deleteFollow") },
        ]
      : [
          {
            tone: "keep",
            text: tr(lang, kind === "archive" ? "work.imp.archive" : "work.imp.hide"),
          },
        ];
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, titleKey, { title: work.title }),
    actions: [
      {
        label: tr(lang, verbKey),
        tone: kind === "delete" ? "danger" : "primary",
        run: () =>
          guarded(ctx, async () => {
            if (kind === "delete") {
              await ctx.request("nexus.work.delete", { workId: work.id });
            } else {
              await ctx.request("nexus.work.update", {
                workId: work.id,
                ...(kind === "archive" ? { archived: true } : { hidden: !work.hidden }),
                expectedRevision: work.revision,
              });
            }
            ctx.changed({ ok: true, text: tr(lang, doneKey, { title: work.title }) });
          }),
      },
    ],
    build: (body) => {
      body.append(impactList(impacts));
    },
  });
}

export type WorkAction = Extract<NexusAction, { kind: `work-${string}` }>;

/** Opens the dialog for a work-* marker. The page's model decides what exists; an id it does not hold is reported as gone. */
export function runWorkAction(ctx: ActionContext, action: WorkAction): void {
  const work = ctx.model().work;
  const owned =
    work !== undefined &&
    (action.kind === "work-resume"
      ? work.controls.some((control) => control.id === action.id)
      : work.id === action.id);
  if (!work || !owned) {
    ctx.changed({ ok: false, text: tr(ctx.lang, "work.err.gone") });
    return;
  }
  switch (action.kind) {
    case "work-pause":
      return controlDialog(ctx, work, "pause");
    case "work-resume":
      return controlDialog(ctx, work, "resume", action.id);
    case "work-stop":
      return controlDialog(ctx, work, "stop_work");
    case "work-endpartial":
      return controlDialog(ctx, work, "end_partial");
    case "work-reopen":
      return controlDialog(ctx, work, "reopen");
    case "work-rename":
      return renameDialog(ctx, work);
    case "work-hide":
      return simpleDialog(ctx, work, "hide");
    case "work-archive":
      return simpleDialog(ctx, work, "archive");
    case "work-delete":
      return simpleDialog(ctx, work, "delete");
  }
}
