import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNexusPage } from "./page.ts";

type Handler = (payload: unknown) => void;

const task = (overrides: Record<string, unknown> = {}) => ({
  id: "T1ABC",
  title: "<img src=x onerror=alert(1)> 整理发票",
  kind: "generic",
  status: "open",
  revision: 1,
  riskCeiling: "R1",
  summary: "",
  goal: { text: "g" },
  entities: {},
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

function fixture(responses: Record<string, unknown | Error>, props: Record<string, string> = {}) {
  const events = new Map<string, Handler>();
  const opened: unknown[] = [];
  let listeners: Array<() => void> = [];
  const request = vi.fn(async (method: string) => {
    const response = responses[method];
    if (response instanceof Error) {
      throw response;
    }
    if (response === undefined) {
      throw new Error(`unknown method ${method}`);
    }
    return response;
  });
  const connection = { connected: true } as ControlUiHost["connection"];
  const host = {
    request,
    connection,
    redact: (text: string) => text,
    subscribe: (listener: () => void) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((entry) => entry !== listener);
      };
    },
    onEvent: (event: string, handler: Handler) => {
      events.set(event, handler);
      return () => events.delete(event);
    },
    navigation: {
      pageHref: (target: { id: string; params?: Record<string, string> }) =>
        `/plugin?id=${target.id}&${new URLSearchParams(target.params).toString()}`,
      openPage: (target: unknown) => opened.push(target),
    },
  } as unknown as ControlUiHost;
  const abort = new AbortController();
  const context = (next: Record<string, string>): ControlUiViewContext =>
    ({
      host,
      signal: abort.signal,
      props: next,
      presented: true,
      mountDefault: () => () => {},
    }) as never;
  const container = document.createElement("div");
  document.body.append(container);
  const view = createNexusPage()(container, context(props)) ?? {};
  return {
    container,
    request,
    opened,
    events,
    view,
    context,
    connection,
    notify: () => listeners.forEach((listener) => listener()),
    text: () => container.textContent ?? "",
  };
}

const flush = async () => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const LIST = {
  "nexus.task.list": { tasks: [task()] },
  "nexus.decision.list": { decisions: [{ taskId: "T1ABC", status: "pending" }] },
};

describe("nexus page", () => {
  it("lists tasks, shows the pending count and never turns a title into markup", async () => {
    const f = fixture({ ...LIST, "nexus.preference.list": { preferences: [] } });
    await flush();
    expect(f.container.querySelector("img")).toBeNull();
    expect(f.text()).toContain("整理发票");
    expect(f.text()).toContain("1 待决策");
    expect(f.container.querySelector("nav a.on")?.textContent).toBe("事项");
  });

  it("hides the preference tab when the gateway does not serve preferences", async () => {
    const without = fixture(LIST);
    await flush();
    expect([...without.container.querySelectorAll("nav a")].map((a) => a.textContent)).toEqual([
      "事项",
      "清除回执",
    ]);
    const withPrefs = fixture({ ...LIST, "nexus.preference.list": { preferences: [] } });
    await flush();
    expect([...withPrefs.container.querySelectorAll("nav a")].map((a) => a.textContent)).toEqual([
      "事项",
      "偏好",
      "清除回执",
    ]);
  });

  it("opens a task through the host navigation when its link is clicked", async () => {
    const f = fixture(LIST);
    await flush();
    f.container
      .querySelector("a[data-nexus-route] code")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(f.opened).toEqual([{ id: "nexus", params: { view: "task", task: "T1ABC" } }]);
  });

  it("renders a task detail from read-only methods and tolerates disabled modules", async () => {
    const f = fixture(
      {
        "nexus.task.get": { task: task(), steps: [], sessions: [] },
        "nexus.decision.list": { decisions: [] },
        "nexus.execution.list": { executions: [] },
      },
      { view: "task", task: "T1ABC" },
    );
    await flush();
    expect(f.request).toHaveBeenCalledWith("nexus.task.get", { taskId: "T1ABC" });
    expect(f.text()).toContain("T1ABC");
    expect(f.text()).toContain("待决策");
    // Only reads are ever issued.
    for (const [method] of f.request.mock.calls) {
      expect(method).toMatch(/\.(list|get|purgeReceipts)$/);
    }
  });

  it("shows a readable error instead of an empty page", async () => {
    const f = fixture({ "nexus.task.list": new Error("store unavailable") });
    await flush();
    expect(f.text()).toContain("Nexus 读取失败：store unavailable");
  });

  it("waits for the gateway connection and loads once it is up", async () => {
    const f = fixture(LIST);
    await flush();
    f.connection.connected = false;
    f.notify();
    await flush();
    expect(f.text()).toContain("正在连接网关");
    f.connection.connected = true;
    f.notify();
    await flush();
    expect(f.text()).toContain("整理发票");
  });

  it("reloads on a change event (debounced) and when the route changes", async () => {
    const f = fixture({ ...LIST, "nexus.task.purgeReceipts": { receipts: [] } });
    await flush();
    const before = f.request.mock.calls.length;
    f.events.get("plugin.nexus-agent-core.task_changed")?.({});
    f.events.get("plugin.nexus-agent-core.decision_changed")?.({});
    vi.advanceTimersByTime(500);
    await flush();
    expect(f.request.mock.calls.filter(([m]) => m === "nexus.task.list")).toHaveLength(2);
    expect(f.request.mock.calls.length).toBeGreaterThan(before);
    f.view.update?.(f.context({ view: "receipts" }));
    await flush();
    expect(f.request).toHaveBeenCalledWith("nexus.task.purgeReceipts", { limit: 100 });
    expect(f.text()).toContain("清除回执");
  });

  it("stops reacting after dispose", async () => {
    const f = fixture(LIST);
    await flush();
    f.view.dispose?.();
    expect(f.events.size).toBe(0);
    const calls = f.request.mock.calls.length;
    vi.advanceTimersByTime(1000);
    await flush();
    expect(f.request.mock.calls.length).toBe(calls);
    expect(f.container.childElementCount).toBe(0);
  });
});
