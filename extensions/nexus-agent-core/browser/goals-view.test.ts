import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGoalPrefs, writeGoalPrefs } from "./goal-prefs.ts";
import { createNexusPage } from "./page.ts";

const goal = (overrides: Record<string, unknown> = {}) => ({
  id: "G1ABC",
  parentId: null,
  category: "finance",
  title: "<img src=x onerror=alert(1)> 攒首付",
  userWords: "我想三年内攒够首付",
  summary: "每月存一部分",
  currentState: "已存 3 万",
  status: "active",
  lifecycle: "live",
  origin: "user",
  createdVia: "console_chat",
  confirmedAt: 1_700_000_000_000,
  confirmedBy: "operator:console",
  sensitivity: "sensitive",
  notifyPolicy: "none",
  sortOrder: 0,
  questions: [],
  revision: 4,
  completedAt: null,
  deletedAt: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  childCount: 0,
  linkCount: 0,
  entryCount: 0,
  lastEntryAt: null,
  ...overrides,
});

type Data = {
  /** Goals by status; the defaults are one active goal and nothing else. */
  active?: unknown[];
  proposed?: unknown[];
  completed?: unknown[];
  /** Turn the whole goal API off (an older gateway). */
  goals?: boolean;
  fail?: Record<string, Error>;
  detail?: unknown;
  /** The page has a Control UI sessions slice (older hosts have none). */
  sessions?: boolean;
  createdKey?: string | null;
};

function fixture(data: Data, props: Record<string, string>, canWrite = true, locale?: string) {
  const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  const order: string[] = [];
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, params });
    order.push(method);
    const failure = data.fail?.[method];
    if (failure) {
      throw failure;
    }
    if (data.goals === false && method.startsWith("nexus.goal.")) {
      throw new Error(`unknown method ${method}`);
    }
    switch (method) {
      case "nexus.task.list":
        return { tasks: [] };
      case "nexus.decision.list":
        return { decisions: [] };
      case "nexus.goal.list": {
        const status = params?.status;
        const goals =
          status === "proposed"
            ? (data.proposed ?? [])
            : status === "completed"
              ? (data.completed ?? [])
              : (data.active ?? [goal()]);
        return { goals, total: goals.length };
      }
      case "nexus.goal.get":
        return (
          data.detail ?? {
            goal: goal(),
            parent: null,
            children: [],
            entries: [],
            entriesTruncated: false,
            links: [],
          }
        );
      case "nexus.goal.startCreation":
        return { grantId: "GR1", expiresAt: 1_700_000_000_000 + 7_200_000 };
      case "chat.send":
        return { runId: "r1" };
      default:
        return { outcome: "ok" };
    }
  });
  const sessions = {
    create: vi.fn(async () => {
      order.push("sessions.create");
      return data.createdKey === undefined ? "raw-key" : data.createdKey;
    }),
    normalizeKey: vi.fn((key: string) => {
      order.push("sessions.normalizeKey");
      return `agent:main:${key}`;
    }),
    open: vi.fn(() => {
      order.push("sessions.open");
    }),
  };
  const host = {
    request,
    connection: { connected: true, canWrite } as ControlUiHost["connection"],
    redact: (text: string) => text,
    subscribe: () => () => {},
    onEvent: () => () => {},
    ...(locale ? { locale } : {}),
    ...(data.sessions === false ? {} : { sessions }),
    navigation: { pageHref: () => "/p", openPage: () => undefined },
  } as unknown as ControlUiHost;
  const context: ControlUiViewContext = {
    host,
    signal: new AbortController().signal,
    props,
    presented: true,
    mountDefault: () => () => {},
  } as never;
  const container = document.createElement("div");
  document.body.append(container);
  createNexusPage()(container, context);
  return {
    container,
    calls,
    order,
    sessions,
    dialog: () => container.querySelector(".nx-dialog") as HTMLElement,
    writes: () =>
      calls.filter(
        (call) => !/\.(list|get|forFile)$/.test(call.method) && call.method !== "chat.send",
      ),
    notice: () => container.querySelector(".nx-notice")?.textContent ?? "",
  };
}

const flush = async () => {
  for (let index = 0; index < 16; index += 1) {
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
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const PROPS = { view: "goals" };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("goals tab", () => {
  it("shows the tab only when the gateway serves the goal API", async () => {
    const served = fixture({}, { view: "tasks" });
    await flush();
    expect([...served.container.querySelectorAll("nav a")].map((a) => a.textContent)).toContain(
      "目标",
    );
    const without = fixture({ goals: false }, { view: "tasks" });
    await flush();
    expect(
      [...without.container.querySelectorAll("nav a")].map((a) => a.textContent),
    ).not.toContain("目标");
  });

  it("renders the lists and never turns a title into markup", async () => {
    const f = fixture(
      { proposed: [goal({ id: "G2", title: "<b>待确认</b>", status: "proposed" })] },
      PROPS,
    );
    await flush();
    expect(f.container.querySelector("main img, main b")).toBeNull();
    expect(f.container.textContent).toContain("<img src=x onerror=alert(1)> 攒首付");
    expect(f.container.textContent).toContain("<b>待确认</b>");
    expect(f.container.querySelector('button[data-nx-act="goal-check"]')).not.toBeNull();
    expect(
      f.container.querySelector('button[data-nx-act="goal-create"][data-nx-id="finance"]'),
    ).not.toBeNull();
    const list = f.calls.find(
      (c) => c.method === "nexus.goal.list" && c.params?.status === "active",
    );
    expect(list?.params).toMatchObject({ limit: 200, orderBy: "recent" });
  });

  it("offers no change on a read-only connection", async () => {
    const f = fixture({ proposed: [goal({ id: "G2", status: "proposed" })] }, PROPS, false);
    await flush();
    for (const act of ["goal-check", "goal-create", "goal-approve", "goal-reject"]) {
      expect(f.container.querySelector(`button[data-nx-act="${act}"]`)).toBeNull();
    }
    expect(f.container.querySelector('button[data-nx-act="goal-open"]')).not.toBeNull();
  });

  it("starts a creation chat in order: session, grant for the normalised key, opener, then the chat view", async () => {
    const f = fixture({}, PROPS);
    await flush();
    f.order.length = 0;
    click(f.container, 'button[data-nx-act="goal-create"][data-nx-id="finance"]');
    await flush();
    expect(f.order.filter((m) => m !== "sessions.normalizeKey")).toEqual([
      "sessions.create",
      "nexus.goal.startCreation",
      "chat.send",
      "sessions.open",
    ]);
    const grant = f.calls.find((c) => c.method === "nexus.goal.startCreation");
    expect(grant?.params).toEqual({ category: "finance", sessionKey: "agent:main:raw-key" });
    const send = f.calls.find((c) => c.method === "chat.send");
    expect(send?.params).toMatchObject({ sessionKey: "raw-key", message: "我想开始一个理财目标" });
    expect(typeof send?.params?.idempotencyKey).toBe("string");
    expect(f.sessions.open).toHaveBeenCalledWith({ sessionKey: "raw-key" });
    // no label: the gateway refuses a label that another session already has, so a second click would fail
    expect(f.sessions.create).toHaveBeenCalledWith();
  });

  it("does not send the opener when the cap refuses the grant", async () => {
    const refused = Object.assign(new Error("limit"), {
      code: "nexus_limit_reached",
      details: { max: 20 },
    });
    const f = fixture({ fail: { "nexus.goal.startCreation": refused } }, PROPS);
    await flush();
    click(f.container, 'button[data-nx-act="goal-create"][data-nx-id="interests"]');
    await flush();
    expect(f.calls.some((c) => c.method === "chat.send")).toBe(false);
    expect(f.sessions.open).not.toHaveBeenCalled();
    expect(f.notice()).toContain("20");
  });

  it("says so when the host cannot create a chat", async () => {
    const none = fixture({ sessions: false }, PROPS);
    await flush();
    click(none.container, 'button[data-nx-act="goal-create"]');
    await flush();
    expect(none.notice()).toContain("没能新建对话");
    const empty = fixture({ createdKey: null }, PROPS);
    await flush();
    click(empty.container, 'button[data-nx-act="goal-create"]');
    await flush();
    expect(empty.calls.some((c) => c.method === "nexus.goal.startCreation")).toBe(false);
    expect(empty.notice()).toContain("没能新建对话");
  });

  it("asks before the checkbox completes a goal, and cancelling changes nothing", async () => {
    const f = fixture({}, PROPS);
    await flush();
    click(f.container, 'button[data-nx-act="goal-check"]');
    await flush();
    expect(f.writes()).toEqual([]);
    const dialog = f.dialog();
    expect(dialog.textContent).toContain("要把这个目标标为完成吗？");
    expect(dialog.textContent).toContain("攒首付");
    (buttonByText(dialog, "取消") as HTMLButtonElement).click();
    await flush();
    expect(f.container.querySelector(".nx-dialog")).toBeNull();
    expect(f.writes()).toEqual([]);
  });

  it("completes the goal once the checkbox is confirmed", async () => {
    const f = fixture({}, PROPS);
    await flush();
    click(f.container, 'button[data-nx-act="goal-check"]');
    await flush();
    (buttonByText(f.dialog(), "标为完成") as HTMLButtonElement).click();
    await flush();
    expect(f.writes()).toEqual([{ method: "nexus.goal.complete", params: { goalId: "G1ABC" } }]);
    expect(f.notice()).toContain("已标为完成");
  });

  it("opens the proposal card from the row's button instead of approving in one click", async () => {
    const proposal = goal({
      id: "G2",
      status: "proposed",
      title: "旅行基金",
      questions: ["预算多少？"],
    });
    const f = fixture(
      {
        proposed: [proposal],
        detail: {
          goal: proposal,
          parent: null,
          children: [],
          entries: [],
          entriesTruncated: false,
          links: [],
        },
      },
      PROPS,
    );
    await flush();
    click(f.container, 'button[data-nx-act="goal-approve"]');
    await flush();
    expect(f.writes()).toEqual([]);
    const dialog = f.dialog();
    expect(dialog.textContent).toContain("预算多少？");
    expect(dialog.querySelector("textarea")).not.toBeNull();
    (buttonByText(dialog, "拒绝") as HTMLButtonElement).click();
    await flush();
    expect(f.writes()).toEqual([{ method: "nexus.goal.delete", params: { goalId: "G2" } }]);
  });

  it("confirms from the pending card with an edited title and the answers as notes", async () => {
    const f = fixture(
      {
        proposed: [
          goal({
            id: "G2",
            status: "proposed",
            title: "旅行基金",
            questions: ["预算多少？", "何时出发？"],
          }),
        ],
        detail: {
          goal: goal({
            id: "G2",
            status: "proposed",
            title: "旅行基金",
            questions: ["预算多少？", "何时出发？"],
          }),
          parent: null,
          children: [],
          entries: [],
          entriesTruncated: false,
          links: [],
        },
      },
      PROPS,
    );
    await flush();
    click(f.container, 'button[data-nx-act="goal-pending"]');
    await flush();
    const dialog = f.dialog();
    const [title] = Array.from(dialog.querySelectorAll("input")) as HTMLInputElement[];
    const [first, second] = Array.from(
      dialog.querySelectorAll("textarea"),
    ) as HTMLTextAreaElement[];
    type(title as HTMLInputElement, "日本旅行基金");
    type(first as HTMLTextAreaElement, "两万");
    expect(second).toBeDefined();
    (buttonByText(dialog, "批准") as HTMLButtonElement).click();
    await flush();
    expect(f.writes()).toEqual([
      { method: "nexus.goal.confirm", params: { goalId: "G2", edits: { title: "日本旅行基金" } } },
      {
        method: "nexus.goal.entry.add",
        params: { goalId: "G2", kind: "note", text: "预算多少？\n两万" },
      },
    ]);
  });

  it("opens the detail card and renames with the expected revision", async () => {
    const f = fixture({}, PROPS);
    await flush();
    click(f.container, 'button[data-nx-act="goal-open"]');
    await flush();
    const detail = f.dialog();
    expect(detail.textContent).toContain("我想三年内攒够首付");
    expect(detail.querySelector("img")).toBeNull();
    click(detail, ".gl-more");
    (buttonByText(detail, "重命名") as HTMLButtonElement).click();
    const rename = f.dialog();
    const input = rename.querySelector("input") as HTMLInputElement;
    const save = buttonByText(rename, "保存") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    type(input, "攒首付 2027");
    save.click();
    await flush();
    expect(f.writes()).toEqual([
      {
        method: "nexus.goal.update",
        params: { goalId: "G1ABC", patch: { title: "攒首付 2027" }, expectedRevision: 4 },
      },
    ]);
  });

  it("starts a sub-goal chat from the detail menu with the parent id", async () => {
    const f = fixture({}, PROPS);
    await flush();
    click(f.container, 'button[data-nx-act="goal-open"]');
    await flush();
    const detail = f.dialog();
    click(detail, ".gl-more");
    (buttonByText(detail, "添加子目标") as HTMLButtonElement).click();
    await flush();
    const grant = f.calls.find((c) => c.method === "nexus.goal.startCreation");
    expect(grant?.params).toMatchObject({ category: "finance", parentId: "G1ABC" });
  });

  it("purges only after the goal id is typed", async () => {
    const f = fixture({}, PROPS);
    await flush();
    click(f.container, 'button[data-nx-act="goal-open"]');
    await flush();
    click(f.dialog(), ".gl-more");
    (buttonByText(f.dialog(), "永久清除…") as HTMLButtonElement).click();
    const dialog = f.dialog();
    const purge = buttonByText(dialog, "永久清除…") as HTMLButtonElement;
    expect(purge.disabled).toBe(true);
    const input = dialog.querySelector("input") as HTMLInputElement;
    type(input, "G1AB");
    expect(purge.disabled).toBe(true);
    type(input, "G1ABC");
    expect(purge.disabled).toBe(false);
    purge.click();
    await flush();
    expect(f.writes()).toEqual([
      { method: "nexus.goal.purge", params: { goalId: "G1ABC", confirmGoalId: "G1ABC" } },
    ]);
  });

  it("hides write items from the detail menu on a read-only connection", async () => {
    const f = fixture({}, PROPS, false);
    await flush();
    click(f.container, 'button[data-nx-act="goal-open"]');
    await flush();
    expect(f.dialog().querySelector(".gl-more")).toBeNull();
  });

  it("says a goal is gone when the detail read fails", async () => {
    const f = fixture({ fail: { "nexus.goal.get": new Error("nexus_not_found") } }, PROPS);
    await flush();
    click(f.container, 'button[data-nx-act="goal-open"]');
    await flush();
    expect(f.notice()).toContain("G1ABC");
    expect(f.container.querySelector(".nx-dialog")).toBeNull();
  });

  it("toggles the page-menu switches and lists completed goals by month", async () => {
    writeGoalPrefs({ showSubtitle: true, autoSort: true });
    const f = fixture(
      {
        completed: [
          goal({
            id: "G9",
            title: "还清信用卡",
            status: "completed",
            completedAt: 1_700_000_000_000,
          }),
        ],
      },
      PROPS,
    );
    await flush();
    expect(f.container.textContent).toContain("已存 3 万");
    click(f.container, 'button[data-nx-act="goal-menu"]');
    const menu = f.dialog();
    const [subtitle, sort] = Array.from(
      menu.querySelectorAll('input[type="checkbox"]'),
    ) as HTMLInputElement[];
    (subtitle as HTMLInputElement).checked = false;
    (subtitle as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
    (sort as HTMLInputElement).checked = false;
    (sort as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
    expect(readGoalPrefs()).toEqual({ showSubtitle: false, autoSort: false });
    await flush();
    expect(f.container.textContent).not.toContain("已存 3 万");
    expect(f.container.querySelector('button[data-nx-act="goal-up"]')).not.toBeNull();
    const manual = f.calls.findLast(
      (c) => c.method === "nexus.goal.list" && c.params?.status === "active",
    );
    expect(manual?.params).toMatchObject({ orderBy: "manual" });

    click(f.container, 'button[data-nx-act="goal-menu"]');
    (buttonByText(f.dialog(), "已完成的目标") as HTMLButtonElement).click();
    await flush();
    expect(f.dialog().textContent).toContain("还清信用卡");
    writeGoalPrefs({ showSubtitle: true, autoSort: true });
  });

  it("moves a goal among its siblings in manual order", async () => {
    writeGoalPrefs({ showSubtitle: true, autoSort: false });
    const f = fixture(
      {
        active: [
          goal({ id: "GA", title: "甲", sortOrder: 0 }),
          goal({ id: "GB", title: "乙", sortOrder: 10 }),
        ],
      },
      PROPS,
    );
    await flush();
    click(f.container, 'button[data-nx-act="goal-up"][data-nx-id="GB"]');
    await flush();
    expect(f.writes()).toEqual([
      { method: "nexus.goal.update", params: { goalId: "GB", patch: { sortOrder: 0 } } },
      { method: "nexus.goal.update", params: { goalId: "GA", patch: { sortOrder: 10 } } },
    ]);
    writeGoalPrefs({ showSubtitle: true, autoSort: true });
  });
});
