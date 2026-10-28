// G3a: the console side of the review reminder: the "Periodic review" block in the goal detail, the "time to review" pill on
// the list row, and the count on the Goals tab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonByText, click, type Data, fixture, flush, goal, PROPS } from "./goals-view-kit.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const NOW = Date.now();
const plan = (over: Record<string, unknown> = {}) => ({
  goalId: "G1ABC",
  cadence: "weekly",
  nextDueAt: NOW + 3 * 86_400_000,
  lastReviewedAt: null,
  snoozedUntil: null,
  nudgedAt: null,
  due: false,
  ...over,
});
const detail = (review?: unknown, goalOver: Record<string, unknown> = {}) => ({
  goal: goal({ category: "interests", sensitivity: "normal", ...goalOver }),
  parent: null,
  children: [],
  entries: [],
  entriesTruncated: false,
  links: [],
  metrics: [],
  ...(review ? { review } : {}),
});
const refusal = (message: string, code = "nexus_conflict") =>
  Object.assign(new Error(message), { code });

async function open(data: Data, canWrite = true) {
  const f = fixture(data, PROPS, canWrite);
  await flush();
  click(f.container, 'button[data-nx-act="goal-open"]');
  await flush();
  return f;
}
const select = (root: HTMLElement) =>
  root.querySelector<HTMLSelectElement>(".gl-review select") as HTMLSelectElement;
const choose = (el: HTMLSelectElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
};

describe("the Periodic review block (G3a)", () => {
  it("starts switched off, and choosing a cadence sets it and draws the detail again", async () => {
    const f = await open({ detail: detail(), review: plan() });
    const dlg = f.dialog();
    expect(select(dlg).value).toBe("off");
    expect(dlg.textContent).toContain("定期回看");
    expect(dlg.textContent).toContain("不会在后台自己运行");
    expect(buttonByText(dlg, "已回看")).toBeUndefined();
    const gets = f.calls.filter((call) => call.method === "nexus.goal.get").length;
    choose(select(dlg), "weekly");
    await flush();
    expect(f.writes()).toEqual([
      { method: "nexus.goal.review.set", params: { goalId: "G1ABC", cadence: "weekly" } },
    ]);
    expect(f.notice()).toContain("已设为每周回看");
    expect(f.calls.filter((call) => call.method === "nexus.goal.get").length).toBe(gets + 1);
  });

  it("choosing 'no reminder' sends null", async () => {
    const f = await open({ detail: detail(plan({ cadence: "monthly" })), review: null });
    expect(select(f.dialog()).value).toBe("monthly");
    choose(select(f.dialog()), "off");
    await flush();
    expect(f.writes()).toEqual([
      { method: "nexus.goal.review.set", params: { goalId: "G1ABC", cadence: null } },
    ]);
    expect(f.notice()).toContain("已关闭回看提醒");
  });

  it("a due plan shows the pill and both buttons; 'reviewed' and 'later' call the act RPC", async () => {
    const due = plan({
      due: true,
      nextDueAt: NOW - 86_400_000,
      lastReviewedAt: NOW - 8 * 86_400_000,
    });
    const f = await open({
      detail: detail(due),
      active: [goal({ review: due })],
      review: plan(),
    });
    const dlg = f.dialog();
    expect(dlg.textContent).toContain("该回看了");
    expect(dlg.textContent).toContain("上次回看");
    (buttonByText(dlg, "已回看") as HTMLButtonElement).click();
    await flush();
    expect(f.writes()).toEqual([
      { method: "nexus.goal.review.act", params: { goalId: "G1ABC", action: "done", lang: "zh" } },
    ]);
    expect(f.notice()).toContain("已记为回看");
    (buttonByText(f.dialog(), "稍后（2 天）") as HTMLButtonElement).click();
    await flush();
    expect(f.writes().at(-1)).toEqual({
      method: "nexus.goal.review.act",
      params: { goalId: "G1ABC", action: "snooze" },
    });
    expect(f.notice()).toContain("好，");
  });

  it("a snoozed plan says when it reminds again", async () => {
    const snoozed = plan({ snoozedUntil: Date.now() + 2 * 86_400_000 });
    const f = await open({ detail: detail(snoozed) });
    expect(f.dialog().textContent).toContain("已推迟");
    expect(f.dialog().textContent).not.toContain("下次回看");
  });

  it("says in words when the goal is no longer in progress", async () => {
    const f = await open({
      detail: detail(plan()),
      fail: { "nexus.goal.review.set": refusal("not allowed while the goal is completed") },
    });
    choose(select(f.dialog()), "monthly");
    await flush();
    expect(f.notice()).toContain("只有进行中的目标可以设回看");
  });

  it("shows the plan but offers no change on a read-only connection, and nothing when there is no plan", async () => {
    const readOnly = await open({ detail: detail(plan()) }, false);
    expect(select(readOnly.dialog()).disabled).toBe(true);
    expect(buttonByText(readOnly.dialog(), "已回看")).toBeUndefined();
    document.body.replaceChildren();
    const bare = await open({ detail: detail() }, false);
    expect(bare.dialog().querySelector(".gl-review")).toBeNull();
  });

  it("is not offered for a goal waiting for approval or a completed one", async () => {
    const proposed = await open({ detail: detail(undefined, { status: "proposed" }) });
    expect(proposed.dialog().querySelector(".gl-review")).toBeNull();
    document.body.replaceChildren();
    const done = await open({ detail: detail(plan(), { status: "completed" }) });
    expect(done.dialog().querySelector(".gl-review")).toBeNull();
  });
});

describe("the detail keeps its scroll position (G3a)", () => {
  it("refills in place after 'reviewed': same window, same scroll position", async () => {
    // A short window so the detail has to scroll.
    const style = document.createElement("style");
    style.textContent = ".nx-dialog{max-height:140px !important}";
    document.head.append(style);
    try {
      const due = plan({ due: true, nextDueAt: NOW - 1000 });
      const f = await open({ detail: detail(due), review: plan() });
      const before = f.dialog();
      expect(before.scrollHeight).toBeGreaterThan(before.clientHeight + 40);
      before.scrollTop = 60;
      expect(before.scrollTop).toBe(60);
      (buttonByText(before, "已回看") as HTMLButtonElement).click();
      await flush();
      // The same window, refilled where it stands.
      expect(f.container.querySelectorAll(".nx-dialog")).toHaveLength(1);
      expect(f.dialog()).toBe(before);
      expect(before.scrollTop).toBe(60);
      expect(before.textContent).toContain("已回看");
    } finally {
      style.remove();
    }
  });
});

describe("keeping the keyboard focus (G3a)", () => {
  it("the button that was used still has the focus after the refill", async () => {
    const due = plan({ due: true, nextDueAt: NOW - 1000 });
    const f = await open({ detail: detail(due), review: plan({ due: true }) });
    const button = buttonByText(f.dialog(), "已回看") as HTMLButtonElement;
    button.focus();
    expect(document.activeElement).toBe(button);
    button.click();
    await flush();
    const now = document.activeElement as HTMLElement;
    expect(now).not.toBe(button);
    expect(now.textContent).toBe("已回看");
    expect(f.dialog().contains(now)).toBe(true);
  });
});

describe("what the list and the tab show (G3a)", () => {
  it("marks a due goal on its row, and only that one", async () => {
    const due = plan({ due: true, nextDueAt: NOW - 1000 });
    const f = fixture(
      {
        active: [
          goal({ id: "G1ABC", review: due }),
          goal({ id: "G2", title: "读书", review: plan() }),
        ],
      },
      PROPS,
    );
    await flush();
    const rows = Array.from(f.container.querySelectorAll(".gl-row"));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("该回看了");
    expect(rows[1]?.textContent).not.toContain("该回看了");
  });

  it("shows the number of due goals on the Goals tab, and nothing when none are due", async () => {
    const f = fixture({ due: [plan(), plan({ goalId: "G2" })] }, PROPS);
    await flush();
    expect(f.container.querySelector("nav")?.textContent).toContain("目标 (2)");
    document.body.replaceChildren();
    const quiet = fixture({ due: [] }, PROPS);
    await flush();
    expect(quiet.container.querySelector("nav")?.textContent).not.toContain("(");
  });

  it("a failing due call never breaks the page", async () => {
    const f = fixture({ fail: { "nexus.goal.review.due": new Error("unknown method") } }, PROPS);
    await flush();
    expect(f.container.querySelector("nav")?.textContent).toContain("目标");
    expect(f.container.querySelectorAll(".gl-row").length).toBe(1);
  });
});
