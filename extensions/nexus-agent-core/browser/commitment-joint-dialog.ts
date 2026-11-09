// "Who answers for this commitment" (design 6.8, W3c-2): the words typed for the responsible person named several people or a
// group, so nobody answers yet. A commitment has ONE responsible person; the user chooses one of two forms:
//   * one person answers, the others help (helpers are not a second owner and not a sending authorization);
//   * one commitment for each person, with the same words, due date and Work citations.
// "Any one of them is enough" has no form here and the dialog says so. The RPC stays the authority; a stale dialog is refused.
import type { CommitmentLine } from "../src/commitment-ui.js";
import type { CommitmentParticipantRole } from "../src/commitment/types.js";
import { tr, type MsgKey } from "../src/i18n.js";
import type { ActionContext } from "./actions.ts";
import { block, guarded, select } from "./commitment-form.ts";
import { openDialog } from "./dialog.ts";
import { el, note } from "./goal-dom.ts";
import { foldName, personPicker, type PersonChoice } from "./person-picker.ts";

const ROLES: readonly CommitmentParticipantRole[] = ["participant", "approver", "recipient"];
const MAX_EACH = 10;
const MAX_HELPERS = 19;

/** The people the typed names point at, when each name is exactly one person who has a record. */
export function prefillByNames(
  people: readonly PersonChoice[],
  names: readonly string[],
): string[] {
  const ids: string[] = [];
  for (const name of names) {
    const hits = people.filter((p) => p.names.some((n) => foldName(n) === foldName(name)));
    if (hits.length === 1 && hits[0] && !ids.includes(hits[0].id)) {
      ids.push(hits[0].id);
    }
  }
  return ids.slice(0, MAX_EACH);
}

export function jointDialog(ctx: ActionContext, line: CommitmentLine): void {
  const lang = ctx.lang;
  const c = line.commitment;
  const people = ctx.model().people ?? [];
  let mode: "lead" | "each" = "lead";
  let lead: string[] = [];
  let helpers: string[] = [];
  let helperRole: CommitmentParticipantRole = "participant";
  let each: string[] = prefillByNames(people, c.ambiguity?.names ?? []);
  const roleName = (r: string) => tr(lang, `cm.assist.role.${r}` as MsgKey);

  const valid = (): boolean =>
    mode === "lead"
      ? lead.length === 1 && !helpers.includes(lead[0] ?? "")
      : each.length >= 2 && each.length <= MAX_EACH;

  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "cm.dlg.joint"),
    actions: [
      {
        label: tr(lang, "dlg.save"),
        tone: "primary",
        enabled: valid,
        run: () =>
          guarded(ctx, async () => {
            await ctx.request(
              "nexus.commitment.resolveJoint",
              mode === "lead"
                ? {
                    commitmentId: c.id,
                    choice: "lead",
                    leadId: lead[0],
                    helperIds: helpers,
                    helperRole,
                  }
                : { commitmentId: c.id, choice: "each", counterpartIds: each },
            );
            ctx.changed({
              ok: true,
              text: tr(lang, mode === "lead" ? "cm.notice.joint.lead" : "cm.notice.joint.each"),
            });
          }),
      },
    ],
    build: (body, changed) => {
      note(body, tr(lang, "cm.joint.lead", { raw: c.responsibleRaw ?? "-" }));
      const lean = el("div", "nx-asf");
      const leadBox = el("div", "nx-jf");
      const eachBox = el("div", "nx-jf");
      const show = () => {
        leadBox.hidden = mode !== "lead";
        eachBox.hidden = mode !== "each";
      };
      body.append(
        block(
          tr(lang, "cm.joint.form"),
          select(
            [
              [tr(lang, "cm.joint.form.lead"), "lead"],
              [tr(lang, "cm.joint.form.each"), "each"],
            ],
            mode,
            (v) => {
              mode = v === "each" ? "each" : "lead";
              show();
              changed();
            },
          ),
        ),
        lean,
      );
      lean.append(leadBox, eachBox);
      // One person answers; the others help.
      leadBox.append(
        block(
          tr(lang, "cm.joint.lead.who"),
          personPicker({
            lang,
            people,
            selected: lead,
            allowTyped: false,
            onChange: (state) => {
              lead = state.selected;
              changed();
            },
          }),
        ),
        block(
          tr(lang, "cm.joint.lead.helpers"),
          personPicker({
            lang,
            people,
            selected: helpers,
            allowTyped: false,
            max: MAX_HELPERS,
            onChange: (state) => {
              helpers = state.selected;
              changed();
            },
          }),
        ),
        block(
          tr(lang, "cm.assist.role"),
          select(
            ROLES.map((r) => [roleName(r), r] as [string, string]),
            helperRole,
            (v) => {
              helperRole = v as CommitmentParticipantRole;
            },
          ),
        ),
      );
      note(leadBox, tr(lang, "cm.joint.lead.hint"));
      // One commitment each.
      eachBox.append(
        block(
          tr(lang, "cm.joint.each.who"),
          personPicker({
            lang,
            people,
            selected: each,
            allowTyped: false,
            max: MAX_EACH,
            onChange: (state) => {
              each = state.selected;
              changed();
            },
          }),
        ),
      );
      note(eachBox, tr(lang, "cm.joint.each.hint"));
      show();
      note(body, tr(lang, "cm.joint.either"));
    },
  });
}
