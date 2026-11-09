// The People page dialogs that move responsibility: stopping a person (the server first says what it would reach, the user gives a
// reason), bringing one back (nothing is handed back by itself), and claiming a typed name for a person. Claiming a name the person
// already answers to only recognises the same person: told and response states stay. Any other name is a change of who is
// responsible: the open commitments get a new version and the told and response states start over.
import type { CounterpartImpact, PendingPersonGroup } from "../src/counterpart/types.js";
import { tr } from "../src/i18n.js";
import type { ActionContext } from "./actions.ts";
import { block, impactList, textarea } from "./commitment-form.ts";
import { openDialog } from "./dialog.ts";
import { el, field, note } from "./goal-dom.ts";
import { peopleGuard } from "./people-form.ts";
import { foldName, personPicker } from "./person-picker.ts";

// ------------------------------------------------------------------ stop

type Preview = { outcome?: string; impact?: CounterpartImpact };

export function deactivateDialog(ctx: ActionContext): void {
  const lang = ctx.lang;
  const person = ctx.model().person;
  if (!person) {
    ctx.changed({ ok: false, text: tr(lang, "pp.err.gone") });
    return;
  }
  // A person who was deleted before and brought back starts from the reason written then; the user rewrites it for this time.
  const earlier = person.lastStopReason?.trim() ?? "";
  let reason = earlier;
  let loaded = false;
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "pp.dlg.off", { name: person.name }),
    actions: [
      {
        label: tr(lang, "pp.btn.off"),
        tone: "danger",
        enabled: () => loaded && reason.trim() !== "",
        run: () =>
          peopleGuard(ctx, async () => {
            const reply = await ctx.request<Preview>("nexus.counterpart.deactivate", {
              counterpartId: person.id,
              reason: reason.trim(),
              expectedRevision: person.revision,
            });
            if (reply.outcome !== "deactivated") {
              ctx.changed({ ok: false, text: tr(lang, "pp.err.changed") });
              return;
            }
            ctx.changed({ ok: true, text: tr(lang, "pp.notice.off", { name: person.name }) });
          }),
      },
    ],
    build: (body, changed) => {
      body.append(
        el("p", "", tr(lang, "pp.dlg.off.intro")),
        field(
          tr(lang, "pp.f.reason"),
          textarea(earlier, 500, (v) => {
            reason = v;
            changed();
          }),
        ),
      );
      if (earlier !== "") {
        body.append(el("p", "muted", tr(lang, "pp.dlg.off.prefill")));
      }
      const slot = el("div");
      const status = el("p", "muted", tr(lang, "cm.dlg.loading"));
      body.append(slot, status);
      void ctx
        .request<Preview>("nexus.counterpart.deactivate", {
          counterpartId: person.id,
          dryRun: true,
        })
        .then((reply) => {
          const impact = reply.impact;
          if (reply.outcome !== "preview" || !impact) {
            ctx.changed({ ok: false, text: tr(lang, "pp.err.state") });
            return;
          }
          status.remove();
          slot.replaceChildren(
            impactList([
              { tone: "stop", text: tr(lang, "pp.imp.stop") },
              impact.openCommitments > 0
                ? { tone: "stop", text: tr(lang, "pp.imp.open", { n: impact.openCommitments }) }
                : { tone: "keep", text: tr(lang, "pp.imp.noOpen") },
              ...(impact.resolvedCommitments > 0
                ? [
                    {
                      tone: "keep" as const,
                      text: tr(lang, "pp.imp.closed", { n: impact.resolvedCommitments }),
                    },
                  ]
                : []),
              ...impact.works.map((work) => ({
                tone: "note" as const,
                text: tr(lang, "pp.imp.work", { title: work.title }),
              })),
              ...(impact.contacts > 0
                ? [
                    {
                      tone: "keep" as const,
                      text: tr(lang, "pp.imp.contacts", { n: impact.contacts }),
                    },
                  ]
                : []),
              { tone: "keep", text: tr(lang, "pp.imp.keep") },
              { tone: "note", text: tr(lang, "pp.imp.notForget") },
            ]),
          );
          loaded = true;
          changed();
        })
        .catch((error: unknown) => {
          status.textContent = error instanceof Error ? error.message : String(error);
        });
    },
  });
}

// ------------------------------------------------------------------ restore

export function restoreDialog(ctx: ActionContext): void {
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
    title: tr(lang, "pp.dlg.on", { name: person.name }),
    actions: [
      {
        label: tr(lang, "pp.btn.on"),
        tone: "primary",
        run: () =>
          peopleGuard(ctx, async () => {
            await ctx.request("nexus.counterpart.restore", { counterpartId: person.id });
            ctx.changed({ ok: true, text: tr(lang, "pp.notice.on", { name: person.name }) });
          }),
      },
    ],
    build: (body) => {
      body.append(
        impactList([
          { tone: "keep", text: tr(lang, "pp.on.back") },
          { tone: "note", text: tr(lang, "pp.on.none") },
        ]),
      );
    },
  });
}

// ------------------------------------------------------------------ claim

type Claimed = { outcome?: string; claimed?: number; resolved?: number; versioned?: number };

/** Point a group of typed names at a person. `id` is `g<index>` into the groups the page loaded. */
export function claimDialog(ctx: ActionContext, id: string): void {
  const lang = ctx.lang;
  const model = ctx.model();
  const group: PendingPersonGroup | undefined =
    model.pending?.[Number(/^g(\d+)$/.exec(id)?.[1] ?? "-1")];
  const people = model.people ?? [];
  if (!group || people.length === 0) {
    ctx.changed({ ok: false, text: tr(lang, group ? "pp.claim.noPeople" : "pp.err.gone") });
    return;
  }
  // One suggestion is only a suggestion: it is pre-selected, never applied.
  let chosen = group.suggestions.length === 1 ? (group.suggestions[0]?.id ?? "") : "";
  let remember = false;
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "pp.dlg.claim", { name: group.raw }),
    actions: [
      {
        label: tr(lang, "pp.btn.claim"),
        tone: "primary",
        enabled: () => chosen !== "",
        run: () =>
          peopleGuard(ctx, async () => {
            const reply = await ctx.request<Claimed>("nexus.counterpart.claim", {
              counterpartId: chosen,
              raw: group.raw,
              ...(remember ? { rememberAlias: true } : {}),
            });
            if (reply.outcome !== "claimed") {
              ctx.changed({ ok: false, text: tr(lang, "pp.claim.nothing") });
              return;
            }
            ctx.changed({
              ok: true,
              text: tr(lang, "pp.notice.claimed", {
                n: reply.claimed ?? 0,
                resolved: reply.resolved ?? 0,
              }),
            });
          }),
      },
    ],
    build: (body, changed) => {
      body.append(el("p", "", tr(lang, "pp.claim.what", { name: group.raw, n: group.open })));
      const effect = el("div");
      const showEffect = () => {
        const person = people.find((p) => p.id === chosen);
        if (!person) {
          effect.replaceChildren();
          return;
        }
        const same = remember || person.names.some((n) => foldName(n) === foldName(group.raw));
        effect.replaceChildren(
          impactList([
            same
              ? { tone: "keep", text: tr(lang, "pp.claim.same", { name: person.name }) }
              : { tone: "stop", text: tr(lang, "pp.claim.other", { name: person.name }) },
          ]),
        );
      };
      body.append(
        block(
          tr(lang, "pp.f.person"),
          personPicker({
            lang,
            people,
            selected: chosen ? [chosen] : [],
            allowTyped: false,
            onChange: (state) => {
              chosen = state.selected[0] ?? "";
              showEffect();
              changed();
            },
          }),
        ),
      );
      const box = el("input");
      box.type = "checkbox";
      box.addEventListener("change", () => {
        remember = box.checked;
        showEffect();
      });
      const line = el("label", "nx-row nx-check");
      line.append(box, el("span", "", tr(lang, "pp.claim.remember", { name: group.raw })));
      body.append(line, effect);
      showEffect();
      note(body, tr(lang, "pp.claim.note"));
    },
  });
}
