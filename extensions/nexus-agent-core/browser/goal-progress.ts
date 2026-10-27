// The progress part of the Goals detail (Goals design 6): activity lines and links with the LIVE state of the Task or claim they
// point at, the metrics block, and the dialogs that add or edit a metric. Everything is built from DOM nodes and textContent.
// The labels are read when the detail opens and never stored, so a refuted claim changes the label and leaves the text alone;
// the RPCs stay the authority (state, finance rule, name clash, sensitive-value scan).
import { metricFigure, metricMet, metricPercent, pointerLabel } from "../src/goal-label.js";
import { tr, type MsgKey } from "../src/i18n.js";
import type {
  GoalEntryRecord,
  GoalLinkRecord,
  GoalMetricDirection,
  GoalMetricRecord,
  GoalRecord,
} from "../src/store/goal-types.js";
import type { ActionContext } from "./actions.ts";
import { openDialog } from "./dialog.ts";
import { el, field, note } from "./goal-dom.ts";

// ------------------------------------------------------------------ activity and links

export function entryLine(
  ctx: ActionContext,
  goal: GoalRecord,
  entry: GoalEntryRecord,
  isStart: boolean,
): HTMLElement {
  const line = el("div", entry.retractedAt === null ? "gl-entry" : "gl-entry gl-retracted");
  const head = el("div", "gl-entry-head");
  head.append(
    el("span", "pill", tr(ctx.lang, `goal.author.${entry.author}` as MsgKey)),
    el(
      "span",
      "muted",
      new Date(entry.effectiveAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    ),
  );
  if (entry.pointer) {
    const label = pointerLabel(ctx.lang, entry.pointer, entry.claimId !== null);
    head.append(el("span", `pill ${label.tone}`.trim(), label.text));
  } else if (entry.kind !== "system") {
    head.append(el("span", "pill muted", tr(ctx.lang, "goal.ptr.self")));
  }
  const text = el("div", "gl-entry-text");
  if (entry.kind === "system") {
    // The oldest system entry is the goal's start; a later one (a metric reaching its target) carries its own sentence.
    text.textContent = isStart
      ? tr(ctx.lang, "goal.detail.added", { title: goal.title })
      : entry.text;
    line.append(head, text);
    if (isStart && entry.text) {
      line.append(el("div", "gl-entry-sub", entry.text));
    }
    return line;
  }
  text.textContent =
    entry.text + (entry.retractedAt === null ? "" : ` ${tr(ctx.lang, "goal.detail.retracted")}`);
  line.append(head, text);
  if (entry.pointer && !entry.pointer.taskGone && entry.pointer.taskTitle) {
    line.append(
      el(
        "div",
        "gl-entry-sub",
        tr(ctx.lang, "goal.ptr.taskTitle", { title: entry.pointer.taskTitle }),
      ),
    );
  }
  return line;
}

export function linkRow(ctx: ActionContext, link: GoalLinkRecord): HTMLElement {
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
    return row;
  }
  row.textContent = `${link.kind} ${link.refId}${link.targetGone ? ` (${tr(ctx.lang, "goal.detail.gone")})` : ""}`;
  return row;
}

// ------------------------------------------------------------------ choosing a Task and one of its claims

type TaskOption = { id: string; title: string; status: string };
type ClaimOption = { id: string; subject: string; predicate: string; state: string };

async function loadTasks(ctx: ActionContext): Promise<TaskOption[]> {
  try {
    const reply = await ctx.request<{ tasks: TaskOption[] }>("nexus.task.list", {
      limit: 100,
      includeClosed: true,
    });
    return reply.tasks ?? [];
  } catch {
    return [];
  }
}

async function loadClaims(ctx: ActionContext, taskId: string): Promise<ClaimOption[]> {
  try {
    const reply = await ctx.request<{ claims: ClaimOption[] }>("nexus.claim.list", {
      taskId,
      limit: 100,
    });
    return reply.claims ?? [];
  } catch {
    return [];
  }
}

const option = (value: string, text: string): HTMLOptionElement => {
  const node = el("option", "", text);
  node.value = value;
  return node;
};

/**
 * Two selects: a Task, then (once one is chosen) one of its claims. `state` is filled in as the user chooses, and `changed` is
 * called after each choice. With `claimRequired` the claim is mandatory (a claim-backed metric); otherwise it is optional.
 */
export function pointerPicker(
  ctx: ActionContext,
  body: HTMLElement,
  state: { taskId: string; claimId: string },
  opts: { claimRequired: boolean; taskLabel: MsgKey; changed: () => void },
): void {
  const taskSelect = el("select");
  taskSelect.append(
    option("", tr(ctx.lang, opts.claimRequired ? "goal.metric.pickTask" : "goal.note.noTask")),
  );
  const claimSelect = el("select");
  const claimRow = field(
    tr(ctx.lang, opts.claimRequired ? "goal.metric.claim" : "goal.note.claim"),
    claimSelect,
  );
  claimRow.hidden = true;
  body.append(field(tr(ctx.lang, opts.taskLabel), taskSelect), claimRow);
  void loadTasks(ctx).then((tasks) => {
    for (const task of tasks) {
      taskSelect.append(option(task.id, `${task.title} · ${task.status}`));
    }
  });
  taskSelect.addEventListener("change", () => {
    state.taskId = taskSelect.value;
    state.claimId = "";
    claimSelect.replaceChildren(
      option("", tr(ctx.lang, opts.claimRequired ? "goal.metric.pickClaim" : "goal.note.noClaim")),
    );
    claimRow.hidden = state.taskId === "";
    opts.changed();
    if (state.taskId === "") {
      return;
    }
    void loadClaims(ctx, state.taskId).then((claims) => {
      if (state.taskId === "") {
        return;
      }
      if (claims.length === 0) {
        claimSelect.append(option("", tr(ctx.lang, "goal.metric.noClaims")));
      }
      for (const claim of claims) {
        claimSelect.append(
          option(claim.id, `${claim.subject} · ${claim.predicate} (${claim.state})`),
        );
      }
    });
  });
  claimSelect.addEventListener("change", () => {
    state.claimId = claimSelect.value;
    opts.changed();
  });
}

// ------------------------------------------------------------------ metrics

export function metricsBlock(
  ctx: ActionContext,
  goal: GoalRecord,
  metrics: readonly GoalMetricRecord[],
  hooks: { edit: (metric: GoalMetricRecord) => void; add: () => void },
): HTMLElement {
  const block = el("div", "gl-block");
  block.append(el("div", "gl-block-label", tr(ctx.lang, "goal.metric.title")));
  if (metrics.length === 0) {
    block.append(el("div", "muted", tr(ctx.lang, "goal.metric.none")));
  }
  const writable = ctx.canWrite !== false && goal.status !== "proposed";
  for (const metric of metrics) {
    const row = el("div", "gl-metric");
    const head = el("div", "gl-metric-head");
    head.append(el("strong", "", metric.name));
    if (metric.source === "claim" && metric.pointer) {
      const label = pointerLabel(ctx.lang, metric.pointer, true);
      head.append(el("span", `pill ${label.tone}`.trim(), label.text));
    } else {
      head.append(el("span", "pill muted", tr(ctx.lang, "goal.ptr.self")));
    }
    if (metricMet(metric)) {
      head.append(el("span", "pill ok", tr(ctx.lang, "goal.metric.met")));
    }
    if (writable) {
      const edit = el("button", "nx-btn", tr(ctx.lang, "goal.metric.edit"));
      edit.type = "button";
      edit.addEventListener("click", () => hooks.edit(metric));
      head.append(edit);
    }
    row.append(head, el("div", "gl-metric-fig", metricFigure(ctx.lang, metric)));
    const percent = metricPercent(metric);
    if (percent !== undefined) {
      const bar = el("div", "gl-bar");
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-valuenow", String(percent));
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      const fill = el("i");
      fill.style.width = `${percent}%`;
      bar.append(fill);
      row.append(bar);
    }
    if (metric.asOf !== null) {
      row.append(
        el(
          "div",
          "muted gl-hint",
          tr(ctx.lang, "goal.metric.asOf", { date: new Date(metric.asOf).toLocaleDateString() }),
        ),
      );
    }
    block.append(row);
  }
  if (writable && metrics.length < 10) {
    const add = el("button", "nx-btn", tr(ctx.lang, "goal.metric.add"));
    add.type = "button";
    add.addEventListener("click", hooks.add);
    block.append(add);
  }
  return block;
}

/** "" clears the figure; anything else must be a finite number. */
function parseFigure(ctx: ActionContext, text: string): number | null {
  const trimmed = text.trim().replace(/,/gu, "");
  if (trimmed === "") {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new Error(tr(ctx.lang, "goal.metric.badFigure"));
  }
  return value;
}

const figureText = (value: number | null): string => (value === null ? "" : String(value));

/** Add (no `existing`) or edit a metric; `reopen` brings the detail back afterwards. */
export function metricDialog(
  ctx: ActionContext,
  goal: GoalRecord,
  existing: GoalMetricRecord | undefined,
  reopen: () => void,
): void {
  const state = {
    name: existing?.name ?? "",
    unit: existing?.unit ?? "",
    direction: (existing?.direction ?? "up") as GoalMetricDirection,
    target: figureText(existing?.target ?? null),
    current: figureText(existing?.current ?? null),
    source: existing?.source ?? "manual",
    taskId: "",
    claimId: "",
  };
  const claimAllowed = goal.category !== "finance";
  const canSave = (): boolean =>
    state.name.trim() !== "" &&
    (existing !== undefined ||
      state.source === "manual" ||
      (state.taskId !== "" && state.claimId !== ""));
  const remove = existing
    ? [
        {
          label: tr(ctx.lang, "goal.metric.remove"),
          tone: "danger" as const,
          run: async () => {
            await ctx.request("nexus.goal.metric.remove", {
              goalId: goal.id,
              metricId: existing.id,
            });
            ctx.changed({ ok: true, text: tr(ctx.lang, "goal.metric.removed") });
            reopen();
          },
        },
      ]
    : [];
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, existing ? "goal.metric.dlgEdit" : "goal.metric.dlgAdd"),
    actions: [
      {
        label: tr(ctx.lang, "dlg.save"),
        tone: "primary",
        enabled: canSave,
        run: async () => {
          const target = parseFigure(ctx, state.target);
          const current = state.source === "manual" ? parseFigure(ctx, state.current) : undefined;
          const reply = await ctx.request<{ reachedNow?: boolean }>("nexus.goal.metric.set", {
            goalId: goal.id,
            ...(existing ? { metricId: existing.id } : { source: state.source }),
            name: state.name.trim(),
            unit: state.unit.trim(),
            direction: state.direction,
            target,
            ...(current !== undefined ? { current } : {}),
            ...(!existing && state.source === "claim"
              ? { taskId: state.taskId, claimId: state.claimId }
              : {}),
            lang: ctx.lang,
          });
          ctx.changed({
            ok: true,
            text: tr(
              ctx.lang,
              reply.reachedNow ? "goal.metric.reachedNotice" : "goal.metric.saved",
            ),
          });
          reopen();
        },
      },
      ...remove,
    ],
    build: (body, changed) => {
      const text = (key: "name" | "unit" | "target" | "current", labelKey: MsgKey, max: number) => {
        const input = el("input");
        input.value = state[key];
        input.maxLength = max;
        input.addEventListener("input", () => {
          state[key] = input.value;
          changed();
        });
        body.append(field(tr(ctx.lang, labelKey), input));
        return input;
      };
      text("name", "goal.metric.name", 60);
      text("unit", "goal.metric.unit", 20);
      const direction = el("select");
      direction.append(
        option("up", tr(ctx.lang, "goal.metric.dirUp")),
        option("down", tr(ctx.lang, "goal.metric.dirDown")),
      );
      direction.value = state.direction;
      direction.addEventListener("change", () => {
        state.direction = direction.value === "down" ? "down" : "up";
        changed();
      });
      body.append(field(tr(ctx.lang, "goal.metric.direction"), direction));
      text("target", "goal.metric.target", 20);
      const currentRow = field(tr(ctx.lang, "goal.metric.current"), el("input"));
      const currentInput = currentRow.querySelector("input") as HTMLInputElement;
      currentInput.value = state.current;
      currentInput.maxLength = 20;
      currentInput.addEventListener("input", () => {
        state.current = currentInput.value;
        changed();
      });
      const claimNote = el("p", "muted", tr(ctx.lang, "goal.metric.claimNote"));
      const picker = el("div");
      const sync = () => {
        currentRow.hidden = state.source !== "manual";
        claimNote.hidden = state.source !== "claim";
        picker.hidden = existing !== undefined || state.source !== "claim";
      };
      if (!existing) {
        const source = el("select");
        source.append(option("manual", tr(ctx.lang, "goal.metric.srcManual")));
        if (claimAllowed) {
          source.append(option("claim", tr(ctx.lang, "goal.metric.srcClaim")));
        }
        source.addEventListener("change", () => {
          state.source = source.value === "claim" ? "claim" : "manual";
          sync();
          changed();
        });
        body.append(field(tr(ctx.lang, "goal.metric.source"), source));
        if (!claimAllowed) {
          note(body, tr(ctx.lang, "goal.metric.financeManual"));
        }
      }
      body.append(currentRow, claimNote, picker);
      pointerPicker(ctx, picker, state, {
        claimRequired: true,
        taskLabel: "goal.metric.task",
        changed,
      });
      sync();
    },
  });
}
