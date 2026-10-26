// The search row above the Files table: a name filter and the page size. Built with DOM calls only, like the Task filter
// bar. The renderer leaves an empty slot in its markup; the page moves this form into it after every mount, so what is
// being typed survives a refresh. Applying always starts at the first page.
import { tr, type Lang } from "../src/i18n.js";
import { PAGE_SIZES } from "../src/task-query.js";
import {
  DEFAULT_FILE_QUERY,
  parseFileQuery,
  FILE_PARAMS,
  type FileQuery,
} from "../src/vault-ui.js";

const MAX_NAME = 200;

export type FileBar = {
  element: HTMLFormElement;
  /** Show these values in the controls (called when the route's query changes, never on a plain refresh). */
  set(query: FileQuery): void;
  /** Rebuild the labels in another language, keeping what is typed. */
  setLang(lang: Lang): void;
};

export function createFileBar(handlers: {
  lang: Lang;
  /** A new query from the controls; `tab` is kept from the route, the page is always 1. */
  apply(change: Pick<FileQuery, "name" | "size">): void;
  reset(): void;
}): FileBar {
  const form = document.createElement("form");
  form.className = "nx-filebar";
  form.noValidate = true;
  let lang = handlers.lang;
  let name = document.createElement("input");
  let size = document.createElement("select");

  const read = (): Pick<FileQuery, "name" | "size"> => {
    const parsed = parseFileQuery((key) =>
      key === FILE_PARAMS.name ? name.value : key === FILE_PARAMS.size ? size.value : undefined,
    );
    return { name: parsed.name, size: parsed.size };
  };

  const build = () => {
    name = document.createElement("input");
    name.type = "text";
    name.name = FILE_PARAMS.name;
    name.maxLength = MAX_NAME;
    name.placeholder = tr(lang, "files.f.name.ph");
    size = document.createElement("select");
    size.name = FILE_PARAMS.size;
    for (const n of PAGE_SIZES) {
      const option = document.createElement("option");
      option.value = String(n);
      option.textContent = tr(lang, "f.sizeOption", { n });
      size.append(option);
    }
    const nameLabel = document.createElement("label");
    nameLabel.className = "f-name";
    nameLabel.append(`${tr(lang, "files.f.name")} `, name);
    const sizeLabel = document.createElement("label");
    sizeLabel.className = "f-size";
    sizeLabel.append(`${tr(lang, "f.size")} `, size);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "nx-btn nx-primary";
    submit.textContent = tr(lang, "files.f.apply");
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "nx-btn";
    reset.textContent = tr(lang, "f.reset");
    reset.addEventListener("click", () => handlers.reset());
    form.replaceChildren(nameLabel, sizeLabel, submit, reset);
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    handlers.apply(read());
  });
  build();

  const show = (query: Pick<FileQuery, "name" | "size">) => {
    name.value = query.name;
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
      const typed = { name: name.value, size: read().size };
      lang = next;
      build();
      show(typed);
    },
  };
}
