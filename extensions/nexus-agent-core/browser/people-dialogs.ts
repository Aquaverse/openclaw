// The write side of the People page: add a person, edit one, confirm one the Agent only heard about, add and remove contact
// notes, and record a commitment for someone. Every dialog is built from the person the page itself loaded (never from the
// clicked markup, which only carries an id). Giving a person a name that someone already has is never done silently: the server
// answers `name_taken` with the people who carry it, and the user decides whether this is another person. Contact values are notes
// kept for the user; saving one authorizes nothing. Stopping a person and claiming a typed name are in people-move-dialogs.ts.
import {
  COUNTERPART_LIMITS,
  CONTACT_TYPES,
  type CounterpartRecord,
  type NameMatch,
} from "../src/counterpart/types.js";
import { tr } from "../src/i18n.js";
import type { ActionContext } from "./actions.ts";
import { createDialog } from "./commitment-dialogs.ts";
import { select } from "./commitment-form.ts";
import { openDialog, type DialogAction } from "./dialog.ts";
import { el, field, note } from "./goal-dom.ts";
import { mergeDialog, notPersonDialog, undismissAction } from "./people-fix-dialogs.ts";
import {
  candidateList,
  kindOptions,
  NAME_MAX,
  parseAliases,
  peopleGuard,
  relationOptions,
  TakenError,
  textBox,
  type PersonDraft,
} from "./people-form.ts";
import { deactivateDialog, claimDialog, restoreDialog } from "./people-move-dialogs.ts";
import { notSameDialog, unsameAction } from "./people-notsame-dialog.ts";
import { contactMoveDialog, splitDialog } from "./people-split-dialogs.ts";
import type { NexusAction } from "./sanitize.ts";

export type PeopleAction = Extract<NexusAction, { kind: `pp-${string}` }>;

type Saved = {
  outcome?: string;
  candidates?: NameMatch["candidates"];
  counterpart?: CounterpartRecord;
};

const relationOf = (draft: PersonDraft) =>
  draft.relation
    ? {
        relation: draft.relation,
        ...(draft.scope.trim() ? { scopeLabel: draft.scope.trim() } : {}),
      }
    : undefined;

/** Name, kind, relation and other names: the fields the add and edit dialogs share. */
function personFields(
  ctx: ActionContext,
  body: HTMLElement,
  draft: PersonDraft,
  changed: () => void,
  withKind: boolean,
): void {
  const lang = ctx.lang;
  body.append(
    field(
      tr(lang, "pp.f.name"),
      textBox(draft.name, NAME_MAX, (v) => {
        draft.name = v;
        changed();
      }),
    ),
  );
  if (withKind) {
    body.append(
      field(
        tr(lang, "pp.f.kind"),
        select(kindOptions(lang), draft.kind, (v) => {
          draft.kind = v === "organization" ? "organization" : v === "team" ? "team" : "person";
          changed();
        }),
      ),
    );
  }
  const scope = field(
    tr(lang, "pp.f.scope"),
    textBox(
      draft.scope,
      COUNTERPART_LIMITS.scopeLabel,
      (v) => {
        draft.scope = v;
        changed();
      },
      tr(lang, "pp.f.scopeHint"),
    ),
  );
  scope.hidden = draft.relation === "";
  body.append(
    field(
      tr(lang, "pp.f.relation"),
      select(relationOptions(lang), draft.relation, (v) => {
        draft.relation = (v || "") as PersonDraft["relation"];
        scope.hidden = draft.relation === "";
        changed();
      }),
    ),
    scope,
  );
}

// ------------------------------------------------------------------ add

function createPersonDialog(ctx: ActionContext): void {
  const lang = ctx.lang;
  const draft: PersonDraft = { name: "", kind: "person", relation: "", scope: "", aliases: "" };
  let contactType: (typeof CONTACT_TYPES)[number] = "email";
  let contactValue = "";
  let taken: NameMatch["candidates"] | undefined;
  let refresh = () => {};
  let slot: HTMLElement | undefined;
  const save = (allowSameName: boolean) => () =>
    peopleGuard(ctx, async () => {
      const aliases = parseAliases(draft.aliases);
      const relation = relationOf(draft);
      const reply = await ctx.request<Saved>("nexus.counterpart.create", {
        displayName: draft.name.trim(),
        kind: draft.kind,
        ...(relation ? { relation } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
        ...(contactValue.trim()
          ? { contacts: [{ type: contactType, value: contactValue.trim() }] }
          : {}),
        ...(allowSameName ? { allowSameName: true } : {}),
      });
      if (reply.outcome === "name_taken") {
        taken = reply.candidates ?? [];
        slot?.replaceChildren(candidateList(lang, taken));
        refresh();
        throw new TakenError(tr(lang, "pp.err.taken"));
      }
      ctx.changed({ ok: true, text: tr(lang, "pp.notice.created", { name: draft.name.trim() }) });
    });
  const actions: DialogAction[] = [
    {
      label: tr(lang, "dlg.save"),
      tone: "primary",
      enabled: () => draft.name.trim() !== "" && taken === undefined,
      run: save(false),
    },
    {
      label: tr(lang, "pp.btn.another"),
      tone: "danger",
      enabled: () => draft.name.trim() !== "" && taken !== undefined,
      run: save(true),
    },
  ];
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "pp.dlg.new"),
    actions,
    build: (body, changed) => {
      refresh = changed;
      personFields(
        ctx,
        body,
        draft,
        () => {
          taken = undefined;
          slot?.replaceChildren();
          changed();
        },
        true,
      );
      slot = el("div");
      body.append(
        slot,
        field(
          tr(lang, "pp.f.aliases"),
          textBox(draft.aliases, 200, (v) => (draft.aliases = v), tr(lang, "pp.f.aliasesHint")),
        ),
        field(
          tr(lang, "pp.f.contactType"),
          select(
            CONTACT_TYPES.map((type): [string, string] => [tr(lang, `pp.ct.${type}`), type]),
            contactType,
            (v) =>
              (contactType = (CONTACT_TYPES as readonly string[]).includes(v)
                ? (v as typeof contactType)
                : "other"),
          ),
        ),
        field(
          tr(lang, "pp.f.contactValue"),
          textBox(contactValue, COUNTERPART_LIMITS.contactValue, (v) => (contactValue = v)),
        ),
      );
      note(body, tr(lang, "pp.contact.note"));
    },
  });
}

// ------------------------------------------------------------------ edit

function editPersonDialog(ctx: ActionContext): void {
  const lang = ctx.lang;
  const person = ctx.model().person;
  if (!person) {
    ctx.changed({ ok: false, text: tr(lang, "pp.err.gone") });
    return;
  }
  const initial: PersonDraft = {
    name: person.name,
    kind: person.kind,
    relation: person.relation?.relation ?? "",
    scope: person.relation?.scopeLabel ?? "",
    aliases: "",
  };
  const draft: PersonDraft = { ...initial };
  const drop = new Set<string>();
  let taken: NameMatch["candidates"] | undefined;
  let refresh = () => {};
  let slot: HTMLElement | undefined;
  const relationChanged = () =>
    draft.relation !== initial.relation ||
    (draft.relation !== "" && draft.scope.trim() !== initial.scope);
  const anything = () =>
    draft.name.trim() !== initial.name ||
    draft.kind !== initial.kind ||
    relationChanged() ||
    parseAliases(draft.aliases).length > 0 ||
    drop.size > 0;
  const save = (allowSameName: boolean) => () =>
    peopleGuard(ctx, async () => {
      const changes: Record<string, unknown> = {};
      if (draft.name.trim() !== initial.name) {
        changes.displayName = draft.name.trim();
      }
      if (draft.kind !== initial.kind) {
        changes.kind = draft.kind;
      }
      if (relationChanged()) {
        changes.relation = relationOf(draft) ?? null;
      }
      const add = parseAliases(draft.aliases);
      if (add.length > 0) {
        changes.addAliases = add;
      }
      if (drop.size > 0) {
        changes.removeAliases = [...drop];
      }
      const reply = await ctx.request<Saved>("nexus.counterpart.update", {
        counterpartId: person.id,
        changes,
        expectedRevision: person.revision,
        ...(allowSameName ? { allowSameName: true } : {}),
      });
      if (reply.outcome === "name_taken") {
        taken = reply.candidates ?? [];
        slot?.replaceChildren(candidateList(lang, taken));
        refresh();
        throw new TakenError(tr(lang, "pp.err.taken"));
      }
      ctx.changed({ ok: true, text: tr(lang, "pp.notice.updated") });
    });
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "pp.dlg.edit"),
    actions: [
      {
        label: tr(lang, "dlg.save"),
        tone: "primary",
        enabled: () => draft.name.trim() !== "" && anything() && taken === undefined,
        run: save(false),
      },
      {
        label: tr(lang, "pp.btn.another"),
        tone: "danger",
        enabled: () => draft.name.trim() !== "" && anything() && taken !== undefined,
        run: save(true),
      },
    ],
    build: (body, changed) => {
      refresh = changed;
      personFields(
        ctx,
        body,
        draft,
        () => {
          taken = undefined;
          slot?.replaceChildren();
          changed();
        },
        true,
      );
      slot = el("div");
      body.append(slot);
      note(body, tr(lang, "pp.f.renameNote"));
      if (person.aliases.length > 0) {
        body.append(el("p", "muted", tr(lang, "pp.f.dropAlias")));
        for (const alias of person.aliases) {
          const line = el("label", "nx-row nx-check");
          const box = el("input");
          box.type = "checkbox";
          box.addEventListener("change", () => {
            if (box.checked) {
              drop.add(alias);
            } else {
              drop.delete(alias);
            }
            changed();
          });
          line.append(box, el("span", "", alias));
          body.append(line);
        }
      }
      body.append(
        field(
          tr(lang, "pp.f.addAliases"),
          textBox(
            draft.aliases,
            200,
            (v) => {
              draft.aliases = v;
              changed();
            },
            tr(lang, "pp.f.aliasesHint"),
          ),
        ),
      );
    },
  });
}

// ------------------------------------------------------------------ confirm

function confirmDialog(ctx: ActionContext): void {
  const lang = ctx.lang;
  const person = ctx.model().person;
  if (!person) {
    ctx.changed({ ok: false, text: tr(lang, "pp.err.gone") });
    return;
  }
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "pp.dlg.confirm"),
    actions: [
      {
        label: tr(lang, "pp.btn.confirm"),
        tone: "primary",
        run: () =>
          peopleGuard(ctx, async () => {
            await ctx.request("nexus.counterpart.update", {
              counterpartId: person.id,
              changes: { confirm: true },
              expectedRevision: person.revision,
            });
            ctx.changed({ ok: true, text: tr(lang, "pp.notice.confirmed", { name: person.name }) });
          }),
      },
    ],
    build: (body) => {
      body.append(el("p", "", tr(lang, "pp.confirm.ask", { name: person.name })));
      note(body, tr(lang, "pp.confirm.note"));
    },
  });
}

// ------------------------------------------------------------------ contacts

function contactAddDialog(ctx: ActionContext): void {
  const lang = ctx.lang;
  const person = ctx.model().person;
  if (!person) {
    ctx.changed({ ok: false, text: tr(lang, "pp.err.gone") });
    return;
  }
  let type: (typeof CONTACT_TYPES)[number] = "email";
  let label = "";
  let value = "";
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "pp.dlg.contact", { name: person.name }),
    actions: [
      {
        label: tr(lang, "dlg.save"),
        tone: "primary",
        enabled: () => value.trim() !== "",
        run: () =>
          peopleGuard(ctx, async () => {
            await ctx.request("nexus.counterpart.contactAdd", {
              counterpartId: person.id,
              contact: {
                type,
                value: value.trim(),
                ...(label.trim() ? { label: label.trim() } : {}),
              },
            });
            ctx.changed({ ok: true, text: tr(lang, "pp.notice.contact") });
          }),
      },
    ],
    build: (body, changed) => {
      body.append(
        field(
          tr(lang, "pp.f.contactType"),
          select(
            CONTACT_TYPES.map((t): [string, string] => [tr(lang, `pp.ct.${t}`), t]),
            type,
            (v) =>
              (type = (CONTACT_TYPES as readonly string[]).includes(v)
                ? (v as typeof type)
                : "other"),
          ),
        ),
        field(
          tr(lang, "pp.f.contactLabel"),
          textBox(
            label,
            COUNTERPART_LIMITS.contactLabel,
            (v) => (label = v),
            tr(lang, "pp.f.contactLabelHint"),
          ),
        ),
        field(
          tr(lang, "pp.f.contactValue"),
          textBox(value, COUNTERPART_LIMITS.contactValue, (v) => {
            value = v;
            changed();
          }),
        ),
      );
      note(body, tr(lang, "pp.contact.note"));
    },
  });
}

function contactRemoveDialog(ctx: ActionContext, id: string): void {
  const lang = ctx.lang;
  const person = ctx.model().person;
  const contact = person?.contacts[Number(/^c(\d+)$/.exec(id)?.[1] ?? "-1")];
  if (!person || !contact) {
    ctx.changed({ ok: false, text: tr(lang, "pp.err.gone") });
    return;
  }
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "pp.dlg.cdel"),
    actions: [
      {
        label: tr(lang, "btn.delete"),
        tone: "danger",
        run: () =>
          peopleGuard(ctx, async () => {
            await ctx.request("nexus.counterpart.contactRemove", {
              counterpartId: person.id,
              endpointId: contact.id,
            });
            ctx.changed({ ok: true, text: tr(lang, "pp.notice.cdel") });
          }),
      },
    ],
    build: (body) => {
      body.append(el("p", "", `${contact.label}：${contact.value}`));
      note(body, tr(lang, "pp.cdel.note"));
    },
  });
}

/** Opens the dialog for a pp-* marker. The page's model decides what exists; an id it does not hold is reported as gone. */
export function runPeopleAction(ctx: ActionContext, action: PeopleAction): void {
  const model = ctx.model();
  if (action.kind === "pp-new") {
    return createPersonDialog(ctx);
  }
  if (action.kind === "pp-claim") {
    return claimDialog(ctx, action.id);
  }
  if (action.kind === "pp-notperson") {
    return notPersonDialog(ctx, action.id);
  }
  if (action.kind === "pp-undismiss") {
    return undismissAction(ctx, action.id);
  }
  if (action.kind === "pp-notsame") {
    return notSameDialog(ctx, action.id);
  }
  if (action.kind === "pp-unsame") {
    return unsameAction(ctx, action.id);
  }
  const byIndex = action.kind === "pp-cdel" || action.kind === "pp-cmove";
  if (!model.person || (!byIndex && model.person.id !== action.id)) {
    ctx.changed({ ok: false, text: tr(ctx.lang, "pp.err.gone") });
    return;
  }
  switch (action.kind) {
    case "pp-edit":
      return editPersonDialog(ctx);
    case "pp-confirm":
      return confirmDialog(ctx);
    case "pp-contact":
      return contactAddDialog(ctx);
    case "pp-cdel":
      return contactRemoveDialog(ctx, action.id);
    case "pp-merge":
      return mergeDialog(ctx);
    case "pp-split":
      return splitDialog(ctx);
    case "pp-cmove":
      return contactMoveDialog(ctx, action.id);
    case "pp-off":
      return deactivateDialog(ctx);
    case "pp-on":
      return restoreDialog(ctx);
    case "pp-record":
      return createDialog(ctx, { personId: model.person.id });
  }
}
