// The filter bar above the Task list. Built with DOM calls only (no HTML strings), from the same field list the HTTP page
// renders its form from (src/task-query.ts). Submitting reads the controls through the shared parser, so a filter that
// reaches a route has always been validated.
import { tr, type Lang } from "../src/i18n.js";
import {
  FILTER_FIELDS,
  FILTER_PARAMS,
  TIME_PRESETS,
  filterFieldOptions,
  filterFieldValue,
  hasInvalidTime,
  parseTaskFilter,
  presetRange,
  type TaskFilter,
} from "../src/task-query.js";
import { tzLabel } from "../src/ui-render.js";

export type FilterBar = {
  element: HTMLFormElement;
  /** Show these values in the controls (called when the route's filter changes, never on a plain refresh). */
  set(filter: TaskFilter): void;
  /** Rebuild the labels in another language, keeping what is typed. */
  setLang(lang: Lang): void;
};

export function createFilterBar(handlers: {
  lang: Lang;
  /** A new filter from the controls; the page number is always 1. */
  apply(filter: TaskFilter): void;
  reset(): void;
  now?: () => Date;
}): FilterBar {
  const form = document.createElement("form");
  form.className = "nx-filters";
  form.noValidate = true;
  let lang = handlers.lang;
  let controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const problem = document.createElement("span");
  problem.className = "f-error bad";
  problem.setAttribute("role", "alert");
  problem.hidden = true;

  const values = () => {
    const out = new Map<string, string>();
    for (const control of controls.values()) {
      out.set(control.name, control.value);
    }
    return out;
  };
  const read = (): TaskFilter => ({
    // A new search starts at the first page.
    ...parseTaskFilter((name) => values().get(name)),
    page: 1,
  });
  /** Applies the controls, unless a time box holds text that is not a date (then say so and change nothing). */
  const submitControls = (override?: Partial<TaskFilter>) => {
    const current = values();
    if (hasInvalidTime((name) => current.get(name))) {
      problem.textContent = tr(lang, "f.timeFormat");
      problem.hidden = false;
      return;
    }
    problem.hidden = true;
    handlers.apply({ ...read(), ...override });
  };

  const build = () => {
    controls = new Map();
    const children: Array<Node | string> = [];
    for (const field of FILTER_FIELDS) {
      const label = document.createElement("label");
      label.className = `f-${field.key}`;
      label.append(`${tr(lang, field.label)} `);
      let control: HTMLInputElement | HTMLSelectElement;
      if (field.kind === "select") {
        const select = document.createElement("select");
        for (const [value, text] of filterFieldOptions(field, lang)) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = text;
          select.append(option);
        }
        control = select;
      } else {
        const input = document.createElement("input");
        input.type = field.kind;
        if (field.placeholder) {
          input.placeholder = tr(lang, field.placeholder);
        }
        if (field.maxLength) {
          input.maxLength = field.maxLength;
        }
        control = input;
      }
      control.name = FILTER_PARAMS[field.key];
      controls.set(field.key, control);
      label.append(control);
      children.push(label);
    }

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "nx-btn nx-primary";
    submit.textContent = tr(lang, "f.apply");
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "nx-btn";
    reset.textContent = tr(lang, "f.reset");
    reset.addEventListener("click", () => handlers.reset());
    const actions = document.createElement("span");
    actions.className = "f-actions";
    actions.append(submit, " ", reset);
    children.push(actions);
    problem.textContent = tr(lang, "f.timeFormat");
    children.push(problem);

    const presets = document.createElement("span");
    presets.className = "f-presets muted";
    presets.append(tr(lang, "f.presets", { zone: tzLabel(handlers.now?.() ?? new Date()) }));
    for (const [key, labelKey] of TIME_PRESETS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nx-link";
      button.textContent = tr(lang, labelKey);
      button.addEventListener("click", () => {
        const range = presetRange(handlers.now?.() ?? new Date(), key);
        submitControls({ from: range.from, to: range.to });
      });
      presets.append(button, " ");
    }
    children.push(presets);
    form.replaceChildren(...children);
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitControls();
  });
  build();

  const show = (filter: TaskFilter) => {
    for (const field of FILTER_FIELDS) {
      const control = controls.get(field.key);
      if (control) {
        control.value = filterFieldValue(filter, field.key);
      }
    }
  };

  return {
    element: form,
    set: show,
    setLang(next) {
      if (next === lang) {
        return;
      }
      const typed = read();
      lang = next;
      build();
      show(typed);
    },
  };
}
