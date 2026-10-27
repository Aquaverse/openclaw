// The Goals page markup: it carries only action markers, escapes user text, nests sub-goals one level, and honours the page menu.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { groupByCompletedMonth, groupEntriesByDay, nestGoals, renderGoalPage } from "./goal-ui.js";
import type { GoalEntryRecord, GoalSummaryRecord } from "./store/goal-types.js";

const goal = (over: Partial<GoalSummaryRecord> & { id: string }): GoalSummaryRecord => ({
  parentId: null,
  category: "interests",
  title: `title ${over.id}`,
  userWords: null,
  summary: null,
  currentState: null,
  status: "active",
  lifecycle: "live",
  origin: "user",
  createdVia: "creation_chat",
  confirmedAt: null,
  confirmedBy: null,
  sensitivity: "normal",
  notifyPolicy: "off",
  sortOrder: 0,
  questions: [],
  revision: 1,
  completedAt: null,
  deletedAt: null,
  createdAt: 1,
  updatedAt: 1,
  childCount: 0,
  linkCount: 0,
  entryCount: 0,
  lastEntryAt: null,
  ...over,
});

describe("goal page markup", () => {
  it("lists active goals with a checkbox marker, a title marker and the subtitle; sub-goals follow their parent", () => {
    const html = renderGoalPage(
      {
        active: [
          goal({ id: "G1", title: "Become a better cook", currentState: "Cooking twice a week" }),
          goal({ id: "G3", title: "Learn the cello" }),
          goal({ id: "G2", parentId: "G1", title: "One new dish a week" }),
        ],
        proposed: [],
      },
      { actions: true, lang: "en" },
    );
    assert.match(html, /data-nx-act="goal-check" data-nx-id="G1"/u);
    assert.match(html, /data-nx-act="goal-open" data-nx-id="G2"/u);
    assert.match(html, /Cooking twice a week/u);
    assert.ok(html.indexOf("One new dish a week") < html.indexOf("Learn the cello"));
    assert.match(html, /gl-row gl-child/u);
    for (const category of ["finance", "interests", "something_else"]) {
      assert.match(html, new RegExp(`data-nx-act="goal-create" data-nx-id="${category}"`, "u"));
    }
    assert.doesNotMatch(html, /data-nx-id="health"/u);
  });

  it("hides subtitles on request and drops every button when the connection cannot write", () => {
    const data = {
      active: [goal({ id: "G1", currentState: "secret subtitle" })],
      proposed: [goal({ id: "G9", status: "proposed" })],
    };
    assert.doesNotMatch(
      renderGoalPage(data, { actions: true, showSubtitle: false }),
      /secret subtitle/u,
    );
    const readOnly = renderGoalPage(data, { actions: false, lang: "en" });
    assert.doesNotMatch(readOnly, /goal-check|goal-create|goal-approve|goal-reject/u);
    assert.match(readOnly, /data-nx-act="goal-open"/u);
  });

  it("shows pending goals in their own group with approve and reject", () => {
    const html = renderGoalPage(
      {
        active: [],
        proposed: [
          goal({
            id: "G7",
            status: "proposed",
            title: "Read more",
            summary: "Maybe twelve books.",
          }),
        ],
      },
      { actions: true, lang: "en" },
    );
    assert.match(html, /Pending approval \(1\)/u);
    assert.match(html, /data-nx-act="goal-approve" data-nx-id="G7"/u);
    assert.match(html, /data-nx-act="goal-reject" data-nx-id="G7"/u);
    assert.match(html, /No goals in progress yet/u);
  });

  it("escapes user text", () => {
    const html = renderGoalPage(
      {
        active: [
          goal({ id: "G1", title: '<img src=x onerror="1">', currentState: "<script>1</script>" }),
        ],
        proposed: [],
      },
      { actions: true },
    );
    assert.doesNotMatch(html, /<img|<script/u);
    assert.match(html, /&lt;img/u);
  });
});

describe("goal grouping helpers", () => {
  it("nests one level and keeps an orphaned sub-goal visible", () => {
    const rows = nestGoals([
      { id: "a", parentId: null },
      { id: "x", parentId: "gone" },
      { id: "b", parentId: "a" },
    ]);
    assert.deepEqual(
      rows.map((r) => `${r.goal.id}${r.child ? "^" : ""}`),
      ["a", "b^", "x"],
    );
  });

  it("groups activity by day and completed goals by month, newest first", () => {
    const at = (iso: string) => new Date(iso).getTime();
    const entry = (id: string, when: number): GoalEntryRecord => ({
      id,
      goalId: "G",
      kind: "note",
      text: id,
      author: "user",
      effectiveAt: when,
      createdAt: when,
      taskId: null,
      claimId: null,
      retractedAt: null,
    });
    const days = groupEntriesByDay([
      entry("a", at("2026-10-20T12:00:00")),
      entry("b", at("2026-10-21T12:00:00")),
      entry("c", at("2026-10-21T15:00:00")),
    ]);
    assert.deepEqual(
      days.map((d) => d.entries.map((e) => e.id)),
      [["c", "b"], ["a"]],
    );
    const months = groupByCompletedMonth(
      [
        { completedAt: at("2026-09-10T12:00:00"), updatedAt: 0, id: "s" },
        { completedAt: at("2026-10-10T12:00:00"), updatedAt: 0, id: "o" },
      ],
      "en",
    );
    assert.deepEqual(
      months.map((m) => m.label),
      ["10/2026", "9/2026"],
    );
  });
});
