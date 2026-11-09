// "People who help" inside the record-a-commitment dialog (W3c-3): an optional picker and one role for all of them. The helpers are
// added right after the commitment exists (one `nexus.commitment.assistAdd` each), so a helper that cannot be added never stops the
// commitment from being recorded; the notice says how many did not make it. The responsible person is never added as a helper.
import { COMMITMENT_LIMITS, type CommitmentParticipantRole } from "../src/commitment/types.js";
import { tr, type Lang, type MsgKey } from "../src/i18n.js";
import type { ActionContext } from "./actions.ts";
import { block, select } from "./commitment-form.ts";
import { field } from "./goal-dom.ts";
import { personPicker, type PersonChoice } from "./person-picker.ts";

const ROLES: readonly CommitmentParticipantRole[] = ["participant", "approver", "recipient"];

export type HelperChoice = { ids: string[]; role: CommitmentParticipantRole };

export const noHelpers = (): HelperChoice => ({ ids: [], role: "participant" });

/** The two form lines (picker and role); empty when there is nobody to pick. A <div>, not a <label>, around the picker. */
export function helperFields(
  lang: Lang,
  people: readonly PersonChoice[],
  choice: HelperChoice,
): HTMLElement[] {
  if (people.length === 0) {
    return [];
  }
  return [
    block(
      tr(lang, "cm.f.helpers"),
      personPicker({
        lang,
        people,
        selected: choice.ids,
        allowTyped: false,
        max: COMMITMENT_LIMITS.participants,
        onChange: (state) => {
          choice.ids = state.selected;
        },
      }),
    ),
    field(
      tr(lang, "cm.f.helperRole"),
      select(
        ROLES.map((r) => [tr(lang, `cm.assist.role.${r}` as MsgKey), r] as [string, string]),
        choice.role,
        (v) => {
          choice.role = ROLES.find((r) => r === v) ?? "participant";
        },
      ),
    ),
  ];
}

/** Add the chosen helpers to the new commitment; returns how many were added and how many were refused. */
export async function addHelpers(
  ctx: ActionContext,
  commitmentId: string,
  choice: HelperChoice,
  responsibleId: string,
): Promise<{ added: number; failed: number }> {
  let added = 0;
  let failed = 0;
  for (const counterpartId of new Set(choice.ids)) {
    if (counterpartId === responsibleId) {
      continue;
    }
    try {
      await ctx.request("nexus.commitment.assistAdd", {
        commitmentId,
        counterpartId,
        role: choice.role,
      });
      added += 1;
    } catch {
      failed += 1;
    }
  }
  return { added, failed };
}
