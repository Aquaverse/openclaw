import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeResolve, needsSecondConfirmation, validatePreferenceDraft } from "./actions.ts";
import { createNexusPage } from "./page.ts";

const task = {
  id: "T1ABC",
  title: "订机票",
  kind: "generic",
  status: "awaiting_decision",
  revision: 2,
  riskCeiling: "R2",
  summary: "",
  goal: { text: "g" },
  entities: {},
  updatedAt: 1_700_000_000_000,
};

const decision = (overrides: Record<string, unknown> = {}) => ({
  id: "DEC1",
  taskId: "T1ABC",
  decisionType: "action",
  riskTier: "R2",
  question: "<b>确认</b>支付 CNY 100？",
  facts: { amount: "100" },
  options: null,
  status: "pending",
  resolution: null,
  deadlineAt: null,
  effectKind: "authorize_actions",
  actionIds: ["ACT1"],
  ...overrides,
});

const watch = (overrides: Record<string, unknown> = {}) => ({
  id: "W1",
  taskId: "T1ABC",
  expect: "航班仍有票",
  status: "scheduled",
  attempts: 0,
  maxAttempts: 4,
  nextCheckAt: 1_700_000_100_000,
  claimId: null,
  ...overrides,
});

const preference = (overrides: Record<string, unknown> = {}) => ({
  id: "P1",
  scope: "global",
  key: "language",
  value: "zh-CN",
  origin: "stated",
  taskId: null,
  confidence: null,
  revision: 1,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

function fixture(
  data: {
    decisions?: unknown[];
    watches?: unknown[];
    preferences?: unknown[];
    resolveReply?: unknown;
    fail?: Record<string, string>;
  },
  props: Record<string, string>,
  canWrite = true,
) {
  const writes: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (data.fail?.[method]) {
      throw new Error(data.fail[method]);
    }
    switch (method) {
      case "nexus.task.get":
        return { task, steps: [], sessions: [] };
      case "nexus.task.list":
        return { tasks: [task] };
      case "nexus.decision.list":
        return { decisions: data.decisions ?? [] };
      case "nexus.execution.list":
        return { executions: [] };
      case "nexus.watch.list":
        return { watches: data.watches ?? [] };
      case "nexus.preference.list":
        return { preferences: data.preferences ?? [] };
      case "nexus.decision.resolve":
        writes.push({ method, params });
        return data.resolveReply ?? { outcome: "approved", executionId: "EX1" };
      case "nexus.watch.cancel":
      case "nexus.preference.delete":
        writes.push({ method, params });
        return { outcome: "ok" };
      case "nexus.preference.set":
        writes.push({ method, params });
        return { outcome: "created" };
      default:
        throw new Error(`unknown method ${method}`);
    }
  });
  const host = {
    request,
    connection: { connected: true, canWrite } as ControlUiHost["connection"],
    redact: (text: string) => text,
    subscribe: () => () => {},
    onEvent: () => () => {},
    navigation: {
      pageHref: () => "/p",
      openPage: () => {},
    },
  } as unknown as ControlUiHost;
  const context = (next: Record<string, string>): ControlUiViewContext =>
    ({
      host,
      signal: new AbortController().signal,
      props: next,
      presented: true,
      mountDefault: () => () => {},
    }) as never;
  const container = document.createElement("div");
  document.body.append(container);
  createNexusPage()(container, context(props));
  return { container, request, writes, dialog: () => container.querySelector(".nx-dialog") };
}

const flush = async () => {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
};

const click = (root: ParentNode, selector: string) => {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) {
    throw new Error(`no element for ${selector}`);
  }
  el.click();
};
const buttonByText = (root: ParentNode, text: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === text,
  );
const detailProps = { view: "task", task: "T1ABC" };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("pure helpers", () => {
  it("asks for a second confirmation from R2 up, and for anything it cannot read", () => {
    expect(needsSecondConfirmation("R0")).toBe(false);
    expect(needsSecondConfirmation("R1")).toBe(false);
    expect(needsSecondConfirmation("R2")).toBe(true);
    expect(needsSecondConfirmation("R3")).toBe(true);
    expect(needsSecondConfirmation("weird")).toBe(true);
  });

  it("maps every resolve outcome to done, stale or error", () => {
    expect(describeResolve({ outcome: "approved", executionId: "EX1" }, "D").kind).toBe("done");
    expect(describeResolve({ outcome: "denied" }, "D").kind).toBe("done");
    for (const outcome of ["already_resolved", "superseded", "expired"]) {
      expect(describeResolve({ outcome }, "D").kind).toBe("stale");
    }
    expect(describeResolve({ outcome: "effect_unsupported" }, "D").kind).toBe("error");
    expect(describeResolve({ outcome: "effect_apply_failed", message: "x" }, "D").kind).toBe(
      "error",
    );
    expect(describeResolve({}, "D").kind).toBe("error");
  });

  it("validates a preference draft the way the RPC will", () => {
    expect(validatePreferenceDraft("global", "language", '"zh-CN"').ok).toBe(true);
    expect(validatePreferenceDraft("domain:travel", "seat", '{"a":1}').ok).toBe(true);
    expect(validatePreferenceDraft("Global", "language", '"x"').ok).toBe(false);
    expect(validatePreferenceDraft("global", "Bad Key", '"x"').ok).toBe(false);
    expect(validatePreferenceDraft("global", "language", "not json").ok).toBe(false);
    expect(validatePreferenceDraft("global", "language", JSON.stringify("x".repeat(5000))).ok).toBe(
      false,
    );
  });
});

describe("action buttons", () => {
  it("shows no buttons when the connection cannot write", async () => {
    const f = fixture({ decisions: [decision()], watches: [watch()] }, detailProps, false);
    await flush();
    expect(f.container.querySelector("button[data-nx-act]")).toBeNull();
    expect(f.container.textContent).toContain("在这里只能查看");
  });

  it("opens a decision dialog built from the loaded record, escaped", async () => {
    const f = fixture({ decisions: [decision()] }, detailProps);
    await flush();
    click(f.container, 'button[data-nx-act="decision"]');
    const dialog = f.dialog() as HTMLElement;
    expect(dialog.querySelector("b")).toBeNull();
    expect(dialog.textContent).toContain("<b>确认</b>支付 CNY 100？");
    expect(dialog.textContent).toContain("R2");
  });

  it("keeps R2 approval disabled until the second confirmation is ticked, then approves", async () => {
    const f = fixture({ decisions: [decision()] }, detailProps);
    await flush();
    click(f.container, 'button[data-nx-act="decision"]');
    const dialog = f.dialog() as HTMLElement;
    const approve = buttonByText(dialog, "批准") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    click(dialog, 'input[type="checkbox"]');
    expect(approve.disabled).toBe(false);
    approve.click();
    await flush();
    expect(f.writes).toEqual([
      {
        method: "nexus.decision.resolve",
        params: { decisionId: "DEC1", resolution: "approved", chosenActionId: "ACT1" },
      },
    ]);
    expect(f.dialog()).toBeNull();
    expect(f.container.querySelector(".nx-notice")?.textContent).toContain("已批准 DEC1");
  });

  it("approves an R1 decision without the extra tick, and lets the user deny any time", async () => {
    const f = fixture({ decisions: [decision({ riskTier: "R1" })] }, detailProps);
    await flush();
    click(f.container, 'button[data-nx-act="decision"]');
    const dialog = f.dialog() as HTMLElement;
    expect((buttonByText(dialog, "批准") as HTMLButtonElement).disabled).toBe(false);
    (buttonByText(dialog, "拒绝") as HTMLButtonElement).click();
    await flush();
    expect(f.writes[0]?.params).toEqual({ decisionId: "DEC1", resolution: "denied" });
  });

  it("requires choosing one candidate action when there are several", async () => {
    const f = fixture(
      { decisions: [decision({ riskTier: "R1", actionIds: ["ACT1", "ACT2"] })] },
      detailProps,
    );
    await flush();
    click(f.container, 'button[data-nx-act="decision"]');
    const dialog = f.dialog() as HTMLElement;
    const approve = buttonByText(dialog, "批准") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    const select = dialog.querySelector("select") as HTMLSelectElement;
    select.value = "ACT2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(approve.disabled).toBe(false);
    approve.click();
    await flush();
    expect(f.writes[0]?.params).toEqual({
      decisionId: "DEC1",
      resolution: "approved",
      chosenActionId: "ACT2",
    });
  });

  it("closes and reports a stale decision, and keeps the dialog open on an RPC error", async () => {
    const stale = fixture(
      { decisions: [decision({ riskTier: "R1" })], resolveReply: { outcome: "already_resolved" } },
      detailProps,
    );
    await flush();
    click(stale.container, 'button[data-nx-act="decision"]');
    (buttonByText(stale.dialog() as HTMLElement, "批准") as HTMLButtonElement).click();
    await flush();
    expect(stale.dialog()).toBeNull();
    expect(stale.container.querySelector(".nx-notice")?.textContent).toContain("已经被处理过");

    const failing = fixture(
      {
        decisions: [decision({ riskTier: "R1" })],
        fail: { "nexus.decision.resolve": "missing scope: operator.write" },
      },
      detailProps,
    );
    await flush();
    click(failing.container, 'button[data-nx-act="decision"]');
    const dialog = failing.dialog() as HTMLElement;
    (buttonByText(dialog, "批准") as HTMLButtonElement).click();
    await flush();
    expect(failing.dialog() === null).toBe(false);
    expect(dialog.querySelector(".error")?.textContent).toContain("missing scope: operator.write");
    expect((buttonByText(dialog, "批准") as HTMLButtonElement).disabled).toBe(false);
  });

  it("cancels a watch only after confirmation, and offers no button for closed watches", async () => {
    const f = fixture(
      { watches: [watch(), watch({ id: "W2", status: "exhausted" })] },
      detailProps,
    );
    await flush();
    expect(f.container.querySelectorAll('button[data-nx-act="watch-cancel"]')).toHaveLength(1);
    click(f.container, 'button[data-nx-act="watch-cancel"]');
    expect(f.writes).toHaveLength(0);
    (buttonByText(f.dialog() as HTMLElement, "取消回检") as HTMLButtonElement).click();
    await flush();
    expect(f.writes).toEqual([{ method: "nexus.watch.cancel", params: { watchId: "W1" } }]);
    expect(f.container.querySelector(".nx-notice")?.textContent).toContain("已取消回检 W1");
  });
});

describe("preference buttons", () => {
  const props = { view: "preferences" };

  it("creates a preference only from a valid draft", async () => {
    const f = fixture({ preferences: [] }, props);
    await flush();
    click(f.container, 'button[data-nx-act="pref-new"]');
    const dialog = f.dialog() as HTMLElement;
    const save = buttonByText(dialog, "保存") as HTMLButtonElement;
    const [scope, key] = Array.from(dialog.querySelectorAll("input"));
    const value = dialog.querySelector("textarea") as HTMLTextAreaElement;
    const type = (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    expect(save.disabled).toBe(true);
    type(key as HTMLInputElement, "language");
    type(value, "not json");
    expect(save.disabled).toBe(true);
    type(value, '"zh-CN"');
    expect((scope as HTMLInputElement).value).toBe("global");
    expect(save.disabled).toBe(false);
    save.click();
    await flush();
    expect(f.writes).toEqual([
      {
        method: "nexus.preference.set",
        params: { scope: "global", key: "language", value: "zh-CN" },
      },
    ]);
    expect(f.container.querySelector(".nx-notice")?.textContent).toContain("已保存偏好");
  });

  it("edits only stated preferences, with scope and key locked", async () => {
    const f = fixture(
      {
        preferences: [
          preference(),
          preference({ id: "P2", key: "seat", origin: "observed", value: "aisle" }),
        ],
      },
      props,
    );
    await flush();
    expect(f.container.querySelectorAll('button[data-nx-act="pref-edit"]')).toHaveLength(1);
    expect(f.container.querySelectorAll('button[data-nx-act="pref-delete"]')).toHaveLength(2);
    click(f.container, 'button[data-nx-act="pref-edit"]');
    const dialog = f.dialog() as HTMLElement;
    const [scope, key] = Array.from(dialog.querySelectorAll("input"));
    expect((scope as HTMLInputElement).readOnly).toBe(true);
    expect((key as HTMLInputElement).readOnly).toBe(true);
    const value = dialog.querySelector("textarea") as HTMLTextAreaElement;
    value.value = '"en-US"';
    value.dispatchEvent(new Event("input", { bubbles: true }));
    (buttonByText(dialog, "保存") as HTMLButtonElement).click();
    await flush();
    expect(f.writes[0]?.params).toEqual({ scope: "global", key: "language", value: "en-US" });
  });

  it("deletes after confirmation", async () => {
    const f = fixture({ preferences: [preference()] }, props);
    await flush();
    click(f.container, 'button[data-nx-act="pref-delete"]');
    expect(f.writes).toHaveLength(0);
    (buttonByText(f.dialog() as HTMLElement, "删除") as HTMLButtonElement).click();
    await flush();
    expect(f.writes).toEqual([
      { method: "nexus.preference.delete", params: { preferenceId: "P1" } },
    ]);
  });
});
