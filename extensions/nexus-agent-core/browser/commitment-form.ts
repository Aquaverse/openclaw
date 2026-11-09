// What the commitment dialogs share: the "what / who / when / next" form (who can be you, a typed name or a person with a record),
// the error wording, the impact list and a Work picker. Built only from DOM nodes and textContent; the RPC stays the authority.
import { tr, type Lang } from "../src/i18n.js";
import type { ActionContext } from "./actions.ts";
import { el, field } from "./goal-dom.ts";
import { foldName, personPicker, type PersonChoice } from "./person-picker.ts";

export type Impact = {
  works?: { workId: string; title: string; role: "required" | "reference" }[];
  helpers?: { counterpartId: string; displayName: string; role: string }[];
};
export type Reply = {
  outcome?: string;
  impact?: Impact;
  commitment?: { id: string; ambiguity?: unknown };
};

export const text = (error: unknown): string =>
  `${(error as { code?: string } | undefined)?.code ?? ""} ${error instanceof Error ? error.message : String(error)}`;

export function describeError(lang: Lang, error: unknown): string {
  const t = text(error);
  if (t.includes("nexus_commitment_state")) {
    return tr(lang, "cm.err.state");
  }
  if (t.includes("nexus_not_found")) {
    return tr(lang, "cm.err.gone");
  }
  if (t.includes("nexus_unsupported")) {
    return tr(lang, "cm.err.either");
  }
  if (t.includes("nexus_commitment_already_cited")) {
    return tr(lang, "cm.err.cited");
  }
  if (t.includes("nexus_gap_ack_required")) {
    return tr(lang, "cm.err.ack");
  }
  return tr(lang, "cm.err.generic", {
    message: error instanceof Error ? error.message : String(error),
  });
}

/** A write; a stale revision or state reloads with a notice instead of leaving the dialog open on old data. */
export async function guarded(ctx: ActionContext, write: () => Promise<void>): Promise<void> {
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
export function impactList(
  items: readonly { tone: keyof typeof MARK; text: string }[],
): HTMLElement {
  const list = el("div", "nx-imp");
  for (const item of items) {
    const line = el("div", `nx-imp-li ${item.tone}`);
    line.append(el("span", "nx-imp-i", MARK[item.tone]), el("span", "", item.text));
    list.append(line);
  }
  return list;
}

/** The Works a lifecycle change reaches, as the impact list (design 6.5). */
export function worksImpact(lang: Lang, impact: Impact | undefined) {
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

/** "N people help" in the impact list: their records stay as they are, so this only tells the user they exist. */
export function helpersImpact(lang: Lang, impact: Impact | undefined) {
  const helpers = impact?.helpers ?? [];
  if (helpers.length === 0) {
    return [];
  }
  return [
    {
      tone: "keep" as const,
      text: tr(lang, "cm.imp.helpers", {
        n: helpers.length,
        names: helpers.map((h) => h.displayName).join("、"),
      }),
    },
  ];
}

export const newRequestId = () =>
  `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function option(label: string, value: string): HTMLOptionElement {
  const node = el("option", "", label);
  node.value = value;
  return node;
}
export function select(
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
export function textarea(value: string, max: number, onInput: (v: string) => void) {
  const node = el("textarea");
  node.rows = 3;
  node.maxLength = max;
  node.value = value;
  node.addEventListener("input", () => onInput(node.value));
  return node;
}
export function textInput(value: string, max: number, onInput: (v: string) => void) {
  const node = el("input");
  node.maxLength = max;
  node.value = value;
  node.addEventListener("input", () => onInput(node.value));
  return node;
}

/** `YYYY-MM-DDTHH:mm` in the viewer's local time, the format a datetime-local input takes. */
export function localInput(ms: number | null): string {
  if (ms === null) {
    return "";
  }
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type { PersonChoice } from "./person-picker.ts";

export type Form = {
  what: string;
  who: "self" | "other";
  name: string;
  personId: string;
  due: "pending" | "none" | "known";
  dueAt: string;
  next: string;
};

/** The "what / who / when / next" fields shared by the record and edit dialogs. */
export function buildForm(
  body: HTMLElement,
  lang: Lang,
  form: Form,
  changed: () => void,
  people: readonly PersonChoice[] = [],
): void {
  body.append(
    field(
      tr(lang, "cm.f.what"),
      textarea(form.what, 500, (v) => {
        form.what = v;
        changed();
      }),
    ),
  );
  const hint = el("p", "muted");
  const showHint = () => {
    const known =
      form.who === "other" && form.personId === "" && form.name.trim() !== ""
        ? people.find((p) => p.names.some((n) => foldName(n) === foldName(form.name)))
        : undefined;
    hint.hidden = known === undefined;
    hint.textContent = known ? tr(lang, "pp.f.nameHint", { name: known.name }) : "";
  };
  // One field for the owner: type a name, or search and click a person who has a record (shown as a chip).
  const owner = block(
    tr(lang, "pp.f.owner"),
    personPicker({
      lang,
      people,
      selected: form.personId ? [form.personId] : [],
      typed: form.name,
      allowTyped: true,
      onChange: (state) => {
        form.personId = state.selected[0] ?? "";
        form.name = state.typed;
        showHint();
        changed();
      },
    }),
  );
  const sync = () => {
    owner.hidden = form.who !== "other";
    showHint();
  };
  sync();
  body.append(
    field(
      tr(lang, "cm.f.who"),
      select(
        [
          [tr(lang, "cm.f.whoSelf"), "self"],
          [tr(lang, "pp.f.whoOther"), "other"],
        ],
        form.who,
        (v) => {
          form.who = v === "self" ? "self" : "other";
          sync();
          changed();
        },
      ),
    ),
    owner,
    hint,
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

export const formValid = (form: Form): boolean =>
  form.what.trim() !== "" &&
  (form.who === "self" || form.personId !== "" || form.name.trim() !== "") &&
  (form.due !== "known" || Number.isFinite(new Date(form.dueAt).getTime()));

export const responsibleOf = (form: Form) =>
  form.who === "self"
    ? { kind: "self" }
    : form.personId
      ? { kind: "counterpart", counterpartId: form.personId }
      : { kind: "name", name: form.name.trim() };
export const dueOf = (form: Form) =>
  form.due === "known"
    ? { kind: "known", at: new Date(form.dueAt).getTime(), tz: localZone() }
    : { kind: form.due };

/** A labelled row made of a div (not a label), so buttons inside it do not click through to the first input. */
export function block(label: string, node: HTMLElement): HTMLElement {
  const line = el("div", "nx-row");
  line.append(el("span", "nx-label", label), node);
  return line;
}

type WorkOption = { work: { id: string; title: string } };

/**
 * A select of the user's Works ("none" first), filled when the list arrives. `value()` is the chosen id or "". `preset` chooses a
 * Work the commitment is already cited in (added to the list when the first 100 do not hold it).
 */
export function workPicker(
  ctx: ActionContext,
  onChange: () => void,
): { line: HTMLElement; value: () => string; preset: (workId: string, title: string) => void } {
  let chosen = "";
  let wanted: { id: string; title: string } | undefined;
  const node = select([[tr(ctx.lang, "pp.f.workNone"), ""]], "", (v) => {
    chosen = v;
    onChange();
  });
  const apply = () => {
    if (!wanted) {
      return;
    }
    if (![...node.options].some((o) => o.value === wanted?.id)) {
      node.append(option(wanted.title, wanted.id));
    }
    node.value = wanted.id;
    chosen = wanted.id;
    onChange();
  };
  let loaded = false;
  void ctx
    .request<{ works?: WorkOption[] }>("nexus.work.list", { limit: 100 })
    .then((reply) => {
      for (const entry of reply.works ?? []) {
        node.append(option(entry.work.title, entry.work.id));
      }
    })
    .catch(() => {
      // Without the list the commitment simply is not tied to a Work now; it can be later.
    })
    .finally(() => {
      loaded = true;
      apply();
    });
  return {
    line: field(tr(ctx.lang, "pp.f.work"), node),
    value: () => chosen,
    preset: (workId, title) => {
      wanted = { id: workId, title };
      if (loaded) {
        apply();
      }
    },
  };
}
