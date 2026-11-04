// The "Commitments" block of the Work detail (design 11.3): one box per commitment the Work cites, required ones first. Plain
// functions that return an HTML string for the Control UI sanitiser: every clickable thing is a `<button data-nx-act data-nx-id>`
// marker, every value goes through `esc`, and every text is a catalog key. The four lines are said apart on purpose: told,
// agreed, closed, verified. A hand close is never called "verified".
import type { CommitmentRecord } from "./commitment/types.js";
import { tr, type Lang, type MsgKey } from "./i18n.js";
import { chip, marker, section, shortTime, type Tone } from "./ui-kit.js";
import { clip, esc } from "./ui-render.js";

/** One commitment as the Work page sees it: the record and how THIS Work cites it. */
export type CommitmentLine = {
  commitment: CommitmentRecord;
  role: "required" | "reference" | null;
  linkId: string | null;
};

const stateChip = (lang: Lang, c: CommitmentRecord): string => {
  if (c.lifecycle === "resolved") {
    return c.resolutionBasis === "source_verified"
      ? chip("green", tr(lang, "cm.state.resolved.verified"))
      : chip("gray", tr(lang, "cm.state.resolved.manual"));
  }
  if (c.lifecycle === "cancelled") {
    return chip("gray", tr(lang, "cm.state.cancelled"));
  }
  const problem =
    c.verification === "verified_exception" || c.verification === "conflicting_evidence";
  const tone: Tone = problem ? "rose" : c.lifecycle === "waiting" ? "blue" : "amber";
  return chip(tone, tr(lang, c.lifecycle === "waiting" ? "cm.state.waiting" : "cm.state.open"));
};

const dueText = (lang: Lang, c: CommitmentRecord, now: number): string =>
  c.dueState === "known"
    ? tr(lang, "cm.due.known", { time: shortTime(c.dueAt, now, lang) })
    : tr(lang, c.dueState === "pending" ? "cm.due.pending" : "cm.due.none");

const acceptText = (lang: Lang, c: CommitmentRecord): string =>
  c.acceptanceState === "accepted"
    ? tr(
        lang,
        c.acceptanceBasisKind === "counterpart_source"
          ? "cm.acc.accepted.source"
          : "cm.acc.accepted.user",
      )
    : tr(lang, `cm.acc.${c.acceptanceState}` as MsgKey);

function commitmentBox(
  line: CommitmentLine,
  lang: Lang,
  now: number,
  withActions: boolean,
): string {
  const c = line.commitment;
  const open = c.lifecycle === "open" || c.lifecycle === "waiting";
  const who = c.responsibleSelf
    ? tr(lang, "cm.who.self")
    : tr(lang, "cm.who", { name: c.responsibleName ?? c.responsibleRaw ?? "-" });
  const problem =
    open && (c.verification === "verified_exception" || c.verification === "conflicting_evidence")
      ? chip("rose", tr(lang, `cm.ver.${c.verification}` as MsgKey))
      : "";
  const meta = [
    `<span>${esc(who)}</span>`,
    `<span${c.overdue ? ' class="nx-cm-late"' : ""}>${esc(dueText(lang, c, now))}</span>`,
    ...(open
      ? [
          `<span>${esc(tr(lang, `cm.comm.${c.communicationState}` as MsgKey))}</span>`,
          `<span>${esc(acceptText(lang, c))}</span>`,
        ]
      : []),
  ].join("<span>·</span>");
  const notes = [
    c.lifecycle === "resolved" && c.resolutionBasis === "manual_override" && c.resolutionReason
      ? tr(lang, "cm.note.manual", { reason: clip(c.resolutionReason, 160) })
      : "",
    c.lifecycle === "cancelled" && c.cancelReason
      ? tr(lang, "cm.note.cancelled", { reason: clip(c.cancelReason, 160) })
      : "",
    open && c.acceptanceState !== "unknown" && c.acceptanceBasis
      ? tr(lang, "cm.note.reply", {
          basis: clip(c.acceptanceBasis, 160),
          time: shortTime(c.acceptanceAt, now, lang),
        })
      : "",
    open && c.nextStep ? tr(lang, "cm.note.next", { text: clip(c.nextStep, 160) }) : "",
  ]
    .filter((text) => text !== "")
    .map((text) => `<p class="nx-cm-n">${esc(text)}</p>`)
    .join("");
  const btn = (act: string, key: MsgKey) => marker(act, c.id, "nx-btn", esc(tr(lang, key)));
  const actions = withActions
    ? [
        ...(open
          ? [
              btn("cm-comm", "cm.btn.comm"),
              btn("cm-accept", "cm.btn.accept"),
              btn("cm-edit", "cm.btn.edit"),
              btn("cm-resolve", "cm.btn.resolve"),
              btn("cm-cancel", "cm.btn.cancel"),
            ]
          : []),
        ...(c.lifecycle === "cancelled" ? [btn("cm-restore", "cm.btn.restore")] : []),
        ...(c.lifecycle === "resolved" ? [btn("cm-reopen", "cm.btn.reopen")] : []),
        ...(line.role
          ? [btn("cm-role", line.role === "required" ? "cm.btn.toReference" : "cm.btn.toRequired")]
          : []),
      ].join("")
    : "";
  return (
    `<div class="nx-cm nx-li${open ? "" : " nx-cm-closed"}">` +
    `<div class="nx-cm-h"><span class="nx-cm-t">${esc(clip(c.requirementText, 200))}</span>` +
    (line.role
      ? chip(line.role === "required" ? "blue" : "gray", tr(lang, `cm.role.${line.role}` as MsgKey))
      : "") +
    `${stateChip(lang, c)}${problem}${c.overdue ? chip("rose", tr(lang, "cm.overdue")) : ""}</div>` +
    `<div class="nx-cm-m">${meta}</div>${notes}` +
    (actions ? `<div class="nx-cm-a">${actions}</div>` : "") +
    `</div>`
  );
}

/**
 * The section, or an empty string when commitments are not available (`lines` undefined). Required commitments come first, then
 * references; open ones before closed ones inside each group (the list RPC already orders by open, then due date).
 */
export function renderCommitmentSection(
  lines: readonly CommitmentLine[] | undefined,
  options: { lang: Lang; now: number; workId: string; withActions: boolean },
): string {
  if (lines === undefined) {
    return "";
  }
  const { lang, now, withActions, workId } = options;
  const rank = (line: CommitmentLine) => (line.role === "required" ? 0 : 1);
  const ordered = lines.toSorted((a, b) => rank(a) - rank(b));
  const add = withActions ? marker("cm-new", workId, "nx-btn", esc(tr(lang, "cm.add"))) : "";
  if (ordered.length === 0) {
    return section(
      tr(lang, "cm.sec"),
      [`<p class="nx-wempty">${esc(tr(lang, "cm.empty"))}</p>`],
      add,
    );
  }
  const hint = ordered.some((line) => line.role === "required")
    ? `<p class="nx-cm-hint">${esc(tr(lang, "cm.hint"))}</p>`
    : "";
  return section(
    tr(lang, "cm.sec"),
    [...ordered.map((line) => commitmentBox(line, lang, now, withActions)), hint],
    add,
  );
}
