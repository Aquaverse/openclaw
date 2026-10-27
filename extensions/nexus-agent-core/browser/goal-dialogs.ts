// The small edit dialogs of the Goals page: rename, add a note, delete (soft) and purge (typed goal id). Each one only asks and
// calls its RPC; the RPC is the authority (revision, state, cap and the sensitive-value scan are checked there).
import { tr } from "../src/i18n.js";
import type { GoalRecord } from "../src/store/goal-types.js";
import type { ActionContext } from "./actions.ts";
import { openDialog } from "./dialog.ts";
import { el, field, note } from "./goal-dom.ts";
import { pointerPicker } from "./goal-progress.ts";

export function renameDialog(ctx: ActionContext, goal: GoalRecord): void {
  let title = goal.title;
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "goal.rename.title"),
    actions: [
      {
        label: tr(ctx.lang, "dlg.save"),
        tone: "primary",
        enabled: () => title.trim() !== "" && title.trim() !== goal.title,
        run: async () => {
          await ctx.request("nexus.goal.update", {
            goalId: goal.id,
            patch: { title: title.trim() },
            expectedRevision: goal.revision,
          });
          ctx.changed({ ok: true, text: tr(ctx.lang, "goal.notice.renamed") });
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
      note(body, tr(ctx.lang, "goal.rename.note"));
    },
  });
}

export function noteDialog(ctx: ActionContext, goal: GoalRecord): void {
  let text = "";
  const pointer = { taskId: "", claimId: "" };
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "goal.note.title"),
    actions: [
      {
        label: tr(ctx.lang, "dlg.save"),
        tone: "primary",
        enabled: () => text.trim() !== "",
        run: async () => {
          await ctx.request("nexus.goal.entry.add", {
            goalId: goal.id,
            kind: "note",
            text: text.trim(),
            ...(pointer.taskId ? { taskId: pointer.taskId } : {}),
            ...(pointer.taskId && pointer.claimId ? { claimId: pointer.claimId } : {}),
          });
          ctx.changed({ ok: true, text: tr(ctx.lang, "goal.notice.noted") });
        },
      },
    ],
    build: (body, changed) => {
      const input = el("textarea");
      input.rows = 5;
      input.maxLength = 2000;
      input.addEventListener("input", () => {
        text = input.value;
        changed();
      });
      body.append(field(tr(ctx.lang, "goal.note.label"), input));
      // Optional: point the note at a Task (and one of its claims); the detail then shows their live status.
      pointerPicker(ctx, body, pointer, {
        claimRequired: false,
        taskLabel: "goal.note.task",
        changed,
      });
    },
  });
}

export function deleteDialog(ctx: ActionContext, goal: GoalRecord, hasChildren: boolean): void {
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "goal.delete.title"),
    actions: [
      {
        label: tr(ctx.lang, "goal.menu.delete"),
        tone: "danger",
        run: async () => {
          await ctx.request("nexus.goal.delete", { goalId: goal.id });
          ctx.changed({ ok: true, text: tr(ctx.lang, "goal.notice.deleted") });
        },
      },
    ],
    build: (body) => {
      body.append(el("p", "", goal.title));
      note(body, tr(ctx.lang, "goal.delete.note"));
      if (hasChildren) {
        note(body, tr(ctx.lang, "goal.delete.withSub"));
      }
    },
  });
}

export function purgeDialog(ctx: ActionContext, goal: GoalRecord): void {
  let typed = "";
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "goal.purge.title"),
    actions: [
      {
        label: tr(ctx.lang, "goal.menu.purge"),
        tone: "danger",
        enabled: () => typed.trim() === goal.id,
        run: async () => {
          await ctx.request("nexus.goal.purge", { goalId: goal.id, confirmGoalId: typed.trim() });
          ctx.changed({ ok: true, text: tr(ctx.lang, "goal.notice.purged") });
        },
      },
    ],
    build: (body, changed) => {
      body.append(el("p", "", goal.title));
      note(body, tr(ctx.lang, "goal.purge.note", { id: goal.id }));
      const input = el("input");
      input.setAttribute("autocomplete", "off");
      input.addEventListener("input", () => {
        typed = input.value;
        changed();
      });
      body.append(input);
    },
  });
}
