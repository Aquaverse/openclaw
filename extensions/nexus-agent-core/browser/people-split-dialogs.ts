// The People page dialogs that pull things apart: split one record into two people, and move a contact that was attached to the
// wrong person. The server first answers what a change would reach (dryRun); nothing is changed before the user has read it and
// chosen. Built from the person the page itself loaded, never from the clicked markup.
import type {
  ContactMoveImpact,
  CounterpartRecord,
  NameMatch,
  SplitImpact,
} from "../src/counterpart/types.js";
import { tr, type Lang } from "../src/i18n.js";
import type { ActionContext } from "./actions.ts";
import { block, impactList, select } from "./commitment-form.ts";
import { openDialog, type DialogAction } from "./dialog.ts";
import { el } from "./goal-dom.ts";
import {
  candidateList,
  kindOptions,
  NAME_MAX,
  peopleGuard,
  relationOptions,
  TakenError,
  textBox,
} from "./people-form.ts";
import { personPicker } from "./person-picker.ts";

type Tone = "keep" | "stop" | "note";

/** A row with a tick box. Built as a div so the tick box is the only thing that toggles. */
function checkRow(
  label: string,
  tag: string,
  checked: boolean,
  onToggle: (on: boolean) => void,
): HTMLElement {
  const line = el("label", "nx-check");
  const box = el("input");
  box.type = "checkbox";
  box.checked = checked;
  box.addEventListener("change", () => onToggle(box.checked));
  line.append(box, el("span", "", label));
  if (tag) {
    line.append(el("span", "nx-pick-rel", tag));
  }
  return line;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ------------------------------------------------------------------ split

type SplitReply = {
  outcome?: string;
  impact?: SplitImpact;
  candidates?: NameMatch["candidates"];
  created?: string;
};

function splitLines(lang: Lang, name: string, picked: boolean, i: SplitImpact) {
  const lines: Array<{ tone: Tone; text: string }> = [];
  if (!picked) {
    lines.push({ tone: "note", text: tr(lang, "pp.split.i.empty") });
  }
  if (i.movedOpenCommitments > 0) {
    lines.push({
      tone: "note",
      text: tr(lang, "pp.split.i.open", { n: i.movedOpenCommitments }),
    });
  }
  if (i.movedResolvedCommitments > 0) {
    lines.push({
      tone: "keep",
      text: tr(lang, "pp.split.i.done", { n: i.movedResolvedCommitments }),
    });
  }
  if (i.movedContacts > 0) {
    lines.push({ tone: "keep", text: tr(lang, "pp.split.i.contacts", { n: i.movedContacts }) });
  }
  if (i.movedAliases > 0) {
    lines.push({ tone: "keep", text: tr(lang, "pp.split.i.aliases", { n: i.movedAliases }) });
  }
  lines.push({
    tone: "keep",
    text: tr(lang, "pp.split.i.kept", {
      name,
      open: i.keptOpenCommitments,
      done: i.keptResolvedCommitments,
      contacts: i.keptContacts,
    }),
  });
  if (i.participantLinksStaying > 0) {
    lines.push({
      tone: "note",
      text: tr(lang, "pp.split.i.links", { n: i.participantLinksStaying, name }),
    });
  }
  for (const work of i.works) {
    lines.push({ tone: "note", text: tr(lang, "pp.split.i.work", { title: work.title }) });
  }
  lines.push({ tone: "stop", text: tr(lang, "pp.split.i.final") });
  return lines;
}

/** Split the person on the page into two: the user names the new one and picks what is theirs; the rest stays. */
export function splitDialog(ctx: ActionContext): void {
  const lang = ctx.lang;
  const person = ctx.model().person;
  if (!person) {
    ctx.changed({ ok: false, text: tr(lang, "pp.err.gone") });
    return;
  }
  if (
    person.contacts.length === 0 &&
    person.aliases.length === 0 &&
    person.commitments.length === 0
  ) {
    ctx.changed({ ok: false, text: tr(lang, "pp.split.none") });
    return;
  }
  let name = "";
  let kind: CounterpartRecord["kind"] = person.kind;
  let relation = "";
  const contactIds = new Set<string>();
  const aliases = new Set<string>();
  const commitmentIds = new Set<string>();
  let taken: NameMatch["candidates"] | undefined;
  let preview: SplitImpact | undefined;
  let sequence = 0;
  let slot: HTMLElement | undefined;
  let takenSlot: HTMLElement | undefined;
  let refresh = () => {};
  const picked = () => contactIds.size + aliases.size + commitmentIds.size > 0;
  const selection = () => ({
    contactIds: [...contactIds],
    aliases: [...aliases],
    commitmentIds: [...commitmentIds],
  });

  const show = () => {
    if (!slot) {
      return;
    }
    slot.replaceChildren(
      preview
        ? impactList(splitLines(lang, person.name, picked(), preview))
        : el("p", "muted", tr(lang, "pp.split.pick")),
    );
  };
  const recheck = () => {
    taken = undefined;
    takenSlot?.replaceChildren();
    preview = undefined;
    show();
    refresh();
    const mine = ++sequence;
    void ctx
      .request<SplitReply>("nexus.counterpart.split", {
        counterpartId: person.id,
        displayName: name.trim() || person.name,
        ...selection(),
        dryRun: true,
      })
      .then((reply) => {
        if (mine !== sequence) {
          return;
        }
        if (reply.outcome !== "preview" || !reply.impact) {
          ctx.changed({ ok: false, text: tr(lang, "pp.err.state") });
          return;
        }
        preview = reply.impact;
        show();
        refresh();
      })
      .catch((error: unknown) => {
        if (mine === sequence) {
          slot?.replaceChildren(el("p", "error", errorText(error)));
        }
      });
  };

  const send = (allowSameName: boolean) => () =>
    peopleGuard(ctx, async () => {
      const reply = await ctx.request<SplitReply>("nexus.counterpart.split", {
        counterpartId: person.id,
        displayName: name.trim(),
        kind,
        ...(relation ? { relation: { relation } } : {}),
        ...selection(),
        expectedRevision: person.revision,
        ...(allowSameName ? { allowSameName: true } : {}),
      });
      if (reply.outcome === "name_taken") {
        taken = reply.candidates ?? [];
        takenSlot?.replaceChildren(candidateList(lang, taken));
        refresh();
        throw new TakenError(tr(lang, "pp.err.taken"));
      }
      if (reply.outcome !== "split") {
        ctx.changed({ ok: false, text: tr(lang, "pp.err.changed") });
        return;
      }
      ctx.changed({
        ok: true,
        text: tr(lang, "pp.notice.split", { name: person.name, created: name.trim() }),
      });
    });
  const actions: DialogAction[] = [
    {
      label: tr(lang, "pp.btn.splitDo"),
      tone: "danger",
      enabled: () => name.trim() !== "" && preview !== undefined && taken === undefined,
      run: send(false),
    },
    {
      label: tr(lang, "pp.btn.splitAnother"),
      tone: "danger",
      enabled: () => name.trim() !== "" && taken !== undefined,
      run: send(true),
    },
  ];
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "pp.dlg.split", { name: person.name }),
    actions,
    build: (body, changed) => {
      refresh = changed;
      body.append(el("p", "", tr(lang, "pp.split.intro", { name: person.name })));
      body.append(
        block(
          tr(lang, "pp.split.name"),
          textBox(name, NAME_MAX, (v) => {
            name = v;
            taken = undefined;
            takenSlot?.replaceChildren();
            changed();
          }),
        ),
        block(
          tr(lang, "pp.f.kind"),
          select(kindOptions(lang), kind, (v) => {
            kind = v as CounterpartRecord["kind"];
          }),
        ),
        block(
          tr(lang, "pp.f.relation"),
          select(relationOptions(lang), relation, (v) => {
            relation = v;
          }),
        ),
      );
      takenSlot = el("div");
      body.append(takenSlot);
      const group = (
        label: string,
        rows: ReadonlyArray<{ key: string; text: string; tag: string }>,
        chosen: Set<string>,
      ) => {
        if (rows.length === 0) {
          return;
        }
        const list = el("div", "nx-checks");
        for (const row of rows) {
          list.append(
            checkRow(row.text, row.tag, chosen.has(row.key), (on) => {
              if (on) {
                chosen.add(row.key);
              } else {
                chosen.delete(row.key);
              }
              recheck();
            }),
          );
        }
        body.append(block(label, list));
      };
      group(
        tr(lang, "pp.split.contacts"),
        person.contacts.map((c) => ({ key: c.id, text: `${c.label}：${c.value}`, tag: "" })),
        contactIds,
      );
      group(
        tr(lang, "pp.split.aliases"),
        person.aliases.map((a) => ({ key: a, text: a, tag: "" })),
        aliases,
      );
      group(
        tr(lang, "pp.split.commitments"),
        person.commitments.map((c) => ({
          key: c.id,
          text: c.text,
          tag: tr(lang, c.open ? "pp.split.tagOpen" : "pp.split.tagDone"),
        })),
        commitmentIds,
      );
      slot = el("div");
      body.append(slot);
      recheck();
    },
  });
}

// ------------------------------------------------------------------ wrong person

type MoveReply = { outcome?: string; impact?: ContactMoveImpact };

function moveLines(lang: Lang, from: string, fromStart: boolean, i: ContactMoveImpact) {
  const lines: Array<{ tone: Tone; text: string }> = [];
  if (i.duplicate && i.to) {
    lines.push({ tone: "keep", text: tr(lang, "pp.cmove.i.dup", { name: i.to.displayName }) });
  }
  lines.push({ tone: "keep", text: tr(lang, "pp.cmove.i.fromNow", { name: from }) });
  if (fromStart) {
    lines.push(
      i.attributions > 0
        ? {
            tone: "note",
            text: tr(lang, "pp.cmove.i.start", {
              n: i.attributions,
              m: i.attributedCommitments,
              v: i.verifiedCommitments,
            }),
          }
        : { tone: "keep", text: tr(lang, "pp.cmove.i.none") },
    );
  }
  lines.push({ tone: "keep", text: tr(lang, "pp.cmove.i.safe") });
  return lines;
}

/** Say contact `c<index>` of the person on the page belongs to someone else (or to nobody). */
export function contactMoveDialog(ctx: ActionContext, id: string): void {
  const lang = ctx.lang;
  const model = ctx.model();
  const person = model.person;
  const contact = person?.contacts[Number(/^c(\d+)$/.exec(id)?.[1] ?? "-1")];
  if (!person || !contact) {
    ctx.changed({ ok: false, text: tr(lang, "pp.err.gone") });
    return;
  }
  const candidates = (model.people ?? []).filter((p) => p.id !== person.id);
  let target = "";
  let nobody = false;
  let fromStart = false;
  let preview: ContactMoveImpact | undefined;
  let sequence = 0;
  let slot: HTMLElement | undefined;
  let refresh = () => {};
  const nameOf = () => candidates.find((p) => p.id === target)?.name ?? "";
  const ready = () => nobody || target !== "";
  const params = () => ({
    counterpartId: person.id,
    endpointId: contact.id,
    ...(nobody ? {} : { toId: target }),
    ...(fromStart ? { fromStart: true } : {}),
  });
  const show = () => {
    if (!slot) {
      return;
    }
    slot.replaceChildren(
      preview ? impactList(moveLines(lang, person.name, fromStart, preview)) : el("p", "muted"),
    );
  };
  const recheck = () => {
    preview = undefined;
    show();
    refresh();
    if (!ready()) {
      return;
    }
    const mine = ++sequence;
    void ctx
      .request<MoveReply>("nexus.counterpart.contactMove", { ...params(), dryRun: true })
      .then((reply) => {
        if (mine !== sequence) {
          return;
        }
        if (reply.outcome !== "preview" || !reply.impact) {
          ctx.changed({ ok: false, text: tr(lang, "pp.err.state") });
          return;
        }
        preview = reply.impact;
        show();
        refresh();
      })
      .catch((error: unknown) => {
        if (mine === sequence) {
          slot?.replaceChildren(el("p", "error", errorText(error)));
        }
      });
  };
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "pp.dlg.cmove"),
    actions: [
      {
        label: tr(lang, "pp.btn.cmoveDo"),
        tone: "danger",
        enabled: () => ready() && preview !== undefined,
        run: () =>
          peopleGuard(ctx, async () => {
            const reply = await ctx.request<MoveReply>("nexus.counterpart.contactMove", {
              ...params(),
              expectedRevision: person.revision,
            });
            if (reply.outcome !== "moved") {
              ctx.changed({ ok: false, text: tr(lang, "pp.err.changed") });
              return;
            }
            ctx.changed({
              ok: true,
              text: nobody
                ? tr(lang, "pp.notice.cmoveNobody")
                : tr(lang, "pp.notice.cmove", { name: nameOf() }),
            });
          }),
      },
    ],
    build: (body, changed) => {
      refresh = changed;
      body.append(
        el(
          "p",
          "",
          tr(lang, "pp.cmove.intro", {
            contact: `${contact.label}：${contact.value}`,
            name: person.name,
          }),
        ),
      );
      const picker = personPicker({
        lang,
        people: candidates,
        allowTyped: false,
        onChange: (state) => {
          const next = state.selected[0] ?? "";
          if (next === target) {
            return;
          }
          target = next;
          if (next) {
            nobody = false;
            box.checked = false;
          }
          recheck();
        },
      });
      const nobodyRow = checkRow(tr(lang, "pp.cmove.nobody"), "", false, (on) => {
        nobody = on;
        picker.hidden = on;
        recheck();
      });
      const box = nobodyRow.querySelector("input") as HTMLInputElement;
      const startRow = checkRow(tr(lang, "pp.cmove.start"), "", false, (on) => {
        fromStart = on;
        recheck();
      });
      body.append(
        block(tr(lang, "pp.cmove.pick"), picker),
        nobodyRow,
        startRow,
        el("p", "muted", tr(lang, "pp.cmove.startHint")),
      );
      slot = el("div");
      body.append(slot);
    },
  });
}
