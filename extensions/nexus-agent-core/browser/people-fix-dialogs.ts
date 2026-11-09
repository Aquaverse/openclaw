// The People page dialogs that correct identity: merge two records of one person, say a typed name "is not a person", and bring an
// ignored name back. The server first answers what a change would reach (dryRun); nothing is changed before the user has read it
// and chosen. Built from the person and the groups the page itself loaded, never from the clicked markup.
import type {
  CounterpartRecord,
  DismissedName,
  MergeImpact,
  NameMatch,
  NotPersonDestination,
  NotPersonImpact,
} from "../src/counterpart/types.js";
import { tr, type Lang, type MsgKey } from "../src/i18n.js";
import type { ActionContext } from "./actions.ts";
import { block, impactList, select } from "./commitment-form.ts";
import { openDialog, type DialogAction } from "./dialog.ts";
import { el, field } from "./goal-dom.ts";
import { candidateList, NAME_MAX, peopleGuard, TakenError, textBox } from "./people-form.ts";
import { personPicker } from "./person-picker.ts";

const relationText = (ctx: ActionContext, relation: CounterpartRecord["relation"]): string =>
  relation
    ? tr(ctx.lang, `pp.rel.${relation.relation}` as MsgKey) +
      (relation.scopeLabel ? `（${relation.scopeLabel}）` : "")
    : "-";

// ------------------------------------------------------------------ merge

type MergeReply = { outcome?: string; impact?: MergeImpact };

const DUP_SHOWN = 3;

/** The "may repeat" hints of a merge preview: a few pairs by wording, then how many more there are. */
function duplicateLines(
  lang: Lang,
  impact: MergeImpact,
  from: string,
  keeper: string,
): Array<{ tone: "note"; text: string }> {
  const pairs = impact.possibleDuplicates ?? [];
  const lines = pairs.slice(0, DUP_SHOWN).map((pair) => ({
    tone: "note" as const,
    text: tr(lang, "pp.merge.dup", {
      a: pair.sourceText,
      b: pair.targetText,
      from,
      name: keeper,
    }),
  }));
  if (pairs.length > DUP_SHOWN) {
    lines.push({
      tone: "note",
      text: tr(lang, "pp.merge.dupMore", { n: pairs.length - DUP_SHOWN }),
    });
  }
  return lines;
}

/** Merge the person on the page into another record of the same kind. */
export function mergeDialog(ctx: ActionContext): void {
  const lang = ctx.lang;
  const model = ctx.model();
  const person = model.person;
  if (!person) {
    ctx.changed({ ok: false, text: tr(lang, "pp.err.gone") });
    return;
  }
  const candidates = (model.people ?? []).filter(
    (p) => p.id !== person.id && (p.kind === undefined || p.kind === person.kind),
  );
  if (candidates.length === 0) {
    ctx.changed({ ok: false, text: tr(lang, "pp.merge.none") });
    return;
  }
  let chosen = "";
  let preview: MergeImpact | undefined;
  let relationChoice: "" | "source" | "target" = "";
  const nameOf = () => candidates.find((p) => p.id === chosen)?.name ?? "";
  const needsChoice = () => preview?.relations !== null && preview?.relations !== undefined;
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "pp.dlg.merge", { name: person.name }),
    actions: [
      {
        label: tr(lang, "pp.btn.mergeDo"),
        tone: "danger",
        enabled: () =>
          chosen !== "" && preview !== undefined && (!needsChoice() || relationChoice !== ""),
        run: () =>
          peopleGuard(ctx, async () => {
            const reply = await ctx.request<MergeReply>("nexus.counterpart.merge", {
              counterpartId: person.id,
              intoId: chosen,
              expectedRevision: person.revision,
              ...(relationChoice ? { relationChoice } : {}),
            });
            if (reply.outcome !== "merged") {
              ctx.changed({ ok: false, text: tr(lang, "pp.err.changed") });
              return;
            }
            ctx.changed({
              ok: true,
              text: tr(lang, "pp.notice.merged", { from: person.name, name: nameOf() }),
            });
          }),
      },
    ],
    build: (body, changed) => {
      body.append(el("p", "", tr(lang, "pp.merge.intro")));
      const slot = el("div");
      const show = () => {
        const keeper = nameOf();
        if (!preview || !keeper) {
          slot.replaceChildren(el("p", "muted", tr(lang, "pp.merge.pick")));
          return;
        }
        const i = preview;
        const lines: Array<{ tone: "keep" | "stop" | "note"; text: string }> = [
          i.openCommitments + i.resolvedCommitments > 0
            ? {
                tone: "keep",
                text: tr(lang, "pp.merge.open", {
                  n: i.openCommitments,
                  m: i.resolvedCommitments,
                  name: keeper,
                }),
              }
            : { tone: "keep", text: tr(lang, "pp.merge.noCommitments") },
          { tone: "keep", text: tr(lang, "pp.merge.names", { from: person.name, name: keeper }) },
          ...(i.contacts > 0
            ? [
                {
                  tone: "keep" as const,
                  text: tr(lang, "pp.merge.contacts", {
                    n: i.contacts,
                    shared: i.sharedContacts,
                    name: keeper,
                  }),
                },
              ]
            : []),
          ...(i.participantLinks > 0
            ? [
                {
                  tone: "keep" as const,
                  text: tr(lang, "pp.merge.links", { n: i.participantLinks }),
                },
              ]
            : []),
          ...i.works.map((work) => ({
            tone: "note" as const,
            text: tr(lang, "pp.merge.work", { title: work.title }),
          })),
          ...duplicateLines(lang, i, person.name, keeper),
          { tone: "stop", text: tr(lang, "pp.merge.final") },
        ];
        const parts: HTMLElement[] = [impactList(lines)];
        if (i.relations) {
          parts.push(
            el("p", "", tr(lang, "pp.merge.rel")),
            select(
              [
                [tr(lang, "pp.merge.relPick"), ""],
                [
                  tr(lang, "pp.merge.relTarget", {
                    name: keeper,
                    rel: relationText(ctx, i.relations.target),
                  }),
                  "target",
                ],
                [
                  tr(lang, "pp.merge.relSource", {
                    from: person.name,
                    rel: relationText(ctx, i.relations.source),
                  }),
                  "source",
                ],
              ],
              relationChoice,
              (v) => {
                relationChoice = v === "source" ? "source" : v === "target" ? "target" : "";
                changed();
              },
            ),
          );
        }
        slot.replaceChildren(...parts);
      };
      body.append(
        block(
          tr(lang, "pp.merge.keep"),
          personPicker({
            lang,
            people: candidates,
            allowTyped: false,
            onChange: (state) => {
              const next = state.selected[0] ?? "";
              if (next === chosen) {
                return;
              }
              chosen = next;
              preview = undefined;
              relationChoice = "";
              show();
              changed();
              if (!next) {
                return;
              }
              void ctx
                .request<MergeReply>("nexus.counterpart.merge", {
                  counterpartId: person.id,
                  intoId: next,
                  dryRun: true,
                })
                .then((reply) => {
                  if (chosen !== next) {
                    return;
                  }
                  if (reply.outcome !== "preview" || !reply.impact) {
                    ctx.changed({ ok: false, text: tr(lang, "pp.err.state") });
                    return;
                  }
                  preview = reply.impact;
                  show();
                  changed();
                })
                .catch((error: unknown) => {
                  slot.replaceChildren(
                    el("p", "error", error instanceof Error ? error.message : String(error)),
                  );
                });
            },
          }),
        ),
        slot,
      );
      show();
    },
  });
}

// ------------------------------------------------------------------ not a person

type NotReply = {
  outcome?: string;
  impact?: NotPersonImpact;
  moved?: number;
  versioned?: number;
  candidates?: NameMatch["candidates"];
};

const DESTINATIONS: ReadonlyArray<{ id: NotPersonDestination; label: MsgKey; desc: MsgKey }> = [
  { id: "organization", label: "pp.not.org", desc: "pp.not.orgDesc" },
  { id: "team", label: "pp.not.team", desc: "pp.not.teamDesc" },
  { id: "self", label: "pp.not.self", desc: "pp.not.selfDesc" },
  { id: "dismiss", label: "pp.not.dismiss", desc: "pp.not.dismissDesc" },
];

/** Say a group of typed names ("pending" group `g<index>`) is not a person. There is no default: the user picks where it goes. */
export function notPersonDialog(ctx: ActionContext, id: string): void {
  const lang = ctx.lang;
  const group = ctx.model().pending?.[Number(/^g(\d+)$/.exec(id)?.[1] ?? "-1")];
  if (!group) {
    ctx.changed({ ok: false, text: tr(lang, "pp.err.gone") });
    return;
  }
  let dest: NotPersonDestination | "" = "";
  let name = group.raw;
  let taken: NameMatch["candidates"] | undefined;
  let slot: HTMLElement | undefined;
  let refresh = () => {};
  const makesRecord = () => dest === "organization" || dest === "team";
  const send = (allowSameName: boolean) => () =>
    peopleGuard(ctx, async () => {
      if (dest === "") {
        return;
      }
      const reply = await ctx.request<NotReply>("nexus.counterpart.notPerson", {
        raw: group.raw,
        destination: dest,
        ...(makesRecord() ? { displayName: name.trim() } : {}),
        ...(allowSameName ? { allowSameName: true } : {}),
      });
      if (reply.outcome === "name_taken") {
        taken = reply.candidates ?? [];
        slot?.replaceChildren(candidateList(lang, taken));
        refresh();
        throw new TakenError(tr(lang, "pp.not.taken"));
      }
      if (reply.outcome === "dismissed") {
        ctx.changed({ ok: true, text: tr(lang, "pp.notice.dismissed", { name: group.raw }) });
      } else if (reply.outcome === "moved") {
        ctx.changed({
          ok: true,
          text:
            dest === "self"
              ? tr(lang, "pp.notice.notSelf", { n: reply.versioned ?? 0 })
              : tr(lang, "pp.notice.notMoved", { n: reply.moved ?? 0 }),
        });
      } else {
        ctx.changed({ ok: false, text: tr(lang, "pp.claim.nothing") });
      }
    });
  const actions: DialogAction[] = [
    {
      label: tr(lang, "pp.btn.notDo"),
      tone: "primary",
      enabled: () => dest !== "" && (!makesRecord() || name.trim() !== "") && taken === undefined,
      run: send(false),
    },
    {
      label: tr(lang, "pp.btn.notAnother"),
      tone: "danger",
      enabled: () => makesRecord() && name.trim() !== "" && taken !== undefined,
      run: send(true),
    },
  ];
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "pp.dlg.not", { name: group.raw }),
    actions,
    build: (body, changed) => {
      refresh = changed;
      body.append(el("p", "", tr(lang, "pp.not.what", { name: group.raw, n: group.open })));
      const effect = el("div");
      const nameField = field(
        tr(lang, "pp.not.name"),
        textBox(name, NAME_MAX, (v) => {
          name = v;
          taken = undefined;
          slot?.replaceChildren();
          changed();
        }),
      );
      nameField.hidden = true;
      const show = () => {
        const chosen = DESTINATIONS.find((item) => item.id === dest);
        effect.replaceChildren(
          ...(chosen
            ? [
                impactList([
                  { tone: dest === "self" ? "stop" : "keep", text: tr(lang, chosen.desc) },
                ]),
              ]
            : []),
        );
        nameField.hidden = !makesRecord();
      };
      const choices = el("div");
      for (const item of DESTINATIONS) {
        const radio = el("input");
        radio.type = "radio";
        radio.name = "nx-notperson";
        radio.addEventListener("change", () => {
          if (!radio.checked) {
            return;
          }
          dest = item.id;
          taken = undefined;
          slot?.replaceChildren();
          show();
          changed();
        });
        const line = el("label", "nx-row nx-check");
        line.append(radio, el("span", "", tr(lang, item.label)));
        choices.append(line);
      }
      slot = el("div");
      body.append(choices, effect, nameField, slot);
      show();
    },
  });
}

// ------------------------------------------------------------------ bring an ignored name back

/** `d<index>` into the ignored names the page loaded. */
export function undismissAction(ctx: ActionContext, id: string): void {
  const lang = ctx.lang;
  const entry: DismissedName | undefined =
    ctx.model().dismissed?.[Number(/^d(\d+)$/.exec(id)?.[1] ?? "-1")];
  if (!entry) {
    ctx.changed({ ok: false, text: tr(lang, "pp.err.gone") });
    return;
  }
  void ctx
    .request("nexus.counterpart.dismissalRestore", { dismissalId: entry.id })
    .then(() =>
      ctx.changed({ ok: true, text: tr(lang, "pp.notice.restored", { name: entry.raw }) }),
    )
    .catch(() => ctx.changed({ ok: false, text: tr(lang, "pp.err.gone") }));
}
