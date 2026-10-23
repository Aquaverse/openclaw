// The write side of the Nexus page: decisions, watch cancellation and preferences. Every action opens a confirmation
// dialog built from the records the page itself loaded (never from the clicked markup, which only carries an id), then
// calls the existing operator.write RPC. The RPCs stay the authority: they re-check status, revision and authority hash,
// so a stale dialog can at worst be refused, never wrongly applied.
import { DEFAULT_LANG, tr, type Lang } from "../src/i18n.js";
import type { EvidenceBlobView } from "../src/store/blob-types.js";
import type { DecisionRecord } from "../src/store/decision-types.js";
import type { PreferenceRecord } from "../src/store/preference-types.js";
import {
  isValidPreferenceKey,
  isValidPreferenceScope,
  MAX_PREFERENCE_VALUE_BYTES,
} from "../src/store/preference-types.js";
import type { VaultFileRecord } from "../src/store/vault-types.js";
import type { WatchRecord } from "../src/store/watch-types.js";
import { clip, fmtTime } from "../src/ui-render.js";
import type { NexusRequest } from "./data.ts";
import { openDialog, type DialogAction } from "./dialog.ts";
import { evidenceViewDialog } from "./evidence-view.ts";
import { fileDetailDialog, fileImportDialog, fileUploadDialog } from "./files-view.ts";
import type { NexusAction } from "./sanitize.ts";

export type NexusModel = {
  decisions: readonly DecisionRecord[];
  watches: readonly WatchRecord[];
  preferences: readonly PreferenceRecord[];
  evidence: readonly EvidenceBlobView[];
  /** The files the Files tab rendered; absent on every other tab. */
  files?: readonly VaultFileRecord[];
};

export const EMPTY_MODEL: NexusModel = {
  decisions: [],
  watches: [],
  preferences: [],
  evidence: [],
};

export type ActionNotice = { ok: boolean; text: string };

export type ActionContext = {
  request: NexusRequest;
  parent: HTMLElement;
  signal: AbortSignal;
  redact: (text: string) => string;
  /** Dialog and notice language; follows the host's locale. */
  lang: Lang;
  /** False when the connection is read-only: dialogs then show details but offer no change. */
  canWrite?: boolean;
  model: () => NexusModel;
  /** Something changed (or turned out to be stale): show the notice and reload. */
  changed: (notice: ActionNotice) => void;
};

function row(body: HTMLElement, label: string, text: string, mono = false): void {
  const line = document.createElement("div");
  line.className = "nx-row";
  const name = document.createElement("span");
  name.className = "nx-label";
  name.textContent = label;
  const value = document.createElement(mono ? "pre" : "span");
  value.className = "nx-value";
  value.textContent = text;
  line.append(name, value);
  body.append(line);
}

function note(body: HTMLElement, text: string): HTMLElement {
  const paragraph = document.createElement("p");
  paragraph.className = "muted";
  paragraph.textContent = text;
  body.append(paragraph);
  return paragraph;
}

const json = (value: unknown, max: number) => clip(JSON.stringify(value, null, 1) ?? "null", max);

/** "R2" and "R3" need a second, explicit confirmation; R0/R1 do not. */
export function needsSecondConfirmation(riskTier: string): boolean {
  const tier = /^R(\d+)$/.exec(riskTier)?.[1];
  return tier === undefined ? true : Number(tier) >= 2;
}

export type ResolveReply = {
  outcome?: string;
  executionId?: string | null;
  reason?: string;
  message?: string;
};

/** How a resolve reply should be shown: done, stale (close and reload), or an error that keeps the dialog open. */
export function describeResolve(
  reply: ResolveReply,
  decisionId: string,
  lang: Lang = DEFAULT_LANG,
): { kind: "done" | "stale" | "error"; text: string } {
  const id = decisionId;
  switch (reply.outcome) {
    case "approved":
      return {
        kind: "done",
        text: reply.executionId
          ? tr(lang, "resolve.approvedReady", { id, exec: reply.executionId })
          : tr(lang, "resolve.approved", { id }),
      };
    case "denied":
      return { kind: "done", text: tr(lang, "resolve.denied", { id }) };
    case "already_resolved":
      return { kind: "stale", text: tr(lang, "resolve.already", { id }) };
    case "superseded":
      return {
        kind: "stale",
        text: tr(lang, "resolve.superseded", {
          id,
          reason: reply.reason ?? tr(lang, "resolve.supersededReason"),
        }),
      };
    case "expired":
      return { kind: "stale", text: tr(lang, "resolve.expired", { id }) };
    case "effect_unsupported":
      return { kind: "error", text: tr(lang, "resolve.unsupported") };
    case "effect_apply_failed":
      return {
        kind: "error",
        text: tr(lang, "resolve.applyFailed", {
          message: reply.message ?? tr(lang, "resolve.applyFailedMessage"),
        }),
      };
    default:
      return {
        kind: "error",
        text: tr(lang, "resolve.unexpected", {
          outcome: reply.outcome ?? tr(lang, "resolve.none"),
        }),
      };
  }
}

function decisionDialog(ctx: ActionContext, id: string): void {
  const decision = ctx
    .model()
    .decisions.find((item) => item.id === id && item.status === "pending");
  if (!decision) {
    ctx.changed({ ok: false, text: tr(ctx.lang, "decision.gone", { id }) });
    return;
  }
  const high = needsSecondConfirmation(decision.riskTier);
  const multiple = decision.actionIds.length > 1;
  let chosen = decision.actionIds.length === 1 ? (decision.actionIds[0] ?? "") : "";
  let acknowledged = false;
  const resolve = async (resolution: "approved" | "denied") => {
    const reply = await ctx.request<ResolveReply>("nexus.decision.resolve", {
      decisionId: decision.id,
      resolution,
      ...(resolution === "approved" && chosen ? { chosenActionId: chosen } : {}),
    });
    const shown = describeResolve(reply, decision.id, ctx.lang);
    if (shown.kind === "error") {
      throw new Error(shown.text);
    }
    ctx.changed({ ok: shown.kind === "done", text: shown.text });
  };
  const actions: DialogAction[] = [
    {
      label: tr(ctx.lang, "dlg.approve"),
      tone: "primary",
      enabled: () => (!multiple || chosen !== "") && (!high || acknowledged),
      run: () => resolve("approved"),
    },
    { label: tr(ctx.lang, "dlg.deny"), tone: "danger", run: () => resolve("denied") },
  ];
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "decision.title", { id: decision.id }),
    actions,
    build: (body, changed) => {
      row(body, tr(ctx.lang, "dlg.task"), decision.taskId);
      row(body, tr(ctx.lang, "dlg.question"), decision.question);
      row(body, tr(ctx.lang, "dlg.type"), decision.effectKind);
      row(body, tr(ctx.lang, "dlg.risk"), decision.riskTier);
      row(body, tr(ctx.lang, "dlg.deadline"), fmtTime(decision.deadlineAt));
      if (decision.facts !== null && decision.facts !== undefined) {
        row(body, tr(ctx.lang, "dlg.facts"), json(decision.facts, 800), true);
      }
      if (decision.options !== null && decision.options !== undefined) {
        row(body, tr(ctx.lang, "dlg.options"), json(decision.options, 800), true);
      }
      if (multiple) {
        const line = document.createElement("div");
        line.className = "nx-row";
        const label = document.createElement("span");
        label.className = "nx-label";
        label.textContent = tr(ctx.lang, "decision.which");
        const select = document.createElement("select");
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = tr(ctx.lang, "decision.choose");
        select.append(blank);
        for (const actionId of decision.actionIds) {
          const option = document.createElement("option");
          option.value = actionId;
          option.textContent = actionId;
          select.append(option);
        }
        select.addEventListener("change", () => {
          chosen = select.value;
          changed();
        });
        line.append(label, select);
        body.append(line);
      }
      if (high) {
        const line = document.createElement("label");
        line.className = "nx-row nx-check";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.addEventListener("change", () => {
          acknowledged = box.checked;
          changed();
        });
        const text = document.createElement("span");
        text.textContent = tr(ctx.lang, "decision.ack", { risk: decision.riskTier });
        line.append(box, text);
        body.append(line);
      }
      note(body, tr(ctx.lang, "decision.warn"));
    },
  });
}

function watchDialog(ctx: ActionContext, id: string): void {
  const watch = ctx.model().watches.find((item) => item.id === id);
  if (!watch) {
    ctx.changed({ ok: false, text: tr(ctx.lang, "watch.gone", { id }) });
    return;
  }
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "watch.title", { id: watch.id }),
    actions: [
      {
        label: tr(ctx.lang, "watch.cancel"),
        tone: "danger",
        run: async () => {
          await ctx.request("nexus.watch.cancel", { watchId: watch.id });
          ctx.changed({ ok: true, text: tr(ctx.lang, "watch.cancelled", { id: watch.id }) });
        },
      },
    ],
    build: (body) => {
      row(body, tr(ctx.lang, "dlg.task"), watch.taskId);
      row(body, tr(ctx.lang, "dlg.condition"), clip(watch.expect, 300));
      row(
        body,
        tr(ctx.lang, "dlg.status"),
        tr(ctx.lang, "watch.state", {
          status: watch.status,
          attempts: watch.attempts,
          max: watch.maxAttempts,
        }),
      );
      note(body, tr(ctx.lang, "watch.note"));
    },
  });
}

function preferenceDeleteDialog(ctx: ActionContext, id: string): void {
  const preference = ctx.model().preferences.find((item) => item.id === id);
  if (!preference) {
    ctx.changed({ ok: false, text: tr(ctx.lang, "pref.gone", { id }) });
    return;
  }
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, "pref.deleteTitle"),
    actions: [
      {
        label: tr(ctx.lang, "btn.delete"),
        tone: "danger",
        run: async () => {
          await ctx.request("nexus.preference.delete", { preferenceId: preference.id });
          ctx.changed({
            ok: true,
            text: tr(ctx.lang, "pref.deleted", { scope: preference.scope, key: preference.key }),
          });
        },
      },
    ],
    build: (body) => {
      row(body, tr(ctx.lang, "dlg.scope"), preference.scope);
      row(body, tr(ctx.lang, "dlg.key"), preference.key);
      row(body, tr(ctx.lang, "dlg.value"), json(preference.value, 400), true);
      row(body, tr(ctx.lang, "dlg.source"), preference.origin);
      note(body, tr(ctx.lang, "pref.deleteNote"));
    },
  });
}

export type PreferenceDraft =
  | { ok: true; scope: string; key: string; value: unknown }
  | { ok: false; message: string };

/** Pure validation behind the preference form; the RPC validates again. */
export function validatePreferenceDraft(
  scope: string,
  key: string,
  rawValue: string,
  lang: Lang = DEFAULT_LANG,
): PreferenceDraft {
  if (!isValidPreferenceScope(scope)) {
    return { ok: false, message: tr(lang, "pref.badScope") };
  }
  if (!isValidPreferenceKey(key)) {
    return { ok: false, message: tr(lang, "pref.badKey") };
  }
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    return { ok: false, message: tr(lang, "pref.badJson") };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > MAX_PREFERENCE_VALUE_BYTES) {
    return {
      ok: false,
      message: tr(lang, "pref.tooLong", { bytes, max: MAX_PREFERENCE_VALUE_BYTES }),
    };
  }
  return { ok: true, scope, key, value };
}

function preferenceFormDialog(ctx: ActionContext, existing: PreferenceRecord | undefined): void {
  let scope = existing?.scope ?? "global";
  let key = existing?.key ?? "";
  let raw = existing ? (JSON.stringify(existing.value, null, 2) ?? "null") : "";
  const draft = () => validatePreferenceDraft(scope, key, raw, ctx.lang);
  let hint: HTMLElement | undefined;
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    cancelLabel: tr(ctx.lang, "btn.cancel"),
    title: tr(ctx.lang, existing ? "pref.editTitle" : "pref.newTitle"),
    actions: [
      {
        label: tr(ctx.lang, "dlg.save"),
        tone: "primary",
        enabled: () => draft().ok,
        run: async () => {
          const checked = draft();
          if (!checked.ok) {
            throw new Error(checked.message);
          }
          const reply = await ctx.request<{ outcome?: string }>("nexus.preference.set", {
            scope: checked.scope,
            key: checked.key,
            value: checked.value,
          });
          ctx.changed({
            ok: true,
            text:
              reply.outcome === "unchanged"
                ? tr(ctx.lang, "pref.unchanged")
                : tr(ctx.lang, "pref.saved", {
                    scope: checked.scope,
                    key: checked.key,
                    outcome: reply.outcome ?? "ok",
                  }),
          });
        },
      },
    ],
    build: (body, changed) => {
      const field = (label: string, input: HTMLInputElement | HTMLTextAreaElement) => {
        const line = document.createElement("label");
        line.className = "nx-row";
        const name = document.createElement("span");
        name.className = "nx-label";
        name.textContent = label;
        line.append(name, input);
        body.append(line);
      };
      // Machine identifiers and JSON: the OS must not capitalise ("hi" -> "Hi"), autocorrect or spell-check them.
      const plainText = <T extends HTMLInputElement | HTMLTextAreaElement>(el: T): T => {
        el.setAttribute("autocapitalize", "off");
        el.setAttribute("autocorrect", "off");
        el.setAttribute("autocomplete", "off");
        el.setAttribute("spellcheck", "false");
        return el;
      };
      const scopeInput = plainText(document.createElement("input"));
      scopeInput.value = scope;
      scopeInput.readOnly = existing !== undefined;
      scopeInput.addEventListener("input", () => {
        scope = scopeInput.value.trim();
        sync();
        changed();
      });
      const keyInput = plainText(document.createElement("input"));
      keyInput.value = key;
      keyInput.readOnly = existing !== undefined;
      keyInput.addEventListener("input", () => {
        key = keyInput.value.trim();
        sync();
        changed();
      });
      const valueInput = plainText(document.createElement("textarea"));
      valueInput.rows = 6;
      valueInput.value = raw;
      valueInput.placeholder = tr(ctx.lang, "pref.placeholder");
      valueInput.addEventListener("input", () => {
        raw = valueInput.value;
        sync();
        changed();
      });
      field(tr(ctx.lang, "dlg.scope"), scopeInput);
      field(tr(ctx.lang, "dlg.key"), keyInput);
      field(tr(ctx.lang, "pref.valueJson"), valueInput);
      hint = note(body, "");
      note(body, tr(ctx.lang, "pref.statedNote"));
      function sync() {
        const checked = draft();
        if (hint) {
          hint.textContent = checked.ok ? "" : checked.message;
        }
      }
      sync();
    },
  });
}

export function runAction(ctx: ActionContext, action: NexusAction): void {
  switch (action.kind) {
    case "evidence-view":
      return evidenceViewDialog(ctx, action.id);
    case "file-new":
      return fileUploadDialog(ctx);
    case "file-import":
      return fileImportDialog(ctx);
    case "file-open":
      return fileDetailDialog(ctx, action.id);
    case "decision":
      return decisionDialog(ctx, action.id);
    case "watch-cancel":
      return watchDialog(ctx, action.id);
    case "pref-delete":
      return preferenceDeleteDialog(ctx, action.id);
    case "pref-new":
      return preferenceFormDialog(ctx, undefined);
    case "pref-edit": {
      const existing = ctx.model().preferences.find((item) => item.id === action.id);
      if (!existing || existing.origin !== "stated") {
        ctx.changed({ ok: false, text: tr(ctx.lang, "pref.onlyStated") });
        return;
      }
      return preferenceFormDialog(ctx, existing);
    }
  }
}
