// The write side of the Commitments block: record, edit, note that they were told, note their response, close with a reason,
// cancel, restore, reopen, and change how the Work cites one. Every dialog is built from the commitments the page itself loaded
// (never from the clicked markup, which only carries an id). The ones that change a lifecycle first ask the server what they
// would reach (`dryRun`) and list exactly that. The RPC stays the authority: a stale dialog can at worst be refused.
import type { CommitmentLine } from "../src/commitment-ui.js";
import { tr, type Lang, type MsgKey } from "../src/i18n.js";
import type { ActionContext } from "./actions.ts";
import { openDialog, type DialogAction } from "./dialog.ts";
import { el, field, note } from "./goal-dom.ts";
import type { NexusAction } from "./sanitize.ts";

export type CommitmentAction = Extract<NexusAction, { kind: `cm-${string}` }>;

type Impact = {
  works?: { workId: string; title: string; role: "required" | "reference" }[];
};
type Reply = { outcome?: string; impact?: Impact; commitment?: { id: string } };

const text = (error: unknown): string =>
  `${(error as { code?: string } | undefined)?.code ?? ""} ${error instanceof Error ? error.message : String(error)}`;

function describeError(lang: Lang, error: unknown): string {
  const t = text(error);
  if (t.includes("nexus_commitment_state")) {
    return tr(lang, "cm.err.state");
  }
  if (t.includes("nexus_not_found")) {
    return tr(lang, "cm.err.gone");
  }
  if (t.includes("nexus_gap_ack_required")) {
    return tr(lang, "cm.err.ack");
  }
  return tr(lang, "cm.err.generic", {
    message: error instanceof Error ? error.message : String(error),
  });
}

/** A write; a stale revision or state reloads with a notice instead of leaving the dialog open on old data. */
async function guarded(ctx: ActionContext, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    const t = text(error);
    if (t.includes("nexus_revision_conflict") || t.includes("nexus_commitment_state")) {
      ctx.changed({ ok: false, text: tr(ctx.lang, "cm.err.state") });
      return;
    }
    throw new Error(describeError(ctx.lang, error), { cause: error });
  }
}

const MARK = { keep: "✓", stop: "✕", note: "!" } as const;
function impactList(items: readonly { tone: keyof typeof MARK; text: string }[]): HTMLElement {
  const list = el("div", "nx-imp");
  for (const item of items) {
    const line = el("div", `nx-imp-li ${item.tone}`);
    line.append(el("span", "nx-imp-i", MARK[item.tone]), el("span", "", item.text));
    list.append(line);
  }
  return list;
}

/** The Works a lifecycle change reaches, as the impact list (design 6.5). */
function worksImpact(lang: Lang, impact: Impact | undefined) {
  const works = impact?.works ?? [];
  if (works.length === 0) {
    return [{ tone: "keep" as const, text: tr(lang, "cm.imp.none") }];
  }
  return works.map((work) =>
    work.role === "required"
      ? { tone: "stop" as const, text: tr(lang, "cm.imp.required", { title: work.title }) }
      : { tone: "keep" as const, text: tr(lang, "cm.imp.reference", { title: work.title }) },
  );
}

const newRequestId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function option(label: string, value: string): HTMLOptionElement {
  const node = el("option", "", label);
  node.value = value;
  return node;
}
function select(
  options: readonly [string, string][],
  value: string,
  onChange: (v: string) => void,
) {
  const node = el("select");
  for (const [label, v] of options) {
    node.append(option(label, v));
  }
  node.value = value;
  node.addEventListener("change", () => onChange(node.value));
  return node;
}
function textarea(value: string, max: number, onInput: (v: string) => void) {
  const node = el("textarea");
  node.rows = 3;
  node.maxLength = max;
  node.value = value;
  node.addEventListener("input", () => onInput(node.value));
  return node;
}
function textInput(value: string, max: number, onInput: (v: string) => void) {
  const node = el("input");
  node.maxLength = max;
  node.value = value;
  node.addEventListener("input", () => onInput(node.value));
  return node;
}

/** `YYYY-MM-DDTHH:mm` in the viewer's local time, the format a datetime-local input takes. */
function localInput(ms: number | null): string {
  if (ms === null) {
    return "";
  }
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Form = {
  what: string;
  who: "self" | "name";
  name: string;
  due: "pending" | "none" | "known";
  dueAt: string;
  next: string;
};

/** The "what / who / when / next" fields shared by the record and edit dialogs. */
function buildForm(body: HTMLElement, lang: Lang, form: Form, changed: () => void): void {
  body.append(
    field(
      tr(lang, "cm.f.what"),
      textarea(form.what, 500, (v) => {
        form.what = v;
        changed();
      }),
    ),
  );
  const name = textInput(form.name, 80, (v) => {
    form.name = v;
    changed();
  });
  const nameLine = field(tr(lang, "cm.f.name"), name);
  nameLine.hidden = form.who !== "name";
  body.append(
    field(
      tr(lang, "cm.f.who"),
      select(
        [
          [tr(lang, "cm.f.whoSelf"), "self"],
          [tr(lang, "cm.f.whoName"), "name"],
        ],
        form.who,
        (v) => {
          form.who = v === "self" ? "self" : "name";
          nameLine.hidden = form.who !== "name";
          changed();
        },
      ),
    ),
    nameLine,
  );
  const at = el("input");
  at.type = "datetime-local";
  at.value = form.dueAt;
  at.addEventListener("input", () => {
    form.dueAt = at.value;
    changed();
  });
  const atLine = field(tr(lang, "cm.f.dueAt"), at);
  atLine.hidden = form.due !== "known";
  body.append(
    field(
      tr(lang, "cm.f.due"),
      select(
        [
          [tr(lang, "cm.f.duePending"), "pending"],
          [tr(lang, "cm.f.dueNone"), "none"],
          [tr(lang, "cm.f.dueKnown"), "known"],
        ],
        form.due,
        (v) => {
          form.due = v === "none" ? "none" : v === "known" ? "known" : "pending";
          atLine.hidden = form.due !== "known";
          changed();
        },
      ),
    ),
    atLine,
    field(
      tr(lang, "cm.f.next"),
      textInput(form.next, 300, (v) => {
        form.next = v;
        changed();
      }),
    ),
  );
}

const formValid = (form: Form): boolean =>
  form.what.trim() !== "" &&
  (form.who === "self" || form.name.trim() !== "") &&
  (form.due !== "known" || Number.isFinite(new Date(form.dueAt).getTime()));

const responsibleOf = (form: Form) =>
  form.who === "self" ? { kind: "self" } : { kind: "name", name: form.name.trim() };
const dueOf = (form: Form) =>
  form.due === "known"
    ? { kind: "known", at: new Date(form.dueAt).getTime(), tz: localZone() }
    : { kind: form.due };

// ------------------------------------------------------------------ record

function createDialog(ctx: ActionContext, workId: string): void {
  const lang = ctx.lang;
  const form: Form = { what: "", who: "name", name: "", due: "pending", dueAt: "", next: "" };
  let role: "required" | "reference" = "required";
  const requestId = newRequestId();
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "cm.dlg.new"),
    actions: [
      {
        label: tr(lang, "dlg.save"),
        tone: "primary",
        enabled: () => formValid(form),
        run: () =>
          guarded(ctx, async () => {
            const reply = await ctx.request<Reply>("nexus.commitment.create", {
              requestId,
              requirementText: form.what.trim(),
              responsible: responsibleOf(form),
              due: dueOf(form),
              ...(form.next.trim() ? { nextStep: form.next.trim() } : {}),
              workId,
              workRole: role,
            });
            ctx.changed({
              ok: true,
              text: tr(lang, reply.outcome === "exists" ? "cm.notice.exists" : "cm.notice.created"),
            });
          }),
      },
    ],
    build: (body, changed) => {
      buildForm(body, lang, form, changed);
      body.append(
        field(
          tr(lang, "cm.f.role"),
          select(
            [
              [tr(lang, "cm.role.required"), "required"],
              [tr(lang, "cm.role.reference"), "reference"],
            ],
            role,
            (v) => (role = v === "reference" ? "reference" : "required"),
          ),
        ),
      );
      note(body, tr(lang, "cm.hint"));
    },
  });
}

// ------------------------------------------------------------------ edit

function editDialog(ctx: ActionContext, line: CommitmentLine): void {
  const lang = ctx.lang;
  const c = line.commitment;
  const initial: Form = {
    what: c.requirementText,
    who: c.responsibleSelf ? "self" : "name",
    name: c.responsibleRaw ?? c.responsibleName ?? "",
    due: c.dueState,
    dueAt: localInput(c.dueAt),
    next: c.nextStep ?? "",
  };
  const form: Form = { ...initial };
  let why = "";
  const material = (): boolean =>
    form.what.trim() !== initial.what ||
    form.who !== initial.who ||
    (form.who === "name" && form.name.trim() !== initial.name) ||
    form.due !== initial.due ||
    (form.due === "known" && form.dueAt !== initial.dueAt);
  const changedAny = (): boolean => material() || form.next.trim() !== initial.next;
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "cm.dlg.edit"),
    actions: [
      {
        label: tr(lang, "dlg.save"),
        tone: "primary",
        enabled: () => formValid(form) && changedAny(),
        run: () =>
          guarded(ctx, async () => {
            const changes: Record<string, unknown> = {};
            if (form.what.trim() !== initial.what) {
              changes.requirementText = form.what.trim();
            }
            if (
              form.who !== initial.who ||
              (form.who === "name" && form.name.trim() !== initial.name)
            ) {
              changes.responsible = responsibleOf(form);
            }
            if (
              form.due !== initial.due ||
              (form.due === "known" && form.dueAt !== initial.dueAt)
            ) {
              changes.due = dueOf(form);
            }
            if (form.next.trim() !== initial.next) {
              changes.nextStep = form.next.trim() === "" ? null : form.next.trim();
            }
            await ctx.request("nexus.commitment.update", {
              commitmentId: c.id,
              changes,
              expectedRevision: c.revision,
              ...(why.trim() ? { reason: why.trim() } : {}),
            });
            ctx.changed({ ok: true, text: tr(lang, "cm.notice.updated") });
          }),
      },
    ],
    build: (body, changed) => {
      const hint = el("p", "muted", tr(lang, "cm.imp.versioned"));
      hint.hidden = true;
      buildForm(body, lang, form, () => {
        hint.hidden = !material();
        changed();
      });
      body.append(
        field(
          tr(lang, "cm.f.why"),
          textInput("", 500, (v) => (why = v)),
        ),
        hint,
      );
    },
  });
}

// ------------------------------------------------------------------ told / response

function commDialog(ctx: ActionContext, line: CommitmentLine): void {
  const lang = ctx.lang;
  let state = "submitted";
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "cm.dlg.comm"),
    actions: [
      {
        label: tr(lang, "dlg.save"),
        tone: "primary",
        run: () =>
          guarded(ctx, async () => {
            await ctx.request("nexus.commitment.communication", {
              commitmentId: line.commitment.id,
              state,
              expectedRevision: line.commitment.revision,
            });
            ctx.changed({ ok: true, text: tr(lang, "cm.notice.comm") });
          }),
      },
    ],
    build: (body) => {
      body.append(
        field(
          tr(lang, "cm.f.state"),
          select(
            [
              [tr(lang, "cm.f.commSubmitted"), "submitted"],
              [tr(lang, "cm.f.commConfirmed"), "confirmed"],
              [tr(lang, "cm.f.commFailed"), "failed"],
              [tr(lang, "cm.f.commUnknown"), "unknown"],
            ],
            state,
            (v) => (state = v),
          ),
        ),
      );
    },
  });
}

function acceptDialog(ctx: ActionContext, line: CommitmentLine): void {
  const lang = ctx.lang;
  let state = "accepted";
  let basis = "";
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "cm.dlg.accept"),
    actions: [
      {
        label: tr(lang, "dlg.save"),
        tone: "primary",
        enabled: () => state === "unknown" || basis.trim() !== "",
        run: () =>
          guarded(ctx, async () => {
            await ctx.request("nexus.commitment.acceptance", {
              commitmentId: line.commitment.id,
              state,
              ...(state !== "unknown" ? { basis: basis.trim() } : {}),
              expectedRevision: line.commitment.revision,
            });
            ctx.changed({ ok: true, text: tr(lang, "cm.notice.accept") });
          }),
      },
    ],
    build: (body, changed) => {
      body.append(
        field(
          tr(lang, "cm.f.state"),
          select(
            [
              [tr(lang, "cm.f.accAccepted"), "accepted"],
              [tr(lang, "cm.f.accDeclined"), "declined"],
              [tr(lang, "cm.f.accClarify"), "needs_clarification"],
              [tr(lang, "cm.f.accUnknown"), "unknown"],
            ],
            state,
            (v) => {
              state = v;
              changed();
            },
          ),
        ),
        field(
          tr(lang, "cm.f.basis"),
          textarea("", 500, (v) => {
            basis = v;
            changed();
          }),
        ),
      );
    },
  });
}

// ------------------------------------------------------------------ lifecycle

type Kind = "resolve" | "cancel" | "reopen" | "restore";
const KIND = {
  resolve: {
    title: "cm.dlg.resolve",
    verb: "cm.btn.resolve",
    done: "cm.notice.resolved",
    method: "resolve",
  },
  cancel: {
    title: "cm.dlg.cancel",
    verb: "cm.btn.cancel",
    done: "cm.notice.cancelled",
    method: "cancel",
  },
  reopen: {
    title: "cm.dlg.reopen",
    verb: "cm.btn.reopen",
    done: "cm.notice.reopened",
    method: "reopen",
  },
  restore: {
    title: "cm.dlg.restore",
    verb: "cm.btn.restore",
    done: "cm.notice.restored",
    method: "restore",
  },
} as const satisfies Record<Kind, { title: MsgKey; verb: MsgKey; done: MsgKey; method: string }>;

/** Resolve / cancel / reopen / restore: the preview comes from the server, the reason (where one is needed) from the person. */
function lifecycleDialog(ctx: ActionContext, line: CommitmentLine, kind: Kind): void {
  const lang = ctx.lang;
  const c = line.commitment;
  const spec = KIND[kind];
  const needsReason = kind === "resolve" || kind === "cancel";
  let reason = "";
  let loaded = kind === "restore";
  const base = { commitmentId: c.id, expectedRevision: c.revision };
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, spec.title),
    actions: [
      {
        label: tr(lang, spec.verb),
        tone: kind === "cancel" ? "danger" : "primary",
        enabled: () => loaded && (!needsReason || reason.trim() !== ""),
        run: () =>
          guarded(ctx, async () => {
            await ctx.request(`nexus.commitment.${spec.method}`, {
              ...base,
              ...(needsReason || (kind === "reopen" && reason.trim())
                ? { reason: reason.trim() }
                : {}),
            });
            ctx.changed({ ok: true, text: tr(lang, spec.done) });
          }),
      },
    ],
    build: (body, changed) => {
      body.append(el("p", "", c.requirementText));
      if (needsReason || kind === "reopen") {
        body.append(
          field(
            tr(lang, "cm.f.reason"),
            textarea("", 500, (v) => {
              reason = v;
              changed();
            }),
          ),
        );
      }
      const slot = el("div");
      body.append(slot);
      const foot: MsgKey | undefined =
        kind === "resolve"
          ? "cm.imp.manual"
          : kind === "cancel"
            ? "cm.imp.cancel"
            : kind === "reopen"
              ? "cm.imp.reopen"
              : undefined;
      if (kind === "restore") {
        return;
      }
      const status = el("p", "muted", tr(lang, "cm.dlg.loading"));
      body.append(status);
      // The preview needs some reason to get past validation where one is required; it changes nothing (dryRun).
      void ctx
        .request<Reply>(`nexus.commitment.${spec.method}`, {
          ...base,
          dryRun: true,
          ...(needsReason ? { reason: "preview" } : {}),
        })
        .then((reply) => {
          if (reply.outcome !== "preview") {
            ctx.changed({ ok: false, text: tr(lang, "cm.err.state") });
            return;
          }
          status.remove();
          slot.replaceChildren(
            impactList([
              ...worksImpact(lang, reply.impact),
              ...(foot ? [{ tone: "note" as const, text: tr(lang, foot) }] : []),
            ]),
          );
          loaded = true;
          changed();
        })
        .catch((error: unknown) => {
          status.textContent = describeError(lang, error);
        });
    },
  });
}

// ------------------------------------------------------------------ role

function roleDialog(ctx: ActionContext, line: CommitmentLine, workId: string): void {
  const lang = ctx.lang;
  const toReference = line.role === "required";
  const actions: DialogAction[] = [
    {
      label: tr(lang, toReference ? "cm.btn.toReference" : "cm.btn.toRequired"),
      tone: toReference ? "danger" : "primary",
      run: () =>
        guarded(ctx, async () => {
          await ctx.request("nexus.commitment.setRole", {
            commitmentId: line.commitment.id,
            workId,
            role: toReference ? "reference" : "required",
            acknowledgeGap: true,
          });
          ctx.changed({ ok: true, text: tr(lang, "cm.notice.role") });
        }),
    },
  ];
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, toReference ? "cm.dlg.toReference" : "cm.dlg.toRequired"),
    actions,
    build: (body) => {
      body.append(el("p", "", line.commitment.requirementText));
      body.append(
        impactList([
          toReference
            ? { tone: "stop", text: tr(lang, "cm.imp.toReference") }
            : { tone: "note", text: tr(lang, "cm.hint") },
        ]),
      );
    },
  });
}

/** Opens the dialog for a cm-* marker. The page's model decides what exists; an id it does not hold is reported as gone. */
export function runCommitmentAction(ctx: ActionContext, action: CommitmentAction): void {
  const model = ctx.model();
  const work = model.work;
  if (action.kind === "cm-new") {
    if (!work || work.id !== action.id || model.commitments === undefined) {
      ctx.changed({ ok: false, text: tr(ctx.lang, "cm.err.gone") });
      return;
    }
    return createDialog(ctx, work.id);
  }
  const line = model.commitments?.find((entry) => entry.commitment.id === action.id);
  if (!line || !work) {
    ctx.changed({ ok: false, text: tr(ctx.lang, "cm.err.gone") });
    return;
  }
  switch (action.kind) {
    case "cm-edit":
      return editDialog(ctx, line);
    case "cm-comm":
      return commDialog(ctx, line);
    case "cm-accept":
      return acceptDialog(ctx, line);
    case "cm-resolve":
      return lifecycleDialog(ctx, line, "resolve");
    case "cm-cancel":
      return lifecycleDialog(ctx, line, "cancel");
    case "cm-restore":
      return lifecycleDialog(ctx, line, "restore");
    case "cm-reopen":
      return lifecycleDialog(ctx, line, "reopen");
    case "cm-role":
      return roleDialog(ctx, line, work.id);
  }
}
