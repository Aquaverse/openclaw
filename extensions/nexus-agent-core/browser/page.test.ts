import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNexusPage } from "./page.ts";
import { NEXUS_CSS } from "./style.ts";

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

function fixture(
  responses: Record<string, unknown | Error>,
  props: Record<string, string> = {},
  locale?: string,
) {
  const events = new Map<string, Handler>();
  const opened: unknown[] = [];
  let listeners: Array<() => void> = [];
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    const raw = responses[method];
    const response =
      typeof raw === "function" ? (raw as (p?: Record<string, unknown>) => unknown)(params) : raw;
    if (response instanceof Error) {
      throw response;
    }
    if (response === undefined) {
      throw new Error(`unknown method ${method}`);
    }
    return response;
  });
  const connection = { connected: true } as ControlUiHost["connection"];
  let currentLocale = locale;
  const host = {
    request,
    get locale() {
      return currentLocale;
    },
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
    setLocale: (next: string) => {
      currentLocale = next;
    },
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

  it("shows a time on every claim, evidence and step row", async () => {
    const f = fixture(
      {
        "nexus.task.get": {
          task: task(),
          steps: [
            {
              id: "S1",
              seq: 1,
              kind: "note",
              status: "done",
              title: "第一步",
              detail: null,
              flowId: null,
              startedAt: 1_700_000_000_000,
              endedAt: 1_700_000_060_000,
            },
          ],
          sessions: [],
        },
        "nexus.claim.list": {
          claims: [
            {
              id: "C1",
              taskId: "T1ABC",
              subject: "s",
              predicate: "p",
              state: "UNVERIFIED",
              requiredForCompletion: null,
              createdAt: 1_700_000_100_000,
              updatedAt: 1_700_000_200_000,
            },
          ],
        },
        "nexus.evidence.list": {
          evidence: [
            {
              evidenceId: "EV1",
              taskId: "T1ABC",
              kind: "file",
              blobKey: null,
              contentHash: "h",
              byteSize: null,
              sourceGroup: "g",
              classification: "personal",
              redactionState: "raw",
              meta: null,
              capturedAt: 1_700_000_300_000,
              linkedClaimIds: [],
            },
          ],
        },
      },
      { view: "task", task: "T1ABC" },
    );
    await flush();
    const stamp = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g;
    const rowText = (needle: string) =>
      [...f.container.querySelectorAll("tr")].find((row) => row.textContent?.includes(needle))
        ?.textContent ?? "";
    expect(rowText("第一步").match(stamp)?.length).toBe(2);
    expect(rowText("C1").match(stamp)?.length).toBe(2);
    expect(rowText("EV1").match(stamp)?.length).toBe(1);
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
      expect(method).toMatch(/\.(list|get|stats|purgeReceipts)$/);
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

  describe("list filters and paging", () => {
    const fillAndSubmit = (f: ReturnType<typeof fixture>, values: Record<string, string>) => {
      const form = f.container.querySelector("form.nx-filters") as HTMLFormElement;
      for (const [name, value] of Object.entries(values)) {
        (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value = value;
      }
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    };
    const control = (f: ReturnType<typeof fixture>, name: string) =>
      (f.container.querySelector("form.nx-filters") as HTMLFormElement).elements.namedItem(
        name,
      ) as HTMLInputElement;

    it("shows the bar on the list only, filled from the route, and asks the RPC for that page", async () => {
      const f = fixture(
        { ...LIST, "nexus.task.list": { tasks: [task()], total: 45 } },
        { qkw: "发票", status: "open", page: "2" },
      );
      await flush();
      const bar = f.container.querySelector("form.nx-filters") as HTMLFormElement;
      expect(bar.hidden).toBe(false);
      expect(control(f, "qkw").value).toBe("发票");
      expect(control(f, "status").value).toBe("open");
      expect(f.request).toHaveBeenCalledWith("nexus.task.list", {
        includeClosed: false,
        limit: 20,
        offset: 20,
        keyword: "发票",
      });
      expect(f.text()).toContain("共 45 条");
      expect(f.text()).toContain("第 2 / 3 页");
      // Page links go through the host navigation and keep the filter.
      const next = [...f.container.querySelectorAll("a[data-nexus-route]")].find(
        (a) => a.textContent === "下一页 ›",
      );
      expect(next?.getAttribute("href")).toContain("page=3");
      expect(next?.getAttribute("href")).toContain("qkw=");
      f.container
        .querySelector("a[data-nexus-route]") // a task link: opening a task hides the bar
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const detail = fixture(
        {
          "nexus.task.get": {
            task: task(),
            steps: [],
            sessions: [],
            pending: [],
            readyExecutions: [],
          },
        },
        { view: "task", task: "T1ABC" },
      );
      await flush();
      expect((detail.container.querySelector("form.nx-filters") as HTMLFormElement).hidden).toBe(
        true,
      );
    });

    it("gives the list back with its filter when leaving a task detail", async () => {
      const f = fixture(
        {
          ...LIST,
          "nexus.task.list": { tasks: [task()], total: 1 },
          "nexus.task.get": {
            task: task(),
            steps: [],
            sessions: [],
            pending: [],
            readyExecutions: [],
          },
        },
        { status: "open", qkw: "invoice" },
      );
      await flush();
      // Open the detail: the host swaps the page parameters in place.
      f.view.update?.(f.context({ view: "task", task: "T1ABC" }));
      await flush();
      const back = [...f.container.querySelectorAll("a[data-nexus-route]")].find(
        (a) => a.textContent === "← 事项",
      ) as HTMLElement | undefined;
      expect(back === undefined).toBe(false);
      back?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      const tab = [...f.container.querySelectorAll("nav a")].find((a) => a.textContent === "事项");
      tab?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(f.opened).toEqual([
        { id: "nexus", params: { status: "open", qkw: "invoice" } },
        { id: "nexus", params: { status: "open", qkw: "invoice" } },
      ]);
    });

    it("submits a new search at page 1 through the host navigation", async () => {
      const f = fixture(
        { ...LIST, "nexus.task.list": { tasks: [task()], total: 1 } },
        { page: "3" },
      );
      await flush();
      fillAndSubmit(f, { qtitle: "发票", status: "planning", size: "50" });
      expect(f.opened).toEqual([
        { id: "nexus", params: { qtitle: "发票", status: "planning", size: "50" } },
      ]);
    });

    it("does not navigate on a time that is not a date, and sends the other fields once it is fixed", async () => {
      const f = fixture({ ...LIST, "nexus.task.list": { tasks: [task()], total: 1 } });
      await flush();
      fillAndSubmit(f, { from: "not-a-date", qid: "T9" });
      expect(f.opened).toEqual([]);
      expect((f.container.querySelector(".f-error") as HTMLElement).hidden).toBe(false);
      fillAndSubmit(f, { from: "", qid: "T9" });
      expect(f.opened).toEqual([{ id: "nexus", params: { qid: "T9" } }]);
    });

    it("fills a date range from a preset", async () => {
      vi.setSystemTime(new Date(2026, 9, 15, 12, 0));
      const f = fixture({ ...LIST, "nexus.task.list": { tasks: [task()], total: 1 } });
      await flush();
      const preset = [...f.container.querySelectorAll("button.nx-link")].find(
        (b) => b.textContent === "近 7 天",
      ) as HTMLButtonElement;
      preset.click();
      expect(f.opened).toEqual([
        { id: "nexus", params: { from: "2026-10-09T00:00", to: "2026-10-15T23:59" } },
      ]);
    });

    it("reloads in place when the same search is submitted again, and resets to the plain list", async () => {
      const f = fixture(
        { ...LIST, "nexus.task.list": { tasks: [task()], total: 1 } },
        { qtitle: "发票" },
      );
      await flush();
      const before = f.request.mock.calls.filter(([m]) => m === "nexus.task.list").length;
      fillAndSubmit(f, {});
      await flush();
      expect(f.opened).toEqual([]);
      expect(f.request.mock.calls.filter(([m]) => m === "nexus.task.list").length).toBe(before + 1);
      (
        [...f.container.querySelectorAll("form.nx-filters button")].find(
          (b) => b.textContent === "重置",
        ) as HTMLButtonElement
      ).click();
      expect(f.opened).toEqual([{ id: "nexus", params: {} }]);
    });

    it("keeps what is being typed when a change event refreshes the list", async () => {
      const f = fixture({ ...LIST, "nexus.task.list": { tasks: [task()], total: 1 } });
      await flush();
      control(f, "qtitle").value = "还没提交";
      f.events.get("plugin.nexus-agent-core.task_changed")?.({});
      vi.advanceTimersByTime(500);
      await flush();
      expect(control(f, "qtitle").value).toBe("还没提交");
    });

    it("shows the last page when the requested one has run out", async () => {
      const calls: Array<Record<string, unknown> | undefined> = [];
      const f = fixture(
        {
          ...LIST,
          "nexus.task.list": (params?: Record<string, unknown>) => {
            calls.push(params);
            return params?.offset === 40
              ? { tasks: [task()], total: 41 }
              : { tasks: [], total: 41 };
          },
        },
        { page: "9" },
      );
      await flush();
      expect(calls.map((p) => p?.offset)).toEqual([160, 40]);
      expect(f.text()).toContain("第 3 / 3 页");
      expect(f.text()).toContain("整理发票");
    });

    it("says so when nothing matches", async () => {
      const f = fixture({ ...LIST, "nexus.task.list": { tasks: [], total: 0 } }, { qkw: "不存在" });
      await flush();
      expect(f.text()).toContain("没有符合条件的事项");
      expect(f.text()).toContain("清除筛选");
    });
  });

  describe("language and visibility", () => {
    const han = /[\u4e00-\u9fff]/;
    const english = (overrides: Record<string, unknown> = {}) => ({
      ...LIST,
      "nexus.task.list": { tasks: [task({ title: "Rebook the flight", ...overrides })], total: 1 },
      "nexus.preference.list": { preferences: [] },
    });

    it("shows the whole list page in English when the host locale is English", async () => {
      const f = fixture(english(), {}, "en-US");
      await flush();
      expect(f.text()).not.toMatch(han);
      expect([...f.container.querySelectorAll("nav a")].map((a) => a.textContent)).toEqual([
        "Tasks",
        "Preferences",
        "Purge receipts",
      ]);
      expect(f.container.querySelector("nav button")?.textContent).toBe("Refresh");
      expect(f.text()).toContain("1 pending");
      expect(f.text()).toContain("1 in total");
      expect(f.text()).toContain("Keyword");
      expect(f.text()).toContain("Last 7 days");
      expect(
        f.container.querySelector<HTMLButtonElement>('form.nx-filters button[type="submit"]')
          ?.textContent,
      ).toBe("Filter");
      const status = f.container.querySelector<HTMLSelectElement>('select[name="status"]');
      expect([...(status?.options ?? [])].slice(0, 4).map((o) => o.textContent)).toEqual([
        "all",
        "open",
        "closed",
        "draft",
      ]);
    });

    it("keeps the status options English in Chinese too, and translates the rest", async () => {
      const f = fixture(english(), {}, "zh-CN");
      await flush();
      const status = f.container.querySelector<HTMLSelectElement>('select[name="status"]');
      expect([...(status?.options ?? [])].slice(0, 3).map((o) => o.textContent)).toEqual([
        "all",
        "open",
        "closed",
      ]);
      expect(f.text()).toContain("关键字");
      expect(f.text()).toContain("筛选");
    });

    it("switches language on the next load without losing what is typed", async () => {
      const f = fixture(english(), {}, "en");
      await flush();
      const title = f.container.querySelector<HTMLInputElement>(
        'input[name="qtitle"]',
      ) as HTMLInputElement;
      title.value = "半截的搜索";
      f.setLocale("zh-CN");
      f.events.get("plugin.nexus-agent-core.task_changed")?.({});
      vi.advanceTimersByTime(500);
      await flush();
      expect(f.container.querySelector("nav a")?.textContent).toBe("事项");
      expect(f.text()).toContain("关键字");
      expect(f.container.querySelector<HTMLInputElement>('input[name="qtitle"]')?.value).toBe(
        "半截的搜索",
      );
    });

    it("shows the filter bar only on the task list", async () => {
      // The bar sets its own `display`, so the stylesheet must not let that beat the `hidden` attribute.
      expect(NEXUS_CSS).toContain(".nexus-page [hidden]{display:none !important}");
      const others: Array<Record<string, string>> = [
        { view: "preferences" },
        { view: "receipts" },
        { view: "task", task: "T1ABC" },
      ];
      for (const props of others) {
        const f = fixture(
          {
            ...LIST,
            "nexus.preference.list": { preferences: [] },
            "nexus.task.purgeReceipts": { receipts: [] },
            "nexus.preference.purgeReceipts": { receipts: [] },
            "nexus.task.get": {
              task: task(),
              steps: [],
              sessions: [],
              pending: [],
              readyExecutions: [],
            },
          },
          props,
        );
        await flush();
        const bar = f.container.querySelector("form.nx-filters") as HTMLFormElement;
        expect(bar.hidden, JSON.stringify(props)).toBe(true);
      }
      const list = fixture(english(), {});
      await flush();
      expect((list.container.querySelector("form.nx-filters") as HTMLFormElement).hidden).toBe(
        false,
      );
    });
  });

  describe("typed time boxes", () => {
    const setup = async (props: Record<string, string> = {}, locale = "en") => {
      const f = fixture(
        { ...LIST, "nexus.task.list": { tasks: [task()], total: 1 } },
        props,
        locale,
      );
      await flush();
      const form = f.container.querySelector("form.nx-filters") as HTMLFormElement;
      const box = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
      return { f, form, box };
    };

    it("uses plain text boxes showing the date as typed, with a space", async () => {
      const { box } = await setup({ from: "2026-10-01T08:30" });
      expect(box("from").type).toBe("text");
      expect(box("to").type).toBe("text");
      expect(box("from").value).toBe("2026-10-01 08:30");
      expect(box("from").placeholder).toBe("YYYY-MM-DD HH:mm");
    });

    it("accepts a typed time and navigates with the canonical form", async () => {
      const { f, form, box } = await setup();
      box("from").value = "2026-10-01 08:30";
      box("to").value = "2026-10-15";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(f.opened).toEqual([
        { id: "nexus", params: { from: "2026-10-01T08:30", to: "2026-10-15T23:59" } },
      ]);
    });

    it("says so, and does not navigate, when a time box is not a date", async () => {
      const { f, form, box } = await setup();
      const message = f.container.querySelector(".f-error") as HTMLElement;
      expect(message.hidden).toBe(true);
      box("from").value = "2026年10月15日";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(f.opened).toEqual([]);
      expect(message.hidden).toBe(false);
      expect(message.textContent).toBe(
        "Time must look like YYYY-MM-DD or YYYY-MM-DD HH:mm (local time).",
      );
      box("from").value = "2026-10-15";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(message.hidden).toBe(true);
      expect(f.opened.length).toBe(1);
    });
  });
});
