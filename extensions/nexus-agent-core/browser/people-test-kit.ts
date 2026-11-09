// Shared fixtures for the People page tests: people, commitments, the page mounted on a fake host, and small DOM helpers.
import assert from "node:assert/strict";
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { createNexusPage, NEXUS_RAIL_PAGE_ID } from "./page.ts";

export const NOW = Date.now();

export const record = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  ownerId: "o",
  id,
  kind: "person",
  displayName: name,
  confirmation: "confirmed",
  origin: "user",
  lifecycle: "live",
  inactiveReason: null,
  inactiveAt: null,
  isSelf: false,
  aliases: [],
  relation: { relation: "client", scopeLabel: "华东" },
  contacts: [],
  revision: 3,
  createdAt: NOW - 5000,
  updatedAt: NOW - 1000,
  ...over,
});
export const summary = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  ...record(id, name, over),
  unresolved: 2,
  overdue: 1,
  needsConfirmation: 2,
  earliestDueAt: NOW - 100,
  ...over,
});
export const commitment = (id: string, text: string, over: Record<string, unknown> = {}) => ({
  ownerId: "o",
  id,
  requirementText: text,
  responsibleSelf: false,
  responsibleCounterpartId: "cp_1",
  responsibleRaw: "钱经理",
  responsibleName: "钱经理",
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
export const viewOf = (
  counterpart: ReturnType<typeof record>,
  over: Record<string, unknown> = {},
) => ({
  counterpart,
  responsible: [commitment("cm_a", "交报价")],
  history: [commitment("cm_old", "交图纸", { lifecycle: "resolved" })],
  related: [
    { workId: "w_1", title: "华东项目", lifecycle: "live", updatedAt: NOW, via: "commitment" },
  ],
  counts: { unresolved: 2, overdue: 1, needsConfirmation: 2 },
  ...over,
});

/** What the gateway answers to `nexus.counterpart.list`: the keyword, the attention filter and the paging are the server's. */
export function listReply(
  everyone: ReturnType<typeof summary>[],
  params: Record<string, unknown> | undefined,
  stopped: ReturnType<typeof summary>[] = [],
) {
  const needsLook = (p: ReturnType<typeof summary>) => p.overdue > 0 || p.needsConfirmation > 0;
  const keyword = typeof params?.keyword === "string" ? params.keyword : "";
  const offset = typeof params?.offset === "number" ? params.offset : 0;
  const limit = typeof params?.limit === "number" ? params.limit : 100;
  // Like the server: the counts follow the search, the rows follow the segment as well.
  const found = (list: ReturnType<typeof summary>[]) =>
    list.filter((p) => keyword === "" || p.displayName.includes(keyword));
  const live = found(everyone);
  const items = (params?.lifecycle === "inactive" ? found(stopped) : live).filter(
    (p) => params?.attention !== true || needsLook(p),
  );
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    counts: {
      all: live.length,
      attention: live.filter(needsLook).length,
      inactive: found(stopped).length,
    },
  };
}

export type Reply = unknown | ((params?: Record<string, unknown>) => unknown);
export type Calls = Array<{ method: string; params: Record<string, unknown> | undefined }>;

export function mount(
  props: Record<string, string>,
  replies: Record<string, Reply> = {},
  options: { canWrite?: boolean } = {},
) {
  const calls: Calls = [];
  const opened: Array<{ id: string; params?: Record<string, string> }> = [];
  const events = new Map<string, () => void>();
  const people = [
    summary("cp_1", "钱经理"),
    summary("cp_2", "孙工", { overdue: 0, needsConfirmation: 0 }),
  ];
  const served: Record<string, Reply> = {
    "nexus.counterpart.list": (params?: Record<string, unknown>) => listReply(people, params),
    "nexus.counterpart.pending": { groups: [] },
    "nexus.counterpart.get": (params?: Record<string, unknown>) => ({
      outcome: "ok",
      view: viewOf(
        record(String(params?.counterpartId), params?.counterpartId === "cp_2" ? "孙工" : "钱经理"),
      ),
    }),
    "nexus.work.list": { works: [{ work: { id: "w_1", title: "华东项目" } }], total: 1 },
    ...replies,
  };
  const request = async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, params });
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
  const handle = createNexusPage(NEXUS_RAIL_PAGE_ID)(container, context);
  return { container, calls, opened, events, handle, context };
}

export const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};
export const q = (container: HTMLElement, selector: string) =>
  container.querySelector<HTMLElement>(selector);
export const click = (container: HTMLElement, selector: string) => {
  const el = q(container, selector);
  assert.ok(el, `missing ${selector}`);
  el.click();
};
export const dialogButton = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>(".nx-dialog button")].find(
    (b) => b.textContent === text,
  );
export const typeInto = (node: HTMLElement | null | undefined, value: string) => {
  assert.ok(node, "missing field");
  (node as HTMLInputElement).value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
};
export const choose = (node: HTMLElement | null | undefined, value: string) => {
  assert.ok(node, "missing select");
  (node as HTMLSelectElement).value = value;
  node.dispatchEvent(new Event("change", { bubbles: true }));
};
