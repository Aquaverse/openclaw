// The "Follow-up" block of the Work detail (design 11.3, 9.5): the plans a Work carries and the schedules they made, said in the
// five lines the user accepted (what to look at, how often, until when, who is told, what will NOT be done), with the next check,
// how well it is covered and the last few checks. Plain functions that return an HTML string for the Control UI sanitiser:
// every clickable thing is a `<button data-nx-act data-nx-id>` marker, every value goes through `esc`, every text is a catalog key.
// A draft is shown as a draft ("start / edit / not now"); nothing says "following up" until a plan was accepted.
import { allMessageKeys, tr, type Lang, type MsgKey } from "./i18n.js";
import type { Cadence } from "./schedule/cadence.js";
import {
  stopsAtFirstChange,
  type DelegationPlanRecord,
  type PlanBody,
  type ScheduleRecord,
  type TriggerRecord,
} from "./schedule/types.js";
import { callout, chip, kv, marker, section, shortTime as dayTime, type Tone } from "./ui-kit.js";
import { clip, esc } from "./ui-render.js";

/** What `nexus.work.followUp` returns for one Work. */
export type FollowUpData = {
  dispatchReady: boolean;
  plans: readonly DelegationPlanRecord[];
  schedules: readonly ScheduleRecord[];
  triggers: Readonly<Record<string, readonly TriggerRecord[]>>;
};

/** A day alone ("11-12") does not say when a check runs, so every date here carries its clock time. */
function shortTime(ms: number | null | undefined, now: number, lang: Lang): string {
  const day = dayTime(ms, now, lang);
  if (
    ms === null ||
    ms === undefined ||
    !Number.isFinite(ms) ||
    new Date(ms).toDateString() === new Date(now).toDateString()
  ) {
    return day;
  }
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${day} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const LIVE = new Set(["active", "paused", "blocked"]);
const isLive = (s: ScheduleRecord) => LIVE.has(s.status);
const KEYS = new Set<string>(allMessageKeys());
const key = (prefix: string, code: string): MsgKey => `${prefix}${code}` as MsgKey;

/** "Daily at 09:00", "Every 2 hours", "Once: today 09:00" in the page language. */
export function cadenceText(lang: Lang, cadence: Cadence, now: number): string {
  if (cadence.kind === "once") {
    return tr(lang, "fu.cad.once", { time: shortTime(cadence.at, now, lang) });
  }
  if (cadence.kind === "interval") {
    return cadence.minutes % 60 === 0
      ? tr(lang, "fu.cad.hours", { n: String(cadence.minutes / 60) })
      : tr(lang, "fu.cad.minutes", { n: String(cadence.minutes) });
  }
  const times = cadence.times.join(lang === "en" ? ", " : "、");
  if (!cadence.weekdays || cadence.weekdays.length === 0 || cadence.weekdays.length === 7) {
    return tr(lang, "fu.cad.daily", { times });
  }
  const days = cadence.weekdays
    .map((d) => tr(lang, key("fu.day.", String(d))))
    .join(lang === "en" ? ", " : "、");
  return tr(lang, "fu.cad.days", { days, times });
}

const stopText = (lang: Lang, body: PlanBody, now: number, ownerType?: string): string => {
  const parts = (body.stopConditions ?? []).map((stop) =>
    stop.kind === "commitment_resolved"
      ? tr(lang, "fu.until.resolved")
      : stop.kind === "until"
        ? tr(lang, "fu.until.at", { time: shortTime(stop.at, now, lang) })
        : tr(lang, "fu.until.goal"),
  );
  // A plan that follows a commitment ends when that commitment is resolved or cancelled (CD-04), whether or not it says so.
  if (
    ownerType === "commitment" &&
    !(body.stopConditions ?? []).some((stop) => stop.kind === "commitment_resolved")
  ) {
    parts.unshift(tr(lang, "fu.until.resolved"));
  }
  if (body.reviewOrEndAt) {
    parts.push(tr(lang, "fu.until.review", { time: shortTime(body.reviewOrEndAt, now, lang) }));
  }
  return parts.length > 0 ? parts.join(lang === "en" ? "; " : "；") : tr(lang, "fu.until.open");
};

const reasonText = (lang: Lang, code: string | null): string => {
  if (!code) {
    return "";
  }
  const k = key("fu.why.", code);
  // An unknown code is shown as the code, never as a raw catalog key.
  return KEYS.has(k) ? tr(lang, k) : code;
};

const scheduleChip = (lang: Lang, s: ScheduleRecord): string => {
  const tone: Record<string, Tone> = {
    active: "green",
    paused: "blue",
    blocked: "rose",
    ended: "gray",
    cancelled: "gray",
  };
  const text =
    s.status === "paused"
      ? tr(lang, key("fu.sched.paused.", s.pauseSource ?? "user"))
      : tr(lang, key("fu.sched.", s.status));
  return chip(tone[s.status] ?? "gray", text);
};

/** Why a check turn did not finish, in words. The stored reason is a code (and sometimes a short detail in brackets). */
export function failText(lang: Lang, reason: string | null): string {
  if (!reason) {
    return "";
  }
  const detail = /\((.*)\)\s*$/s.exec(reason)?.[1] ?? "";
  const [head = "", tail = ""] = reason.replace(/\s*\(.*\)\s*$/s, "").split(":");
  switch (head) {
    case "turn_ended_without_report":
      return tr(lang, "fu.fail.noReport") + (detail ? ` (${clip(detail, 200)})` : "");
    case "turn_not_started":
      return tail === "host_refused"
        ? tr(lang, "fu.fail.refused")
        : tail === "host_error"
          ? tr(lang, "fu.fail.hostError")
          : tr(lang, "fu.fail.notStarted", { why: tail });
    case "turn_never_started":
      return tr(lang, "fu.fail.neverStarted");
    case "turn_not_finished":
      return tr(lang, "fu.fail.notFinished");
    case "prerequisite_missing":
      return tr(lang, "fu.fail.prerequisite", { code: tail });
    default:
      return head.startsWith("schedule_")
        ? tr(lang, "fu.fail.scheduleChanged")
        : tr(lang, "fu.fail.other", { code: clip(reason, 120) });
  }
}

/** Why a due time did not become a check. Unknown codes say nothing rather than show a code. */
const skipText = (lang: Lang, reason: string | null): string =>
  reason === "previous_check_open"
    ? tr(lang, "fu.skip.open")
    : reason && ["paused", "blocked", "ended", "cancelled"].includes(reason)
      ? tr(lang, "fu.skip.state")
      : "";

/** One check record as its parts, so the short list and the full history say the same things. `bad` marks a check that went wrong. */
export function checkParts(
  lang: Lang,
  t: TriggerRecord,
  now: number,
): { time: string; source: string; what: string; note: string; bad: boolean } {
  const time = shortTime(t.plannedAt, now, lang);
  const source = t.source === "scheduled" ? "" : tr(lang, key("fu.src.", t.source));
  let what: string;
  let note = "";
  let bad = false;
  if (t.outcome === "created") {
    if (t.report) {
      what = tr(lang, key("fu.last.", t.report.outcome));
      note = t.report.summary;
      bad = t.report.outcome === "cannot_check";
      const n = t.report.notice;
      if (n) {
        // What happened to the notification the user chose: sent, or that the chosen channel was unavailable (nothing else).
        const said = tr(
          lang,
          n.status === "failed" && n.reason ? "fu.notice.failedWhy" : key("fu.notice.", n.status),
          { channel: n.channel, to: n.to, reason: n.reason ?? "" },
        );
        note = `${said} · ${note}`;
        bad = bad || n.status !== "sent";
      }
    } else if (t.turnState === "failed") {
      what = tr(lang, "fu.last.failed");
      note = failText(lang, t.failReason);
      bad = true;
    } else {
      what = tr(lang, "fu.last.waiting");
    }
  } else {
    what = tr(lang, key("fu.last.", t.outcome === "quarantined" ? "skipped" : t.outcome));
    note = t.outcome === "skipped" ? skipText(lang, t.skipReason) : "";
  }
  return { time, source, what, note, bad };
}

const checkLine = (lang: Lang, t: TriggerRecord, now: number): { text: string; bad: boolean } => {
  const p = checkParts(lang, t, now);
  const what = p.source ? `${p.source} · ${p.what}` : p.what;
  const note = clip(p.note, 200);
  return {
    text: note
      ? tr(lang, "fu.last.lineNote", { time: p.time, what, note })
      : tr(lang, "fu.last.line", { time: p.time, what }),
    bad: p.bad,
  };
};

/** The coverage note is a code the dispatcher wrote; say it in words, and show nothing for one we do not know. */
const coverageNoteText = (lang: Lang, note: string | null): string =>
  note && KEYS.has(`fu.note.${note}`) ? tr(lang, key("fu.note.", note)) : "";

/** The last few check records of one check, as lines (nothing when it has none yet). Ended checks keep showing theirs. */
function recentLines(lang: Lang, recent: readonly TriggerRecord[], now: number): string {
  return recent.length === 0
    ? ""
    : `<p class="nx-cm-n">${esc(tr(lang, "fu.last.title"))}</p>` +
        recent
          .map((t) => {
            const line = checkLine(lang, t, now);
            return `<p class="nx-cm-n${line.bad ? " nx-fu-bad" : ""}">${esc(line.text)}</p>`;
          })
          .join("");
}

function scheduleRow(
  lang: Lang,
  s: ScheduleRecord,
  triggers: readonly TriggerRecord[],
  now: number,
  withActions: boolean,
  wrapping = false,
  restorable = false,
): string {
  const covTone: Tone =
    s.coverageState === "on_plan" ? "green" : s.coverageState === "degraded" ? "amber" : "gray";
  const next =
    s.status === "active" && s.nextDueAt !== null
      ? tr(lang, "fu.sched.next", { time: shortTime(s.nextDueAt, now, lang) })
      : s.status === "ended" || s.status === "cancelled"
        ? reasonText(lang, s.stopReason)
        : s.status === "blocked"
          ? s.blockReasons
              .map((r) =>
                r.ref?.startsWith("host_capability")
                  ? tr(lang, "fu.block.host_capability")
                  : tr(lang, "fu.block.prerequisite_missing"),
              )
              .join(lang === "en" ? "; " : "；")
          : tr(lang, "fu.sched.nextNone");
  const noteText = coverageNoteText(lang, s.coverageNote);
  const note = noteText ? esc(noteText) : "";
  const history = marker("fu-history", s.id, "nx-btn", esc(tr(lang, "fu.btn.history")));
  const actions =
    !withActions || wrapping
      ? ""
      : s.status === "active"
        ? marker("fu-check", s.id, "nx-btn", esc(tr(lang, "fu.btn.check"))) +
          marker("fu-pause", s.id, "nx-btn", esc(tr(lang, "fu.btn.pause"))) +
          marker("fu-stop", s.id, "nx-btn nx-danger", esc(tr(lang, "fu.btn.stop")))
        : s.status === "paused"
          ? (s.pauseSource === "work_control"
              ? ""
              : marker("fu-resume", s.id, "nx-btn", esc(tr(lang, "fu.btn.resume")))) +
            marker("fu-stop", s.id, "nx-btn nx-danger", esc(tr(lang, "fu.btn.stop")))
          : s.status === "blocked"
            ? marker("fu-stop", s.id, "nx-btn nx-danger", esc(tr(lang, "fu.btn.stop")))
            : restorable &&
                (s.status === "ended" || s.status === "cancelled") &&
                s.stopReason !== "plan_replaced" &&
                s.stopReason !== "work_deleted"
              ? marker("fu-restore", s.id, "nx-btn", esc(tr(lang, "fu.btn.restore")))
              : "";
  const buttons = actions + history;
  const recent = triggers.slice(0, 3);
  return (
    `<div class="nx-fu-s"><div class="nx-cm-h"><span class="nx-cm-t">${esc(clip(s.purpose, 160))}</span>` +
    `${wrapping && isLive(s) ? chip("amber", tr(lang, "fu.sched.wrapping")) : scheduleChip(lang, s)}${isLive(s) ? chip(covTone, tr(lang, key("fu.cov.", s.coverageState))) : ""}</div>` +
    `<div class="nx-cm-m"><span>${esc(cadenceText(lang, s.cadence, now))}</span><span>·</span><span>${esc(next)}</span>${note ? `<span>·</span><span>${note}</span>` : ""}</div>` +
    recentLines(lang, recent, now) +
    (buttons ? `<div class="nx-cm-a">${buttons}</div>` : "") +
    `</div>`
  );
}

function planState(lang: Lang, plan: DelegationPlanRecord, live: readonly ScheduleRecord[]) {
  if (plan.status === "draft") {
    return chip("amber", tr(lang, "fu.plan.draft"));
  }
  if (plan.status === "ended" || plan.status === "revoked") {
    const why = reasonText(lang, plan.endReason);
    return chip(
      "gray",
      why ? tr(lang, "fu.plan.endedWhy", { reason: why }) : tr(lang, "fu.plan.ended"),
    );
  }
  if (plan.status === "accepted" && plan.endRequestedAt !== null) {
    return chip(
      "amber",
      tr(lang, "fu.plan.wrapping", { reason: reasonText(lang, plan.endReason) }),
    );
  }
  if (live.some((s) => s.status === "active")) {
    return chip("green", tr(lang, "fu.plan.running"));
  }
  if (live.some((s) => s.status === "blocked")) {
    return chip("rose", tr(lang, "fu.plan.blocked"));
  }
  return live.length > 0
    ? chip("blue", tr(lang, "fu.plan.paused"))
    : chip("gray", tr(lang, "fu.plan.idle"));
}

function planBox(
  lang: Lang,
  plan: DelegationPlanRecord,
  data: FollowUpData,
  now: number,
  withActions: boolean,
): string {
  const wrapping = plan.status === "accepted" && plan.endRequestedAt !== null;
  const own = data.schedules.filter((s) => s.planId === plan.id);
  const live = own.filter(isLive);
  const body = plan.plan;
  const none = tr(lang, "fu.none");
  const join = (items: readonly string[] | undefined) =>
    items && items.length > 0 ? items.join(lang === "en" ? "; " : "；") : none;
  const draftCadence = (body.schedules ?? [])
    .map((spec) => {
      const c = spec.cadence as Cadence | undefined;
      const text = c && typeof c === "object" && "kind" in c ? cadenceText(lang, c, now) : "";
      return text !== "" && stopsAtFirstChange(spec.stop)
        ? `${text}（${tr(lang, "fu.cad.stopOnChange")}）`
        : text;
    })
    .filter((text) => text !== "");
  const often = body.frequencyText ?? (draftCadence.length > 0 ? draftCadence.join("；") : none);
  // Each check may name its own sources. Show them per check; a plan with no per-check sources keeps
  // the single shared line exactly as before (drafts from body.schedules, accepted from schedules).
  const lookText = (): string => {
    const effective = (specSources?: string[], savedSources?: string[]): string[] => {
      const ownSources = savedSources ?? (Array.isArray(specSources) ? specSources : []);
      return ownSources.length > 0 ? ownSources : (body.sources ?? []);
    };
    const checks =
      plan.status === "accepted" && own.length > 0
        ? own.map((s) => ({ purpose: s.purpose, sources: effective(undefined, s.sources) }))
        : (body.schedules ?? []).map((spec) => ({
            purpose: spec.purpose,
            sources: effective(spec.sources),
          }));
    if (checks.every((c) => c.sources.length === 0)) {
      return esc(join(body.sources));
    }
    const hasOwn = checks.some((_, index) =>
      plan.status === "accepted" && own.length > 0
        ? own[index]!.sources.length > 0
        : Array.isArray(body.schedules?.[index]?.sources) &&
          (body.schedules?.[index]?.sources?.length ?? 0) > 0,
    );
    if (!hasOwn) {
      return esc(join(body.sources));
    }
    return checks.map((c) => `${esc(c.purpose)}: ${esc(join(c.sources))}`).join("<br>");
  };
  const facts = kv([
    [tr(lang, "fu.k.look"), lookText()],
    [tr(lang, "fu.k.often"), esc(often)],
    [tr(lang, "fu.k.until"), esc(stopText(lang, body, now, plan.planOwnerType))],
    [tr(lang, "fu.k.notify"), esc(body.notifyText ?? tr(lang, "fu.notifyNone"))],
    [tr(lang, "fu.k.wont"), esc(join(body.wontDo))],
    ...(body.limits && body.limits.length > 0
      ? ([[tr(lang, "fu.k.limits"), esc(join(body.limits))]] as const)
      : []),
  ]);
  const schedules =
    plan.status === "accepted" || plan.status === "ended"
      ? own
          .toSorted((a, b) => Number(isLive(b)) - Number(isLive(a)))
          .filter((s) => plan.status === "accepted" || isLive(s))
          .map((s) =>
            scheduleRow(
              lang,
              s,
              data.triggers[s.id] ?? [],
              now,
              withActions,
              wrapping,
              plan.status === "accepted",
            ),
          )
          .join("")
      : "";
  // A plan that ended keeps its checks' records: one line per check, with the way to read them all.
  const pastChecks =
    plan.status === "ended" && schedules === ""
      ? own
          .map(
            (s) =>
              `<div class="nx-fu-s"><div class="nx-cm-h"><span class="nx-cm-t">${esc(clip(s.purpose, 160))}</span></div>` +
              recentLines(lang, (data.triggers[s.id] ?? []).slice(0, 3), now) +
              `<div class="nx-cm-a">${marker("fu-history", s.id, "nx-btn", esc(tr(lang, "fu.btn.history")))}</div></div>`,
          )
          .join("")
      : "";
  const buttons = !withActions
    ? ""
    : plan.status === "draft"
      ? marker("fu-start", plan.id, "nx-btn nx-primary", esc(tr(lang, "fu.btn.start"))) +
        marker("fu-edit", plan.id, "nx-btn", esc(tr(lang, "fu.btn.edit"))) +
        marker("fu-skip", plan.id, "nx-btn", esc(tr(lang, "fu.btn.skip")))
      : plan.status === "accepted" && !wrapping
        ? marker("fu-edit", plan.id, "nx-btn", esc(tr(lang, "fu.btn.edit"))) +
          marker("fu-end", plan.id, "nx-btn nx-danger", esc(tr(lang, "fu.btn.end")))
        : plan.status === "ended" &&
            !data.plans.some((p) => p.status === "draft" || p.status === "accepted")
          ? // An ended plan can be brought back: its words and checks open as a new plan that the user confirms.
            marker("fu-reopen", plan.id, "nx-btn", esc(tr(lang, "fu.btn.reopen")))
          : "";
  return (
    `<div class="nx-cm nx-li nx-fu-plan${plan.status === "ended" ? " nx-cm-closed" : ""}">` +
    `<div class="nx-cm-h"><span class="nx-cm-t">${esc(clip(plan.purpose, 200))}</span>${planState(lang, plan, live)}</div>` +
    facts +
    // The plan's own buttons (edit / end the plan) sit with the plan, above its checks: the checks have their own buttons below.
    (buttons ? `<div class="nx-cm-a">${buttons}</div>` : "") +
    (schedules !== "" ? `<p class="nx-cm-hint">${esc(tr(lang, "fu.checks.title"))}</p>` : "") +
    schedules +
    pastChecks +
    `</div>`
  );
}

/** The section, or an empty string when follow-up is not available (`data` undefined). */
export function renderFollowSection(
  data: FollowUpData | undefined,
  options: { lang: Lang; now: number; workId: string; withActions: boolean },
): string {
  if (data === undefined) {
    return "";
  }
  const { lang, now, withActions, workId } = options;
  const shown = data.plans.filter((p) => p.status !== "revoked");
  const current = shown.filter((p) => p.status === "draft" || p.status === "accepted");
  const past = shown
    .filter((p) => p.status === "ended")
    .toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, 2);
  const add = withActions ? marker("fu-new", workId, "nx-btn", esc(tr(lang, "fu.new"))) : "";
  const hostOff = data.dispatchReady
    ? ""
    : callout("amber", `<p>${esc(tr(lang, "fu.hostOff"))}</p>`);
  if (current.length === 0 && past.length === 0) {
    return section(
      tr(lang, "fu.sec"),
      [`<p class="nx-wempty">${esc(tr(lang, "fu.empty"))}</p>`, hostOff],
      add,
    );
  }
  return section(
    tr(lang, "fu.sec"),
    [
      hostOff,
      ...current.map((p) => planBox(lang, p, data, now, withActions)),
      // Earlier plans are folded away; opening the fold shows them (a closed <details> keeps its content out of sight).
      ...(past.length > 0
        ? [
            `<details class="nx-fu-past"><summary>${esc(tr(lang, "fu.sec.history", { n: past.length }))}</summary>` +
              past.map((p) => planBox(lang, p, data, now, withActions)).join("") +
              `</details>`,
          ]
        : []),
    ],
    add,
  );
}
