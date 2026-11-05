// What the people dialogs share: error wording, the relation and kind choices, and the list of people that already carry a name.
// Built only from DOM nodes and textContent; the RPC stays the authority.
import {
  COUNTERPART_KINDS,
  COUNTERPART_LIMITS,
  COUNTERPART_RELATIONS,
  type NameMatch,
} from "../src/counterpart/types.js";
import { tr, type Lang, type MsgKey } from "../src/i18n.js";
import type { ActionContext } from "./actions.ts";
import { text } from "./commitment-form.ts";
import { el } from "./goal-dom.ts";

export const NAME_MAX = COUNTERPART_LIMITS.name;

export type PersonDraft = {
  name: string;
  kind: (typeof COUNTERPART_KINDS)[number];
  /** "" = no relation recorded. */
  relation: "" | (typeof COUNTERPART_RELATIONS)[number];
  scope: string;
  /** Other names, as typed (separated by commas or 、). */
  aliases: string;
};

export const kindOptions = (lang: Lang): [string, string][] =>
  COUNTERPART_KINDS.map((kind) => [tr(lang, `pp.kind.${kind}` as MsgKey), kind]);

export const relationOptions = (lang: Lang): [string, string][] => [
  [tr(lang, "pp.rel.none"), ""],
  ...COUNTERPART_RELATIONS.map((relation): [string, string] => [
    tr(lang, `pp.rel.${relation}` as MsgKey),
    relation,
  ]),
];

/** "小王、老王, 王总" to ["小王", "老王", "王总"]: blanks and repeats dropped. */
export function parseAliases(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,，、;；\n]/u)
        .map((part) => part.trim())
        .filter((part) => part !== ""),
    ),
  ];
}

/** The server said another person already carries this name; the dialog shows who and offers "this is someone else". */
export class TakenError extends Error {}

/** A write on a person: a stale revision, a vanished or inactive person reloads with a notice instead of an open dialog. */
export async function peopleGuard(ctx: ActionContext, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (error instanceof TakenError) {
      throw error;
    }
    const t = text(error);
    if (t.includes("nexus_revision_conflict")) {
      ctx.changed({ ok: false, text: tr(ctx.lang, "pp.err.changed") });
      return;
    }
    if (t.includes("nexus_not_found")) {
      ctx.changed({ ok: false, text: tr(ctx.lang, "pp.err.gone") });
      return;
    }
    if (t.includes("nexus_counterpart_state")) {
      ctx.changed({ ok: false, text: tr(ctx.lang, "pp.err.state") });
      return;
    }
    if (t.includes("nexus_relation_conflict")) {
      throw new Error(tr(ctx.lang, "pp.err.relconf"), { cause: error });
    }
    if (t.includes("nexus_choice_required")) {
      throw new Error(tr(ctx.lang, "pp.err.choice"), { cause: error });
    }
    if (t.includes("nexus_forbidden")) {
      throw new Error(tr(ctx.lang, "pp.err.self"), { cause: error });
    }
    throw new Error(
      tr(ctx.lang, "pp.err.generic", {
        message: error instanceof Error ? error.message : String(error),
      }),
      { cause: error },
    );
  }
}

/** The people who already answer to a name, as lines the person can compare (name, how they are related). */
export function candidateList(lang: Lang, candidates: NameMatch["candidates"]): HTMLElement {
  const list = el("div", "nx-imp");
  for (const candidate of candidates) {
    const relation = candidate.relation ? tr(lang, `pp.rel.${candidate.relation}` as MsgKey) : "";
    const line = el("div", "nx-imp-li note");
    line.append(
      el("span", "nx-imp-i", "!"),
      el("span", "", `${candidate.displayName}${relation ? ` · ${relation}` : ""}`),
    );
    list.append(line);
  }
  return list;
}

export function textBox(
  value: string,
  max: number,
  onInput: (v: string) => void,
  placeholder = "",
): HTMLInputElement {
  const node = el("input");
  node.maxLength = max;
  node.value = value;
  node.placeholder = placeholder;
  node.addEventListener("input", () => onInput(node.value));
  return node;
}
