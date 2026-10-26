// The search row above the Files table: a name filter, the kind / favorite / sensitivity filters and the page size.
// Built with DOM calls only, like the Task filter bar. The renderer leaves an empty slot in its markup; the page moves
// this form into it after every mount, so what is being typed survives a refresh. Applying always starts at the first page.
import { tr, type Lang, type MsgKey } from "../src/i18n.js";
import { PAGE_SIZES } from "../src/task-query.js";
import { FILE_KINDS } from "../src/vault-kind.js";
import {
  DEFAULT_FILE_QUERY,
  FILE_PARAMS,
  parseFileQuery,
  type FileFilters,
} from "../src/vault-ui.js";

const MAX_NAME = 200;

export type FileBar = {
  element: HTMLFormElement;
  /** Show these values in the controls (called when the route's query changes, never on a plain refresh). */
  set(query: FileFilters): void;
  /** Rebuild the labels in another language, keeping what is typed. */
  setLang(lang: Lang): void;
};

export function createFileBar(handlers: {
  lang: Lang;
  /** New filters from the controls; `tab` is kept from the route, the page is always 1. */
  apply(change: FileFilters): void;
  reset(): void;
}): FileBar {
  const form = document.createElement("form");
  form.className = "nx-filebar";
  form.noValidate = true;
  let lang = handlers.lang;
  let name = document.createElement("input");
  let kind = document.createElement("select");
  let favorite = document.createElement("select");
  let sensitivity = document.createElement("select");
  let size = document.createElement("select");

  const read = (): FileFilters => {
    const values: Record<string, string> = {
      [FILE_PARAMS.name]: name.value,
      [FILE_PARAMS.kind]: kind.value,
      [FILE_PARAMS.favorite]: favorite.value,
      [FILE_PARAMS.sensitivity]: sensitivity.value,
      [FILE_PARAMS.size]: size.value,
    };
    const parsed = parseFileQuery((key) => values[key]);
    return {
      name: parsed.name,
      kind: parsed.kind,
      favorite: parsed.favorite,
      sensitivity: parsed.sensitivity,
      size: parsed.size,
    };
  };

  const select = (
    field: string,
    options: ReadonlyArray<readonly [string, string]>,
  ): HTMLSelectElement => {
    const element = document.createElement("select");
    element.name = field;
    for (const [value, text] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      element.append(option);
    }
    return element;
  };
  const labelled = (className: string, text: string, control: HTMLElement): HTMLLabelElement => {
    const label = document.createElement("label");
    label.className = className;
    label.append(`${text} `, control);
    return label;
  };

  const build = () => {
    const t = (key: MsgKey) => tr(lang, key);
    name = document.createElement("input");
    name.type = "text";
    name.name = FILE_PARAMS.name;
    name.maxLength = MAX_NAME;
    name.placeholder = t("files.f.name.ph");
    kind = select(FILE_PARAMS.kind, [
      ["", t("files.f.kind.all")],
      ...FILE_KINDS.map((value) => [value, t(`files.kind.${value}`)] as const),
    ]);
    favorite = select(FILE_PARAMS.favorite, [
      ["", t("files.f.fav.all")],
      ["1", t("files.f.fav.only")],
    ]);
    sensitivity = select(FILE_PARAMS.sensitivity, [
      ["", t("files.f.sens.all")],
      ["sensitive", t("files.f.sens.sensitive")],
      ["normal", t("files.f.sens.normal")],
    ]);
    size = select(
      FILE_PARAMS.size,
      PAGE_SIZES.map((n) => [String(n), tr(lang, "f.sizeOption", { n })] as const),
    );
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "nx-btn nx-primary";
    submit.textContent = t("files.f.apply");
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "nx-btn";
    reset.textContent = t("f.reset");
    reset.addEventListener("click", () => handlers.reset());
    form.replaceChildren(
      labelled("f-name", t("files.f.name"), name),
      labelled("f-kind", t("files.f.kind"), kind),
      labelled("f-fav", t("files.f.fav"), favorite),
      labelled("f-sens", t("files.f.sens"), sensitivity),
      labelled("f-size", t("f.size"), size),
      submit,
      reset,
    );
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    handlers.apply(read());
  });
  build();

  const show = (query: FileFilters) => {
    name.value = query.name;
    kind.value = query.kind;
    favorite.value = query.favorite ? "1" : "";
    sensitivity.value = query.sensitivity;
    size.value = String(query.size);
  };
  show(DEFAULT_FILE_QUERY);

  return {
    element: form,
    set: show,
    setLang(next) {
      if (next === lang) {
        return;
      }
      // Keep what is typed (the name unparsed, so a half-written word survives the rebuild).
      const typed = { ...read(), name: name.value };
      lang = next;
      build();
      show(typed);
    },
  };
}
