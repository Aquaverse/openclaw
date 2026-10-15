// The write side of the Nexus page: decisions, watch cancellation and preferences. Every action opens a confirmation
// dialog built from the records the page itself loaded (never from the clicked markup, which only carries an id), then
// calls the existing operator.write RPC. The RPCs stay the authority: they re-check status, revision and authority hash,
// so a stale dialog can at worst be refused, never wrongly applied.
import type { DecisionRecord } from "../src/store/decision-types.js";
import type { PreferenceRecord } from "../src/store/preference-types.js";
import {
  isValidPreferenceKey,
  isValidPreferenceScope,
  MAX_PREFERENCE_VALUE_BYTES,
} from "../src/store/preference-types.js";
import type { WatchRecord } from "../src/store/watch-types.js";
import { clip, fmtTime } from "../src/ui-render.js";
import type { NexusRequest } from "./data.ts";
import { openDialog, type DialogAction } from "./dialog.ts";
import type { NexusAction } from "./sanitize.ts";

export type NexusModel = {
  decisions: readonly DecisionRecord[];
  watches: readonly WatchRecord[];
  preferences: readonly PreferenceRecord[];
};

export const EMPTY_MODEL: NexusModel = { decisions: [], watches: [], preferences: [] };

export type ActionNotice = { ok: boolean; text: string };

export type ActionContext = {
  request: NexusRequest;
  parent: HTMLElement;
  signal: AbortSignal;
  redact: (text: string) => string;
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
): { kind: "done" | "stale" | "error"; text: string } {
  switch (reply.outcome) {
    case "approved":
      return {
        kind: "done",
        text: `已批准 ${decisionId}${reply.executionId ? `（执行 ${reply.executionId} 已就绪，等 Agent 提交）` : ""}。`,
      };
    case "denied":
      return { kind: "done", text: `已拒绝 ${decisionId}。` };
    case "already_resolved":
      return { kind: "stale", text: `${decisionId} 已经被处理过，没有再次改变。` };
    case "superseded":
      return {
        kind: "stale",
        text: `${decisionId} 已失效：${reply.reason ?? "事项已变化"}。请看最新的待决策。`,
      };
    case "expired":
      return { kind: "stale", text: `${decisionId} 已过期。` };
    case "effect_unsupported":
      return { kind: "error", text: "当前配置不支持这类决策的效果，未批准。" };
    case "effect_apply_failed":
      return { kind: "error", text: `批准没有生效：${reply.message ?? "效果应用失败"}。` };
    default:
      return { kind: "error", text: `意外的返回：${reply.outcome ?? "无"}。` };
  }
}

function decisionDialog(ctx: ActionContext, id: string): void {
  const decision = ctx
    .model()
    .decisions.find((item) => item.id === id && item.status === "pending");
  if (!decision) {
    ctx.changed({ ok: false, text: `${id} 已不在待决策列表里，已刷新。` });
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
    const shown = describeResolve(reply, decision.id);
    if (shown.kind === "error") {
      throw new Error(shown.text);
    }
    ctx.changed({ ok: shown.kind === "done", text: shown.text });
  };
  const actions: DialogAction[] = [
    {
      label: "批准",
      tone: "primary",
      enabled: () => (!multiple || chosen !== "") && (!high || acknowledged),
      run: () => resolve("approved"),
    },
    { label: "拒绝", tone: "danger", run: () => resolve("denied") },
  ];
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    title: `处理待决策 ${decision.id}`,
    actions,
    build: (body, changed) => {
      row(body, "事项", decision.taskId);
      row(body, "问题", decision.question);
      row(body, "类型", decision.effectKind);
      row(body, "风险", decision.riskTier);
      row(body, "截止", fmtTime(decision.deadlineAt));
      if (decision.facts !== null && decision.facts !== undefined) {
        row(body, "事实", json(decision.facts, 800), true);
      }
      if (decision.options !== null && decision.options !== undefined) {
        row(body, "选项", json(decision.options, 800), true);
      }
      if (multiple) {
        const line = document.createElement("div");
        line.className = "nx-row";
        const label = document.createElement("span");
        label.className = "nx-label";
        label.textContent = "批准哪个动作";
        const select = document.createElement("select");
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = "请选择…";
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
        text.textContent = `这是 ${decision.riskTier} 决策：我已核对上面的动作和影响，同意授权。`;
        line.append(box, text);
        body.append(line);
      }
      note(body, "批准会产生真实授权；拒绝是终局，Agent 不会再就同一件事重复询问。");
    },
  });
}

function watchDialog(ctx: ActionContext, id: string): void {
  const watch = ctx.model().watches.find((item) => item.id === id);
  if (!watch) {
    ctx.changed({ ok: false, text: `${id} 已不在回检列表里，已刷新。` });
    return;
  }
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    title: `取消回检 ${watch.id}`,
    actions: [
      {
        label: "取消回检",
        tone: "danger",
        run: async () => {
          await ctx.request("nexus.watch.cancel", { watchId: watch.id });
          ctx.changed({ ok: true, text: `已取消回检 ${watch.id}。` });
        },
      },
    ],
    build: (body) => {
      row(body, "事项", watch.taskId);
      row(body, "条件", clip(watch.expect, 300));
      row(body, "状态", `${watch.status}（已查 ${watch.attempts}/${watch.maxAttempts}）`);
      note(body, "取消后不再回检，对应的定时任务会被删除。");
    },
  });
}

function preferenceDeleteDialog(ctx: ActionContext, id: string): void {
  const preference = ctx.model().preferences.find((item) => item.id === id);
  if (!preference) {
    ctx.changed({ ok: false, text: `${id} 已不在偏好列表里，已刷新。` });
    return;
  }
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    title: "删除偏好",
    actions: [
      {
        label: "删除",
        tone: "danger",
        run: async () => {
          await ctx.request("nexus.preference.delete", { preferenceId: preference.id });
          ctx.changed({ ok: true, text: `已删除偏好 ${preference.scope} / ${preference.key}。` });
        },
      },
    ],
    build: (body) => {
      row(body, "范围", preference.scope);
      row(body, "键", preference.key);
      row(body, "值", json(preference.value, 400), true);
      row(body, "来源", preference.origin);
      note(
        body,
        "删除后这条偏好不再生效，历史修订保留；要彻底清除请用 nexus.preference.purge（operator.admin）。",
      );
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
): PreferenceDraft {
  if (!isValidPreferenceScope(scope)) {
    return { ok: false, message: "范围只能是 global 或 domain:名称（小写字母、数字、._-）。" };
  }
  if (!isValidPreferenceKey(key)) {
    return { ok: false, message: "键需以小写字母或数字开头，只含小写字母、数字、._-，最长 64。" };
  }
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    return { ok: false, message: "值必须是合法的 JSON（字符串要带引号）。" };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > MAX_PREFERENCE_VALUE_BYTES) {
    return { ok: false, message: `值太长（${bytes} 字节，上限 ${MAX_PREFERENCE_VALUE_BYTES}）。` };
  }
  return { ok: true, scope, key, value };
}

function preferenceFormDialog(ctx: ActionContext, existing: PreferenceRecord | undefined): void {
  let scope = existing?.scope ?? "global";
  let key = existing?.key ?? "";
  let raw = existing ? (JSON.stringify(existing.value, null, 2) ?? "null") : "";
  const draft = () => validatePreferenceDraft(scope, key, raw);
  let hint: HTMLElement | undefined;
  openDialog({
    parent: ctx.parent,
    signal: ctx.signal,
    redact: ctx.redact,
    title: existing ? "编辑偏好" : "新增偏好",
    actions: [
      {
        label: "保存",
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
                ? "值没有变化。"
                : `已保存偏好 ${checked.scope} / ${checked.key}（${reply.outcome ?? "ok"}）。`,
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
      const scopeInput = document.createElement("input");
      scopeInput.value = scope;
      scopeInput.readOnly = existing !== undefined;
      scopeInput.addEventListener("input", () => {
        scope = scopeInput.value.trim();
        sync();
        changed();
      });
      const keyInput = document.createElement("input");
      keyInput.value = key;
      keyInput.readOnly = existing !== undefined;
      keyInput.addEventListener("input", () => {
        key = keyInput.value.trim();
        sync();
        changed();
      });
      const valueInput = document.createElement("textarea");
      valueInput.rows = 6;
      valueInput.value = raw;
      valueInput.placeholder = '例如 "简体中文" 或 {"seat":"aisle"}';
      valueInput.addEventListener("input", () => {
        raw = valueInput.value;
        sync();
        changed();
      });
      field("范围", scopeInput);
      field("键", keyInput);
      field("值（JSON）", valueInput);
      hint = note(body, "");
      note(body, "保存后这条偏好的来源记为 stated（你亲自声明）。偏好只改变默认选项，不构成授权。");
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
        ctx.changed({ ok: false, text: "只有你亲自声明（stated）的偏好可以在这里编辑，已刷新。" });
        return;
      }
      return preferenceFormDialog(ctx, existing);
    }
  }
}
