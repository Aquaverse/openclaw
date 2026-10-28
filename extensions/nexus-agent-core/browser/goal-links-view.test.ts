// G2.2: the console can link a Task to a goal and remove the link, and a note can link its Task in the same step.
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

const LINK = {
  id: "L1",
  goalId: "G1ABC",
  kind: "task",
  refId: "T1",
  createdAt: 1_700_000_000_000,
  targetGone: false,
  task: { status: "executing", title: "订琴房" },
};
const TASKS = [
  { id: "T1", title: "订琴房", status: "executing" },
  { id: "T2", title: "买琴谱", status: "succeeded" },
];
const detail = (links: unknown[] = [], goalOver: Record<string, unknown> = {}) => ({
  goal: goal({ category: "interests", sensitivity: "normal", ...goalOver }),
  parent: null,
  children: [],
  entries: [],
  entriesTruncated: false,
  links,
  metrics: [],
});
const refusal = (message: string, code = "nexus_conflict") =>
  Object.assign(new Error(message), { code });

async function open(data: Data, canWrite = true) {
  data.tasks ??= TASKS;
  const f = fixture(data, PROPS, canWrite);
  await flush();
  click(f.container, 'button[data-nx-act="goal-open"]');
  await flush();
  return f;
}
const choose = (select: HTMLSelectElement, value: string) => {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
};

describe("linking a Task to a goal (G2.2)", () => {
  it("adds a link by choosing a Task, then shows the detail again", async () => {
    const f = await open({ detail: detail() });
    (buttonByText(f.dialog(), "添加关联") as HTMLButtonElement).click();
    await flush();
    const dlg = f.dialog();
    expect(dlg.textContent).toContain("一个事项只能属于一个目标");
    const save = buttonByText(dlg, "关联") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    choose(dlg.querySelector("select") as HTMLSelectElement, "T2");
    expect(save.disabled).toBe(false);
    // A link is a Task only: the claim choice never appears, and no claim list is asked for.
    expect((dlg.querySelectorAll("select")[1] as HTMLElement).closest("label")?.hidden).toBe(true);
    expect(f.calls.some((call) => call.method === "nexus.claim.list")).toBe(false);
    save.click();
    await flush();
    expect(f.writes()).toEqual([
      { method: "nexus.goal.link.add", params: { goalId: "G1ABC", kind: "task", refId: "T2" } },
    ]);
    expect(f.notice()).toContain("已关联");
    // Back on the goal's detail.
    expect(f.dialog().textContent).toContain("添加关联");
  });

  it("says in words when the Task already belongs to another goal, and stays open", async () => {
    const f = await open({
      detail: detail(),
      fail: { "nexus.goal.link.add": refusal("the Task already belongs to another goal") },
    });
    (buttonByText(f.dialog(), "添加关联") as HTMLButtonElement).click();
    await flush();
    const dlg = f.dialog();
    choose(dlg.querySelector("select") as HTMLSelectElement, "T1");
    (buttonByText(dlg, "关联") as HTMLButtonElement).click();
    await flush();
    expect(dlg.querySelector(".error")?.textContent).toContain("已经属于另一个目标");
    expect(f.container.querySelector(".nx-dialog")).toBe(dlg);
  });

  it("cancelling returns to the detail without writing", async () => {
    const f = await open({ detail: detail() });
    (buttonByText(f.dialog(), "添加关联") as HTMLButtonElement).click();
    await flush();
    (buttonByText(f.dialog(), "取消") as HTMLButtonElement).click();
    await flush();
    expect(f.writes()).toHaveLength(0);
    expect(f.container.querySelectorAll(".nx-dialog")).toHaveLength(1);
    expect(f.dialog().textContent).toContain("添加关联");
  });

  it("removes a link only after confirmation", async () => {
    const f = await open({ detail: detail([LINK]) });
    expect(f.dialog().textContent).toContain("订琴房");
    (buttonByText(f.dialog(), "移除") as HTMLButtonElement).click();
    await flush();
    expect(f.writes()).toHaveLength(0);
    const dlg = f.dialog();
    expect(dlg.textContent).toContain("事项本身不受影响");
    (buttonByText(dlg, "移除") as HTMLButtonElement).click();
    await flush();
    expect(f.writes()).toEqual([
      { method: "nexus.goal.link.remove", params: { goalId: "G1ABC", linkId: "L1" } },
    ]);
    expect(f.notice()).toContain("已移除关联");
  });

  it("keeping the link: cancel in the remove dialog writes nothing", async () => {
    const f = await open({ detail: detail([LINK]) });
    (buttonByText(f.dialog(), "移除") as HTMLButtonElement).click();
    await flush();
    (buttonByText(f.dialog(), "取消") as HTMLButtonElement).click();
    await flush();
    expect(f.writes()).toHaveLength(0);
    expect(f.dialog().textContent).toContain("订琴房");
  });

  it("offers neither button on a read-only connection or for a proposed goal", async () => {
    const readOnly = await open({ detail: detail([LINK]) }, false);
    expect(buttonByText(readOnly.dialog(), "添加关联")).toBeUndefined();
    expect(buttonByText(readOnly.dialog(), "移除")).toBeUndefined();
    expect(readOnly.dialog().textContent).toContain("订琴房");
    document.body.replaceChildren();
    const proposed = await open({ detail: detail([], { status: "proposed" }) });
    expect(buttonByText(proposed.dialog(), "添加关联")).toBeUndefined();
  });
});

describe("a note that links its Task (G2.2)", () => {
  const openNote = async (data: Data) => {
    const f = await open({ detail: detail(), ...data });
    click(f.dialog(), ".gl-more");
    (buttonByText(f.dialog(), "添加记录") as HTMLButtonElement).click();
    await flush();
    return f;
  };
  const checkbox = (root: HTMLElement) =>
    root.querySelector('input[type="checkbox"]') as HTMLInputElement;

  it("offers the choice only once a Task is chosen, off by default", async () => {
    const f = await openNote({});
    const dlg = f.dialog();
    const row = checkbox(dlg).closest("label") as HTMLElement;
    expect(row.hidden).toBe(true);
    choose(dlg.querySelector("select") as HTMLSelectElement, "T1");
    await flush();
    expect(row.hidden).toBe(false);
    expect(checkbox(dlg).checked).toBe(false);
    type(dlg.querySelector("textarea") as HTMLTextAreaElement, "订好了");
    (buttonByText(dlg, "保存") as HTMLButtonElement).click();
    await flush();
    expect(f.writes().map((call) => call.method)).toEqual(["nexus.goal.entry.add"]);
  });

  it("saves the note and then links the Task when asked", async () => {
    const f = await openNote({});
    const dlg = f.dialog();
    type(dlg.querySelector("textarea") as HTMLTextAreaElement, "订好了");
    choose(dlg.querySelector("select") as HTMLSelectElement, "T1");
    await flush();
    const box = checkbox(dlg);
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    (buttonByText(dlg, "保存") as HTMLButtonElement).click();
    await flush();
    expect(f.writes()).toEqual([
      {
        method: "nexus.goal.entry.add",
        params: { goalId: "G1ABC", kind: "note", text: "订好了", taskId: "T1" },
      },
      { method: "nexus.goal.link.add", params: { goalId: "G1ABC", kind: "task", refId: "T1" } },
    ]);
    expect(f.notice()).toContain("已记录，并关联了事项");
  });

  it("keeps the note when the link is refused, and does not keep the dialog open to add it twice", async () => {
    const f = await openNote({
      fail: { "nexus.goal.link.add": refusal("the Task already belongs to another goal") },
    });
    const dlg = f.dialog();
    type(dlg.querySelector("textarea") as HTMLTextAreaElement, "订好了");
    choose(dlg.querySelector("select") as HTMLSelectElement, "T1");
    await flush();
    const box = checkbox(dlg);
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    (buttonByText(dlg, "保存") as HTMLButtonElement).click();
    await flush();
    expect(f.writes().filter((call) => call.method === "nexus.goal.entry.add")).toHaveLength(1);
    expect(f.notice()).toContain("已记录，但没能关联事项");
    expect(f.notice()).toContain("已经属于另一个目标");
    expect(f.container.querySelector(".nx-dialog")).toBeNull();
  });
});
