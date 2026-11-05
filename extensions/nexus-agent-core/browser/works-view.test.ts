// The Work page in the console module: the rail entry, the two panes, selection through the URL, and the dialogs that
// preview what an action touches before it is confirmed.
import assert from "node:assert/strict";
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { afterEach, describe, it } from "vitest";
import { createNexusPage, NEXUS_PAGE_ID, NEXUS_RAIL_PAGE_ID } from "./page.ts";

const NOW = Date.now();

const work = (id: string, over: Record<string, unknown> = {}) => ({
  work: {
    ownerId: "o",
    id,
    title: `工作 ${id}`,
    requestText: null,
    outcomeText: null,
    migratedOutcome: null,
    hidden: false,
    revision: 2,
    lifecycle: "live",
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
  },
  state: {
    primary: "in_progress",
    flags: [],
    reasons: [],
    nextStep: { kind: "none" },
    evaluationVersion: 1,
  },
  goalId: null,
  tasks: [{ id: "t1", title: "查航班", status: "running", phase: "running", superseded: false }],
  openPrerequisites: 0,
  outcome: null,
  terminal: null,
  ...over,
});

type Reply = unknown | ((params?: Record<string, unknown>) => unknown);
type Calls = Array<{ method: string; params: Record<string, unknown> | undefined }>;

function mount(
  props: Record<string, string>,
  replies: Record<string, Reply> = {},
  options: { canWrite?: boolean; works?: boolean; pageId?: string } = {},
) {
  const calls: Calls = [];
  const opened: Array<{ id: string; params?: Record<string, string> }> = [];
  const events = new Map<string, () => void>();
  const list = [
    work("w1", {
      state: {
        primary: "needs_you",
        flags: [],
        reasons: [],
        nextStep: { kind: "decide", objectKind: "decision", objectId: "d" },
        evaluationVersion: 1,
      },
    }),
    work("w2"),
  ];
  const served: Record<string, Reply> = {
    "nexus.work.counts": (params?: Record<string, unknown>) =>
      // A search is counted over what it finds only; the account's own numbers are the greeting's.
      params?.keyword
        ? {
            total: 1,
            counts: { done: 0, ended_incomplete: 0, needs_you: 0, blocked: 0, in_progress: 1 },
            hiddenCount: 0,
          }
        : {
            total: 2,
            counts: { done: 0, ended_incomplete: 0, needs_you: 1, blocked: 0, in_progress: 1 },
            hiddenCount: 0,
          },
    "nexus.work.list": { works: list, total: 2, offset: 0 },
    "nexus.work.get": (params?: Record<string, unknown>) => ({
      ...(list.find((entry) => entry.work.id === params?.workId) ?? work(String(params?.workId))),
      links: [],
      events: [],
      controls: [],
    }),
    "nexus.task.list": { tasks: [], total: 0 },
    "nexus.decision.list": { decisions: [] },
    ...replies,
  };
  const request = async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, params });
    if (options.works === false && method.startsWith("nexus.work.")) {
      throw new Error(`unknown method ${method}`);
    }
    const raw = served[method];
    const reply =
      typeof raw === "function" ? (raw as (p?: Record<string, unknown>) => unknown)(params) : raw;
    if (reply instanceof Error) {
      throw reply;
    }
    if (reply === undefined) {
      throw new Error(`unknown method ${method}`);
    }
    return reply;
  };
  const host = {
    request,
    locale: "zh-CN",
    connection: { connected: true, canWrite: options.canWrite !== false },
    redact: (text: string) => text,
    subscribe: () => () => {},
    onEvent: (name: string, handler: () => void) => {
      events.set(name, handler);
      return () => events.delete(name);
    },
    navigation: {
      pageHref: (target: { id: string; params?: Record<string, string> }) =>
        `/plugin?id=${target.id}&${new URLSearchParams(target.params).toString()}`,
      openPage: (target: { id: string; params?: Record<string, string> }) => opened.push(target),
    },
  } as unknown as ControlUiHost;
  const abort = new AbortController();
  const container = document.createElement("div");
  document.body.append(container);
  const context = {
    host,
    signal: abort.signal,
    props,
    presented: true,
    mountDefault: () => () => {},
  } as unknown as ControlUiViewContext;
  const handle = createNexusPage(options.pageId)(container, context);
  return { container, calls, opened, events, handle, context };
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};
const q = (container: HTMLElement, selector: string) =>
  container.querySelector<HTMLElement>(selector);
const click = (container: HTMLElement, selector: string) => {
  const el = q(container, selector);
  assert.ok(el, `missing ${selector}`);
  el.click();
};
const dialogButton = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>(".nx-dialog button")].find(
    (b) => b.textContent === text,
  );

afterEach(() => {
  document.body.replaceChildren();
});

describe("work page", () => {
  it("is opened from the host's left rail: no inner navigation on the Work page, and no Work tab in it", async () => {
    const served = mount({ view: "works" });
    await flush();
    assert.ok(q(served.container, ".nexus-page")?.classList.contains("nx-rail"));
    const tasks = mount({ view: "tasks" });
    await flush();
    assert.equal(q(tasks.container, ".nexus-page")?.classList.contains("nx-rail"), false);
    for (const f of [served, tasks]) {
      assert.ok(![...f.container.querySelectorAll("nav a")].some((a) => a.textContent === "工作"));
    }
    assert.equal(tasks.container.querySelector(".nx-reddot"), null);
  });

  it("keeps its links on the page id it was opened under (the rail page stays the rail page)", async () => {
    const rail = mount({ view: "works" }, {}, { pageId: NEXUS_RAIL_PAGE_ID });
    await flush();
    const railHrefs = [...rail.container.querySelectorAll<HTMLAnchorElement>("a.nx-wrow")].map(
      (a) => a.getAttribute("href") ?? "",
    );
    assert.ok(railHrefs.length > 0);
    for (const href of railHrefs) {
      assert.ok(href.includes(`id=${NEXUS_RAIL_PAGE_ID}&`), href);
    }
    const tab = mount({ view: "tasks" });
    await flush();
    for (const a of tab.container.querySelectorAll<HTMLAnchorElement>("nav a")) {
      assert.ok((a.getAttribute("href") ?? "").includes(`id=${NEXUS_PAGE_ID}&`));
    }
  });

  it("shows the list and the first work's detail, in the split layout", async () => {
    const f = mount({ view: "works" });
    await flush();
    assert.ok(f.container.querySelector(".nexus-page")?.classList.contains("nx-split"));
    assert.equal(f.container.querySelectorAll("a.nx-wrow").length, 2);
    assert.equal(q(f.container, ".nx-wtitle")?.textContent, "工作 w1");
    assert.ok(q(f.container, ".nx-works")?.classList.contains("nx-auto"));
    const get = f.calls.find((c) => c.method === "nexus.work.get");
    assert.equal(get?.params?.workId, "w1");
    // The old pages keep their own layout.
    const tasks = mount({ view: "tasks" });
    await flush();
    assert.ok(!tasks.container.querySelector(".nexus-page")?.classList.contains("nx-split"));
  });

  it("opens the work named in the URL and selects it through the host", async () => {
    const f = mount({ view: "work", work: "w2", state: "in_progress" });
    await flush();
    assert.equal(q(f.container, ".nx-wtitle")?.textContent, "工作 w2");
    assert.ok(q(f.container, ".nx-works")?.classList.contains("nx-picked"));
    const list = f.calls.find((c) => c.method === "nexus.work.list");
    assert.deepEqual(list?.params?.states, ["in_progress"]);
    click(f.container, "a.nx-wrow");
    assert.deepEqual(f.opened.at(-1), {
      id: "nexus",
      params: { view: "work", work: "w1", state: "in_progress" },
    });
  });

  it("says so when the named work is gone", async () => {
    const f = mount(
      { view: "work", work: "nope" },
      { "nexus.work.get": Object.assign(new Error("work not found"), { code: "nexus_not_found" }) },
    );
    await flush();
    assert.match(f.container.textContent ?? "", /不存在，或已被删除/);
  });

  it("offers no change on a read-only connection", async () => {
    const f = mount({ view: "works" }, {}, { canWrite: false });
    await flush();
    assert.equal(f.container.querySelector('button[data-nx-act="work-pause"]'), null);
    assert.equal(f.container.querySelector('button[data-nx-act="work-delete"]'), null);
    // Reading and searching stay available.
    assert.ok(f.container.querySelector(".nx-search-slot .nx-wsearch input"));
  });

  it("previews what a pause touches before it asks to confirm, then applies it", async () => {
    const f = mount(
      { view: "works" },
      {
        "nexus.work.control": (params?: Record<string, unknown>) =>
          params?.dryRun === true
            ? {
                outcome: "preview",
                action: "pause",
                affectedTasks: [{ id: "t1", title: "查航班", status: "running" }],
              }
            : { outcome: "applied", controlId: "wc_1" },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="work-pause"]');
    const confirm = () => dialogButton(f.container, "暂停");
    assert.ok(confirm()?.disabled, "disabled until the preview arrives");
    await flush();
    assert.match(
      q(f.container, ".nx-dialog")?.textContent ?? "",
      /『查航班』：暂停期间不会继续推进/,
    );
    assert.equal(confirm()?.disabled, false);
    const preview = f.calls.find((c) => c.method === "nexus.work.control");
    assert.equal(preview?.params?.dryRun, true);
    confirm()?.click();
    await flush();
    const applied = f.calls.findLast((c) => c.method === "nexus.work.control");
    assert.equal(applied?.params?.dryRun, undefined);
    assert.equal(applied?.params?.workId, "w1");
    assert.equal(applied?.params?.action, "pause");
    assert.equal(q(f.container, ".nx-dialog"), null);
    assert.match(q(f.container, ".nx-notice")?.textContent ?? "", /已暂停『工作 w1』/);
  });

  it("resumes exactly the pause that was clicked", async () => {
    const paused = work("w1", {
      state: {
        primary: "blocked",
        blockedKind: "paused",
        flags: [],
        reasons: [],
        nextStep: { kind: "none" },
        evaluationVersion: 1,
      },
    });
    const f = mount(
      { view: "works" },
      {
        "nexus.work.list": { works: [paused], total: 1, offset: 0 },
        "nexus.work.get": {
          ...paused,
          links: [],
          events: [],
          controls: [
            {
              id: "wc_a",
              scopeKind: "work",
              scopeId: null,
              state: "paused",
              reason: "出差",
              reconcileOnly: false,
              createdAt: NOW,
            },
            {
              id: "wc_b",
              scopeKind: "work",
              scopeId: null,
              state: "paused",
              reason: null,
              reconcileOnly: false,
              createdAt: NOW,
            },
          ],
        },
        "nexus.work.control": (params?: Record<string, unknown>) =>
          params?.dryRun === true
            ? { outcome: "preview", action: "resume", controlId: params.controlId }
            : { outcome: "released" },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="work-resume"][data-nx-id="wc_b"]');
    await flush();
    dialogButton(f.container, "恢复")?.click();
    await flush();
    const sent = f.calls.filter((c) => c.method === "nexus.work.control");
    assert.ok(sent.every((c) => c.params?.controlId === "wc_b"));
    assert.equal(sent.length, 2);
  });

  it("needs a reason to reopen, and reloads with a notice when the work changed underneath", async () => {
    const ended = work("w1", {
      state: {
        primary: "ended_incomplete",
        flags: [],
        reasons: [],
        nextStep: { kind: "none" },
        evaluationVersion: 1,
      },
      terminal: {
        id: "wt",
        reason: "stop",
        resultAtClose: "stopped_before_completion",
        recordedAt: NOW,
      },
    });
    const f = mount(
      { view: "works" },
      {
        "nexus.work.list": { works: [ended], total: 1, offset: 0 },
        "nexus.work.get": { ...ended, links: [], events: [], controls: [] },
        "nexus.work.control": (params?: Record<string, unknown>) =>
          params?.dryRun === true
            ? { outcome: "preview", action: "reopen" }
            : { outcome: "reopened" },
        "nexus.work.update": Object.assign(new Error("the work changed; reload it"), {
          code: "nexus_revision_conflict",
        }),
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="work-reopen"]');
    await flush();
    const reopen = () => dialogButton(f.container, "重新打开");
    assert.ok(reopen()?.disabled, "no reason yet");
    const box = q(f.container, ".nx-dialog textarea") as HTMLTextAreaElement;
    box.value = "还要订酒店";
    box.dispatchEvent(new Event("input"));
    assert.equal(reopen()?.disabled, false);
    reopen()?.click();
    await flush();
    const sent = f.calls.findLast((c) => c.method === "nexus.work.control");
    assert.equal(sent?.params?.reopenBasis, "还要订酒店");
    // A stale rename closes the dialog and says the work changed.
    click(f.container, 'button[data-nx-act="work-rename"]');
    const input = q(f.container, ".nx-dialog input") as HTMLInputElement;
    input.value = "新标题";
    input.dispatchEvent(new Event("input"));
    dialogButton(f.container, "保存")?.click();
    await flush();
    assert.equal(q(f.container, ".nx-dialog"), null);
    assert.match(q(f.container, ".nx-notice")?.textContent ?? "", /刚刚有变化/);
  });

  it("explains a refused delete in words", async () => {
    const f = mount(
      { view: "works" },
      {
        "nexus.work.delete": Object.assign(
          new Error("stop or finish the work's active tasks first"),
          { code: "nexus_work_has_active_tasks" },
        ),
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="work-delete"]');
    dialogButton(f.container, "删除")?.click();
    await flush();
    assert.match(q(f.container, ".nx-dialog .error")?.textContent ?? "", /还有进行中的步骤/);
  });

  it("searches in place, on Enter or after a short pause, keeping the state filter and leaving the address alone", async () => {
    const f = mount({ view: "works", state: "needs_you" });
    await flush();
    const input = q(f.container, ".nx-search-slot .nx-wsearch input") as HTMLInputElement;
    assert.ok(input);
    const lastList = () => f.calls.findLast((c) => c.method === "nexus.work.list");
    input.value = "机票";
    input.dispatchEvent(new Event("input"));
    input.form?.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    assert.equal(lastList()?.params?.keyword, "机票");
    assert.deepEqual(lastList()?.params?.states, ["needs_you"]);
    // Typing alone applies after a pause.
    input.value = "酒店";
    input.dispatchEvent(new Event("input"));
    await wait(500);
    assert.equal(lastList()?.params?.keyword, "酒店");
    // A search is a state of the list, not a place to go: the host is never navigated (it would redraw and jump).
    await wait(900);
    assert.equal(f.opened.length, 0);
    // A reload (an event from the server, say) keeps the search instead of falling back to the address.
    f.events.get("plugin.nexus-agent-core.work_changed")?.();
    await wait(600);
    assert.equal(lastList()?.params?.keyword, "酒店");
    assert.equal((q(f.container, ".nx-wsearch input") as HTMLInputElement).value, "酒店");
    // Picking a row navigates, and the link carries the search and the state.
    click(f.container, "a.nx-wrow");
    assert.deepEqual(f.opened.at(-1)?.params, {
      view: "work",
      work: "w1",
      state: "needs_you",
      q: "酒店",
    });
  });

  it("waits for the input method: pinyin being composed is not a query, and the box is left alone", async () => {
    const f = mount({ view: "works" });
    await flush();
    const input = q(f.container, ".nx-wsearch input") as HTMLInputElement;
    const lists = () => f.calls.filter((c) => c.method === "nexus.work.list").length;
    const before = lists();
    input.dispatchEvent(new Event("compositionstart"));
    for (const partial of ["j", "ji", "ji p", "ji pi"]) {
      input.value = partial;
      input.dispatchEvent(new Event("input"));
      await wait(450);
    }
    input.form?.dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(lists(), before, "nothing is read while composing");
    // A reload in the middle of a composition must not write into the box either.
    f.events.get("plugin.nexus-agent-core.work_changed")?.();
    await wait(600);
    assert.equal(input.value, "ji pi");
    input.value = "机票";
    input.dispatchEvent(new Event("compositionend"));
    input.dispatchEvent(new Event("input"));
    await wait(500);
    assert.equal(f.calls.findLast((c) => c.method === "nexus.work.list")?.params?.keyword, "机票");
    assert.equal(input.value, "机票");
  });

  it("shows the keyword of the route in the box and keeps it across a reload", async () => {
    const f = mount({ view: "works", q: "机票" });
    await flush();
    const input = q(f.container, ".nx-wsearch input") as HTMLInputElement;
    assert.equal(input.value, "机票");
    input.value = "机票 北京";
    f.events.get("plugin.nexus-agent-core.work_changed")?.();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
    await flush();
    const again = q(f.container, ".nx-wsearch input") as HTMLInputElement;
    assert.equal(again, input);
    assert.equal(again.value, "机票 北京");
    const list = f.calls.findLast((c) => c.method === "nexus.work.list");
    assert.equal(list?.params?.keyword, "机票");
  });

  it("puts the waiting decision on the row and the ask card, and opens it through the decision dialog", async () => {
    const decision = {
      id: "d1",
      taskId: "t1",
      decisionType: "approval",
      riskTier: "R1",
      question: "购买东航 MU5331？",
      facts: { 价格: "1860" },
      options: null,
      unknowns: null,
      policies: [],
      deadlineAt: null,
      status: "pending",
      effectKind: "external",
      actionIds: [],
    };
    const f = mount({ view: "works" }, { "nexus.decision.list": { decisions: [decision] } });
    await flush();
    assert.match(q(f.container, "a.nx-wrow .nx-wnx")?.textContent ?? "", /购买东航 MU5331？/);
    assert.match(q(f.container, ".nx-ask")?.textContent ?? "", /价格.*1860/);
    click(f.container, '.nx-ask button[data-nx-act="decision"]');
    assert.ok(q(f.container, ".nx-dialog"));
    assert.match(q(f.container, ".nx-dialog")?.textContent ?? "", /购买东航 MU5331？/);
  });

  it("still shows the page when the decisions cannot be read", async () => {
    const f = mount(
      { view: "works" },
      { "nexus.decision.list": Object.assign(new Error("denied"), { code: "nexus_denied" }) },
    );
    await flush();
    assert.equal(f.container.querySelectorAll("a.nx-wrow").length, 2);
    // The card falls back to the Work's own next step; there is just no decision to open.
    assert.match(q(f.container, ".nx-ask")?.textContent ?? "", /有一件事等你决定/);
    assert.equal(q(f.container, 'button[data-nx-act="decision"]'), null);
  });

  it("reads 50 rows a page and loads the next page when the end of the list comes into view", async () => {
    const everything = Array.from({ length: 120 }, (_, i) =>
      work(`w${String(i).padStart(3, "0")}`),
    );
    const watchers: Array<{ fire: () => void }> = [];
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(private readonly callback: IntersectionObserverCallback) {
        watchers.push({
          fire: () =>
            this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never),
        });
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
    try {
      const f = mount(
        { view: "works" },
        {
          "nexus.work.list": (params?: Record<string, unknown>) => ({
            works: everything.slice(
              Number(params?.offset ?? 0),
              Number(params?.offset ?? 0) + Number(params?.limit),
            ),
            total: everything.length,
          }),
        },
      );
      await flush();
      const lists = () => f.calls.filter((c) => c.method === "nexus.work.list");
      assert.equal(lists()[0]?.params?.limit, 50);
      assert.equal(lists()[0]?.params?.order, "state");
      assert.equal(f.container.querySelectorAll("a.nx-wrow").length, 50);
      assert.match(q(f.container, ".nx-wload button")?.textContent ?? "", /已显示 50\/120/);
      watchers.at(-1)?.fire();
      await flush();
      assert.equal(lists().at(-1)?.params?.offset, 50);
      assert.equal(f.container.querySelectorAll("a.nx-wrow").length, 100);
      // Rows added later are clickable like the first ones (one delegated handler), and the heading is not repeated.
      assert.equal(f.container.querySelectorAll(".nx-gh").length, 1);
      f.container.querySelectorAll<HTMLElement>("a.nx-wrow")[99]?.click();
      assert.equal(f.opened.at(-1)?.params?.work, "w099");
      watchers.at(-1)?.fire();
      await flush();
      assert.equal(f.container.querySelectorAll("a.nx-wrow").length, 120);
      assert.equal(q(f.container, ".nx-wload"), null);
      // Nothing more to ask for.
      const asked = lists().length;
      watchers.at(-1)?.fire();
      await flush();
      assert.equal(lists().length, asked);
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });

  it("offers a button when the page cannot watch the scroll, and retries after a failure", async () => {
    const everything = Array.from({ length: 70 }, (_, i) => work(`w${String(i).padStart(3, "0")}`));
    let failNext = false;
    const f = mount(
      { view: "works" },
      {
        "nexus.work.list": (params?: Record<string, unknown>) => {
          if (Number(params?.offset ?? 0) > 0 && failNext) {
            failNext = false;
            throw new Error("down");
          }
          return {
            works: everything.slice(
              Number(params?.offset ?? 0),
              Number(params?.offset ?? 0) + Number(params?.limit),
            ),
            total: everything.length,
          };
        },
      },
    );
    await flush();
    failNext = true;
    click(f.container, ".nx-wload button");
    await flush();
    assert.equal(f.container.querySelectorAll("a.nx-wrow").length, 50);
    assert.match(q(f.container, ".nx-wload button")?.textContent ?? "", /加载失败/);
    click(f.container, ".nx-wload button");
    await flush();
    assert.equal(f.container.querySelectorAll("a.nx-wrow").length, 70);
  });

  it("keeps the pages already loaded, and the scroll position, when the page reloads", async () => {
    const everything = Array.from({ length: 120 }, (_, i) =>
      work(`w${String(i).padStart(3, "0")}`),
    );
    const f = mount(
      { view: "works" },
      {
        "nexus.work.list": (params?: Record<string, unknown>) => ({
          works: everything.slice(
            Number(params?.offset ?? 0),
            Number(params?.offset ?? 0) + Number(params?.limit),
          ),
          total: everything.length,
        }),
      },
    );
    await flush();
    click(f.container, ".nx-wload button");
    await flush();
    assert.equal(f.container.querySelectorAll("a.nx-wrow").length, 100);
    f.events.get("plugin.nexus-agent-core.work_changed")?.();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
    await flush();
    const reload = f.calls.findLast((c) => c.method === "nexus.work.list");
    // One request for everything already shown, not the first page again.
    assert.equal(reload?.params?.offset, 0);
    assert.equal(reload?.params?.limit, 100);
    assert.equal(f.container.querySelectorAll("a.nx-wrow").length, 100);
  });

  it("changes the list in place while searching: the detail pane and the box are not rebuilt", async () => {
    const f = mount({ view: "works" });
    await flush();
    const detail = q(f.container, ".nx-dw");
    const input = q(f.container, ".nx-wsearch input") as HTMLInputElement;
    const getsBefore = f.calls.filter((c) => c.method === "nexus.work.get").length;
    const countsBefore = f.calls.filter((c) => c.method === "nexus.work.counts").length;
    input.value = "机票";
    input.form?.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    assert.equal(f.calls.findLast((c) => c.method === "nexus.work.list")?.params?.keyword, "机票");
    // The segments follow the keyword in their links; the rest of the page is the very same nodes.
    assert.match(q(f.container, ".nx-seg a")?.getAttribute("href") ?? "", /q=%E6%9C%BA%E7%A5%A8/);
    assert.equal(q(f.container, ".nx-dw"), detail);
    assert.equal(q(f.container, ".nx-wsearch input"), input);
    assert.equal(f.calls.filter((c) => c.method === "nexus.work.get").length, getsBefore);
    // The numbers beside the segments are counted over what the search finds: one request, with the keyword.
    const counted = f.calls.filter((c) => c.method === "nexus.work.counts");
    assert.equal(counted.length, countsBefore + 1);
    assert.equal(counted.at(-1)?.params?.keyword, "机票");
    const numbers = [...f.container.querySelectorAll(".nx-seg a")].map(
      (a) => `${a.firstChild?.textContent}${a.querySelector(".nx-n")?.textContent}`,
    );
    assert.deepEqual(numbers, ["全部1", "待你处理0", "受阻0", "进行中1", "已完成0", "已结束0"]);
    // The greeting still speaks for the whole account.
    assert.match(q(f.container, ".nx-hello")?.textContent ?? "", /有 1 件待你处理/);
    assert.equal(f.opened.length, 0);
    // The address changing for another reason (the back button, a link) decides again and ends the search.
    f.handle?.update?.({ ...f.context, props: { view: "works", state: "done" } });
    await flush();
    assert.ok(f.calls.filter((c) => c.method === "nexus.work.counts").length > countsBefore);
    assert.equal(
      f.calls.findLast((c) => c.method === "nexus.work.list")?.params?.keyword,
      undefined,
    );
    assert.equal((q(f.container, ".nx-wsearch input") as HTMLInputElement).value, "");
  });

  it("clearing the filter from the empty list works while a search is in place", async () => {
    const f = mount({ view: "works" }, { "nexus.work.list": { works: [], total: 0 } });
    await flush();
    const input = q(f.container, ".nx-wsearch input") as HTMLInputElement;
    input.value = "nothing";
    input.form?.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    assert.match(q(f.container, ".nx-rows")?.textContent ?? "", /当前筛选下没有工作/);
    const before = f.calls.filter((c) => c.method === "nexus.work.counts").length;
    // The link goes to the address the host already has: the page reloads itself without the search.
    click(f.container, ".nx-rows a");
    await flush();
    assert.ok(f.calls.filter((c) => c.method === "nexus.work.counts").length > before);
    assert.equal(
      f.calls.findLast((c) => c.method === "nexus.work.list")?.params?.keyword,
      undefined,
    );
    assert.equal((q(f.container, ".nx-wsearch input") as HTMLInputElement).value, "");
  });

  it("reloads when a work changes elsewhere", async () => {
    const f = mount({ view: "works" });
    await flush();
    const before = f.calls.filter((c) => c.method === "nexus.work.list").length;
    f.events.get("plugin.nexus-agent-core.work_changed")?.();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
    await flush();
    assert.ok(f.calls.filter((c) => c.method === "nexus.work.list").length > before);
  });
});

describe("commitments in the work page", () => {
  const commitment = (over: Record<string, unknown> = {}) => ({
    ownerId: "o",
    id: "cm_one",
    requirementText: "把合同发给我",
    responsibleSelf: false,
    responsibleRaw: "小王",
    responsibleName: null,
    dueState: "pending",
    dueAt: null,
    communicationState: "draft",
    acceptanceState: "unknown",
    acceptanceBasisKind: null,
    lifecycle: "open",
    verification: "unverified",
    resolutionBasis: null,
    resolutionReason: null,
    cancelReason: null,
    nextStep: null,
    overdue: false,
    revision: 4,
    ...over,
  });
  const served = (items: unknown[]) => ({
    "nexus.commitment.list": { items, total: items.length },
  });
  const typeInto = (node: HTMLElement | null | undefined, value: string) => {
    assert.ok(node, "missing field");
    (node as HTMLInputElement).value = value;
    node.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("shows nothing when commitments are switched off", async () => {
    const f = mount({ view: "works" });
    await flush();
    assert.doesNotMatch(f.container.textContent ?? "", /承诺事项/);
  });

  it("lists the commitments the work cites", async () => {
    const f = mount(
      { view: "works" },
      served([{ commitment: commitment(), role: "required", linkId: "wl_1" }]),
    );
    await flush();
    assert.match(q(f.container, ".nx-cm")?.textContent ?? "", /把合同发给我/);
    const asked = f.calls.find((c) => c.method === "nexus.commitment.list");
    assert.equal(asked?.params?.workId, "w1");
  });

  it("records a commitment for the work, once, with the request id and the role", async () => {
    const f = mount(
      { view: "works" },
      {
        ...served([]),
        "nexus.commitment.create": { outcome: "created", commitment: { id: "cm_new" } },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="cm-new"]');
    const save = () => dialogButton(f.container, "保存");
    assert.ok(save()?.disabled, "needs the text and a name");
    typeInto(q(f.container, ".nx-dialog textarea"), "周五前交报价");
    typeInto(q(f.container, ".nx-dialog input"), "小李");
    assert.equal(save()?.disabled, false);
    save()?.click();
    await flush();
    const made = f.calls.find((c) => c.method === "nexus.commitment.create");
    assert.equal(made?.params?.requirementText, "周五前交报价");
    assert.deepEqual(made?.params?.responsible, { kind: "name", name: "小李" });
    assert.deepEqual(made?.params?.due, { kind: "pending" });
    assert.equal(made?.params?.workId, "w1");
    assert.equal(made?.params?.workRole, "required");
    assert.match(String(made?.params?.requestId), /^d[a-z0-9]+$/);
    assert.equal(q(f.container, ".nx-dialog"), null);
  });

  it("previews what a hand close reaches and needs a reason", async () => {
    const f = mount(
      { view: "works" },
      {
        ...served([{ commitment: commitment(), role: "required", linkId: "wl_1" }]),
        "nexus.commitment.resolve": (params?: Record<string, unknown>) =>
          params?.dryRun === true
            ? {
                outcome: "preview",
                impact: {
                  works: [{ workId: "w1", title: "签合同", role: "required" }],
                  plansToWrapUp: [],
                },
              }
            : { outcome: "applied" },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="cm-resolve"][data-nx-id="cm_one"]');
    const confirm = () => dialogButton(f.container, "注明原因结案");
    assert.ok(confirm()?.disabled, "no preview and no reason yet");
    await flush();
    assert.match(q(f.container, ".nx-dialog")?.textContent ?? "", /签合同/);
    assert.ok(confirm()?.disabled, "still needs a reason");
    typeInto(q(f.container, ".nx-dialog textarea"), "对方口头确认已交付");
    assert.equal(confirm()?.disabled, false);
    confirm()?.click();
    await flush();
    const applied = f.calls.findLast((c) => c.method === "nexus.commitment.resolve");
    assert.equal(applied?.params?.dryRun, undefined);
    assert.equal(applied?.params?.reason, "对方口头确认已交付");
    assert.equal(applied?.params?.expectedRevision, 4);
    assert.equal(q(f.container, ".nx-dialog"), null);
  });

  it("reloads with a notice when the commitment changed underneath", async () => {
    const f = mount(
      { view: "works" },
      {
        ...served([{ commitment: commitment(), role: "required", linkId: "wl_1" }]),
        "nexus.commitment.cancel": (params?: Record<string, unknown>) => {
          if (params?.dryRun === true) {
            return { outcome: "preview", impact: { works: [], plansToWrapUp: [] } };
          }
          throw Object.assign(new Error("stale"), { code: "nexus_revision_conflict" });
        },
      },
    );
    await flush();
    click(f.container, 'button[data-nx-act="cm-cancel"][data-nx-id="cm_one"]');
    await flush();
    typeInto(q(f.container, ".nx-dialog textarea"), "不需要了");
    dialogButton(f.container, "取消承诺")?.click();
    await flush();
    assert.equal(q(f.container, ".nx-dialog"), null);
    assert.match(q(f.container, ".nx-notice")?.textContent ?? "", /已经是别的状态/);
  });
});

describe("rail pages without function yet", () => {
  const pages = [
    ["goals", "提升英语口语表达"],
    ["library", "资料库"],
    ["status", "状态"],
  ] as const;

  for (const [hub, sample] of pages) {
    it(`shows the ${hub} design as a static page, with no data read and no inner navigation`, async () => {
      const f = mount({ view: "hub", hub });
      await flush();
      const page = q(f.container, ".nexus-page");
      assert.ok(page?.classList.contains("nx-rail"));
      assert.ok(q(f.container, ".nx-dz .app"), "the design is mounted");
      assert.ok((f.container.textContent ?? "").includes(sample));
      assert.equal(q(f.container, ".nx-dz nav.rail"), null, "the prototype's own rail is gone");
      assert.equal(q(f.container, ".nx-dz script"), null);
      assert.equal(f.container.querySelector("[onclick]"), null);
      assert.deepEqual(
        f.calls.filter(
          (c) => c.method.startsWith("nexus.work.") || c.method.startsWith("nexus.task."),
        ),
        [],
      );
    });
  }

  it("falls back to the task list for a page it does not know", async () => {
    const f = mount({ view: "hub", hub: "nowhere" });
    await flush();
    assert.equal(q(f.container, ".nx-dz"), null);
    assert.equal(q(f.container, ".nexus-page")?.classList.contains("nx-rail"), false);
  });
});
