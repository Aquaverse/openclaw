// Shared fixture of the Goals page tests (goals-view.test.ts, goal-metrics-view.test.ts): a page over a stubbed host with
// the goal API, plus small DOM helpers.
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { vi } from "vitest";
import { createNexusPage } from "./page.ts";

export const goal = (overrides: Record<string, unknown> = {}) => ({
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

export type Data = {
  /** Goals by status; the defaults are one active goal and nothing else. */
  active?: unknown[];
  proposed?: unknown[];
  completed?: unknown[];
  /** Turn the whole goal API off (an older gateway). */
  goals?: boolean;
  fail?: Record<string, Error>;
  detail?: unknown;
  /** Tasks and claims the pickers offer (G2). */
  tasks?: unknown[];
  claims?: unknown[];
  /** The metric write reports that the target was reached. */
  reached?: boolean;
  /** The page has a Control UI sessions slice (older hosts have none). */
  sessions?: boolean;
  createdKey?: string | null;
};

export function fixture(
  data: Data,
  props: Record<string, string>,
  canWrite = true,
  locale?: string,
) {
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
        return { tasks: data.tasks ?? [] };
      case "nexus.claim.list":
        return { claims: data.claims ?? [] };
      case "nexus.goal.metric.set":
        return { metric: {}, created: true, reachedNow: data.reached === true };
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
        (call) => !/\.(list|get|forFile|stats)$/.test(call.method) && call.method !== "chat.send",
      ),
    notice: () => container.querySelector(".nx-notice")?.textContent ?? "",
  };
}

export const flush = async () => {
  for (let index = 0; index < 16; index += 1) {
    await Promise.resolve();
  }
};
export const click = (root: ParentNode, selector: string) => {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) {
    throw new Error(`no element for ${selector}`);
  }
  el.click();
};
export const buttonByText = (root: ParentNode, text: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === text,
  );
export const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
export const PROPS = { view: "goals" };
