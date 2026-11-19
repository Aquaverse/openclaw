// The notification a check may carry: only a complete, valid choice is accepted; it is sent by the plugin after the check has reported
// (never by the check's model), only for the outcomes the user ticked, only to the chosen channel; an unavailable channel is
// recorded in the check record and nothing else is tried.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { dispatchKit } from "../test-support/dispatch-kit.js";
import { A } from "../test-support/goal-kit.js";
import { scheduleKit } from "../test-support/schedule-kit.js";
import { createScheduleCheckTools } from "../tools/schedule-check-tools.js";
import { createCheckRuntime } from "./check-runtime.js";
import { checkSessionKey } from "./dispatcher.js";
import {
  connectedChannels,
  parseNotify,
  renderNotice,
  sendNotice,
  tidyTarget,
  wantsNotice,
  type NoticeHost,
  type NoticeSender,
} from "./notify.js";
import type { NotifySpec, ScheduleSpec } from "./types.js";

const SLACK: NotifySpec = {
  kind: "channel",
  channel: "slack",
  to: "#nexus-test",
  onChanged: true,
  onCannotCheck: false,
  mode: "template",
  text: "【跟进】{purpose}：{result}。{summary}（{source}）",
};

describe("parseNotify", () => {
  it("accepts a complete choice and keeps only its own fields", () => {
    assert.deepEqual(parseNotify({ ...SLACK, extra: 1, accountId: "work" }), {
      ...SLACK,
      accountId: "work",
    });
  });

  it("refuses anything incomplete or odd", () => {
    const bad: unknown[] = [
      undefined,
      null,
      "slack",
      { ...SLACK, kind: "email" },
      { ...SLACK, channel: "" },
      { ...SLACK, channel: "Slack Team" },
      { ...SLACK, to: "  " },
      { ...SLACK, to: "#a\n#b" },
      { ...SLACK, to: "x".repeat(121) },
      { ...SLACK, mode: "markdown" },
      { ...SLACK, onChanged: false, onCannotCheck: false },
      { ...SLACK, onChanged: "yes" },
      { ...SLACK, text: "   " },
      { ...SLACK, text: "x".repeat(501) },
      { ...SLACK, accountId: "a b" },
    ];
    for (const raw of bad) {
      assert.equal(parseNotify(raw), null, JSON.stringify(raw));
    }
  });
});

describe("wantsNotice and renderNotice", () => {
  it("notifies only for the outcomes that were ticked, never for no_change", () => {
    assert.equal(wantsNotice(SLACK, "changed"), true);
    assert.equal(wantsNotice(SLACK, "cannot_check"), false);
    assert.equal(
      wantsNotice({ ...SLACK, onChanged: false, onCannotCheck: true }, "cannot_check"),
      true,
    );
    assert.equal(wantsNotice({ ...SLACK, onCannotCheck: true }, "no_change"), false);
  });

  const facts = {
    outcome: "changed" as const,
    summary: "页面状态已变为 Closed。",
    purpose: "等 Issue 关闭",
    sources: ["https://github.com/openclaw/openclaw/issues/197685"],
    at: Date.UTC(2026, 9, 8, 7, 0),
    tz: "UTC",
  };

  it("fills the placeholders of a template", () => {
    const text = renderNotice(
      { ...SLACK, text: "{purpose}|{result}|{summary}|{source}|{time}|{unknown}" },
      facts,
    );
    const parts = text.split("|");
    assert.equal(parts[0], "等 Issue 关闭");
    assert.equal(parts[1], "有变化");
    assert.equal(parts[2], "页面状态已变为 Closed。");
    assert.equal(parts[3], "https://github.com/openclaw/openclaw/issues/197685");
    assert.match(parts[4] ?? "", /\d/);
    assert.equal(parts[5], "{unknown}");
  });

  it("sends a fixed text exactly as written, placeholders and all", () => {
    assert.equal(
      renderNotice({ ...SLACK, mode: "fixed", text: "好了 {summary}" }, facts),
      "好了 {summary}",
    );
  });
});

describe("sendNotice", () => {
  const host = (over: Partial<NoticeHost> = {}, sent: Array<Record<string, unknown>> = []) => {
    const sender: NoticeSender = async (ctx) => {
      sent.push({ to: ctx.to, text: ctx.text, accountId: ctx.accountId });
    };
    const h: NoticeHost = {
      connectedChannels: () => ["slack", "telegram"],
      loadSender: async () => sender,
      ...over,
    };
    return { h, sent };
  };

  it("sends one message to the chosen target and says it was sent", async () => {
    const { h, sent } = host();
    const out = await sendNotice(h, { ...SLACK, accountId: "work" }, "你好", () => 5);
    assert.deepEqual(out, { status: "sent", channel: "slack", to: "#nexus-test", at: 5 });
    assert.deepEqual(sent, [{ to: "#nexus-test", text: "你好", accountId: "work" }]);
  });

  it("sends to what the host resolves a #name to, and records the name the user chose", async () => {
    const { h, sent } = host({
      resolveTarget: async ({ to }) => ({
        ok: true,
        to: to === "#nexus-test" ? "channel:C0123456789" : to,
      }),
    });
    const out = await sendNotice(h, SLACK, "你好", () => 5);
    assert.deepEqual(out, { status: "sent", channel: "slack", to: "#nexus-test", at: 5 });
    assert.equal(sent[0]?.to, "channel:C0123456789");
  });

  it("a name the host cannot resolve sends nothing and records why", async () => {
    const { h, sent } = host({
      resolveTarget: async () => ({ ok: false, error: 'Unknown target "#nexus-test" for Slack.' }),
    });
    const out = await sendNotice(h, SLACK, "你好", () => 5);
    assert.equal(out.status, "failed");
    assert.match(out.reason ?? "", /Unknown target/);
    assert.deepEqual(sent, []);
  });

  it("tidies what people type into 'send to' into the channel's own form and leaves real names and ids alone", () => {
    const cases: [string, string][] = [
      ["#nexus-test", "#nexus-test"],
      ["  ＃nexus-test ", "#nexus-test"],
      ["# nexus-test", "#nexus-test"],
      ['"#nexus-test"', "#nexus-test"],
      ["`#nexus-test`", "#nexus-test"],
      ["“#nexus-test”", "#nexus-test"],
      ["「@张三」", "@张三"],
      ["<#C0123ABCD|nexus-test>", "channel:C0123ABCD"],
      ["<#123456789012345678>", "channel:123456789012345678"],
      ["<@U0123ABCD|bob>", "user:U0123ABCD"],
      ["<@123456789012345678>", "<@123456789012345678>"],
      ["https://acme.slack.com/archives/C0123ABCD/p1700000000000100", "channel:C0123ABCD"],
      ["https://discord.com/channels/111/222333", "channel:222333"],
      ["https://t.me/nexus_team", "@nexus_team"],
      ["t.me/c/1234567890/12", "-1001234567890"],
      ["channel:C0123ABCD", "channel:C0123ABCD"],
      ["user:ou_abc", "user:ou_abc"],
      ["+8613800000000", "+8613800000000"],
      ["oc_a1b2c3", "oc_a1b2c3"],
      ["#room:matrix.org", "#room:matrix.org"],
      ["spaces/AAAAxxxx", "spaces/AAAAxxxx"],
      ["产品群", "产品群"],
    ];
    for (const [typed, want] of cases) {
      assert.equal(tidyTarget(typed), want, typed);
    }
  });

  it("keeps the tidied destination in the plan and asks the host to resolve the tidied one", async () => {
    const parsed = parseNotify({ ...SLACK, to: " ＃nexus-test " });
    assert.equal(parsed?.to, "#nexus-test");
    const asked: string[] = [];
    const { h } = host({
      resolveTarget: async ({ to }) => {
        asked.push(to);
        return { ok: true, to: "channel:C0123456789" };
      },
    });
    await sendNotice(h, { ...SLACK, to: "＃nexus-test" }, "你好");
    assert.deepEqual(asked, ["#nexus-test"]);
  });

  it("when a typed name cannot be found, the record says what to do; an id is not blamed on the name", async () => {
    const { h } = host({
      connectedChannels: () => ["feishu"],
      resolveTarget: async () => ({ ok: false, error: 'Unknown target "产品群" for Feishu.' }),
    });
    const named = await sendNotice(h, { ...SLACK, channel: "feishu", to: "产品群" }, "你好");
    assert.equal(named.status, "failed");
    assert.match(named.reason ?? "", /Unknown target/);
    assert.match(named.reason ?? "", /改填 ID/);
    const { h: byId } = host({
      connectedChannels: () => ["feishu"],
      resolveTarget: async () => ({ ok: false, error: "Unknown target for Feishu." }),
    });
    const id = await sendNotice(byId, { ...SLACK, channel: "feishu", to: "user:ou_abc" }, "你好");
    assert.doesNotMatch(id.reason ?? "", /改填 ID/);
  });

  it("a channel that is not connected is only recorded as unavailable: nothing is sent, no other channel is tried", async () => {
    const { h, sent } = host({ connectedChannels: () => ["telegram"] });
    const out = await sendNotice(h, SLACK, "你好", () => 5);
    assert.equal(out.status, "unavailable");
    assert.deepEqual(sent, []);
  });

  it("a channel whose sender is not loaded is unavailable too", async () => {
    const { h } = host({ loadSender: async () => undefined });
    assert.equal((await sendNotice(h, SLACK, "你好")).status, "unavailable");
    const { h: broken } = host({
      loadSender: async () => {
        throw new Error("boom");
      },
    });
    assert.equal((await sendNotice(broken, SLACK, "你好")).status, "unavailable");
  });

  it("a failed send is recorded with the host's short reason and never throws", async () => {
    const { h } = host({
      loadSender: async () => async () => {
        throw new Error("channel_not_found");
      },
    });
    const out = await sendNotice(h, SLACK, "你好", () => 5);
    assert.equal(out.status, "failed");
    assert.equal(out.reason, "channel_not_found");
    assert.equal(JSON.stringify(out).includes("你好"), false);
  });
});

describe("connectedChannels", () => {
  it("lists configured channels that are not switched off, with their accounts", () => {
    const cfg = {
      channels: {
        slack: { enabled: true, accounts: { work: {}, home: {} } },
        telegram: { enabled: false },
        discord: {},
        defaults: "x",
        "Bad Id": {},
      },
    };
    assert.deepEqual(connectedChannels(cfg), [
      { id: "discord", accounts: [] },
      { id: "slack", accounts: ["work", "home"] },
    ]);
    assert.deepEqual(connectedChannels(undefined), []);
    assert.deepEqual(connectedChannels({}), []);
  });
});

describe("a plan with a notification", () => {
  it("refuses an incomplete notification when the plan is drafted", () => {
    const w = scheduleKit();
    const work = w.workWithTask();
    const out = w.k.delegationPlanCreate({
      principal: A,
      workId: work.workId,
      planOwnerType: "commitment",
      planOwnerId: w.commitment(),
      purpose: "跟进",
      plan: w.body({ schedules: [w.daily({ notify: { ...SLACK, to: "" } })] }),
      createdBy: "user",
      now: w.now(),
    });
    assert.notEqual(out.outcome, "created");
    assert.match(JSON.stringify(out), /bad_notify/);
  });

  it("each check keeps its own notification when the plan is accepted", () => {
    const w = scheduleKit();
    const work = w.workWithTask();
    const plan = w.draft(work.workId, w.commitment(), {
      plan: w.body({
        schedules: [
          w.daily({ purpose: "等 Issue 关闭", notify: SLACK }),
          w.daily({ purpose: "每天看一眼进展" }),
        ],
      }),
    });
    const done = w.accept(plan.id);
    assert.equal(done.outcome, "accepted", JSON.stringify(done));
    const ids = (done as { schedules: { id: string }[] }).schedules.map((s) => s.id);
    // Looked up by the check's purpose: the order the accepted schedules come back in is not part of what is tested.
    const notifyOf = (purpose: string): unknown => {
      const rows = ids.map(
        (id) =>
          w.db.prepare("SELECT purpose, notify_json FROM schedules WHERE id = ?").get(id) as {
            purpose: string;
            notify_json: string | null;
          },
      );
      const row = rows.find((r) => r.purpose === purpose);
      return row?.notify_json === null || row === undefined ? null : JSON.parse(row.notify_json);
    };
    assert.deepEqual(notifyOf("等 Issue 关闭"), SLACK);
    assert.equal(notifyOf("每天看一眼进展"), null);
  });
});

describe("the notification owed by a reported check", () => {
  async function reported(
    spec: Partial<ScheduleSpec>,
    outcome: "changed" | "no_change" | "cannot_check",
  ) {
    const w = dispatchKit();
    const runtime = createCheckRuntime({
      getStore: async () => w.store,
      resolvePrincipal: () => A,
      logger: { info: () => undefined, warn: () => undefined },
      now: w.now,
      claimWaitMs: 0,
      sleep: async () => undefined,
      state: { pending: new Map() },
    });
    const f = w.follow(spec);
    w.advance(10_000);
    await w.dispatcher.tick();
    const trigger = w.triggers(f.scheduleId)[0]!;
    const call = w.host.scheduled[0]!;
    const sessionKey = checkSessionKey(f.scheduleId, trigger.plannedAt);
    await runtime.onCronChanged({
      action: "started",
      jobId: trigger.turnJobId!,
      sessionTarget: `session:${sessionKey}`,
      job: { name: `plugin:nexus-agent-core:tag:nexus-check-${trigger.id}:x` },
    });
    await runtime.authenticate(
      { prompt: call.message },
      { sessionKey, runId: "run1", trigger: "cron" },
    );
    const after: string[] = [];
    const tool = createScheduleCheckTools(
      {
        getStore: async () => w.store,
        resolvePrincipal: () => A,
        now: w.now,
        afterReport: (_p, id) => after.push(id),
      },
      { sessionKey },
    )[0]!;
    await tool.execute("c1", {
      triggerId: trigger.id,
      outcome,
      summary: "页面状态已变为 Closed。",
    } as never);
    return { w, f, trigger, after };
  }

  it("a new report hands the trigger to the notifier exactly once", async () => {
    const { after, trigger } = await reported({ notify: SLACK }, "changed");
    assert.deepEqual(after, [trigger.id]);
  });

  it("owes the chosen message for a ticked outcome, with the facts to fill it, and never twice", async () => {
    const { w, trigger } = await reported({ notify: SLACK }, "changed");
    const owed = await w.store.scheduleCheckNoticeGet({ principal: A, triggerId: trigger.id });
    assert.equal(owed.outcome, "pending");
    if (owed.outcome !== "pending") {
      return;
    }
    assert.equal(owed.notify.to, "#nexus-test");
    assert.equal(owed.facts.outcome, "changed");
    assert.equal(owed.facts.summary, "页面状态已变为 Closed。");
    const notice = { status: "unavailable" as const, channel: "slack", to: "#nexus-test", at: 9 };
    const rec = await w.store.scheduleCheckNoticeRecord({
      principal: A,
      triggerId: trigger.id,
      notice,
    });
    assert.equal(rec.outcome, "recorded");
    const row = w.db
      .prepare("SELECT report_json FROM schedule_triggers WHERE id = ?")
      .get(trigger.id) as { report_json: string };
    const stored = JSON.parse(row.report_json) as { outcome: string; notice?: unknown };
    assert.deepEqual(stored.notice, notice);
    assert.equal(stored.outcome, "changed");
    assert.equal(
      (await w.store.scheduleCheckNoticeGet({ principal: A, triggerId: trigger.id })).outcome,
      "done",
    );
    const again = await w.store.scheduleCheckNoticeRecord({
      principal: A,
      triggerId: trigger.id,
      notice: { ...notice, status: "sent" },
    });
    assert.equal(again.outcome, "noop");
  });

  it("owes nothing for an outcome that was not ticked, or for a check without a notification", async () => {
    for (const [spec, outcome] of [
      [{ notify: SLACK }, "cannot_check"],
      [{ notify: SLACK }, "no_change"],
      [{}, "changed"],
    ] as const) {
      const { w, trigger } = await reported(spec, outcome);
      assert.equal(
        (await w.store.scheduleCheckNoticeGet({ principal: A, triggerId: trigger.id })).outcome,
        "none",
        outcome,
      );
    }
  });

  it("owes a message for cannot_check when that was ticked", async () => {
    const { w, trigger } = await reported(
      { notify: { ...SLACK, onChanged: false, onCannotCheck: true } },
      "cannot_check",
    );
    assert.equal(
      (await w.store.scheduleCheckNoticeGet({ principal: A, triggerId: trigger.id })).outcome,
      "pending",
    );
  });
});
