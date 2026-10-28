import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeResolve, needsSecondConfirmation, validatePreferenceDraft } from "./actions.ts";
import { decodePreviewText, PREVIEW_MAX_BYTES } from "./evidence-view.ts";
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

const claim = (overrides: Record<string, unknown> = {}) => ({
  id: "CLM01ABC",
  taskId: "T1ABC",
  subject: "本周练习时长",
  predicate: "reported",
  value: 12,
  state: "ASSERTED",
  policy: null,
  headEventId: "E1",
  requiredForCompletion: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
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
    claims?: unknown[];
    preferences?: unknown[];
    evidence?: unknown[];
    readData?: Uint8Array;
    totalBytes?: number;
    resolveReply?: unknown;
    fail?: Record<string, string>;
  },
  props: Record<string, string>,
  canWrite = true,
  locale?: string,
) {
  const writes: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  const reads: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
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
      case "nexus.claim.list":
        return { claims: data.claims ?? [] };
      case "nexus.claim.retract":
        writes.push({ method, params });
        return { outcome: data.fail?.["retract:already"] ? "already_retracted" : "retracted" };
      case "nexus.preference.list":
        return { preferences: data.preferences ?? [] };
      case "nexus.evidence.list":
        return { evidence: data.evidence ?? [] };
      case "nexus.evidence.handle":
        reads.push({ method, params });
        return { handleId: "EH1", byteSize: data.totalBytes ?? 0, contentHash: "sha256:abc" };
      case "nexus.evidence.read": {
        reads.push({ method, params });
        const bytes = data.readData ?? new Uint8Array();
        return {
          dataBase64: btoa(String.fromCharCode(...bytes)),
          totalBytes: data.totalBytes ?? bytes.length,
          length: bytes.length,
          contentHash: "sha256:abc",
        };
      }
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
    locale,
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
  return { container, request, writes, reads, dialog: () => container.querySelector(".nx-dialog") };
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

describe("claim retract button (G2.1)", () => {
  it("retracts a claim only after confirmation, and sends the task, claim and a reason", async () => {
    const f = fixture({ claims: [claim()] }, detailProps);
    await flush();
    expect(f.container.querySelectorAll('button[data-nx-act="claim-retract"]')).toHaveLength(1);
    click(f.container, 'button[data-nx-act="claim-retract"]');
    expect(f.writes).toHaveLength(0);
    const dialog = f.dialog() as HTMLElement;
    expect(dialog.textContent).toContain("本周练习时长");
    expect(dialog.textContent).toContain("撤回不可恢复");
    (buttonByText(dialog, "确认撤回") as HTMLButtonElement).click();
    await flush();
    expect(f.writes).toEqual([
      {
        method: "nexus.claim.retract",
        params: { taskId: "T1ABC", claimId: "CLM01ABC", reason: "用户在控制台撤回" },
      },
    ]);
    expect(f.container.querySelector(".nx-notice")?.textContent).toContain("已撤回声明 CLM01ABC");
  });

  it("cancelling writes nothing, a refuted claim has no button, and a read-only page shows none", async () => {
    const f = fixture({ claims: [claim(), claim({ id: "CLM02", state: "REFUTED" })] }, detailProps);
    await flush();
    expect(f.container.querySelectorAll('button[data-nx-act="claim-retract"]')).toHaveLength(1);
    click(f.container, 'button[data-nx-act="claim-retract"]');
    (buttonByText(f.dialog() as HTMLElement, "取消") as HTMLButtonElement).click();
    await flush();
    expect(f.writes).toHaveLength(0);
    const readOnly = fixture({ claims: [claim()] }, detailProps, false);
    await flush();
    expect(readOnly.container.querySelector('button[data-nx-act="claim-retract"]')).toBeNull();
  });

  it("says so when the claim was already retracted, and shows a failed write in the dialog", async () => {
    const f = fixture({ claims: [claim()], fail: { "retract:already": "1" } }, detailProps);
    await flush();
    click(f.container, 'button[data-nx-act="claim-retract"]');
    (buttonByText(f.dialog() as HTMLElement, "确认撤回") as HTMLButtonElement).click();
    await flush();
    expect(f.container.querySelector(".nx-notice")?.textContent).toContain("之前已经撤回过");
    const failing = fixture(
      { claims: [claim()], fail: { "nexus.claim.retract": "missing scope: operator.write" } },
      detailProps,
    );
    await flush();
    click(failing.container, 'button[data-nx-act="claim-retract"]');
    const dialog = failing.dialog() as HTMLElement;
    (buttonByText(dialog, "确认撤回") as HTMLButtonElement).click();
    await flush();
    expect(dialog.querySelector(".error")?.textContent).toContain("missing scope");
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

  it("scope, key and value boxes opt out of capitalisation, autocorrect and spell-check (macOS turned `hi` into `Hi`)", async () => {
    const f = fixture({ preferences: [] }, props);
    await flush();
    click(f.container, 'button[data-nx-act="pref-new"]');
    const dialog = f.dialog() as HTMLElement;
    const boxes = Array.from(dialog.querySelectorAll("input, textarea"));
    expect(boxes).toHaveLength(3);
    for (const box of boxes) {
      expect(box.getAttribute("autocapitalize")).toBe("off");
      expect(box.getAttribute("autocorrect")).toBe("off");
      expect(box.getAttribute("spellcheck")).toBe("false");
    }
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

describe("dialogs in the host's language", () => {
  const han = /[\u4e00-\u9fff]/;

  it("describes every resolve outcome in English without Chinese", () => {
    for (const reply of [
      { outcome: "approved", executionId: "EX1" },
      { outcome: "approved" },
      { outcome: "denied" },
      { outcome: "already_resolved" },
      { outcome: "superseded" },
      { outcome: "superseded", reason: "price changed" },
      { outcome: "expired" },
      { outcome: "effect_unsupported" },
      { outcome: "effect_apply_failed" },
      { outcome: "weird" },
      {},
    ]) {
      expect(describeResolve(reply, "D1", "en").text).not.toMatch(han);
      expect(describeResolve(reply, "D1", "zh").text).toMatch(han);
    }
    expect(describeResolve({ outcome: "approved", executionId: "EX1" }, "D1", "en").text).toBe(
      "Approved D1 (execution EX1 is ready; waiting for the agent to commit it).",
    );
  });

  it("validates a preference draft in English", () => {
    for (const [scope, key, value] of [
      ["Bad Scope", "k", '"v"'],
      ["global", "Bad Key", '"v"'],
      ["global", "k", "{nope"],
      ["global", "k", JSON.stringify("x".repeat(5000))],
    ] as const) {
      const out = validatePreferenceDraft(scope, key, value, "en");
      expect(out.ok).toBe(false);
      expect(out.ok ? "" : out.message).not.toMatch(han);
    }
  });

  it("builds the decision, watch and preference dialogs in English", async () => {
    const f = fixture(
      { decisions: [decision()], watches: [watch()], preferences: [preference()] },
      detailProps,
      true,
      "en-US",
    );
    await flush();
    click(f.container, 'button[data-nx-act="decision"]');
    expect(f.dialog()?.textContent).toContain("Resolve decision DEC1");
    expect(f.dialog()?.textContent).toContain("Approve");
    expect(f.dialog()?.textContent).toContain("Deny");
    expect(f.dialog()?.textContent).toContain("This is an R2 decision");
    expect(buttonByText(f.dialog() as ParentNode, "Cancel") !== undefined).toBe(true);
    // The question comes from the server and is shown as is; everything else around it is English.
    const chrome = (f.dialog()?.textContent ?? "").replace(decision().question, "");
    expect(chrome).not.toMatch(han);
    buttonByText(f.dialog() as ParentNode, "Cancel")?.click();

    click(f.container, 'button[data-nx-act="watch-cancel"]');
    expect(f.dialog()?.textContent).toContain("Cancel watch W1");
    expect(f.dialog()?.textContent).toContain("checked 0/4");
    buttonByText(f.dialog() as ParentNode, "Cancel")?.click();
  });

  it("builds the preference dialogs in English", async () => {
    const f = fixture({ preferences: [preference()] }, { view: "preferences" }, true, "en");
    await flush();
    click(f.container, 'button[data-nx-act="pref-new"]');
    expect(f.dialog()?.textContent).toContain("New preference");
    expect(f.dialog()?.textContent).toContain("Value (JSON)");
    expect(f.dialog()?.textContent).toContain("declared by you");
    expect(f.dialog()?.textContent).not.toMatch(han);
    buttonByText(f.dialog() as ParentNode, "Cancel")?.click();
    click(f.container, 'button[data-nx-act="pref-delete"]');
    expect(f.dialog()?.textContent).toContain("Delete preference");
    expect(f.dialog()?.textContent).not.toMatch(han);
  });

  describe("view original", () => {
    const stored = (overrides: Record<string, unknown> = {}) => ({
      evidenceId: "EV1",
      taskId: "T1ABC",
      kind: "file",
      blobKey: "k1",
      contentHash: "sha256:abc",
      byteSize: 12,
      sourceGroup: "g",
      classification: "internal",
      redactionState: "raw",
      meta: null,
      capturedAt: 1_700_000_000_000,
      linkedClaimIds: [],
      ...overrides,
    });
    const encode = (text: string) => new TextEncoder().encode(text);

    it("offers the button only for evidence that has stored bytes", async () => {
      const f = fixture(
        {
          evidence: [
            stored(),
            stored({ evidenceId: "EV2", blobKey: null, kind: "execution" }),
            stored({ evidenceId: "EV3", blobKey: null, redactionState: "purged" }),
          ],
        },
        detailProps,
      );
      await flush();
      const buttons = f.container.querySelectorAll('button[data-nx-act="evidence-view"]');
      expect(buttons.length).toBe(1);
      expect(buttons[0]?.getAttribute("data-nx-id")).toBe("EV1");
      // The "Bytes" column says so too: stored, none (metadata only), purged.
      const cells = [...f.container.querySelectorAll("tr")]
        .filter((tr) => tr.textContent?.includes("EV"))
        .map((tr) => tr.textContent ?? "");
      expect(cells.some((text) => text.includes("EV1") && text.includes("在库"))).toBe(true);
      expect(cells.some((text) => text.includes("EV2") && text.includes("无"))).toBe(true);
      expect(cells.some((text) => text.includes("EV3") && text.includes("purged"))).toBe(true);
    });

    it("previews the text through handle and read, and shows it as text, not markup", async () => {
      const f = fixture(
        { evidence: [stored()], readData: encode("你好 <img src=x onerror=alert(1)>") },
        detailProps,
      );
      await flush();
      click(f.container, 'button[data-nx-act="evidence-view"]');
      await flush();
      expect(f.reads).toEqual([
        { method: "nexus.evidence.handle", params: { taskId: "T1ABC", evidenceId: "EV1" } },
        {
          method: "nexus.evidence.read",
          params: { handleId: "EH1", offset: 0, length: PREVIEW_MAX_BYTES },
        },
      ]);
      expect(f.dialog()?.querySelector("img")).toBeNull();
      expect(f.dialog()?.querySelector("pre.nx-original")?.textContent).toBe(
        "你好 <img src=x onerror=alert(1)>",
      );
      expect(f.dialog()?.textContent).toContain("sha256:abc");
    });

    it("says how much is shown when the original is longer than the limit", async () => {
      const f = fixture(
        { evidence: [stored({ byteSize: 200_000 })], readData: encode("abc"), totalBytes: 200_000 },
        detailProps,
      );
      await flush();
      click(f.container, 'button[data-nx-act="evidence-view"]');
      await flush();
      expect(f.dialog()?.textContent).toContain("前 3 字节，共 200000 字节");
    });

    it("does not preview binary content", async () => {
      const f = fixture(
        { evidence: [stored()], readData: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) },
        detailProps,
      );
      await flush();
      click(f.container, 'button[data-nx-act="evidence-view"]');
      await flush();
      expect(f.dialog()?.querySelector("pre.nx-original")).toBeNull();
      expect(f.dialog()?.textContent).toContain("不是文本");
    });

    it("explains evidence_has_no_bytes instead of showing the raw error", async () => {
      const f = fixture(
        { evidence: [stored()], fail: { "nexus.evidence.handle": "evidence_has_no_bytes" } },
        detailProps,
      );
      await flush();
      click(f.container, 'button[data-nx-act="evidence-view"]');
      await flush();
      expect(f.dialog()?.textContent).toContain("没有原文");
      expect(f.dialog()?.textContent).not.toContain("evidence_has_no_bytes");
    });

    it("decodes text, drops a cut multi-byte tail, and refuses binary", () => {
      expect(decodePreviewText(encode("héllo"), false)).toBe("héllo");
      expect(decodePreviewText(encode("a你").subarray(0, 3), true)).toBe("a");
      expect(decodePreviewText(encode("a你").subarray(0, 3), false)).toBeUndefined();
      expect(decodePreviewText(new Uint8Array([104, 0, 105]), false)).toBeUndefined();
      expect(decodePreviewText(new Uint8Array([0xff, 0xfe, 0x41]), false)).toBeUndefined();
      expect(decodePreviewText(new Uint8Array(), false)).toBe("");
    });
  });
});
