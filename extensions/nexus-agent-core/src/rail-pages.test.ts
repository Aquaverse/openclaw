// The two rail destinations that are real pages now: Goals and Library. Both are plain markup functions, so the tests
// read the HTML directly — the list pane, the detail pane and the markers the Control UI module turns back into actions.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderFilesPage } from "./files-page-ui.js";
import { renderGoalsPage } from "./goals-page-ui.js";
import type { GoalDetailRecord, GoalSummaryRecord } from "./store/goal-types.js";
import type { VaultFileRecord } from "./store/vault-types.js";
import { DEFAULT_FILE_QUERY } from "./vault-ui.js";

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
  createdAt: Date.parse("2026-09-02T10:00:00"),
  updatedAt: Date.parse("2026-10-28T10:00:00"),
  childCount: 0,
  linkCount: 0,
  entryCount: 0,
  lastEntryAt: null,
  ...over,
});

const file = (over: Partial<VaultFileRecord> & { id: string }): VaultFileRecord => ({
  objectId: "o_1",
  displayName: "report.xlsx",
  folder: "",
  collection: "vault",
  state: "active",
  source: "upload",
  sourceRef: null,
  sensitivity: "normal",
  sensitivityBy: "rule",
  importedBy: "user",
  createdAt: Date.parse("2026-10-01T10:00:00"),
  updatedAt: Date.parse("2026-10-29T10:00:00"),
  trashedAt: null,
  expiresAt: null,
  size: 48 * 1024,
  mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  contentHash: "h1",
  versionCount: 2,
  pinnedAt: null,
  favorite: false,
  lastOpenedAt: null,
  ...over,
});

describe("the Goals page", () => {
  const data = {
    seg: "active" as const,
    goals: [
      goal({ id: "g1", title: "存够应急金", childCount: 2, currentState: "本月转入 5000" }),
      goal({ id: "g3", parentId: "g1", title: "每月转 5000" }),
    ],
    counts: { active: 1, done: 3 },
    proposed: [goal({ id: "g2", status: "proposed", title: "每周跑步" })],
  };

  it("lists the goals of the chosen segment, the proposals and the create buttons", () => {
    const html = renderGoalsPage(data, { actions: true, lang: "zh" });
    assert.match(html, /class="nx-wlist"/);
    assert.match(html, /href="nexus-nav:\/goals\/g1"/);
    assert.match(html, /存够应急金/);
    assert.match(html, /本月转入 5000/);
    // A sub-goal sits under its parent and is drawn as one.
    assert.match(html, /class="nx-wrow nx-gchild" href="nexus-nav:\/goals\/g3"/);
    // The segment counts come from the store, not from the rendered rows.
    assert.match(html, /进行中<span class="nx-n">1<\/span>/);
    assert.match(html, /已完成<span class="nx-n">3<\/span>/);
    // A proposal is a question: it opens the confirmation card instead of a detail pane.
    assert.match(html, /data-nx-act="goal-pending" data-nx-id="g2"/);
    for (const category of ["finance", "interests", "something_else"]) {
      assert.match(html, new RegExp(`data-nx-act="goal-create" data-nx-id="${category}"`));
    }
    // Creating sits above the rows, not after them.
    assert.ok(html.indexOf('data-nx-act="goal-create"') < html.indexOf('class="nx-rows"'));
    // Nothing chosen: the detail pane says what to do.
    assert.match(html, /从左侧选一个目标/);
  });

  it("shows what the goal is about, its sub-goals, its updates and what it is linked to", () => {
    const detail: GoalDetailRecord = {
      goal: goal({
        id: "g1",
        title: "存够应急金",
        userWords: "年底前存够 10 万",
        currentState: "余额约 7.2 万",
      }),
      parent: null,
      children: [goal({ id: "g3", parentId: "g1", title: "每月转 5000" })],
      entries: [
        {
          id: "e1",
          goalId: "g1",
          kind: "note",
          text: "本月转入 5000",
          author: "user",
          effectiveAt: Date.parse("2026-10-28T09:00:00"),
          createdAt: Date.parse("2026-10-28T09:00:00"),
          taskId: null,
          claimId: null,
          retractedAt: null,
        },
      ],
      entriesTruncated: false,
      links: [
        {
          id: "l1",
          goalId: "g1",
          kind: "vault_file",
          refId: "vf_1",
          createdAt: 1,
          targetGone: false,
        },
      ],
      metrics: [
        {
          id: "m1",
          goalId: "g1",
          name: "已存金额",
          unit: "万",
          direction: "up",
          target: 10,
          current: 5,
          asOf: null,
          source: "manual",
          taskId: null,
          claimId: null,
          reachedAt: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    const html = renderGoalsPage({ ...data, detail }, { actions: true, lang: "zh" });
    assert.match(html, /class="nx-detail"/);
    assert.match(html, /年底前存够 10 万/);
    assert.match(html, /余额约 7.2 万/);
    assert.match(html, /href="nexus-nav:\/goals\/g3"/);
    assert.match(html, /本月转入 5000/);
    assert.match(html, /href="nexus-nav:\/files\?file=vf_1"/);
    // Half way to the figure it is measured against: the bar reads that off the rounded class.
    assert.match(html, /class="nx-gbar"><i class="nx-p50">/);
    // The actions the page already had stay reachable: tick it done, or open the full dialog from the detail pane.
    assert.match(html, /data-nx-act="goal-check" data-nx-id="g1"/);
    assert.match(html, /data-nx-act="goal-open" data-nx-id="g1"/);
  });

  it("marks the chosen row and asks for a goal when the address names one that is gone", () => {
    const html = renderGoalsPage(
      { ...data, seg: "done", goals: [goal({ id: "g4" })] },
      { lang: "zh" },
    );
    assert.match(html, /class="nx-wrow" href="nexus-nav:\/goals\/g4\?seg=done"/);
    assert.match(html, /从左侧选一个目标/);
  });
});

describe("the Library page", () => {
  const query = DEFAULT_FILE_QUERY;
  const stats = { files: { "vault:active": 1 }, objectBytes: 48 * 1024, reservedBytes: 0 };

  it("lists the files with their type tile and links each row to its detail", () => {
    const html = renderFilesPage(
      { files: [file({ id: "vf_1", displayName: "Q3 报告.xlsx" })], total: 1, query, stats },
      { actions: true, lang: "zh" },
    );
    assert.match(html, /class="nx-wlist"/);
    assert.match(html, /class="nx-ftile nx-t-green">XLSX</);
    assert.match(html, /href="nexus-nav:\/files\?file=vf_1"/);
    assert.match(html, /data-nx-act="file-new"/);
    assert.match(html, /从左侧选一个文件/);
  });

  it("shows the file's own details, the goals that point at it and the two actions it offers", () => {
    const html = renderFilesPage(
      {
        files: [file({ id: "vf_1", displayName: "Q3 报告.xlsx" })],
        total: 1,
        query: { ...query, file: "vf_1" },
        stats,
        detail: {
          file: file({ id: "vf_1", displayName: "Q3 报告.xlsx", folder: "客户 A" }),
          goals: [{ id: "g1", title: "存够应急金", status: "active", category: "finance" }],
        },
      },
      { actions: true, lang: "zh" },
    );
    assert.match(html, /class="nx-detail"/);
    assert.match(html, /客户 A/);
    assert.match(html, /href="nexus-nav:\/goals\/g1"/);
    assert.match(html, /data-nx-act="file-open" data-nx-id="vf_1"/);
    // A 48 KB spreadsheet is small enough to download.
    assert.match(html, /data-nx-act="file-download" data-nx-id="vf_1"/);
  });
});
