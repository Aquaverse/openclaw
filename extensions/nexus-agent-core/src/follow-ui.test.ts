// The "Follow-up" block (design 11.3): a draft is never said to be following up, the five lines and the next check are shown, the
// buttons depend on the state, and nothing is drawn when plans are not available.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { cadenceText, renderFollowSection, type FollowUpData } from "./follow-ui.js";
import type { DelegationPlanRecord, ScheduleRecord, TriggerRecord } from "./schedule/types.js";

const NOW = Date.UTC(2026, 10, 11, 2, 0, 0);
const plan = (over: Partial<DelegationPlanRecord> = {}): DelegationPlanRecord => ({
  ownerId: "o",
  id: "dp_1",
  workId: "w1",
  workVersion: 1,
  planOwnerType: "commitment",
  planOwnerId: "c1",
  purpose: "跟进小王提交报告",
  planVersion: 1,
  status: "accepted",
  plan: {
    sources: ["邮箱里小王的回信"],
    notifyText: "只记录在这里",
    wontDo: ["不自动催办对方"],
    stopConditions: [{ kind: "until", at: NOW + 86_400_000 }],
    schedules: [],
  },
  gaps: [],
  startIntent: "none",
  acceptedResponsibilityVersion: 1,
  acceptedContractVersion: 1,
  replacesPlanId: null,
  endReason: null,
  endRequestedAt: null,
  wrapupUntil: null,
  createdBy: "user",
  createdAt: NOW,
  acceptedAt: NOW,
  endedAt: null,
  ...over,
});
const schedule = (over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  ownerId: "o",
  id: "sc_1",
  workId: "w1",
  ownerType: "commitment",
  ownerRef: "c1",
  planId: "dp_1",
  planVersion: 1,
  scheduleKind: "recurring",
  purpose: "看有没有回复",
  cadence: { kind: "daily", times: ["09:00", "18:00"] },
  tz: "Asia/Shanghai",
  nextDueAt: NOW + 3_600_000,
  dispatchWindowMs: null,
  executorKind: "check_task",
  executorRef: null,
  status: "active",
  pauseSource: null,
  blockReasons: [],
  lastManualTriggerAt: null,
  stopReason: null,
  endedAt: null,
  coverageState: "on_plan",
  coverageNote: null,
  replacesScheduleId: null,
  createdVia: "plan",
  revision: 3,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const trigger = (over: Partial<TriggerRecord> = {}): TriggerRecord => ({
  id: "tg_1",
  scheduleId: "sc_1",
  scheduleRevision: 3,
  occurrenceKey: "k",
  planVersion: 1,
  source: "scheduled",
  plannedAt: NOW - 3_600_000,
  outcome: "created",
  skipReason: null,
  mergedOccurrenceKeys: [],
  taskId: "t1",
  slotOpen: false,
  firedAt: NOW - 3_600_000,
  turnState: "reported",
  turnJobId: null,
  turnSessionKey: null,
  failReason: null,
  report: { outcome: "changed", summary: "小王回复了，说周五交" },
  createdAt: NOW - 3_600_000,
  ...over,
});
const data = (over: Partial<FollowUpData> = {}): FollowUpData => ({
  dispatchReady: true,
  plans: [plan()],
  schedules: [schedule()],
  triggers: { sc_1: [trigger()] },
  ...over,
});
const render = (d: FollowUpData | undefined, withActions = true, lang: "zh" | "en" = "zh") =>
  renderFollowSection(d, { lang, now: NOW, workId: "w1", withActions });

describe("follow-up block", () => {
  it("draws nothing when plans are not available", () => {
    assert.equal(render(undefined), "");
  });

  it("says plainly that there is no plan, and offers a new one", () => {
    const html = render(data({ plans: [], schedules: [], triggers: {} }));
    assert.match(html, /还没有跟进方案/);
    assert.match(html, /data-nx-act="fu-new" data-nx-id="w1"/);
    assert.doesNotMatch(render(data({ plans: [], schedules: [], triggers: {} }), false), /fu-new/);
  });

  it("shows the five lines, the next check, coverage and the last check of a running plan", () => {
    const html = render(data());
    for (const text of [
      "看什么",
      "邮箱里小王的回信",
      "多久看一次",
      "每天 09:00、18:00",
      "何时结束",
      "通知你",
      "只记录在这里",
      "不会做",
      "不自动催办对方",
    ]) {
      assert.ok(html.includes(text), text);
    }
    assert.match(html, /跟进中/);
    assert.match(html, /下次检查/);
    assert.match(html, /按计划覆盖/);
    assert.match(html, /有变化 ?[:：]?|有变化/);
    assert.match(html, /小王回复了，说周五交/);
    for (const act of ["fu-check", "fu-pause", "fu-stop", "fu-edit", "fu-end"]) {
      assert.ok(html.includes(`data-nx-act="${act}"`), act);
    }
    assert.ok(!html.includes('data-nx-act="fu-resume"'));
  });

  it("a plan whose commitment ended says it is ending, keeps only the records button, and says when a commitment plan ends", () => {
    const html = render(
      data({
        plans: [
          plan({
            endRequestedAt: NOW,
            wrapupUntil: NOW + 1_800_000,
            endReason: "commitment_resolved",
          }),
        ],
      }),
    );
    assert.match(html, /正在结束（这项承诺已办结），已在跑的检查先收尾/);
    assert.match(html, /收尾中/);
    const acts = [...html.matchAll(/data-nx-act="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((a) => a !== "fu-new");
    assert.deepEqual(acts, ["fu-history"], "nothing can be changed while it wraps up");
    assert.match(
      render(data()),
      /何时结束.*这项承诺办结或取消时/s,
      "a commitment plan always ends with its commitment",
    );
    const ofWork = render(
      data({
        plans: [
          plan({
            planOwnerType: "work",
            planOwnerId: "w1",
            plan: { ...plan().plan, stopConditions: [] },
          }),
        ],
      }),
    );
    assert.match(ofWork, /没有设定结束条件，由你停止/);
    const ended = render(
      data({
        plans: [plan({ status: "ended", endReason: "commitment_cancelled", endedAt: NOW })],
        schedules: [schedule({ status: "cancelled", stopReason: "commitment_cancelled" })],
      }),
    );
    assert.match(ended, /已结束（这项承诺已取消）/);
  });

  it("a draft is a draft: start / edit / not now, and never 'following up'", () => {
    const html = render(
      data({ plans: [plan({ status: "draft", acceptedAt: null })], schedules: [], triggers: {} }),
    );
    assert.match(html, /草稿，尚未开始/);
    assert.doesNotMatch(html, /跟进中/);
    for (const act of ["fu-start", "fu-edit", "fu-skip"]) {
      assert.ok(html.includes(`data-nx-act="${act}"`), act);
    }
    assert.ok(!html.includes("fu-end"));
  });

  it("names who paused a check and offers resume only for a paused one", () => {
    const work = render(
      data({
        schedules: [schedule({ status: "paused", pauseSource: "work_control", nextDueAt: null })],
      }),
    );
    assert.match(work, /工作暂停时一并暂停/);
    assert.ok(
      !work.includes('data-nx-act="fu-resume"'),
      "the Work's pause is released from the Work",
    );
    assert.ok(!work.includes('data-nx-act="fu-pause"'));
    assert.ok(!work.includes('data-nx-act="fu-check"'), "a paused check is not run by hand");
    assert.match(work, /data-nx-act="fu-stop"/);
    const user = render(
      data({ schedules: [schedule({ status: "paused", pauseSource: "user", nextDueAt: null })] }),
    );
    assert.match(user, /你暂停的/);
    assert.match(user, /data-nx-act="fu-resume"/);
  });

  it("a blocked check says why, a failed check says it did not finish", () => {
    const blocked = render(
      data({
        schedules: [
          schedule({
            status: "blocked",
            nextDueAt: null,
            blockReasons: [
              {
                code: "prerequisite_missing",
                ref: "host_capability:scheduled_dispatch",
                actor: "system",
              },
            ],
          }),
        ],
      }),
    );
    assert.match(blocked, /受阻/);
    assert.match(blocked, /宿主还不能启动定时检查/);
    const failed = render(
      data({ triggers: { sc_1: [trigger({ report: null, turnState: "failed" })] } }),
    );
    assert.match(failed, /检查没完成/);
  });

  it("warns when the host cannot start checks, and read-only pages have no buttons", () => {
    assert.match(render(data({ dispatchReady: false })), /不能自动启动定时检查/);
    const readOnly = render(data(), false);
    const acts = [...readOnly.matchAll(/data-nx-act="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(acts, ["fu-history"], "reading the records is all a read-only page offers");
  });

  it("says why a check did not finish, in words, and marks it as a problem", () => {
    const html = (reason: string | null, over: Partial<TriggerRecord> = {}) =>
      render(
        data({
          triggers: {
            sc_1: [trigger({ report: null, turnState: "failed", failReason: reason, ...over })],
          },
        }),
      );
    const noReport = html("turn_ended_without_report (status=ok)");
    assert.match(noReport, /检查没完成：检查结束了，但没有交回结果 \(status=ok\)/);
    assert.match(noReport, /class="nx-cm-n nx-fu-bad"/);
    assert.match(html("turn_not_started:host_refused"), /宿主拒绝开始这次检查/);
    assert.match(html("turn_never_started"), /宿主一直没有开始/);
    assert.match(html("turn_not_finished"), /一直没有结束/);
    assert.match(html("prerequisite_missing:owner_closed"), /检查前提不满足：owner_closed/);
    assert.match(html("schedule_paused"), /已不再进行中/);
    assert.match(html("something_new"), /没有完成（something_new）/);
    assert.match(
      render(
        data({
          triggers: {
            sc_1: [
              trigger({ report: null, turnState: "failed", failReason: "turn_never_started" }),
            ],
          },
        }),
        true,
        "en",
      ),
      /never started/,
    );
    const cannot = render(
      data({
        triggers: {
          sc_1: [trigger({ report: { outcome: "cannot_check", summary: "页面打不开：超时" } })],
        },
      }),
    );
    assert.match(cannot, /没能检查：页面打不开：超时/);
    assert.match(cannot, /nx-fu-bad/);
    assert.doesNotMatch(render(data()), /nx-fu-bad/, "a normal check is not drawn as a problem");
  });

  it("names a manual or catch-up check, and says why a due time was skipped", () => {
    const manual = render(data({ triggers: { sc_1: [trigger({ source: "manual" })] } }));
    assert.match(manual, /手动检查 · 有变化/);
    const skipped = render(
      data({
        triggers: {
          sc_1: [trigger({ outcome: "skipped", skipReason: "previous_check_open", report: null })],
        },
      }),
    );
    assert.match(skipped, /已跳过：上一次检查还没结束/);
  });

  it("shows a coverage note in words and never as a raw code", () => {
    const down = render(
      data({ schedules: [schedule({ coverageState: "degraded", coverageNote: "check_failed" })] }),
    );
    assert.match(down, /上一次检查没有完成/);
    assert.doesNotMatch(down, /check_failed/);
    const odd = render(
      data({ schedules: [schedule({ coverageState: "degraded", coverageNote: "mystery_code" })] }),
    );
    assert.doesNotMatch(odd, /mystery_code/);
  });

  it("every check, and every check of an ended plan, has a way to read all its records", () => {
    const live = render(data());
    assert.match(live, /data-nx-act="fu-history" data-nx-id="sc_1"/);
    const ended = render(
      data({
        plans: [plan({ status: "ended", endReason: "work_stopped", endedAt: NOW })],
        schedules: [schedule({ status: "ended", stopReason: "work_stopped" })],
        triggers: {},
      }),
    );
    assert.match(ended, /data-nx-act="fu-history" data-nx-id="sc_1"/);
  });

  it("an ended plan says why, in either language, and an unknown reason is shown as itself", () => {
    const ended = data({
      plans: [plan({ status: "ended", endReason: "work_stopped", endedAt: NOW })],
      schedules: [schedule({ status: "ended", stopReason: "work_stopped" })],
    });
    assert.match(render(ended), /已结束（工作已停止）/);
    assert.match(render(ended, true, "en"), /Ended \(the work was stopped\)/);
    const odd = data({
      plans: [plan({ status: "ended", endReason: "strange_code", endedAt: NOW })],
    });
    assert.match(render(odd), /strange_code/);
  });

  it("escapes what the plan says", () => {
    const html = render(data({ plans: [plan({ purpose: "<img src=x onerror=1>" })] }));
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("&lt;img"));
  });

  it("writes cadences in words", () => {
    assert.equal(cadenceText("zh", { kind: "interval", minutes: 120 }, NOW), "每 2 小时");
    assert.equal(cadenceText("zh", { kind: "interval", minutes: 30 }, NOW), "每 30 分钟");
    assert.match(
      cadenceText("zh", { kind: "daily", times: ["09:00"], weekdays: [1, 2, 3, 4, 5] }, NOW),
      /周一、周二、周三、周四、周五 09:00/,
    );
    assert.equal(
      cadenceText("en", { kind: "daily", times: ["09:00", "18:00"] }, NOW),
      "Daily at 09:00, 18:00",
    );
  });
});
