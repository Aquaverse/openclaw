// "Not the same person" (W3c-4): the user answers a "may be the same person" hint with "these are two people". A small confirmation
// first (it silences the hint for that pair; nothing else changes), and a one-click undo from the quiet line that lists the marks.
// Both are built from the lists the page loaded (`s<index>` / `u<index>` in the marker), never from the clicked markup.
import { tr } from "../src/i18n.js";
import type { ActionContext } from "./actions.ts";
import { openDialog } from "./dialog.ts";
import { el } from "./goal-dom.ts";
import { peopleGuard } from "./people-form.ts";

const indexOf = (id: string, prefix: "s" | "u"): number =>
  Number(new RegExp(`^${prefix}(\\d+)$`).exec(id)?.[1] ?? "-1");

export function notSameDialog(ctx: ActionContext, id: string): void {
  const lang = ctx.lang;
  const person = ctx.model().person;
  const other = person?.same?.[indexOf(id, "s")];
  if (!person || !other) {
    ctx.changed({ ok: false, text: tr(lang, "pp.err.gone") });
    return;
  }
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "pp.same.dlg"),
    actions: [
      {
        label: tr(lang, "pp.same.dlg.ok"),
        tone: "primary",
        run: () =>
          peopleGuard(ctx, async () => {
            await ctx.request("nexus.counterpart.notSame", {
              counterpartId: person.id,
              otherId: other.id,
            });
            ctx.changed({
              ok: true,
              text: tr(lang, "pp.same.notice", { a: person.name, b: other.name }),
            });
          }),
      },
    ],
    build: (body) => {
      body.append(el("p", "", tr(lang, "pp.same.dlg.body", { a: person.name, b: other.name })));
    },
  });
}

export function unsameAction(ctx: ActionContext, id: string): void {
  const lang = ctx.lang;
  const person = ctx.model().person;
  const other = person?.notSame?.[indexOf(id, "u")];
  if (!person || !other) {
    ctx.changed({ ok: false, text: tr(lang, "pp.err.gone") });
    return;
  }
  void ctx
    .request("nexus.counterpart.notSameRestore", { counterpartId: person.id, otherId: other.id })
    .then(() => ctx.changed({ ok: true, text: tr(lang, "pp.same.undone", { name: other.name }) }))
    .catch(() => ctx.changed({ ok: false, text: tr(lang, "pp.err.gone") }));
}
