// A person picker for the commitment and claim dialogs: type to search the people who have a record, click one to choose them
// (shown as a chip you can remove). Typing without choosing stays a typed name where the form allows one. Built only from DOM
// nodes and textContent. It is written for a list of chosen people: today a commitment has ONE responsible person, so the form
// passes MAX_PICKED; a design with several owners raises that number and reads `selected` as the list.
import { tr, type Lang, type MsgKey } from "../src/i18n.js";
import { el } from "./goal-dom.ts";

/** A person the dialogs can point at: the id the server knows and every name that person answers to. */
export type PersonChoice = {
  id: string;
  name: string;
  relation: string | null;
  names: readonly string[];
  /** person, organization or team (a merge is offered only between records of one kind). */
  kind?: string;
};

/** How many people one commitment can have as its owner today (the ledger holds a single responsible person). */
export const MAX_PICKED = 1;
const MAX_SHOWN = 8;

export type PickState = { selected: string[]; typed: string };

export const foldName = (text: string): string => text.normalize("NFKC").trim().toLowerCase();

export function personPicker(options: {
  lang: Lang;
  people: readonly PersonChoice[];
  selected?: readonly string[];
  typed?: string;
  /** Whether text typed without choosing anyone is a value (a typed name). Off when only a person will do. */
  allowTyped: boolean;
  max?: number;
  onChange: (state: PickState) => void;
}): HTMLElement {
  const { lang, people, allowTyped } = options;
  const max = options.max ?? MAX_PICKED;
  const state: PickState = {
    selected: [...(options.selected ?? [])].slice(0, max),
    typed: options.typed ?? "",
  };
  const root = el("div", "nx-pick");
  const chips = el("div", "nx-pick-chips");
  const input = el("input");
  input.maxLength = 80;
  input.value = state.typed;
  input.placeholder = tr(lang, allowTyped ? "pp.pick.typeOrPick" : "pp.pick.search");
  const list = el("div", "nx-pick-list");
  list.hidden = true;
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  const emit = () => options.onChange({ selected: [...state.selected], typed: state.typed });

  const renderList = () => {
    list.replaceChildren();
    if (state.selected.length >= max) {
      list.hidden = true;
      return;
    }
    const needle = foldName(state.typed);
    const found = people
      .filter(
        (p) =>
          !state.selected.includes(p.id) &&
          (needle === "" || p.names.some((name) => foldName(name).includes(needle))),
      )
      .slice(0, MAX_SHOWN);
    for (const person of found) {
      const item = el("button", "nx-pick-item");
      item.type = "button";
      item.append(el("span", "", person.name));
      if (person.relation) {
        item.append(el("span", "nx-pick-rel", tr(lang, `pp.rel.${person.relation}` as MsgKey)));
      }
      item.addEventListener("click", () => {
        state.selected.push(person.id);
        state.typed = "";
        input.value = "";
        renderChips();
        renderList();
        emit();
      });
      list.append(item);
    }
    if (found.length === 0 && needle !== "" && !allowTyped) {
      list.append(el("p", "muted", tr(lang, "pp.pick.none")));
    }
    list.hidden = list.childElementCount === 0;
  };

  const renderChips = () => {
    chips.replaceChildren();
    for (const id of state.selected) {
      const chip = el("span", "nx-pick-chip");
      const remove = el("button", "", "×");
      remove.type = "button";
      remove.title = tr(lang, "pp.pick.remove");
      remove.setAttribute("aria-label", tr(lang, "pp.pick.remove"));
      remove.addEventListener("click", () => {
        state.selected = state.selected.filter((other) => other !== id);
        renderChips();
        renderList();
        emit();
      });
      chip.append(el("span", "", nameOf(id)), remove);
      chips.append(chip);
    }
    chips.hidden = state.selected.length === 0;
    input.hidden = state.selected.length >= max;
  };

  input.addEventListener("input", () => {
    state.typed = input.value;
    renderList();
    emit();
  });
  input.addEventListener("focus", renderList);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      list.hidden = true;
    }
  });
  input.addEventListener("blur", () => {
    // A click on a suggestion lands after the blur; give it time before the list goes away.
    setTimeout(() => {
      if (root.isConnected) {
        list.hidden = true;
      }
    }, 150);
  });
  root.append(chips, input, list);
  renderChips();
  return root;
}
