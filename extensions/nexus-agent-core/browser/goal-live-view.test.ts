// G2.1: the open goal-detail dialog follows the data behind it, the Task picker can search, and statuses are in words.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buttonByText,
  click,
  type Data,
  fixture,
  flush,
  goal,
  PROPS,
  type,
} from "./goals-view-kit.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const claimMetric = (claimState: string) => ({
  id: "GM2",
  goalId: "G1ABC",
  name: "已记录时长",
  unit: "小时",
  direction: "up",
  target: 40,
  current: 12,
  asOf: 1_700_000_000_000,
  source: "claim",
  taskId: "T1",
  claimId: "C1",
  reachedAt: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  pointer: {
    taskGone: false,
    taskStatus: "executing",
    taskTitle: "订琴房",
    claimState,
    claimGone: false,
  },
});

const detailWith = (claimState: string) => ({
  goal: goal({ category: "interests", sensitivity: "normal" }),
  parent: null,
  children: [],
  entries: [],
  entriesTruncated: false,
  links: [],
  metrics: [claimMetric(claimState)],
});

const TASKS = [
  { id: "T1", title: "订琴房", status: "executing" },
  { id: "T2", title: "买琴谱", status: "succeeded" },
];

async function open(data: Data) {
  // The same object, so a test can change `data.detail` after the dialog opened.
  data.tasks ??= TASKS;
  const f = fixture(data, PROPS);
  await flush();
  click(f.container, 'button[data-nx-act="goal-open"]');
  await flush();
  return f;
}

const settle = async (ms = 500) => {
  vi.advanceTimersByTime(ms);
  await flush();
};

describe("an open goal detail follows its data (G2.1)", () => {
  it("redraws when a claim changes, so a retracted claim shows as refuted without reopening", async () => {
    const data: Data = { detail: detailWith("ASSERTED") };
    const f = await open(data);
    expect(f.dialog().textContent).toContain("已声明");
    expect(f.dialog().textContent).not.toContain("被反驳");
    data.detail = detailWith("REFUTED");
    f.emit("claim_changed");
    await settle();
    expect(f.container.querySelectorAll(".nx-dialog")).toHaveLength(1);
    expect(f.dialog().textContent).toContain("被反驳");
  });

  it("redraws on task and goal events too, once per burst", async () => {
    const data: Data = { detail: detailWith("ASSERTED") };
    const f = await open(data);
    const gets = () => f.calls.filter((call) => call.method === "nexus.goal.get").length;
    const before = gets();
    f.emit("task_changed");
    f.emit("goal_changed");
    f.emit("claim_changed");
    await settle();
    expect(gets()).toBe(before + 1);
    expect(f.container.querySelectorAll(".nx-dialog")).toHaveLength(1);
  });

  it("ignores events that cannot change it, and does not open a dialog that was closed", async () => {
    const data: Data = { detail: detailWith("ASSERTED") };
    const f = await open(data);
    const gets = () => f.calls.filter((call) => call.method === "nexus.goal.get").length;
    const before = gets();
    f.emit("vault_changed");
    await settle();
    expect(gets()).toBe(before);
    click(f.dialog(), ".nx-x");
    f.emit("claim_changed");
    await settle();
    expect(f.container.querySelector(".nx-dialog")).toBeNull();
    expect(gets()).toBe(before);
  });

  it("does not redraw over a form the user is typing in", async () => {
    const data: Data = { detail: detailWith("ASSERTED") };
    const f = await open(data);
    (f.dialog().querySelector(".gl-more") as HTMLElement).click();
    const rename = Array.from(f.dialog().querySelectorAll<HTMLElement>("*")).find(
      (node) => node.textContent === "重命名" && node.children.length === 0,
    );
    rename?.click();
    await flush();
    // The rename form replaced the detail; typing in it must survive an event.
    const input = f.dialog().querySelector("input") as HTMLInputElement;
    type(input, "新标题");
    f.emit("claim_changed");
    await settle();
    expect((f.dialog().querySelector("input") as HTMLInputElement).value).toBe("新标题");
  });
});

describe("the Task picker (G2.1)", () => {
  const openMetricForm = async (data: Data) => {
    const f = await open(data);
    (buttonByText(f.dialog(), "添加度量") as HTMLButtonElement).click();
    await flush();
    return f;
  };
  const noMetrics = () => ({ ...detailWith("ASSERTED"), metrics: [] });

  it("shows task statuses in words", async () => {
    const f = await openMetricForm({ detail: noMetrics() });
    const labels = Array.from(f.dialog().querySelectorAll("option")).map((o) => o.textContent);
    expect(labels).toContain("订琴房 · 执行中");
    expect(labels).toContain("买琴谱 · 已完成");
    expect(labels.join("|")).not.toContain("executing");
  });

  it("asks the gateway for matches while typing", async () => {
    const f = await openMetricForm({ detail: noMetrics() });
    const search = f.dialog().querySelector('input[type="search"]') as HTMLInputElement;
    expect(search).not.toBeNull();
    type(search, "琴谱");
    await flush();
    const listCalls = f.calls.filter((call) => call.method === "nexus.task.list");
    expect(listCalls.at(-1)?.params).toMatchObject({
      keyword: "琴谱",
      limit: 100,
      includeClosed: true,
    });
    // Clearing the box goes back to the unfiltered list (no keyword sent).
    type(search, "");
    await flush();
    const last = f.calls.findLast((call) => call.method === "nexus.task.list");
    expect(last?.params).not.toHaveProperty("keyword");
  });

  it("keeps the chosen task selectable after a search no longer lists it", async () => {
    const f = await openMetricForm({ detail: noMetrics() });
    const dlg = f.dialog();
    const selects = () => Array.from(dlg.querySelectorAll("select"));
    const taskSelect = selects()[2] as HTMLSelectElement;
    taskSelect.value = "T1";
    taskSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const search = dlg.querySelector('input[type="search"]') as HTMLInputElement;
    type(search, "琴谱");
    await flush();
    const options = Array.from((selects()[2] as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toContain("T1");
    expect((selects()[2] as HTMLSelectElement).value).toBe("T1");
  });
});
