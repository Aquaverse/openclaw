// The write side of the Commitments block: record, edit, note that they were told, note their response, close with a reason,
// cancel, restore, reopen, and change how the Work cites one. Every dialog is built from the commitments the page itself loaded
// (never from the clicked markup, which only carries an id). The ones that change a lifecycle first ask the server what they
// would reach (`dryRun`) and list exactly that. The RPC stays the authority: a stale dialog can at worst be refused.
import type { CommitmentLine } from "../src/commitment-ui.js";
import { tr, type MsgKey } from "../src/i18n.js";
import type { ActionContext } from "./actions.ts";
import { assistDialog } from "./commitment-assist-dialog.ts";
import {
  buildForm,
  describeError,
  dueOf,
  formValid,
  guarded,
  impactList,
  localInput,
  newRequestId,
  responsibleOf,
  select,
  textarea,
  textInput,
  workPicker,
  worksImpact,
  type Form,
  type Impact,
  type PersonChoice,
  type Reply,
} from "./commitment-form.ts";
import { jointDialog } from "./commitment-joint-dialog.ts";
import { openDialog, type DialogAction } from "./dialog.ts";
import { el, field, note } from "./goal-dom.ts";
import type { NexusAction } from "./sanitize.ts";

export type CommitmentAction = Extract<NexusAction, { kind: `cm-${string}` }>;

// ------------------------------------------------------------------ record

export type CreateOptions = {
  /** Cite the new commitment in this Work (required by default). */
  workId?: string;
  /** Start with this person chosen (the people page); the Work is then optional and only a reference. */
  personId?: string;
};

export function createDialog(ctx: ActionContext, options: CreateOptions): void {
  const lang = ctx.lang;
  const people = ctx.model().people ?? [];
  const form: Form = {
    what: "",
    who: "other",
    name: "",
    personId: options.personId ?? "",
    due: "pending",
    dueAt: "",
    next: "",
  };
  let role: "required" | "reference" = options.workId ? "required" : "reference";
  const requestId = newRequestId();
  let picker: ReturnType<typeof workPicker> | undefined;
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
            const workId = options.workId ?? (picker?.value() || undefined);
            const reply = await ctx.request<Reply>("nexus.commitment.create", {
              requestId,
              requirementText: form.what.trim(),
              responsible: responsibleOf(form),
              due: dueOf(form),
              ...(form.next.trim() ? { nextStep: form.next.trim() } : {}),
              ...(workId ? { workId, workRole: role } : {}),
            });
            ctx.changed({
              ok: true,
              text: tr(
                lang,
                reply.outcome === "exists"
                  ? "cm.notice.exists"
                  : reply.commitment?.ambiguity
                    ? "cm.notice.joint"
                    : "cm.notice.created",
              ),
            });
          }),
      },
    ],
    build: (body, changed) => {
      buildForm(body, lang, form, changed, people);
      if (!options.workId) {
        picker = workPicker(ctx, changed);
        body.append(picker.line);
      }
      body.append(
        field(
          tr(lang, "cm.f.role"),
          select(
            [
              [tr(lang, "cm.role.required"), "required"],
              [tr(lang, "cm.role.reference"), "reference"],
            ],
            role,
            (v) => (role = v === "required" ? "required" : "reference"),
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
  const known = ctx.model().people ?? [];
  const current = c.responsibleCounterpartId;
  const people: readonly PersonChoice[] =
    current && !known.some((p) => p.id === current)
      ? [
          ...known,
          {
            id: current,
            name: c.responsibleName ?? current,
            relation: null,
            names: [c.responsibleName ?? ""],
          },
        ]
      : known;
  const initial: Form = {
    what: c.requirementText,
    who: c.responsibleSelf ? "self" : "other",
    name: c.responsibleRaw ?? c.responsibleName ?? "",
    personId: current ?? "",
    due: c.dueState,
    dueAt: localInput(c.dueAt),
    next: c.nextStep ?? "",
  };
  const form: Form = { ...initial };
  let why = "";
  // What the reason field started with (the last edit's reason, once it has been read): only a different note counts.
  let whyStart = "";
  const ownerChanged = (): boolean =>
    form.who !== initial.who ||
    (form.who === "other" &&
      (form.personId !== initial.personId ||
        (form.personId === "" && form.name.trim() !== initial.name)));
  const material = (): boolean =>
    form.what.trim() !== initial.what ||
    ownerChanged() ||
    form.due !== initial.due ||
    (form.due === "known" && form.dueAt !== initial.dueAt);
  const noteChanged = (): boolean => why.trim() !== "" && why.trim() !== whyStart.trim();
  const changedAny = (): boolean =>
    material() || form.next.trim() !== initial.next || noteChanged();
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
            if (ownerChanged()) {
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
      let reasonInput: HTMLInputElement | undefined;
      hint.hidden = true;
      buildForm(
        body,
        lang,
        form,
        () => {
          hint.hidden = !material();
          changed();
        },
        people,
      );
      body.append(
        field(
          tr(lang, "cm.f.why"),
          (reasonInput = textInput("", 500, (v) => {
            why = v;
            changed();
          })),
        ),
        hint,
      );
      // The reason given at the last edit comes back into the field, so a small follow-up edit does not start from nothing.
      void ctx
        .request<{ events?: { kind: string; payload?: { reason?: unknown } }[] }>(
          "nexus.commitment.get",
          { commitmentId: c.id },
        )
        .then((reply) => {
          const last = (reply.events ?? []).find(
            (event) => event.kind === "edited" && typeof event.payload?.reason === "string",
          );
          if (last && reasonInput && why === "") {
            why = String(last.payload?.reason);
            whyStart = why;
            reasonInput.value = why;
          }
        })
        .catch(() => {
          // The reason is a convenience; the edit works without it.
        });
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

// ------------------------------------------------------------------ attach to a Work

/**
 * Cite a commitment in a Work (a reference unless the person says it is required). The dialog first reads where it is cited
 * today and starts from that: the Work and role it already has are chosen, so changing the role is one click and a Work it is
 * not in yet is a different choice.
 */
function attachDialog(ctx: ActionContext, line: CommitmentLine): void {
  const lang = ctx.lang;
  const c = line.commitment;
  let role: "required" | "reference" = "reference";
  let cited: { workId: string; title: string; role: "required" | "reference" }[] = [];
  let picker: ReturnType<typeof workPicker> | undefined;
  const roleBox = el("select");
  const roleOptions: [string, string][] = [
    [tr(lang, "cm.role.reference"), "reference"],
    [tr(lang, "cm.role.required"), "required"],
  ];
  const current = (): (typeof cited)[number] | undefined =>
    cited.find((work) => work.workId === picker?.value());
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "pp.dlg.attach"),
    actions: [
      {
        label: tr(lang, "pp.btn.attach"),
        tone: "primary",
        enabled: () => (picker?.value() ?? "") !== "" && current()?.role !== role,
        run: () =>
          guarded(ctx, async () => {
            const workId = picker?.value() ?? "";
            if (current()) {
              // Already cited there: only the role changes.
              await ctx.request("nexus.commitment.setRole", {
                commitmentId: c.id,
                workId,
                role,
                acknowledgeGap: true,
              });
            } else {
              await ctx.request("nexus.work.link", {
                workId,
                role,
                targetKind: "commitment",
                targetId: c.id,
              });
            }
            ctx.changed({ ok: true, text: tr(lang, "pp.notice.attached") });
          }),
      },
    ],
    build: (body, changed) => {
      body.append(el("p", "", c.requirementText));
      const where = el("p", "muted", tr(lang, "cm.dlg.loading"));
      body.append(where);
      picker = workPicker(ctx, changed);
      for (const [label, value] of roleOptions) {
        const node = el("option", "", label);
        node.value = value;
        roleBox.append(node);
      }
      roleBox.value = role;
      roleBox.addEventListener("change", () => {
        role = roleBox.value === "required" ? "required" : "reference";
        changed();
      });
      // Choosing a Work it is already cited in shows the role it has there.
      const picked = picker.line.querySelector("select");
      picked?.addEventListener("change", () => {
        const here = current();
        if (here) {
          role = here.role;
          roleBox.value = role;
        }
        changed();
      });
      body.append(picker.line, field(tr(lang, "cm.f.role"), roleBox));
      void ctx
        .request<{ impact?: Impact }>("nexus.commitment.impact", { commitmentId: c.id })
        .then((reply) => {
          cited = (reply.impact?.works ?? []).map((work) => ({
            workId: work.workId,
            title: work.title,
            role: work.role,
          }));
          where.textContent =
            cited.length > 0
              ? tr(lang, "pp.attach.in", {
                  titles: cited
                    .map((work) => `${work.title}（${tr(lang, `cm.role.${work.role}` as MsgKey)}）`)
                    .join("、"),
                })
              : tr(lang, "pp.attach.none");
          const first = cited[0];
          if (first) {
            role = first.role;
            roleBox.value = role;
            picker?.preset(first.workId, first.title);
          }
          changed();
        })
        .catch((error: unknown) => {
          where.textContent = describeError(lang, error);
        });
      note(body, tr(lang, "cm.hint"));
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
    return createDialog(ctx, { workId: work.id });
  }
  const line = model.commitments?.find((entry) => entry.commitment.id === action.id);
  if (!line) {
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
      return work
        ? roleDialog(ctx, line, work.id)
        : ctx.changed({ ok: false, text: tr(ctx.lang, "cm.err.gone") });
    case "cm-attach":
      return attachDialog(ctx, line);
    case "cm-assist":
      return assistDialog(ctx, line);
    case "cm-joint":
      return jointDialog(ctx, line);
  }
}
