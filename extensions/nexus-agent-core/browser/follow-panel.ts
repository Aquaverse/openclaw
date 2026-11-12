// The review panel of the people page (design 9.5): "keep following up" and "remind" on one commitment. The panel first finds which
// Work would carry the follow-up (nothing is created for that), then shows what the user is asked to confirm. Only the confirm button
// writes, and it does so in one step on the server (the carrier Work, the link, the plan and its acceptance together, or nothing). A
// commitment that already has a plan only points to it: there is never a second one. A reminder only prepares a draft; there is no
// outgoing channel here, so nothing is sent and the draft says so.
import type { CommitmentLine } from "../src/commitment-ui.js";
import { tr, type Lang } from "../src/i18n.js";
import type { ActionContext } from "./actions.ts";
import { block, impactList, newRequestId, select, text, textInput } from "./commitment-form.ts";
import { openDialog } from "./dialog.ts";
import { describeFollowError } from "./follow-dialogs.ts";
import { buildPlanFields, emptyForm, formProblem, toPlan } from "./follow-form.ts";
import { el, field } from "./goal-dom.ts";

type Carrier =
  | { kind: "active" | "paused"; workId: string; planId: string; planVersion: number }
  | { kind: "unique"; workId: string }
  | { kind: "multi"; candidates: { workId: string; title: string }[] }
  | { kind: "none" }
  | { kind: "replace"; oldPlanId: string };

const NEW = "";
const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

async function workTitle(ctx: ActionContext, workId: string): Promise<string> {
  try {
    const got = await ctx.request<{ work?: { title?: string } }>("nexus.work.get", { workId });
    return got.work?.title ?? workId;
  } catch {
    return workId;
  }
}

function followPanel(ctx: ActionContext, line: CommitmentLine): void {
  const lang = ctx.lang;
  const c = line.commitment;
  const name = c.responsibleName ?? c.responsibleRaw ?? "-";
  const label = clip(c.requirementText, 60);
  const form = emptyForm(lang, tr(lang, "fp.purpose", { name, text: label }));
  const requestRef = newRequestId();
  let carrier: Carrier | undefined;
  let workChoice = NEW;
  let newTitle = clip(tr(lang, "fp.purpose", { name, text: label }), 120);
  let ready = false;
  const creatable = () => carrier !== undefined && !["active", "paused"].includes(carrier.kind);
  const problem = () =>
    formProblem(form) ??
    (workChoice === NEW && carrier?.kind !== "unique" && newTitle.trim() === ""
      ? "fu.f.err.purpose"
      : null);
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "fp.follow.title", { text: label }),
    actions: [
      {
        label: tr(lang, "fp.confirm"),
        tone: "primary",
        enabled: () => ready && creatable() && problem() === null,
        run: async () => {
          if (!carrier || !creatable()) {
            return;
          }
          const made = toPlan(lang, form);
          const chosen = carrier.kind === "unique" ? carrier.workId : workChoice;
          try {
            const reply = await ctx.request<{
              outcome?: string;
              workId?: string;
              workCreated?: boolean;
            }>("nexus.delegation.followStart", {
              commitmentId: c.id,
              expectedKind: carrier.kind,
              ...(chosen !== NEW ? { workId: chosen } : { newWorkTitle: newTitle.trim() }),
              purpose: made.purpose,
              plan: made.plan,
              startIntent: made.startIntent,
              requestRef,
            });
            const title =
              chosen !== NEW ? await workTitle(ctx, reply.workId ?? chosen) : newTitle.trim();
            ctx.changed({
              ok: true,
              text: tr(lang, reply.workCreated ? "fp.notice.startedNew" : "fp.notice.started", {
                title,
              }),
            });
          } catch (error) {
            const t = text(error);
            if (t.includes("plan exists") || t.includes("plan_exists")) {
              ctx.changed({ ok: false, text: tr(lang, "fp.err.exists") });
              return;
            }
            if (t.includes("carrier changed") || t.includes("work not candidate")) {
              ctx.changed({ ok: false, text: tr(lang, "fp.err.changed") });
              return;
            }
            if (t.includes("commitment closed")) {
              throw new Error(tr(lang, "fp.err.closed"), { cause: error });
            }
            throw new Error(describeFollowError(lang, error), { cause: error });
          }
        },
      },
    ],
    build: (body, changed) => {
      const status = el("p", "muted", tr(lang, "fp.loading"));
      const slot = el("div");
      const err = el("p", "error");
      err.hidden = true;
      body.append(status, slot, err);
      const recheck = () => {
        const bad = ready ? problem() : "fp.err.pick";
        const show = bad !== null && (!ready || form.purpose !== "");
        err.textContent = show ? tr(lang, bad as never) : "";
        err.hidden = !show;
        changed();
      };
      void ctx
        .request<{ carrier?: Carrier }>("nexus.delegation.carrier", { commitmentId: c.id })
        .then(async (reply) => {
          carrier = reply.carrier;
          status.remove();
          if (!carrier) {
            slot.append(el("p", "error", tr(lang, "fu.err.gone")));
            return;
          }
          if (carrier.kind === "active" || carrier.kind === "paused") {
            const title = await workTitle(ctx, carrier.workId);
            slot.append(
              el(
                "p",
                "",
                tr(lang, carrier.kind === "active" ? "fp.carrier.active" : "fp.carrier.paused", {
                  title,
                }),
              ),
            );
            changed();
            return;
          }
          slot.append(el("p", "muted", tr(lang, "fp.review")));
          const titleRow = field(
            tr(lang, "fp.newTitle"),
            textInput(newTitle, 300, (v) => {
              newTitle = v;
              recheck();
            }),
          );
          if (carrier.kind === "unique") {
            slot.append(
              el(
                "p",
                "",
                tr(lang, "fp.carrier.unique", { title: await workTitle(ctx, carrier.workId) }),
              ),
            );
          } else if (carrier.kind === "multi") {
            slot.append(el("p", "", tr(lang, "fp.carrier.multi")));
            // Never preselected by recency or list order: the user picks, or asks for a new work.
            const picker = select(
              [
                ["—", "__none__"],
                ...carrier.candidates.map(
                  (entry) => [entry.title, entry.workId] as [string, string],
                ),
                [tr(lang, "fp.pickNew"), NEW],
              ],
              "__none__",
              (v) => {
                workChoice = v;
                ready = v !== "__none__";
                titleRow.hidden = v !== NEW;
                recheck();
              },
            );
            picker.style.margin = "6px 0 14px";
            slot.append(picker);
            workChoice = "__none__";
          } else {
            slot.append(
              el(
                "p",
                "",
                tr(lang, carrier.kind === "none" ? "fp.carrier.none" : "fp.carrier.replace"),
              ),
            );
          }
          titleRow.hidden = carrier.kind === "unique" || carrier.kind === "multi";
          slot.append(titleRow);
          ready = carrier.kind !== "multi";
          buildPlanFields(lang, slot, form, recheck);
          slot.append(el("p", "muted", tr(lang, "fp.dont")));
          recheck();
        })
        .catch((error: unknown) => {
          status.textContent = describeFollowError(lang, error);
        });
    },
  });
}

/** The words of the draft: it asks to confirm when the other person has not accepted, and never says "overdue" then. */
export function nudgeDraft(lang: Lang, line: CommitmentLine, name: string): string {
  const c = line.commitment;
  const due =
    c.dueState === "known" && c.dueAt
      ? tr(lang, "fp.nudge.d.due", { time: new Date(c.dueAt).toLocaleString() })
      : "";
  return tr(lang, c.acceptanceState === "accepted" ? "fp.nudge.d.accepted" : "fp.nudge.d.pending", {
    name,
    text: clip(c.requirementText, 80),
    due,
  });
}

function nudgePanel(ctx: ActionContext, line: CommitmentLine): void {
  const lang = ctx.lang;
  const c = line.commitment;
  const person = ctx.model().person;
  const name = c.responsibleName ?? c.responsibleRaw ?? "-";
  let draft = nudgeDraft(lang, line, name);
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(lang, "btn.cancel"),
    title: tr(lang, "fp.nudge.title", { text: clip(c.requirementText, 60) }),
    actions: [
      {
        label: tr(lang, "fp.nudge.copy"),
        tone: "primary",
        enabled: () => draft.trim() !== "",
        run: async () => {
          try {
            await navigator.clipboard.writeText(draft);
          } catch (error) {
            throw new Error(tr(lang, "fp.nudge.copyFail"), { cause: error });
          }
          ctx.changed({ ok: true, text: tr(lang, "fp.nudge.copied") });
        },
      },
    ],
    build: (body, changed) => {
      body.append(el("p", "muted", tr(lang, "fp.nudge.note")));
      const checks = el("div");
      body.append(block(tr(lang, "fp.nudge.checks"), checks));
      const textBox = el("textarea");
      textBox.rows = 5;
      textBox.maxLength = 1000;
      textBox.value = draft;
      textBox.addEventListener("input", () => {
        draft = textBox.value;
        changed();
      });
      body.append(field(tr(lang, "fp.nudge.draft"), textBox));
      // The checks are read from the server now, not from the clicked markup.
      void ctx
        .request<{
          commitment?: {
            lifecycle: string;
            responsibleCounterpartId: string | null;
            responsibilityVersion: number;
          };
        }>("nexus.commitment.get", { commitmentId: c.id })
        .then((reply) => {
          const live = reply.commitment;
          const items: { tone: "keep" | "stop" | "note"; text: string }[] = [];
          const open = live?.lifecycle === "open" || live?.lifecycle === "waiting";
          items.push({
            tone: open ? "keep" : "stop",
            text: tr(lang, open ? "fp.nudge.c.open" : "fp.nudge.c.closed"),
          });
          const same =
            live !== undefined &&
            person !== undefined &&
            live.responsibleCounterpartId === person.id;
          items.push({
            tone: same ? "keep" : "stop",
            text: same
              ? tr(lang, "fp.nudge.c.who", {
                  name,
                  version: String(live?.responsibilityVersion ?? 1),
                })
              : tr(lang, "fp.nudge.c.whoNot", { name }),
          });
          const contact = person?.contacts[0];
          items.push({
            tone: contact ? "keep" : "stop",
            text: contact
              ? tr(lang, "fp.nudge.c.contact", { name, label: `${contact.label} ${contact.value}` })
              : tr(lang, "fp.nudge.c.noContact", { name }),
          });
          if (contact) {
            items.push({ tone: "note", text: tr(lang, "fp.nudge.c.unverified") });
          }
          if (c.acceptanceState !== "accepted") {
            items.push({ tone: "note", text: tr(lang, "fp.nudge.c.pending") });
          }
          checks.replaceChildren(impactList(items));
        })
        .catch((error: unknown) => {
          checks.replaceChildren(el("p", "error", describeFollowError(lang, error)));
        });
    },
  });
}

export function runFollowPanel(
  ctx: ActionContext,
  kind: "cm-follow" | "cm-nudge",
  commitmentId: string,
): void {
  const line = ctx.model().commitments?.find((entry) => entry.commitment.id === commitmentId);
  if (!line || (line.commitment.lifecycle !== "open" && line.commitment.lifecycle !== "waiting")) {
    ctx.changed({ ok: false, text: tr(ctx.lang, "fu.err.gone") });
    return;
  }
  return kind === "cm-follow" ? followPanel(ctx, line) : nudgePanel(ctx, line);
}
