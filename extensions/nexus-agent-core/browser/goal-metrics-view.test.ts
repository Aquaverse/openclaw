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

describe("goal progress and metrics (G2)", () => {
  const metric = (overrides: Record<string, unknown> = {}) => ({
    id: "GM1",
    goalId: "G1ABC",
    name: "练习",
    unit: "小时",
    direction: "up",
    target: 50,
    current: 20,
    asOf: 1_700_000_000_000,
    source: "manual",
    taskId: null,
    claimId: null,
    reachedAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  });
  const detail = (extra: Record<string, unknown> = {}, goalOver: Record<string, unknown> = {}) => ({
    goal: goal({ category: "interests", sensitivity: "normal", ...goalOver }),
    parent: null,
    children: [],
    entries: [],
    entriesTruncated: false,
    links: [],
    metrics: [],
    ...extra,
  });
  const TASKS = [{ id: "T1", title: "订琴房", status: "executing" }];
  const CLAIMS = [{ id: "C1", subject: "练习时长", predicate: "累计", state: "ASSERTED" }];
  const choose = (select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const open = async (data: Data, canWrite = true) => {
    const f = fixture({ tasks: TASKS, claims: CLAIMS, ...data }, PROPS, canWrite);
    await flush();
    click(f.container, 'button[data-nx-act="goal-open"]');
    await flush();
    return f;
  };

  it("lists self-reported and claim-backed metrics with the live state of the claim", async () => {
    const f = await open({
      detail: detail({
        metrics: [
          metric(),
          metric({
            id: "GM2",
            name: "已记录时长",
            source: "claim",
            taskId: "T1",
            claimId: "C1",
            current: 12,
            target: 40,
            pointer: {
              taskGone: false,
              taskStatus: "executing",
              taskTitle: "订琴房",
              claimState: "REFUTED",
              claimGone: false,
            },
          }),
        ],
      }),
    });
    const text = f.dialog().textContent ?? "";
    expect(text).toContain("20 / 50 小时");
    expect(text).toContain("自述");
    expect(text).toContain("12 / 40 小时");
    expect(text).toContain("被反驳");
    expect(f.dialog().querySelectorAll(".gl-bar").length).toBe(2);
  });

  it('shows the live status next to an entry and a linked Task, and "removed" when they are gone', async () => {
    const entry = (over: Record<string, unknown>) => ({
      id: "GE1",
      goalId: "G1ABC",
      kind: "note",
      text: "订好了琴房",
      author: "user",
      effectiveAt: 1_700_000_000_000,
      createdAt: 1_700_000_000_000,
      taskId: "T1",
      claimId: "C1",
      retractedAt: null,
      ...over,
    });
    const f = await open({
      detail: detail({
        entries: [
          entry({
            pointer: {
              taskGone: false,
              taskStatus: "executing",
              taskTitle: "订琴房",
              claimState: "VERIFIED",
              claimGone: false,
            },
          }),
          entry({
            id: "GE2",
            text: "另一条",
            pointer: {
              taskGone: true,
              taskStatus: null,
              taskTitle: null,
              claimState: null,
              claimGone: true,
            },
          }),
          entry({ id: "GE3", text: "没有指针", taskId: null, claimId: null }),
        ],
        links: [
          {
            id: "GK1",
            goalId: "G1ABC",
            kind: "task",
            refId: "T1",
            createdAt: 1,
            targetGone: false,
            task: { status: "succeeded", title: "订琴房" },
          },
        ],
      }),
    });
    const text = f.dialog().textContent ?? "";
    expect(text).toContain("已核验");
    expect(text).toContain("事项：订琴房");
    expect(text).toContain("事项已清除");
    expect(text).toContain("事项：已完成");
    expect(f.dialog().querySelectorAll(".gl-entry .pill.muted").length).toBe(1);
  });

  it("adds a manual metric: the figures are numbers, the language goes along", async () => {
    const f = await open({ detail: detail() });
    (buttonByText(f.dialog(), "添加度量") as HTMLButtonElement).click();
    await flush();
    const dlg = f.dialog();
    const inputs = Array.from(dlg.querySelectorAll("input"));
    const save = buttonByText(dlg, "保存") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    type(inputs[0] as HTMLInputElement, "练习");
    type(inputs[1] as HTMLInputElement, "小时");
    type(inputs[2] as HTMLInputElement, "50");
    type(inputs[3] as HTMLInputElement, "1,200");
    save.click();
    await flush();
    expect(f.writes()).toEqual([
      {
        method: "nexus.goal.metric.set",
        params: {
          goalId: "G1ABC",
          source: "manual",
          name: "练习",
          unit: "小时",
          direction: "up",
          target: 50,
          current: 1200,
          lang: "zh",
        },
      },
    ]);
  });

  it("refuses a figure that is not a number and keeps the dialog open", async () => {
    const f = await open({ detail: detail() });
    (buttonByText(f.dialog(), "添加度量") as HTMLButtonElement).click();
    await flush();
    const dlg = f.dialog();
    const inputs = Array.from(dlg.querySelectorAll("input"));
    type(inputs[0] as HTMLInputElement, "练习");
    type(inputs[2] as HTMLInputElement, "很多");
    (buttonByText(dlg, "保存") as HTMLButtonElement).click();
    await flush();
    expect(f.writes()).toEqual([]);
    expect(f.dialog().querySelector(".error")?.textContent).toContain("请填写数字");
  });

  it("adds a claim-backed metric by choosing a Task and then one of its claims", async () => {
    const f = await open({ detail: detail() });
    (buttonByText(f.dialog(), "添加度量") as HTMLButtonElement).click();
    await flush();
    const dlg = f.dialog();
    const inputs = Array.from(dlg.querySelectorAll("input"));
    type(inputs[0] as HTMLInputElement, "已记录时长");
    type(inputs[2] as HTMLInputElement, "40");
    const selects = () => Array.from(dlg.querySelectorAll("select"));
    choose(selects()[1] as HTMLSelectElement, "claim");
    const save = buttonByText(dlg, "保存") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    choose(selects()[2] as HTMLSelectElement, "T1");
    await flush();
    expect(save.disabled).toBe(true);
    choose(selects()[3] as HTMLSelectElement, "C1");
    expect(save.disabled).toBe(false);
    save.click();
    await flush();
    const set = f.writes()[0];
    expect(set?.method).toBe("nexus.goal.metric.set");
    expect(set?.params).toMatchObject({
      source: "claim",
      taskId: "T1",
      claimId: "C1",
      name: "已记录时长",
      target: 40,
    });
    expect(set?.params).not.toHaveProperty("current");
  });

  it("a finance goal offers a manual figure only", async () => {
    const f = await open({ detail: detail({}, { category: "finance" }) });
    (buttonByText(f.dialog(), "添加度量") as HTMLButtonElement).click();
    await flush();
    const dlg = f.dialog();
    const source = Array.from(dlg.querySelectorAll("select"))[1] as HTMLSelectElement;
    expect(Array.from(source.options).map((o) => o.value)).toEqual(["manual"]);
    expect(dlg.textContent).toContain("只能自己填");
  });

  it("edits a metric by id without sending its source, and can remove it", async () => {
    const f = await open({ detail: detail({ metrics: [metric()] }) });
    (buttonByText(f.dialog(), "编辑") as HTMLButtonElement).click();
    await flush();
    const dlg = f.dialog();
    expect(dlg.querySelector("h2")?.textContent).toBe("编辑度量");
    const inputs = Array.from(dlg.querySelectorAll("input"));
    type(inputs[3] as HTMLInputElement, "30");
    (buttonByText(dlg, "保存") as HTMLButtonElement).click();
    await flush();
    const set = f.writes()[0];
    expect(set?.params).toMatchObject({ goalId: "G1ABC", metricId: "GM1", current: 30 });
    expect(set?.params).not.toHaveProperty("source");
    // the detail comes back after a save; remove from there
    (buttonByText(f.dialog(), "编辑") as HTMLButtonElement).click();
    await flush();
    (buttonByText(f.dialog(), "删除度量") as HTMLButtonElement).click();
    await flush();
    expect(f.writes().at(-1)).toEqual({
      method: "nexus.goal.metric.remove",
      params: { goalId: "G1ABC", metricId: "GM1" },
    });
  });

  it("says when the target was reached", async () => {
    const f = await open({ detail: detail({ metrics: [metric()] }), reached: true });
    (buttonByText(f.dialog(), "编辑") as HTMLButtonElement).click();
    await flush();
    const dlg = f.dialog();
    type(Array.from(dlg.querySelectorAll("input"))[3] as HTMLInputElement, "50");
    (buttonByText(dlg, "保存") as HTMLButtonElement).click();
    await flush();
    expect(f.notice()).toContain("已达到目标值");
  });

  it("a note can point at a Task and one of its claims", async () => {
    const f = await open({ detail: detail() });
    click(f.dialog(), ".gl-more");
    (buttonByText(f.dialog(), "添加记录") as HTMLButtonElement).click();
    await flush();
    const dlg = f.dialog();
    type(dlg.querySelector("textarea") as HTMLTextAreaElement, "订好了琴房");
    const selects = () => Array.from(dlg.querySelectorAll("select"));
    choose(selects()[0] as HTMLSelectElement, "T1");
    await flush();
    choose(selects()[1] as HTMLSelectElement, "C1");
    (buttonByText(dlg, "保存") as HTMLButtonElement).click();
    await flush();
    expect(f.writes()).toEqual([
      {
        method: "nexus.goal.entry.add",
        params: { goalId: "G1ABC", kind: "note", text: "订好了琴房", taskId: "T1", claimId: "C1" },
      },
    ]);
  });

  it("a plain note sends no pointer", async () => {
    const f = await open({ detail: detail() });
    click(f.dialog(), ".gl-more");
    (buttonByText(f.dialog(), "添加记录") as HTMLButtonElement).click();
    await flush();
    const dlg = f.dialog();
    type(dlg.querySelector("textarea") as HTMLTextAreaElement, "今天练了一小时");
    (buttonByText(dlg, "保存") as HTMLButtonElement).click();
    await flush();
    expect(f.writes()[0]?.params).toEqual({
      goalId: "G1ABC",
      kind: "note",
      text: "今天练了一小时",
    });
  });

  it("offers no metric buttons on a read-only connection", async () => {
    const f = await open({ detail: detail({ metrics: [metric()] }) }, false);
    expect(buttonByText(f.dialog(), "添加度量")).toBeUndefined();
    expect(buttonByText(f.dialog(), "编辑")).toBeUndefined();
    expect(f.dialog().textContent).toContain("20 / 50 小时");
  });
});
