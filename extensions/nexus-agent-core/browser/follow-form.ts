// The follow-up plan form (design 9.5): what to look at, how often, until when, who is told and what will NOT be done. The same
// form serves the Work page and the review panel of the people page. It only collects words and times; the RPC stays the
// authority and re-checks everything. Built from DOM nodes and textContent, never from markup strings.
import { tr, type Lang } from "../src/i18n.js";
import type { Cadence } from "../src/schedule/cadence.js";
import type {
  DelegationPlanRecord,
  PlanBody,
  ScheduleSpec,
  StartIntent,
} from "../src/schedule/types.js";
import { block, localInput, localZone, select, textarea, textInput } from "./commitment-form.ts";
import { el, field } from "./goal-dom.ts";

export type CheckForm = {
  purpose: string;
  kind: "daily" | "interval" | "once";
  times: string;
  days: "all" | "work";
  every: string;
  unit: "minutes" | "hours";
  at: string;
};
export type PlanForm = {
  purpose: string;
  sources: string;
  checks: CheckForm[];
  until: string;
  wont: string;
  startIntent: Extract<StartIntent, "none" | "now">;
};

const MAX_CHECKS = 5;
const WORKDAYS = [1, 2, 3, 4, 5];
const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
const localMs = (value: string): number => (value ? new Date(value).getTime() : Number.NaN);

export const emptyCheck = (purpose = ""): CheckForm => ({
  purpose,
  kind: "daily",
  times: "09:00",
  days: "all",
  every: "2",
  unit: "hours",
  at: "",
});

export function emptyForm(lang: Lang, purpose = ""): PlanForm {
  return {
    purpose,
    sources: "",
    checks: [emptyCheck(purpose)],
    until: "",
    wont: [1, 2, 3].map((n) => tr(lang, `fu.wont.${n}` as never)).join("\n"),
    startIntent: "none",
  };
}

/** One saved check as a form row (a named function, not a `map` callback that spreads: see the no-map-spread lint rule). */
function checkFromSpec(spec: ScheduleSpec): CheckForm {
  const cadence = spec.cadence as Cadence;
  const check = emptyCheck(spec.purpose);
  if (cadence.kind === "once") {
    return { ...check, kind: "once", at: localInput(cadence.at) };
  }
  if (cadence.kind === "interval") {
    const hours = cadence.minutes % 60 === 0;
    return {
      ...check,
      kind: "interval",
      every: String(hours ? cadence.minutes / 60 : cadence.minutes),
      unit: hours ? "hours" : "minutes",
    };
  }
  return {
    ...check,
    kind: "daily",
    times: cadence.times.join(", "),
    days:
      cadence.weekdays && cadence.weekdays.length > 0 && cadence.weekdays.length < 7
        ? "work"
        : "all",
  };
}

/** The form of an existing plan, so "edit" starts from what the user accepted or drafted. */
export function formFromPlan(lang: Lang, plan: DelegationPlanRecord): PlanForm {
  const body = plan.plan;
  const until = (body.stopConditions ?? []).find((stop) => stop.kind === "until");
  const checks = (body.schedules ?? []).map(checkFromSpec);
  return {
    purpose: plan.purpose,
    sources: (body.sources ?? []).join("\n"),
    checks: checks.length > 0 ? checks : [emptyCheck(plan.purpose)],
    until: until && until.kind === "until" ? localInput(until.at) : "",
    wont: (body.wontDo ?? []).join("\n") || emptyForm(lang).wont,
    startIntent: plan.startIntent === "now" ? "now" : "none",
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function cadenceOf(check: CheckForm): Cadence | string {
  if (check.kind === "once") {
    const at = localMs(check.at);
    return Number.isFinite(at) && at > Date.now() ? { kind: "once", at } : "fu.f.err.at";
  }
  if (check.kind === "interval") {
    const n = Number(check.every);
    const minutes = check.unit === "hours" ? n * 60 : n;
    return Number.isInteger(n) && n > 0 && minutes >= 15
      ? { kind: "interval", minutes }
      : "fu.f.err.every";
  }
  const times = check.times
    .split(/[,，、\s]+/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (times.length === 0 || times.length > 8 || !times.every((t) => TIME.test(t))) {
    return "fu.f.err.times";
  }
  return {
    kind: "daily",
    times: [...new Set(times)].toSorted(),
    ...(check.days === "work" ? { weekdays: WORKDAYS } : {}),
  };
}

/** The first thing wrong with the form, as a catalog key, or null. */
export function formProblem(form: PlanForm): string | null {
  if (form.purpose.trim() === "") {
    return "fu.f.err.purpose";
  }
  if (lines(form.sources).length === 0) {
    return "fu.f.err.sources";
  }
  for (const check of form.checks) {
    if (check.purpose.trim() === "") {
      return "fu.f.err.checkPurpose";
    }
    const cadence = cadenceOf(check);
    if (typeof cadence === "string") {
      return cadence;
    }
  }
  if (form.until !== "" && !(localMs(form.until) > Date.now())) {
    return "fu.f.err.until";
  }
  if (lines(form.wont).length === 0) {
    return "fu.f.err.wont";
  }
  return null;
}

/** What the RPC takes: the plan body with its schedules, written in the words the user saw (call only after `formProblem` is null). */
export function toPlan(
  lang: Lang,
  form: PlanForm,
): { purpose: string; plan: PlanBody; startIntent: StartIntent } {
  const tz = localZone();
  const schedules = form.checks.map((check): ScheduleSpec => {
    const cadence = cadenceOf(check) as Cadence;
    return {
      scheduleKind: cadence.kind === "once" ? "once" : "recurring",
      purpose: check.purpose.trim(),
      cadence,
      tz,
    };
  });
  const until = localMs(form.until);
  return {
    purpose: form.purpose.trim(),
    startIntent: form.startIntent,
    plan: {
      schedules,
      sources: lines(form.sources),
      notifyText: tr(lang, "fu.f.notifyFixed"),
      wontDo: lines(form.wont),
      tz,
      ...(Number.isFinite(until)
        ? { stopConditions: [{ kind: "until" as const, at: until }] }
        : {}),
    },
  };
}

function checkRows(
  lang: Lang,
  form: PlanForm,
  rebuild: () => void,
  changed: () => void,
): HTMLElement {
  const box = el("div");
  form.checks.forEach((check, index) => {
    const card = el("div", "nx-li");
    card.append(
      field(
        tr(lang, "fu.f.checkPurpose"),
        textInput(check.purpose, 300, (v) => {
          check.purpose = v;
          changed();
        }),
      ),
      field(
        tr(lang, "fu.f.checks"),
        select(
          [
            [tr(lang, "fu.f.kind.daily"), "daily"],
            [tr(lang, "fu.f.kind.interval"), "interval"],
            [tr(lang, "fu.f.kind.once"), "once"],
          ],
          check.kind,
          (v) => {
            check.kind = v as CheckForm["kind"];
            rebuild();
            changed();
          },
        ),
      ),
    );
    if (check.kind === "daily") {
      card.append(
        field(
          tr(lang, "fu.f.times"),
          textInput(check.times, 80, (v) => {
            check.times = v;
            changed();
          }),
        ),
        field(
          "",
          select(
            [
              [tr(lang, "fu.f.days.all"), "all"],
              [tr(lang, "fu.f.days.work"), "work"],
            ],
            check.days,
            (v) => {
              check.days = v as CheckForm["days"];
              changed();
            },
          ),
        ),
      );
    } else if (check.kind === "interval") {
      const every = textInput(check.every, 5, (v) => {
        check.every = v;
        changed();
      });
      every.inputMode = "numeric";
      const row = el("div");
      row.append(
        every,
        select(
          [
            [tr(lang, "fu.f.unit.hours"), "hours"],
            [tr(lang, "fu.f.unit.minutes"), "minutes"],
          ],
          check.unit,
          (v) => {
            check.unit = v as CheckForm["unit"];
            changed();
          },
        ),
      );
      card.append(block(tr(lang, "fu.f.every"), row));
    } else {
      const at = el("input");
      at.type = "datetime-local";
      at.value = check.at;
      at.addEventListener("input", () => {
        check.at = at.value;
        changed();
      });
      card.append(field(tr(lang, "fu.f.at"), at));
    }
    if (form.checks.length > 1) {
      const drop = el("button", "nx-btn", tr(lang, "fu.f.removeCheck"));
      drop.type = "button";
      drop.addEventListener("click", () => {
        form.checks.splice(index, 1);
        rebuild();
        changed();
      });
      card.append(drop);
    }
    box.append(card);
  });
  if (form.checks.length < MAX_CHECKS) {
    const add = el("button", "nx-btn", tr(lang, "fu.f.addCheck"));
    add.type = "button";
    add.addEventListener("click", () => {
      form.checks.push(emptyCheck(form.purpose));
      rebuild();
      changed();
    });
    box.append(add);
  }
  return box;
}

/** Fill `body` with the form fields; `changed` is called after every input so the dialog re-checks its buttons. */
export function buildPlanFields(
  lang: Lang,
  body: HTMLElement,
  form: PlanForm,
  changed: () => void,
  extra?: HTMLElement,
): void {
  const purpose = textInput(form.purpose, 300, (v) => {
    form.purpose = v;
    changed();
  });
  purpose.placeholder = tr(lang, "fu.f.purposeHint");
  const sources = textarea(form.sources, 600, (v) => {
    form.sources = v;
    changed();
  });
  sources.placeholder = tr(lang, "fu.f.sourcesHint");
  const checks = el("div");
  const rebuild = () => checks.replaceChildren(checkRows(lang, form, rebuild, changed));
  rebuild();
  const until = el("input");
  until.type = "datetime-local";
  until.value = form.until;
  until.addEventListener("input", () => {
    form.until = until.value;
    changed();
  });
  const wont = textarea(form.wont, 600, (v) => {
    form.wont = v;
    changed();
  });
  wont.rows = 4;
  if (extra) {
    body.append(extra);
  }
  body.append(
    field(tr(lang, "fu.f.purpose"), purpose),
    field(tr(lang, "fu.f.sources"), sources),
    block(tr(lang, "fu.f.checks"), checks),
    field(tr(lang, "fu.f.until"), until),
    el("p", "muted", tr(lang, "fu.f.untilHint")),
    field(tr(lang, "fu.f.wont"), wont),
    el("p", "muted", tr(lang, "fu.f.notifyFixed")),
    field(
      tr(lang, "fu.f.start"),
      select(
        [
          [tr(lang, "fu.f.start.none"), "none"],
          [tr(lang, "fu.f.start.now"), "now"],
        ],
        form.startIntent,
        (v) => {
          form.startIntent = v as PlanForm["startIntent"];
          changed();
        },
      ),
    ),
  );
}
