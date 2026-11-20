// The Dashboard page: the greeting, the six numbers, what waits for a decision, what is blocked or overdue, what changed
// last, and the two side blocks. Every number and row is a link into the page that acts on it.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { CounterpartSummary } from "./counterpart/types.js";
import { renderDashboard, type DashboardData } from "./dashboard-ui.js";
import type { DecisionRecord } from "./store/decision-types.js";
import type { GoalSummaryRecord } from "./store/goal-types.js";
import type { WorkView } from "./store/work-facts.js";
import type { WorkCounts } from "./work-ui.js";

const NOW = new Date("2026-11-19T09:30:00+08:00").getTime();

const counts: WorkCounts = {
  total: 7,
  hiddenCount: 0,
  counts: { needs_you: 2, blocked: 1, in_progress: 2, done: 1, ended_incomplete: 1 },
};

const work = (
  id: string,
  primary: keyof WorkCounts["counts"],
  over: Partial<WorkView> = {},
): WorkView =>
  ({
    work: {
      ownerId: "o",
      id,
      title: `工作 ${id}`,
      requestText: null,
      outcomeText: null,
      migratedOutcome: null,
      hidden: false,
      revision: 1,
      lifecycle: "live",
      createdAt: NOW - 4000,
      updatedAt: NOW - 1000,
    },
    state: { primary, flags: [], reasons: [], nextStep: { kind: "none" }, evaluationVersion: 1 },
    goalId: null,
    tasks: [],
    openPrerequisites: 0,
    outcome: null,
    terminal: null,
    ...over,
  }) as WorkView;

const decision = (id: string, over: Partial<DecisionRecord> = {}): DecisionRecord =>
  ({
    id,
    taskId: "t1",
    decisionType: "approve",
    riskTier: "high",
    question: "要不要把这笔钱放出去？",
    facts: { 金额: "12 万", 对方: "客户 A" },
    options: [],
    unknowns: [],
    policies: [],
    authorityHash: "h",
    taskRevision: 1,
    requiredDecider: null,
    deadlineAt: NOW + 86_400_000,
    status: "pending",
    resolution: null,
    resolutionSource: null,
    resolvedBy: null,
    resolvedAt: null,
    coreApprovalState: "pending",
    sessionKey: null,
    runId: null,
    toolCallId: null,
    effectKind: "external",
    chosenActionId: null,
    actionIds: [],
    ...over,
  }) as DecisionRecord;

const goal = (id: string, title: string, linkCount: number): GoalSummaryRecord =>
  ({
    id,
    parentId: null,
    category: "career",
    title,
    userWords: null,
    summary: null,
    currentState: null,
    status: "active",
    lifecycle: "active",
    origin: "user",
    createdVia: "page",
    confirmedAt: null,
    confirmedBy: null,
    sensitivity: "normal",
    notifyPolicy: "none",
    sortOrder: 0,
    childCount: 0,
    linkCount,
    entryCount: 0,
    lastEntryAt: null,
  }) as unknown as GoalSummaryRecord;

const person = (id: string, name: string, needs: number, overdue: number): CounterpartSummary =>
  ({ id, displayName: name, needsConfirmation: needs, overdue }) as CounterpartSummary;

const data = (over: Partial<DashboardData> = {}): DashboardData => ({
  counts,
  works: [work("w1", "needs_you"), work("w2", "blocked"), work("w3", "in_progress")],
  decisions: [decision("d1")],
  goals: [goal("g1", "年底前换工作", 3)],
  counterparts: [person("cp1", "钱经理", 2, 1)],
  now: NOW,
  goalsEnabled: true,
  ...over,
});

describe("the Dashboard", () => {
  it("greets with the hour, sums the day, and links into the workbench", () => {
    const html = renderDashboard(data(), { lang: "zh" });
    assert.match(html, /class="ea-page"/);
    assert.match(html, /早上好/);
    assert.match(html, /11 月 19 日/);
    assert.match(html, /1 项待你决策/);
    assert.match(html, /2 项进行中/);
    assert.match(html, /href="nexus-nav:\/works"/);
    assert.match(html, /打开工作台/);
  });

  it("shows the six numbers, each one a link into the list that acts on it", () => {
    const html = renderDashboard(data(), { lang: "zh" });
    assert.match(html, /class="ea-kpi warn" href="nexus-nav:\/works\?state=needs_you"/);
    assert.match(html, /class="ea-kpi bad" href="nexus-nav:\/works\?state=blocked"/);
    assert.match(html, /class="ea-kpi ok" href="nexus-nav:\/works\?state=in_progress"/);
    assert.match(html, /class="ea-kpi" href="nexus-nav:\/works\?state=done"/);
    assert.match(html, /class="ea-kpi" href="nexus-nav:\/works"/);
    assert.match(html, /待我决策/);
    assert.match(html, /全部工作/);
  });

  it("puts the waiting decision first, with its facts, risk and deadline", () => {
    const html = renderDashboard(data(), { lang: "zh" });
    assert.match(html, /href="nexus-nav:\/tasks\/t1"/);
    assert.match(html, /要不要把这笔钱放出去/);
    assert.match(html, /金额 12 万 · 对方 客户 A/);
    assert.match(html, /风险 高/);
    assert.match(html, /class="ea-meta"/);
  });

  it("lists what is blocked before what waits for the person, and the recent works", () => {
    const html = renderDashboard(data(), { lang: "zh" });
    const blocked = html.indexOf("工作 w2");
    const needs = html.indexOf("工作 w1");
    assert.ok(blocked >= 0 && needs >= 0, "both attention cards are drawn");
    assert.ok(blocked < needs, "the blocked work comes first");
    assert.match(html, /class="ea-row" href="nexus-nav:\/works\/w3"/);
  });

  it("draws the goals and the people who have something waiting", () => {
    const html = renderDashboard(data(), { lang: "zh" });
    assert.match(html, /href="nexus-nav:\/goals\/g1"/);
    assert.match(html, /3 项工作/);
    assert.match(html, /href="nexus-nav:\/people\/cp1"/);
    assert.match(html, /2 项待确认 · 1 项逾期/);
  });

  it("says what is empty instead of drawing a blank block", () => {
    const empty: Partial<DashboardData> = {
      decisions: [],
      works: [],
      goals: [],
      counterparts: [],
      counts: {
        total: 0,
        hiddenCount: 0,
        counts: { needs_you: 0, blocked: 0, in_progress: 0, done: 0, ended_incomplete: 0 },
      },
    };
    const html = renderDashboard(data(empty), { lang: "en" });
    assert.match(html, /Nothing needs your decision right now/);
    assert.match(html, /Nothing is blocked or overdue/);
    assert.match(html, /No work yet/);
    assert.match(html, /No goals yet/);
    assert.match(html, /Nobody you work with has anything waiting/);
  });

  it("leaves the goals block out when the feature is off, and keeps everything else", () => {
    const html = renderDashboard(data({ goalsEnabled: false }), { lang: "zh" });
    assert.doesNotMatch(html, /年底前换工作/);
    assert.match(html, /协作提醒/);
  });
});
