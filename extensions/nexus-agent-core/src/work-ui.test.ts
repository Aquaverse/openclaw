// The Work page markup: states in words, grouping, filters in the links, write buttons only when allowed, escaping.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { WorkView } from "./store/work-facts.js";
import {
  renderWorkRows,
  renderWorksPage,
  workActionModel,
  type WorkCounts,
  type WorkDetail,
  type WorksPageData,
} from "./work-ui.js";
import type { WorkPrimaryState, WorkState } from "./work/types.js";

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();

const state = (primary: WorkPrimaryState, over: Partial<WorkState> = {}): WorkState => ({
  primary,
  flags: [],
  reasons: [],
  nextStep: { kind: "none" },
  evaluationVersion: 1,
  ...over,
});

const view = (id: string, primary: WorkPrimaryState, over: Partial<WorkView> = {}): WorkView => ({
  work: {
    ownerId: "o",
    id,
    title: `title ${id}`,
    requestText: null,
    outcomeText: null,
    originalResultId: "r",
    contextMode: "personal",
    primaryContextId: "c",
    contextOrigin: "legacy_default",
    contextReview: "none",
    entryKind: "chat",
    migratedOutcome: null,
    currentWorkVersion: 1,
    origin: "user",
    requestRef: null,
    lifecycle: "live",
    hidden: false,
    revision: 3,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3_600_000,
    archivedAt: null,
    deletedAt: null,
  },
  state: state(primary),
  goalId: null,
  tasks: [],
  openPrerequisites: 0,
  outcome: null,
  terminal: null,
  ...over,
});

const counts = (over: Partial<WorkCounts["counts"]> = {}, hiddenCount = 0): WorkCounts => {
  const base = { done: 0, ended_incomplete: 0, needs_you: 0, blocked: 0, in_progress: 0, ...over };
  return {
    total: Object.values(base).reduce((a, b) => a + b, 0),
    counts: base,
    hiddenCount,
  };
};

const page = (over: Partial<WorksPageData> = {}): WorksPageData => ({
  counts: counts(),
  works: [],
  detail: null,
  missing: false,
  picked: false,
  now: NOW,
  ...over,
});

const detailOf = (v: WorkView, over: Partial<WorkDetail> = {}): WorkDetail => ({
  ...v,
  links: [],
  events: [],
  controls: [],
  ...over,
});

/** What a reader sees: the markup without tags, so class names and attributes cannot hide an enum value. */
const visible = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const acts = (html: string) => [...html.matchAll(/data-nx-act="([^"]+)"/g)].map((m) => m[1]);

describe("work page list", () => {
  it("says what to do when there is no work at all, and offers a way out of an empty filter", () => {
    const none = renderWorksPage(page(), { lang: "zh" });
    assert.match(none, /还没有工作/);
    const filtered = renderWorksPage(page({ counts: counts({ done: 2 }), state: "needs_you" }), {
      lang: "zh",
    });
    assert.match(filtered, /当前筛选下没有工作/);
    assert.match(filtered, /href="nexus-nav:\/works"/);
  });

  it("groups by what needs the reader first and shows words, never state names", () => {
    const html = renderWorksPage(
      page({
        counts: counts({ needs_you: 1, in_progress: 1, done: 1 }),
        works: [view("w1", "needs_you"), view("w2", "in_progress"), view("w3", "done")],
      }),
      { lang: "zh" },
    );
    assert.ok(html.indexOf("title w1") < html.indexOf("title w2"));
    assert.ok(html.indexOf("title w2") < html.indexOf("title w3"));
    const text = visible(html);
    assert.match(text, /待你处理/);
    assert.match(text, /进行中/);
    assert.match(text, /已完成/);
    assert.doesNotMatch(text, /needs_you|in_progress|ended_incomplete/);
  });

  it("writes one heading per run of the same state, and none when a state is chosen", () => {
    const works = [
      ...Array.from({ length: 3 }, (_, i) => view(`n${i}`, "needs_you")),
      ...Array.from({ length: 8 }, (_, i) => view(`d${i}`, "done")),
    ];
    const html = renderWorksPage(page({ counts: counts({ needs_you: 3, done: 8 }), works }), {
      lang: "zh",
    });
    assert.equal((html.match(/class="nx-wrow[ "]/g) ?? []).length, 11);
    assert.equal((html.match(/class="nx-gh"/g) ?? []).length, 2);
    const chosen = renderWorksPage(
      page({ counts: counts({ done: 8 }), works: works.slice(3), state: "done" }),
      { lang: "zh" },
    );
    assert.equal((chosen.match(/class="nx-gh"/g) ?? []).length, 0);
  });

  it("continues a page of rows without repeating the heading of the group it is in", () => {
    const more = [view("d8", "done"), view("e1", "ended_incomplete")];
    const out = renderWorkRows(more, { now: NOW }, { lang: "zh", after: "done" });
    assert.equal((out.html.match(/class="nx-gh"/g) ?? []).length, 1);
    assert.match(out.html, /class="nx-gh">已结束</);
    assert.equal(out.last, "ended_incomplete");
    assert.equal(renderWorkRows([], { now: NOW }, { after: "done" }).last, "done");
  });

  it("keeps the chosen filter in every link and marks the selected row", () => {
    const html = renderWorksPage(
      page({
        counts: counts({ needs_you: 1 }),
        works: [view("w1", "needs_you")],
        detail: detailOf(view("w1", "needs_you")),
        state: "needs_you",
        q: "机票",
      }),
      { lang: "zh" },
    );
    assert.match(
      html,
      /class="nx-wrow nx-t-amber on" href="nexus-nav:\/works\/w1\?state=needs_you&amp;q=%E6%9C%BA%E7%A5%A8"/,
    );
    assert.match(html, /<a class="on" href="nexus-nav:\/works\?state=needs_you&amp;q=/);
  });

  it("notes the hidden works, and the other running step of a work that needs you in its detail", () => {
    const w1 = view("w1", "needs_you", {
      state: state("needs_you", { flags: ["other_branch_running"] }),
    });
    const html = renderWorksPage(
      page({ counts: counts({ needs_you: 1 }, 4), works: [w1], detail: detailOf(w1) }),
      { lang: "zh" },
    );
    assert.match(html, /另有 4 件已隐藏的工作/);
    assert.match(visible(html), /其他步骤进行中/);
  });

  it("leaves a slot for the search box and says how many works wait", () => {
    const waiting = renderWorksPage(page({ counts: counts({ needs_you: 2 }) }), { lang: "zh" });
    assert.match(waiting, /<div class="nx-search-slot"><\/div>/);
    assert.match(visible(waiting), /有 2 件待你处理/);
    assert.match(visible(renderWorksPage(page(), { lang: "zh" })), /没有需要你处理的事/);
  });

  it("shows the question a row is waiting on instead of a generic line", () => {
    const w1 = view("w1", "needs_you", {
      state: state("needs_you", {
        nextStep: { kind: "decide", objectKind: "decision", objectId: "d1" },
      }),
      tasks: [
        {
          id: "t1",
          title: "订票",
          status: "running",
          phase: "waiting_approval",
          superseded: false,
        },
      ],
    });
    const html = renderWorksPage(
      page({
        counts: counts({ needs_you: 1 }),
        works: [w1],
        decisions: [
          {
            id: "d1",
            taskId: "t1",
            question: "购买东航 MU5331？",
            facts: null,
            deadlineAt: null,
            riskTier: "R2",
          },
          {
            id: "d2",
            taskId: "other",
            question: "别的工作的问题",
            facts: null,
            deadlineAt: null,
            riskTier: "R2",
          },
        ],
      }),
      { lang: "zh" },
    );
    assert.match(html, /<span class="nx-wnx">购买东航 MU5331？<\/span>/);
    assert.doesNotMatch(html, /别的工作的问题/);
  });

  it("never turns a title into markup", () => {
    const html = renderWorksPage(
      page({
        counts: counts({ in_progress: 1 }),
        works: [
          view("w1", "in_progress", {
            work: { ...view("w1", "in_progress").work, title: "<img src=x onerror=alert(1)>" },
          }),
        ],
      }),
      { lang: "en" },
    );
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img src=x/);
  });
});

describe("work page detail", () => {
  it("opens with the wanted result, the progress and the next step, and says what done means", () => {
    const v = view("w1", "in_progress", {
      tasks: [
        { id: "t1", title: "查航班", status: "succeeded", phase: "completed", superseded: false },
        { id: "t2", title: "订酒店", status: "running", phase: "running", superseded: false },
        { id: "t0", title: "旧的", status: "cancelled", phase: "cancelled", superseded: true },
      ],
    });
    v.work.outcomeText = "订好去纽约的机票";
    const html = renderWorksPage(
      page({ counts: counts({ in_progress: 1 }), works: [v], detail: detailOf(v) }),
      {
        lang: "zh",
        actions: true,
      },
    );
    const text = visible(html);
    assert.match(text, /我要的结果 订好去纽约的机票/);
    assert.match(text, /现在进展 1\/2 步已完成/);
    assert.match(html, /class="nx-ring nx-p50"/);
    assert.match(text, /1\/2 步 我要的结果/);
    assert.match(text, /完成标准 暂定：所有步骤都成功/);
    assert.match(html, /href="nexus-nav:\/tasks\/t1"/);
    assert.match(html, /nx-ck nx-ck-ok">✓/);
    assert.match(html, /nx-ck nx-ck-wait"><\/span>/);
    // Nothing is asked of the reader, and a replaced step is not a criterion.
    assert.doesNotMatch(text, /暂时不需要你做什么|旧的/);
    assert.doesNotMatch(html, /class="nx-ask"/);
  });

  it("asks one thing at a time: the waiting decision with its facts, or the step that needs input", () => {
    const w1 = view("w1", "needs_you", {
      state: state("needs_you", {
        nextStep: { kind: "decide", objectKind: "decision", objectId: "d1" },
      }),
      tasks: [
        {
          id: "t1",
          title: "订票",
          status: "running",
          phase: "waiting_approval",
          superseded: false,
        },
      ],
    });
    const decisions = [
      {
        id: "d1",
        taskId: "t1",
        question: "购买东航 MU5331？",
        facts: { 航班: "11-03 08:30 虹桥 → 宝安", 价格: 1860, nested: { a: 1 } },
        deadlineAt: NOW + 3_600_000,
        riskTier: "R2",
      },
      {
        id: "d2",
        taskId: "t1",
        question: "第二个问题",
        facts: null,
        deadlineAt: null,
        riskTier: "R1",
      },
    ];
    const data = page({
      counts: counts({ needs_you: 1 }),
      works: [w1],
      detail: detailOf(w1),
      decisions,
    });
    const html = renderWorksPage(data, { lang: "zh", actions: true });
    const text = visible(html);
    assert.match(text, /需要你决定 购买东航 MU5331？/);
    assert.match(text, /航班 11-03 08:30 虹桥 → 宝安/);
    assert.match(text, /价格 1860/);
    assert.doesNotMatch(text, /nested/);
    assert.match(html, /data-nx-act="decision" data-nx-id="d1"/);
    assert.match(text, /今天 13:00 前有效/);
    assert.match(text, /还有 1 个决定/);
    // Read-only: the question and facts stay, the button goes.
    const readOnly = renderWorksPage(data, { lang: "zh", actions: false });
    assert.doesNotMatch(readOnly, /data-nx-act="decision"/);
    assert.match(visible(readOnly), /购买东航 MU5331？/);

    const input = view("w2", "needs_you", {
      state: state("needs_you", { nextStep: { kind: "provide_input", objectId: "t9" } }),
      tasks: [
        { id: "t9", title: "补票据", status: "running", phase: "waiting_input", superseded: false },
      ],
    });
    const asked = renderWorksPage(
      page({ counts: counts({ needs_you: 1 }), works: [input], detail: detailOf(input) }),
      { lang: "zh" },
    );
    assert.match(visible(asked), /需要你补充 需要你补充信息/);
    assert.match(asked, /<a class="nx-pb" href="nexus-nav:\/tasks\/t9">打开步骤<\/a>/);
  });

  it("never shows arguments stored as JSON as the result the person wanted", () => {
    const v = view("w1", "in_progress");
    v.work.requestText = '{"action":"book_train_tickets","passengers":2}';
    const json = visible(
      renderWorksPage(page({ works: [v], detail: detailOf(v) }), { lang: "zh" }),
    );
    assert.doesNotMatch(json, /book_train_tickets/);
    assert.match(json, /我要的结果 title w1/);
    v.work.requestText = "订两张去北京的火车票";
    const words = visible(
      renderWorksPage(page({ works: [v], detail: detailOf(v) }), { lang: "zh" }),
    );
    assert.match(words, /我要的结果 订两张去北京的火车票/);
  });

  it("shows the real first cause of a block", () => {
    const paused = view("w1", "blocked", {
      state: state("blocked", {
        blockedKind: "paused",
        reasons: [{ code: "paused_by_user", objectKind: "control", objectId: "c1", actor: "user" }],
      }),
    });
    const html = renderWorksPage(
      page({
        counts: counts({ blocked: 1 }),
        works: [paused],
        detail: detailOf(paused, {
          controls: [
            {
              id: "wc_1",
              scopeKind: "work",
              scopeId: null,
              state: "paused",
              reason: "出差",
              reconcileOnly: false,
              createdAt: NOW,
            },
          ],
        }),
      }),
      { lang: "zh", actions: true },
    );
    const text = visible(html);
    assert.match(text, /已暂停/);
    assert.match(text, /你暂停了这件事/);
    assert.match(text, /暂停中：出差/);
    assert.match(html, /data-nx-act="work-resume" data-nx-id="wc_1"/);
  });

  it("writes an unknown reason or event as itself instead of failing", () => {
    const odd = view("w1", "blocked", {
      state: state("blocked", {
        blockedKind: "blocked_reason",
        reasons: [
          { code: "future_code" as never, objectKind: "work", objectId: "w1", actor: "system" },
        ],
      }),
    });
    const html = renderWorksPage(
      page({
        counts: counts({ blocked: 1 }),
        works: [odd],
        detail: detailOf(odd, {
          events: [{ id: "e1", seq: 1, kind: "future_kind", actor: "system", createdAt: NOW }],
        }),
      }),
      { lang: "en", actions: false },
    );
    assert.match(html, /future_code/);
    assert.match(html, /future_kind/);
  });

  it("offers write buttons only when allowed, and only those that fit the state", () => {
    const open = view("w1", "in_progress");
    const base = { counts: counts({ in_progress: 1 }), works: [open], detail: detailOf(open) };
    assert.deepEqual(acts(renderWorksPage(page(base), { actions: false })), []);
    assert.deepEqual(acts(renderWorksPage(page(base), { actions: true })), [
      "work-pause",
      "work-stop",
      "work-endpartial",
      "work-rename",
      "work-hide",
      "work-archive",
      "work-delete",
    ]);
    const ended = view("w2", "ended_incomplete", {
      terminal: {
        id: "wt",
        reason: "stop",
        resultAtClose: "stopped_before_completion",
        recordedAt: NOW,
      },
    });
    const endedActs = acts(
      renderWorksPage(
        page({ counts: counts({ ended_incomplete: 1 }), works: [ended], detail: detailOf(ended) }),
        { actions: true },
      ),
    );
    assert.ok(endedActs.includes("work-reopen"));
    assert.ok(!endedActs.includes("work-pause") && !endedActs.includes("work-stop"));
    const done = view("w3", "done");
    const doneActs = acts(
      renderWorksPage(
        page({ counts: counts({ done: 1 }), works: [done], detail: detailOf(done) }),
        { actions: true },
      ),
    );
    assert.ok(!doneActs.includes("work-stop") && !doneActs.includes("work-reopen"));
  });

  it("calls a migrated success history, and an achieved work by its time", () => {
    const migrated = view("w1", "done");
    migrated.work.migratedOutcome = "succeeded";
    const m = renderWorksPage(
      page({ counts: counts({ done: 1 }), works: [migrated], detail: detailOf(migrated) }),
      { lang: "zh" },
    );
    assert.match(visible(m), /原因未记录/);
    const achieved = view("w2", "done", {
      outcome: {
        eventId: "e",
        eventType: "achieved",
        basis: "source_verified",
        recordedAt: NOW,
        firstAchievedAt: NOW,
      },
    });
    const a = renderWorksPage(
      page({ counts: counts({ done: 1 }), works: [achieved], detail: detailOf(achieved) }),
      { lang: "zh" },
    );
    assert.match(visible(a), /已于 今天 12:00 达成。/);
  });

  it("reports a work that cannot be read, and the narrow-screen state", () => {
    const missing = renderWorksPage(page({ missing: true, picked: true }), { lang: "zh" });
    assert.match(missing, /class="nx-works nx-picked"/);
    assert.match(missing, /不存在，或已被删除/);
    const auto = renderWorksPage(page(), { lang: "zh" });
    assert.match(auto, /class="nx-works nx-auto"/);
  });

  it("builds the dialog model from the loaded work", () => {
    const v = view("w1", "blocked", {
      terminal: null,
    });
    const model = workActionModel(
      detailOf(v, {
        controls: [
          {
            id: "wc_1",
            scopeKind: "work",
            scopeId: null,
            state: "paused",
            reason: null,
            reconcileOnly: false,
            createdAt: NOW,
          },
        ],
      }),
    );
    assert.equal(model.id, "w1");
    assert.equal(model.revision, 3);
    assert.equal(model.ended, false);
    assert.equal(model.controls[0]?.id, "wc_1");
  });

  it("speaks English when asked", () => {
    const v = view("w1", "needs_you", {
      state: state("needs_you", {
        nextStep: { kind: "decide", objectKind: "decision", objectId: "d1" },
      }),
    });
    const text = visible(
      renderWorksPage(page({ counts: counts({ needs_you: 1 }), works: [v], detail: detailOf(v) }), {
        lang: "en",
      }),
    );
    assert.match(text, /A decision is waiting for you/);
    assert.match(text, /The result I want/);
  });

  it("names what a link points at instead of showing its id, and falls back to the id when the name is gone", () => {
    const v = view("w1", "in_progress");
    const link = (
      id: string,
      kind: string,
      targetId: string,
      title: string | null,
      role = "required",
    ) => ({
      id,
      role,
      targetKind: kind,
      targetId,
      targetTitle: title,
      purpose: null,
      createdAt: NOW,
      endedAt: null,
      endBasis: null,
    });
    const html = renderWorksPage(
      page({
        counts: counts({ in_progress: 1 }),
        works: [v],
        detail: detailOf(v, {
          goalId: "g_1",
          goalTitle: "今年把华东做起来",
          links: [
            link("l1", "commitment", "cm_1", "周五前把报价发给客户"),
            link("l2", "work", "w9", "华东项目", "coordination"),
            link("l3", "artifact", "f_1", null, "reference"),
          ],
        }),
      }),
      { lang: "zh" },
    );
    const text = visible(html);
    assert.match(text, /周五前把报价发给客户/);
    assert.match(text, /必要 · 承诺/);
    assert.match(text, /协作 · 工作/);
    assert.match(text, /仅参考 · 文件/);
    assert.match(text, /今年把华东做起来/);
    // A linked Work is a link to it; a name that cannot be read shows the id.
    assert.match(html, /href="nexus-nav:\/works\/w9"[^>]*>华东项目</);
    assert.match(html, /<code>f_1<\/code>/);
    assert.doesNotMatch(text, /cm_1/);
  });
});
