// The search box at the top of the Work list: one text field with a magnifier, like the prototype. Built with DOM calls
// only (a form control cannot pass through the markup allow-list). The renderer leaves an empty slot; the page moves this
// form into it after every mount, so what is being typed survives a refresh. Typing applies after a short pause, Enter
// at once; applying keeps the state filter of the route (the page decides) and always lands on the plain list.
import { tr, type Lang, type MsgKey } from "../src/i18n.js";

const MAX_QUERY = 100;
const TYPING_PAUSE_MS = 350;
const SVG = "http://www.w3.org/2000/svg";

export type WorkBar = {
  element: HTMLFormElement;
  /** Show this keyword in the box (called when the route's keyword changes, never on a plain refresh). */
  set(q: string): void;
  /** Rebuild the placeholder in another language, keeping what is typed. */
  setLang(lang: Lang): void;
  /** Gives the box the focus back after a mount replaced the page around it, if the user was typing in it. */
  restoreFocus(): void;
};

export function createWorkBar(handlers: {
  lang: Lang;
  /** The placeholder text of the box; the Work list's by default. */
  placeholder?: MsgKey;
  apply(q: string): void;
}): WorkBar {
  const form = document.createElement("form");
  form.className = "nx-wsearch";
  form.noValidate = true;
  form.setAttribute("role", "search");
  let lang = handlers.lang;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let typing = false;
  // An input method (pinyin, kana, ...) is composing: the box holds text that is not final yet.
  let composing = false;
  let applied = "";

  const icon = document.createElementNS(SVG, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS(SVG, "circle");
  circle.setAttribute("cx", "11");
  circle.setAttribute("cy", "11");
  circle.setAttribute("r", "7");
  const handle = document.createElementNS(SVG, "path");
  handle.setAttribute("d", "m20 20-3.5-3.5");
  icon.append(circle, handle);

  const input = document.createElement("input");
  input.type = "text";
  input.name = "q";
  input.maxLength = MAX_QUERY;
  input.autocomplete = "off";
  const text = () => tr(lang, handlers.placeholder ?? "work.search.placeholder");
  input.placeholder = text();
  input.setAttribute("aria-label", text());
  form.append(icon, input);

  const submit = () => {
    clearTimeout(timer);
    if (composing) {
      return;
    }
    const q = input.value.trim();
    if (q === applied) {
      return;
    }
    applied = q;
    handlers.apply(q);
  };
  // While an input method composes, the text is a candidate (pinyin letters, say), not a query: nothing is applied and
  // nothing touches the box until the choice is made, or the composition would break.
  input.addEventListener("compositionstart", () => {
    typing = true;
    composing = true;
    clearTimeout(timer);
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    clearTimeout(timer);
    timer = setTimeout(submit, TYPING_PAUSE_MS);
  });
  input.addEventListener("input", (event) => {
    if (composing || (event as InputEvent).isComposing) {
      return;
    }
    typing = true;
    clearTimeout(timer);
    timer = setTimeout(submit, TYPING_PAUSE_MS);
  });
  // Leaving the box by hand ends "typing"; being detached by a rebuild of the page around it does not.
  input.addEventListener("focusout", () => {
    setTimeout(() => {
      if (input.isConnected) {
        typing = false;
      }
    }, 0);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });

  return {
    element: form,
    set(q) {
      if (composing) {
        return;
      }
      // The route echoing back what was just typed must not overwrite characters typed since.
      if (q === applied) {
        return;
      }
      applied = q;
      input.value = q;
    },
    setLang(next) {
      if (next === lang) {
        return;
      }
      lang = next;
      input.placeholder = text();
      input.setAttribute("aria-label", text());
    },
    restoreFocus() {
      if (!typing || composing) {
        return;
      }
      typing = false;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    },
  };
}
