// The follow-up check turn (design 4.5.3, W4b): a background turn is ours only when the host job, the session and the marker all
// point at the same fired trigger; anything else gets no tools. The report tool is gated to the claimed run, ends the check Task,
// opens the dispatch slot and never touches the Work's outcome.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { dispatchKit, MIN } from "../test-support/dispatch-kit.js";
import { A, B } from "../test-support/goal-kit.js";
import { createScheduleCheckTools } from "../tools/schedule-check-tools.js";
import { createCheckRuntime, readCheckMarker } from "./check-runtime.js";
import { checkSessionKey } from "./dispatcher.js";

async function world() {
  const w = dispatchKit();
  const logs: string[] = [];
  let principal: typeof A | undefined = A;
  const runtime = createCheckRuntime({
    getStore: async () => w.store,
    resolvePrincipal: () => principal,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    now: w.now,
    claimWaitMs: 0,
    sleep: async () => undefined,
    state: { pending: new Map() },
  });
  const f = w.follow();
  w.advance(10_000);
  await w.dispatcher.tick();
  const trigger = w.triggers(f.scheduleId)[0]!;
  const call = w.host.scheduled[0]!;
  const sessionKey = checkSessionKey(f.scheduleId, trigger.plannedAt);
  const started = (jobId = trigger.turnJobId!) =>
    runtime.onCronChanged({
      action: "started",
      jobId,
      sessionTarget: `session:${sessionKey}`,
      job: { name: `plugin:nexus-agent-core:tag:nexus-check-${trigger.id}:x` },
    });
  const tools = (session = sessionKey) =>
    createScheduleCheckTools(
      {
        getStore: async () => w.store,
        resolvePrincipal: () => principal,
        now: w.now,
        logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      },
      { sessionKey: session },
    );
  const report = async (params: Record<string, unknown>, session = sessionKey) => {
    const tool = tools(session)[0]!;
    const out = (await tool.execute("c1", params as never)) as {
      details?: unknown;
      content?: Array<{ text?: string }>;
    };
    return JSON.parse(out.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  };
  return {
    ...w,
    f,
    trigger,
    call,
    sessionKey,
    runtime,
    started,
    report,
    logs,
    setPrincipal: (p: typeof A | undefined) => {
      principal = p;
    },
  };
}

const ctx = (sessionKey: string, runId = "run1") => ({ sessionKey, runId, trigger: "cron" });

describe("check turn: authentication", () => {
  it("recognises the marker the dispatcher puts in the prompt", async () => {
    const w = await world();
    assert.equal(readCheckMarker(w.call.message), w.trigger.id);
    assert.equal(readCheckMarker("hello"), undefined);
  });

  it("a prompt without our marker is not ours (falls through to the other branches)", async () => {
    const w = await world();
    assert.equal(
      await w.runtime.authenticate({ prompt: "[nexus:watch:W123]" }, ctx(w.sessionKey)),
      undefined,
    );
  });

  it("claims the turn for the exact trigger: protocol, brief and only the check tools; Task starts", async () => {
    const w = await world();
    await w.started();
    const out = await w.runtime.authenticate({ prompt: w.call.message }, ctx(w.sessionKey));
    assert.ok(out);
    assert.ok(out.toolsAllow.includes("nexus_schedule_check_report"));
    assert.ok(out.toolsAllow.includes("nexus_task_get"));
    assert.ok(out.toolsAllow.includes("web_fetch"));
    assert.ok(!out.toolsAllow.includes("nexus_decision_request"));
    assert.ok(!out.toolsAllow.includes("nexus_watch_report"));
    assert.match(out.prependSystemContext ?? "", /follow-up check/);
    assert.match(out.prependContext ?? "", new RegExp(`triggerId: ${w.trigger.id}`));
    assert.match(out.prependContext ?? "", /https:\/\/example\.com\/status/);
    assert.match(out.prependContext ?? "", /看对方有没有回复/);
    const t = w.triggers(w.f.scheduleId)[0]!;
    assert.equal(t.turnState, "claimed");
    assert.equal(w.taskRow(t.taskId!)?.status, "planning");
  });

  it("fails closed (no tools) when no started job exists for the session", async () => {
    const w = await world();
    const out = await w.runtime.authenticate({ prompt: w.call.message }, ctx(w.sessionKey));
    assert.deepEqual(out?.toolsAllow, []);
    assert.equal(w.triggers(w.f.scheduleId)[0]?.turnState, "scheduled");
  });

  it("fails closed when the marker names another trigger than the host job's", async () => {
    const w = await world();
    await w.started();
    const out = await w.runtime.authenticate(
      { prompt: "[nexus:check:tg_FORGED0000]" },
      ctx(w.sessionKey),
    );
    assert.deepEqual(out?.toolsAllow, []);
    assert.equal(w.triggers(w.f.scheduleId)[0]?.turnState, "scheduled");
  });

  it("fails closed when the job runs in another session than the one recorded", async () => {
    const w = await world();
    await w.started();
    const out = await w.runtime.authenticate(
      { prompt: w.call.message },
      ctx("agent:main:somewhere-else"),
    );
    assert.deepEqual(out?.toolsAllow, []);
  });

  it("the host folds session keys to lower case: a turn under the folded key is still ours", async () => {
    const w = await world();
    await w.started();
    assert.equal(
      w.sessionKey,
      w.sessionKey.toLowerCase(),
      "the key we record is already lower case",
    );
    const out = await w.runtime.authenticate(
      { prompt: w.call.message },
      ctx(w.sessionKey.toUpperCase()),
    );
    assert.ok(out?.toolsAllow.length, "claimed even though the case differs");
    assert.equal(w.triggers(w.f.scheduleId)[0]?.turnState, "claimed");
  });

  it("one started job authenticates at most one turn", async () => {
    const w = await world();
    await w.started();
    assert.ok(
      (await w.runtime.authenticate({ prompt: w.call.message }, ctx(w.sessionKey)))?.toolsAllow
        .length,
    );
    const again = await w.runtime.authenticate(
      { prompt: w.call.message },
      ctx(w.sessionKey, "run2"),
    );
    assert.deepEqual(again?.toolsAllow, []);
  });

  it("a retry of the same run (same model again, or a fallback model) is still the check turn: same tools and brief", async () => {
    const w = await world();
    await w.started();
    const first = await w.runtime.authenticate({ prompt: w.call.message }, ctx(w.sessionKey));
    assert.ok(first?.toolsAllow.includes("nexus_schedule_check_report"));
    const retry = await w.runtime.authenticate({ prompt: w.call.message }, ctx(w.sessionKey));
    assert.deepEqual(retry?.toolsAllow, first?.toolsAllow);
    assert.equal(retry?.prependContext, first?.prependContext);
    assert.equal(retry?.prependSystemContext, first?.prependSystemContext);
    assert.ok(w.logs.some((m) => /re-authenticated for a retry of the same run/.test(m)));
    // The trigger was claimed once, and the retried turn can still report.
    const t = w.triggers(w.f.scheduleId)[0]!;
    assert.equal(t.turnState, "claimed");
  });

  it("a retry does not let another run, another trigger or a finished job borrow the grant", async () => {
    const w = await world();
    await w.started();
    await w.runtime.authenticate({ prompt: w.call.message }, ctx(w.sessionKey));
    const otherRun = await w.runtime.authenticate(
      { prompt: w.call.message },
      ctx(w.sessionKey, "run2"),
    );
    assert.deepEqual(otherRun?.toolsAllow, []);
    const otherTrigger = await w.runtime.authenticate(
      { prompt: w.call.message.replace(w.trigger.id, "tg_OTHER") },
      ctx(w.sessionKey),
    );
    assert.deepEqual(otherTrigger?.toolsAllow, []);
    await w.runtime.onCronChanged({
      action: "finished",
      jobId: w.trigger.turnJobId!,
      status: "ok",
    });
    const afterEnd = await w.runtime.authenticate({ prompt: w.call.message }, ctx(w.sessionKey));
    assert.deepEqual(afterEnd?.toolsAllow, []);
  });

  it("refuses to run a check whose schedule was paused after the check was fired, and closes it", async () => {
    const w = await world();
    w.k.schedulePause({ principal: A, scheduleId: w.f.scheduleId, source: "user", now: w.now() });
    await w.started();
    const out = await w.runtime.authenticate({ prompt: w.call.message }, ctx(w.sessionKey));
    assert.deepEqual(out?.toolsAllow, []);
    const t = w.triggers(w.f.scheduleId)[0]!;
    assert.equal(t.turnState, "failed");
    assert.equal(t.failReason, "schedule_paused");
    assert.equal(w.taskRow(t.taskId!)?.status, "cancelled");
    assert.equal(t.slotOpen, false);
  });

  it("refuses when the prerequisite is gone (INV-11) and does not run the check", async () => {
    const w = await world();
    // Closed behind the ledger's back (no wrap-up was registered), so the gate itself is what is tested.
    w.db
      .prepare("UPDATE commitments SET lifecycle = 'cancelled', cancelled_at = 1 WHERE id = ?")
      .run(w.f.commitmentId);
    await w.started();
    const out = await w.runtime.authenticate({ prompt: w.call.message }, ctx(w.sessionKey));
    assert.deepEqual(out?.toolsAllow, []);
    assert.match(w.triggers(w.f.scheduleId)[0]?.failReason ?? "", /prerequisite_missing|schedule_/);
  });

  it("a check fired before the commitment ended may still run during the wrap-up window (design 6.4)", async () => {
    const w = await world();
    w.k.commitmentCancel({
      principal: A,
      commitmentId: w.f.commitmentId,
      reason: "不做了",
      now: w.now(),
    });
    await w.started();
    const out = await w.runtime.authenticate({ prompt: w.call.message }, ctx(w.sessionKey));
    assert.ok(
      out?.toolsAllow.includes("nexus_schedule_check_report"),
      "the running check is not cut off",
    );
    assert.equal(w.triggers(w.f.scheduleId)[0]?.turnState, "claimed");
  });

  it("after the wrap-up window the check is refused and the plan is over", async () => {
    const w = await world();
    w.k.commitmentCancel({
      principal: A,
      commitmentId: w.f.commitmentId,
      reason: "不做了",
      now: w.now(),
    });
    w.advance(31 * 60_000);
    await w.dispatcher.tick();
    assert.equal(w.schedule(w.f.scheduleId).status, "cancelled");
    await w.started();
    const out = await w.runtime.authenticate({ prompt: w.call.message }, ctx(w.sessionKey));
    assert.deepEqual(out?.toolsAllow, []);
  });

  it("another owner cannot claim", async () => {
    const w = await world();
    await w.started();
    w.setPrincipal(B);
    const out = await w.runtime.authenticate({ prompt: w.call.message }, ctx(w.sessionKey));
    assert.deepEqual(out?.toolsAllow, []);
    assert.equal(w.triggers(w.f.scheduleId)[0]?.turnState, "scheduled");
  });
});

describe("check turn: the report", () => {
  const claimed = async () => {
    const w = await world();
    await w.started();
    await w.runtime.authenticate({ prompt: w.call.message }, ctx(w.sessionKey));
    return w;
  };

  it("the gate lets the report through only for the claimed run of that trigger", async () => {
    const w = await claimed();
    const ok = await w.runtime.beforeToolCall(
      {
        toolName: "nexus_schedule_check_report",
        params: { triggerId: w.trigger.id },
        runId: "run1",
      },
      { sessionKey: w.sessionKey },
    );
    assert.equal(ok, undefined);
    for (const bad of [
      { runId: "run9", sessionKey: w.sessionKey, triggerId: w.trigger.id },
      { runId: "run1", sessionKey: "agent:main:main", triggerId: w.trigger.id },
      { runId: "run1", sessionKey: w.sessionKey, triggerId: "tg_OTHER00000" },
    ]) {
      const out = await w.runtime.beforeToolCall(
        {
          toolName: "nexus_schedule_check_report",
          params: { triggerId: bad.triggerId },
          runId: bad.runId,
        },
        { sessionKey: bad.sessionKey },
      );
      assert.equal(out?.block, true);
    }
    assert.equal(
      await w.runtime.beforeToolCall({ toolName: "nexus_task_get", params: {}, runId: "r" }, {}),
      undefined,
    );
  });

  it("a finished check ends its Task succeeded, opens the slot and restores coverage", async () => {
    const w = await claimed();
    const out = await w.report({
      triggerId: w.trigger.id,
      outcome: "no_change",
      summary: "页面没有新内容。",
    });
    assert.equal(out.ok, true);
    const t = w.triggers(w.f.scheduleId)[0]!;
    assert.equal(t.turnState, "reported");
    assert.deepEqual(t.report, { outcome: "no_change", summary: "页面没有新内容。" });
    assert.equal(t.slotOpen, false);
    assert.equal(w.taskRow(t.taskId!)?.status, "succeeded");
    assert.equal(w.taskRow(t.taskId!)?.summary, "页面没有新内容。");
    assert.equal(w.schedule(w.f.scheduleId).coverageState, "on_plan");
  });

  it("cannot_check ends the Task failed and degrades coverage: never shown as 'nothing changed'", async () => {
    const w = await claimed();
    const out = await w.report({
      triggerId: w.trigger.id,
      outcome: "cannot_check",
      summary: "没有可读取的来源。",
    });
    assert.equal(out.ok, true);
    const t = w.triggers(w.f.scheduleId)[0]!;
    assert.equal(w.taskRow(t.taskId!)?.status, "failed");
    const s = w.schedule(w.f.scheduleId);
    assert.equal(s.coverageState, "degraded");
    assert.equal(s.coverageNote, "check_failed");
  });

  it("a second report of the same turn is answered, not applied", async () => {
    const w = await claimed();
    await w.report({ triggerId: w.trigger.id, outcome: "changed", summary: "对方回复了。" });
    const again = await w.report({
      triggerId: w.trigger.id,
      outcome: "no_change",
      summary: "没有变化。",
    });
    assert.equal(again.ok, true);
    assert.equal(again.alreadyReported, true);
    assert.equal(w.triggers(w.f.scheduleId)[0]?.report?.outcome, "changed");
  });

  it("refuses a report from another session, with a bad outcome, or with an empty summary, and says so in the log", async () => {
    const w = await claimed();
    assert.equal(
      (
        await w.report(
          { triggerId: w.trigger.id, outcome: "no_change", summary: "x" },
          "agent:main:main",
        )
      ).ok,
      false,
    );
    assert.equal(
      (await w.report({ triggerId: w.trigger.id, outcome: "satisfied", summary: "x" })).code,
      "invalid_outcome",
    );
    assert.equal(
      (await w.report({ triggerId: w.trigger.id, outcome: "changed", summary: "  " })).code,
      "invalid_summary",
    );
    assert.equal(
      (await w.report({ triggerId: "bad id!", outcome: "changed", summary: "x" })).code,
      "invalid_trigger_id",
    );
    assert.equal(w.triggers(w.f.scheduleId)[0]?.turnState, "claimed");
    assert.ok(w.logs.some((line) => line.includes("check report refused (invalid_outcome)")));
    assert.ok(
      w.logs.every((line) => !line.includes("satisfied")),
      "the log never carries the content",
    );
  });

  it("an over-long summary is cut to the limit, not refused: the check still gets reported", async () => {
    const w = await claimed();
    const out = await w.report({
      triggerId: w.trigger.id,
      outcome: "no_change",
      summary: "字".repeat(900),
    });
    assert.equal(out.ok, true);
    const t = w.triggers(w.f.scheduleId)[0]!;
    assert.equal(t.turnState, "reported");
    assert.equal(Array.from(t.report?.summary ?? "").length, 600);
  });

  it("another owner cannot report", async () => {
    const w = await claimed();
    w.setPrincipal(B);
    const out = await w.report({ triggerId: w.trigger.id, outcome: "changed", summary: "x" });
    assert.equal(out.ok, false);
    w.setPrincipal(A);
    assert.equal(w.triggers(w.f.scheduleId)[0]?.turnState, "claimed");
  });

  it("a host job that ends without a report closes the check as failed; after a report it changes nothing", async () => {
    const w = await claimed();
    await w.runtime.onCronChanged({ action: "finished", jobId: w.trigger.turnJobId! });
    const t = w.triggers(w.f.scheduleId)[0]!;
    assert.equal(t.turnState, "failed");
    assert.equal(t.failReason, "turn_ended_without_report");
    assert.equal(w.taskRow(t.taskId!)?.status, "failed");
    assert.equal(w.schedule(w.f.scheduleId).coverageState, "degraded");

    const ok = await claimed();
    await ok.report({ triggerId: ok.trigger.id, outcome: "no_change", summary: "没变化" });
    await ok.runtime.onCronChanged({ action: "finished", jobId: ok.trigger.turnJobId! });
    await ok.runtime.onCronChanged({ action: "removed", jobId: ok.trigger.turnJobId! });
    assert.equal(ok.triggers(ok.f.scheduleId)[0]?.turnState, "reported");
  });

  it("keeps what the host said about the end of a job that never reported", async () => {
    const w = await claimed();
    await w.runtime.onCronChanged({
      action: "finished",
      jobId: w.trigger.turnJobId!,
      status: "error",
      error: "model not configured",
    });
    const t = w.triggers(w.f.scheduleId)[0]!;
    assert.equal(t.turnState, "failed");
    assert.equal(
      t.failReason,
      "turn_ended_without_report (status=error; error=model not configured)",
    );
  });

  it("a host job that is only `removed` while its turn runs does not close the check: the model can still report", async () => {
    const w = await claimed();
    await w.runtime.onCronChanged({ action: "removed", jobId: w.trigger.turnJobId! });
    assert.equal(w.triggers(w.f.scheduleId)[0]?.turnState, "claimed");
    const out = await w.report({
      triggerId: w.trigger.id,
      outcome: "no_change",
      summary: "没变化",
    });
    assert.equal(out.ok, true);
    assert.equal(w.triggers(w.f.scheduleId)[0]?.turnState, "reported");
  });
});

describe("check Tasks never count toward the Work", () => {
  it("firing and ending checks leaves the Work's outcome events and task facts alone", async () => {
    const w = await world();
    // the Work's own Task finished: the Work is achieved
    w.db
      .prepare("UPDATE nexus_tasks SET status = 'succeeded', ended_at = 1 WHERE id = ?")
      .run(w.f.taskId);
    w.k.workEvaluate({ principal: A, workId: w.f.workId, now: w.now() });
    const events = () =>
      w.count("SELECT COUNT(*) AS c FROM work_outcome_events WHERE work_id = ?", w.f.workId);
    const before = events();
    assert.equal(before, 1);
    // a failed and a succeeded check later, still only the original outcome event
    await w.started();
    await w.runtime.authenticate({ prompt: w.call.message }, ctx(w.sessionKey));
    await w.report({ triggerId: w.trigger.id, outcome: "cannot_check", summary: "无法检查" });
    w.advance(16 * MIN);
    await w.dispatcher.tick();
    w.k.workEvaluate({ principal: A, workId: w.f.workId, now: w.now() });
    assert.equal(events(), before);
    assert.ok(w.count("SELECT COUNT(*) AS c FROM nexus_tasks WHERE kind = 'schedule_check'") >= 2);
  });
});
