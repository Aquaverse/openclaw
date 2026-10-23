// Stage 4 Watcher acceptance flows through the REAL entry points: the three watch tools, the watch runtime (cron_changed
// correlation, authenticate-as-claim, tool gate, scheduling), the watch RPC handlers and the decision outbox, on the real
// kernel (in-memory SQLite) with a recording fake of the host scheduler. The harness lives in test-support/decision-world.ts.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { NEXUS_WATCHER_PROTOCOL } from "./prompt.js";
import { P, world, type Details } from "./test-support/decision-world.js";
import {
  buildWatchMessage,
  createWatchRuntime,
  createWatchSharedState,
  resolveWatcherExtraTools,
  WATCHER_BASE_TOOLS,
} from "./watch-runtime.js";

type World = ReturnType<typeof world>;

const MIN = 60_000;
const HOUR = 60 * MIN;

async function wcall(w: World, name: string, params: Record<string, unknown>): Promise<Details> {
  const tool = w.watchTools("s1").find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name}`);
  const out = (await tool.execute("call", params as never)) as unknown as { details: Details };
  return out.details;
}

async function claimCall(
  w: World,
  name: string,
  params: Record<string, unknown>,
): Promise<Details> {
  const tool = w.claimTools("s1").find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name}`);
  const out = (await tool.execute("call", params as never)) as unknown as { details: Details };
  return out.details;
}

/** A Task with one still-unproven claim, ready for a watch. */
async function setup(w: World, title = "订东京酒店") {
  const t = w.newTask(title);
  const claim = await claimCall(w, "nexus_claim_add", {
    taskId: t,
    subject: "booking",
    predicate: "executed",
  });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  return { t, claimId: claim.claimId as string };
}

async function mkWatch(
  w: World,
  t: string,
  claimId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const out = await wcall(w, "nexus_watch_create", {
    taskId: t,
    claimId,
    expect: "酒店回复了确认邮件",
    firstCheckInMinutes: 10,
    ...extra,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  await w.watchRuntime.sync();
  return out.watchId as string;
}

const watchRow = (w: World, id: string) => w.row("SELECT * FROM watches WHERE id = ?", id);
const taskStatus = (w: World, t: string) =>
  String(w.row("SELECT status FROM nexus_tasks WHERE id = ?", t).status);
const jobOf = (w: World, id: string) => String(watchRow(w, id).scheduler_job_id);
const jobName = (watchId: string, sessionKey = "s1") =>
  `plugin:nexus-agent-core:tag:nexus-watch-${watchId}:${sessionKey}:u1`;

/** The host announces that a job started (what spike 4 showed arrives before the prompt). */
async function started(w: World, jobId: string, watchId: string, sessionKey = "s1") {
  await w.watchRuntime.onCronChanged({
    action: "started",
    jobId,
    sessionTarget: `session:${sessionKey}`,
    job: { name: jobName(watchId, sessionKey), sessionTarget: `session:${sessionKey}` },
  });
}

/** started + the watcher prompt, as the host would deliver them. */
async function turn(
  w: World,
  watchId: string,
  runId: string,
  over: { sessionKey?: string; prompt?: string; skipStart?: boolean } = {},
) {
  const sessionKey = over.sessionKey ?? "s1";
  const jobId = jobOf(w, watchId);
  if (!over.skipStart) {
    await started(w, jobId, watchId, sessionKey);
  }
  const taskId = String(watchRow(w, watchId).task_id);
  const out = await w.watchRuntime.authenticate(
    { prompt: over.prompt ?? buildWatchMessage({ id: watchId, taskId }) },
    { runId, sessionKey, trigger: "cron", agentId: "main" },
  );
  return { jobId, out };
}

/** nexus_watch_report as the host runs it: the gate hook first, then the tool. */
async function report(
  w: World,
  watchId: string,
  outcome: string,
  runId: string,
  finding?: string,
  sessionKey = "s1",
) {
  const gate = await w.watchRuntime.beforeToolCall(
    { toolName: "nexus_watch_report", params: { watchId, outcome }, runId },
    { sessionKey, agentId: "main", runId },
  );
  if (gate) {
    return { blocked: true as const, reason: gate.blockReason };
  }
  const details = await wcall(w, "nexus_watch_report", {
    watchId,
    outcome,
    ...(finding ? { finding } : {}),
  });
  return { blocked: false as const, details };
}

const finished = (w: World, jobId: string) =>
  w.watchRuntime.onCronChanged({ action: "finished", jobId, status: "ok" });
const schedules = (w: World) => w.schedulerCalls.filter((call) => call.op === "schedule");
const watchEvents = (w: World) => w.emitted.filter((entry) => entry.event === "watch_changed");

/** SUPPORTED the honest way: a committed execution attached as evidence. */
async function proveByExecution(w: World, t: string, claimId: string) {
  const actionId = await w.booking(t);
  const decision = await w.run("nexus_decision_request", {
    taskId: t,
    effect: { actionIds: [actionId] },
  });
  const resolved = await w.rpc("nexus.decision.resolve", {
    decisionId: decision.decisionId as string,
    resolution: "approved",
  });
  const executionId = resolved.payload?.executionId as string;
  assert.ok(executionId);
  const commit = await w.run("nexus_action_commit", { executionId });
  assert.equal(commit.status, "succeeded");
  const linked = await claimCall(w, "nexus_evidence_add", {
    taskId: t,
    claimId,
    ref: { kind: "execution", id: executionId },
  });
  assert.equal(linked.state, "SUPPORTED", JSON.stringify(linked));
}

describe("creating a watch", () => {
  it("is an intent first: pending_schedule, the Task moves to watching, then the runtime turns it into one cron job", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const before = taskStatus(w, t);
    assert.ok(before === "clarifying" || before === "planning" || before === "draft", before);
    const created = await wcall(w, "nexus_watch_create", {
      taskId: t,
      claimId,
      expect: "酒店回复了确认邮件",
      firstCheckInMinutes: 10,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.reused, false);
    const id = created.watchId as string;
    assert.match(id, /^W[0-9A-Z]{10}$/u);
    assert.equal(taskStatus(w, t), "watching");
    await w.watchRuntime.sync();

    const row = watchRow(w, id);
    assert.equal(row.status, "scheduled");
    assert.equal(row.scheduler_job_id, "job-1");
    assert.equal(row.scheduler_revision, row.revision);
    const calls = w.schedulerCalls.filter((call) => call.tag === `nexus-watch-${id}`);
    assert.deepEqual(
      calls.map((call) => call.op),
      ["unschedule", "schedule"],
      "unscheduling by tag comes first: scheduling is not idempotent",
    );
    const call = schedules(w)[0] as Record<string, unknown>;
    assert.equal(call.delayMs, 10 * MIN);
    assert.equal(call.sessionKey, "s1");
    assert.equal(call.name, `nexus-watch-${id}-r1`);
    assert.ok(String(call.message).startsWith(`[nexus:watch:${id}]`));
    const changes = watchEvents(w).map((entry) => entry.payload.change);
    assert.ok(changes.includes("created") && changes.includes("scheduled"), changes.join(","));
  });

  it("an identical active watch is reused, not duplicated", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    await mkWatch(w, t, claimId);
    const again = await wcall(w, "nexus_watch_create", {
      taskId: t,
      claimId,
      expect: "酒店回复了确认邮件",
    });
    assert.equal(again.ok, true);
    assert.equal(again.reused, true);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM watches"), 1);
    assert.equal(schedules(w).length, 1);
  });

  it("refuses what cannot work: empty or long expect, bad delay or attempts, unknown / met / refuted claim, closed Task", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const base = { taskId: t, claimId, expect: "ok", firstCheckInMinutes: 10 };
    assert.equal(
      (await wcall(w, "nexus_watch_create", { ...base, expect: "  " })).code,
      "invalid_bad_expect",
    );
    assert.equal(
      (await wcall(w, "nexus_watch_create", { ...base, expect: "x".repeat(501) })).code,
      "invalid_bad_expect",
    );
    assert.equal(
      (await wcall(w, "nexus_watch_create", { ...base, firstCheckInMinutes: 0 })).code,
      "invalid_bad_delay",
    );
    assert.equal(
      (await wcall(w, "nexus_watch_create", { ...base, firstCheckInMinutes: 43_201 })).code,
      "invalid_bad_delay",
    );
    assert.equal(
      (await wcall(w, "nexus_watch_create", { ...base, maxAttempts: 9 })).code,
      "invalid_bad_attempts",
    );
    assert.equal(
      (await wcall(w, "nexus_watch_create", { ...base, claimId: "CNOSUCH" })).code,
      "claim_not_found",
    );
    assert.equal(
      (await wcall(w, "nexus_watch_create", { ...base, taskId: "TNOSUCH1" })).code,
      "not_found",
    );
    assert.equal(w.count("SELECT COUNT(*) AS c FROM watches"), 0);

    w.db.prepare("UPDATE claims SET state = 'SUPPORTED' WHERE id = ?").run(claimId);
    assert.equal((await wcall(w, "nexus_watch_create", base)).code, "invalid_claim_already_met");
    w.db.prepare("UPDATE claims SET state = 'REFUTED' WHERE id = ?").run(claimId);
    assert.equal((await wcall(w, "nexus_watch_create", base)).code, "invalid_claim_refuted");
    w.db.prepare("UPDATE claims SET state = 'ASSERTED' WHERE id = ?").run(claimId);

    w.db.prepare("UPDATE nexus_tasks SET status = 'cancelled' WHERE id = ?").run(t);
    assert.equal((await wcall(w, "nexus_watch_create", base)).code, "task_closed");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM watches"), 0);
  });

  it("three active watches per Task at most", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    for (const n of [1, 2, 3]) {
      await mkWatch(w, t, claimId, { expect: `条件 ${n}` });
    }
    const fourth = await wcall(w, "nexus_watch_create", {
      taskId: t,
      claimId,
      expect: "条件 4",
      firstCheckInMinutes: 10,
    });
    assert.equal(fourth.code, "limit_reached");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM watches"), 3);
  });

  it("a failed schedule leaves the intent in place; the next pass schedules it", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    w.setScheduleMode("fail");
    const id = await mkWatch(w, t, claimId);
    assert.equal(watchRow(w, id).status, "pending_schedule");
    assert.equal(watchRow(w, id).scheduler_job_id, null);
    w.setScheduleMode("ok");
    await w.watchRuntime.sync();
    assert.equal(watchRow(w, id).status, "scheduled");
    assert.equal(
      w.count("SELECT COUNT(*) AS c FROM watches WHERE scheduler_job_id IS NOT NULL"),
      1,
    );
  });

  it("a scheduled watch that never fired is rebuilt as a miss, with the 1 hour back-off", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId);
    w.advance(10 * MIN + 15 * MIN + 1);
    await w.watchRuntime.sync();
    const row = watchRow(w, id);
    assert.equal(row.attempts, 1);
    assert.equal(row.status, "scheduled");
    assert.equal(row.scheduler_job_id, "job-2");
    assert.equal(schedules(w).length, 2);
    assert.equal((schedules(w)[1] as Record<string, unknown>).delayMs, HOUR);
    assert.equal((schedules(w)[1] as Record<string, unknown>).name, `nexus-watch-${id}-r2`);
  });
});

describe("authenticating a background turn (section 10.2)", () => {
  it("one started job + the matching marker: the turn is a watcher turn with the narrow tool list and a run trigger carrying the watch id", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId);
    const { jobId, out } = await turn(w, id, "run-W1");
    assert.ok(out);
    assert.deepEqual(out.toolsAllow, w.watchRuntime.allowedTools());
    for (const base of WATCHER_BASE_TOOLS) {
      assert.ok(out.toolsAllow.includes(base), base);
    }
    for (const name of out.toolsAllow) {
      assert.ok(
        !/^nexus_(action|decision|watch_create|watch_cancel|preference)/u.test(name),
        `${name} must not be offered to a watcher`,
      );
    }
    assert.equal(out.prependSystemContext, NEXUS_WATCHER_PROTOCOL);
    assert.ok(out.prependContext?.includes("酒店回复了确认邮件"));
    const row = watchRow(w, id);
    assert.equal(row.status, "firing");
    assert.equal(row.attempts, 1);
    assert.equal(row.scheduler_job_id, jobId);
    const trigger = w.row("SELECT * FROM run_triggers WHERE run_id = 'run-W1'");
    assert.equal(trigger.trigger, "cron");
    assert.equal(trigger.watch_id, id);
    assert.equal(trigger.job_id, jobId);
    assert.ok(watchEvents(w).some((entry) => entry.payload.change === "firing"));
  });

  it("a prompt without our marker is not ours: other cron jobs and heartbeats are left alone", async () => {
    const w = world({ claims: true });
    const out = await w.watchRuntime.authenticate(
      { prompt: "每天早上 9 点提醒我喝水" },
      { runId: "r", sessionKey: "s1", trigger: "cron", agentId: "main" },
    );
    assert.equal(out, undefined);
  });

  it("fails closed: no started job, marker for another watch, two candidates, replay, another session, unknown job", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId, { expect: "条件 A" });
    const other = await mkWatch(w, t, claimId, { expect: "条件 B" });
    const isClosed = (out: { toolsAllow: string[] } | undefined) => {
      assert.ok(out, "a marker-bearing turn always gets an answer");
      assert.deepEqual(out.toolsAllow, []);
    };

    // 1) the marker, but the host never said a job started
    isClosed((await turn(w, id, "r1", { skipStart: true })).out);
    assert.equal(watchRow(w, id).status, "scheduled", "nothing was claimed");

    // 2) a real job of watch A started, but the prompt names watch B (a forged or stale prompt)
    isClosed(
      (
        await turn(w, id, "r2", {
          prompt: buildWatchMessage({ id: other, taskId: t }),
        })
      ).out,
    );
    assert.equal(watchRow(w, id).status, "scheduled");
    assert.equal(watchRow(w, other).status, "scheduled");
    await finished(w, jobOf(w, id));

    // 3) two started jobs for the same session: ambiguous, neither is trusted
    await started(w, jobOf(w, id), id);
    await started(w, jobOf(w, other), other);
    isClosed(
      await w.watchRuntime.authenticate(
        { prompt: buildWatchMessage({ id, taskId: t }) },
        { runId: "r3", sessionKey: "s1", trigger: "cron", agentId: "main" },
      ),
    );
    assert.equal(watchRow(w, id).status, "scheduled");
    assert.equal(watchRow(w, other).status, "scheduled");
    await finished(w, jobOf(w, id));
    await finished(w, jobOf(w, other));
    assert.equal(w.watchRuntime.pendingCount(), 0, "finished drops the pending entry");

    // 4) happy path once, then the same prompt again (retry or replay): the job is spent
    const ok = await turn(w, id, "r4");
    assert.ok(ok.out && ok.out.toolsAllow.length > 0);
    isClosed((await turn(w, id, "r5", { skipStart: true })).out);
    assert.equal(w.row("SELECT COUNT(*) AS c FROM run_triggers WHERE watch_id IS NOT NULL").c, 1);

    // 5) the job belongs to another session than the one the turn runs in
    isClosed((await turn(w, other, "r6", { sessionKey: "s2" })).out);
    assert.equal(watchRow(w, other).status, "scheduled");
    assert.equal(w.row("SELECT COUNT(*) AS c FROM run_triggers WHERE run_id = 'r6'").c, 0);

    // 6) a Nexus-named job the ledger has never heard of: no tools, and its cron job is removed
    w.schedulerCalls.length = 0;
    const ghost = "W0ABCDEFGHJ";
    await started(w, "ghost-job", ghost);
    const ghostOut = await w.watchRuntime.authenticate(
      { prompt: `[nexus:watch:${ghost}] x` },
      { runId: "r7", sessionKey: "s1", trigger: "cron", agentId: "main" },
    );
    isClosed(ghostOut);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    assert.ok(
      w.schedulerCalls.some(
        (call) => call.op === "unschedule" && call.tag === `nexus-watch-${ghost}`,
      ),
      "the forged or stale Nexus job is removed by tag",
    );
  });

  it("a watch whose Task closed meanwhile is cancelled, not run", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId);
    w.db.prepare("UPDATE nexus_tasks SET status = 'cancelled' WHERE id = ?").run(t);
    const { out } = await turn(w, id, "r1");
    assert.deepEqual(out?.toolsAllow, []);
    assert.equal(watchRow(w, id).status, "cancelled");
  });

  it("a finished event for a watch that was never claimed changes nothing", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId);
    // spike 4: on a busy session the host answers `started` then `finished(error)` without running a turn
    await started(w, jobOf(w, id), id);
    await w.watchRuntime.onCronChanged({
      action: "finished",
      jobId: jobOf(w, id),
      status: "error",
    });
    const row = watchRow(w, id);
    assert.equal(row.status, "scheduled");
    assert.equal(row.attempts, 0);
    assert.equal(w.watchRuntime.pendingCount(), 0);
  });
});

describe("watcherExtraTools is a fixed allow-list, not a trusted config value", () => {
  it("only web_fetch / web_search get through; exec, browser, channel sends and Nexus action tools are dropped", () => {
    const got = resolveWatcherExtraTools([
      "exec",
      "web_fetch",
      "browser",
      "message",
      "nexus_action_commit",
      "web_fetch",
    ]);
    assert.deepEqual(got.tools, ["web_fetch"]);
    assert.deepEqual(got.rejected, ["exec", "browser", "message", "nexus_action_commit"]);
    assert.deepEqual(resolveWatcherExtraTools(undefined).tools, ["web_fetch", "web_search"]);
    assert.deepEqual(resolveWatcherExtraTools([]).tools, []);
  });

  it("a runtime built with a hostile list still hands the watcher turn no write tool", async () => {
    const w = world({ claims: true });
    const rt = createWatchRuntime({
      getStore: async () => w.store,
      events: w.events,
      resolvePrincipal: () => P,
      scheduler: {
        schedule: async () => undefined,
        unscheduleByTag: async () => ({ removed: 0, failed: 0 }),
      },
      recordTrigger: async () => {},
      logger: { info: () => {}, warn: () => {} },
      now: () => w.now(),
      extraTools: ["exec", "browser", "web_search"],
    });
    const allowed = rt.allowedTools();
    assert.ok(allowed.includes("web_search"));
    assert.ok(!allowed.includes("exec"));
    assert.ok(!allowed.includes("browser"));
  });
});

describe("two registrations of the plugin (dev run 2026-10-14)", () => {
  it("a started job seen by one runtime authenticates the prompt seen by another when they share process state; separate state fails closed", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId);
    const other = await mkWatch(w, t, claimId, { expect: "条件 B" });
    const make = (state?: ReturnType<typeof createWatchSharedState>) =>
      createWatchRuntime({
        getStore: async () => w.store,
        events: w.events,
        resolvePrincipal: () => P,
        scheduler: {
          schedule: async () => undefined,
          unscheduleByTag: async () => ({ removed: 0, failed: 0 }),
        },
        recordTrigger: async () => {},
        logger: { info: () => {}, warn: () => {} },
        now: () => w.now(),
        claimWaitMs: 0,
        sleep: async () => {},
        ...(state ? { state } : {}),
      });
    const startedEvent = (watchId: string) => ({
      action: "started",
      jobId: jobOf(w, watchId),
      sessionTarget: "session:s1",
      job: { name: jobName(watchId), sessionTarget: "session:s1" },
    });
    const ctx = { runId: "run-X", sessionKey: "s1", trigger: "cron", agentId: "main" };

    const shared = createWatchSharedState();
    const cronSide = make(shared);
    const promptSide = make(shared);
    await cronSide.onCronChanged(startedEvent(id));
    const out = await promptSide.authenticate(
      { prompt: buildWatchMessage({ id, taskId: t }) },
      ctx,
    );
    assert.ok(out && out.toolsAllow.length > 0);
    assert.equal(watchRow(w, id).status, "firing");

    // the bug: each registration with its own state
    const cronAlone = make();
    const promptAlone = make();
    await cronAlone.onCronChanged(startedEvent(other));
    const closed = await promptAlone.authenticate(
      { prompt: buildWatchMessage({ id: other, taskId: t }) },
      { ...ctx, runId: "run-Y" },
    );
    assert.deepEqual(closed?.toolsAllow, []);
    assert.equal(watchRow(w, other).status, "scheduled");
  });
});

describe("the watcher's report", () => {
  it("nexus_watch_report is only valid in the authenticated run of that watch", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId);
    const other = await mkWatch(w, t, claimId, { expect: "条件 B" });

    // a user turn, and a run the ledger has never seen
    await w.prompt("run-user");
    assert.equal((await report(w, id, "not_yet", "run-user")).blocked, true);
    assert.equal((await report(w, id, "not_yet", "run-nobody")).blocked, true);
    // other tools are none of the gate's business
    assert.equal(
      await w.watchRuntime.beforeToolCall(
        { toolName: "nexus_task_get", params: {}, runId: "run-user" },
        { sessionKey: "s1", agentId: "main", runId: "run-user" },
      ),
      undefined,
    );

    await turn(w, id, "run-W");
    assert.equal(
      (await report(w, other, "not_yet", "run-W")).blocked,
      true,
      "another watch's id is refused",
    );
    const ok = await report(w, id, "not_yet", "run-W");
    assert.equal(ok.blocked, false);
    // a user-trigger run cannot report even for a firing watch
    assert.equal((await report(w, id, "not_yet", "run-user")).blocked, true);
  });

  it("not_yet backs off 1h, then 6h; the finding becomes a Task note", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId, { maxAttempts: 4 });

    await turn(w, id, "run-1");
    const first = await report(w, id, "not_yet", "run-1", "邮箱里还没有回复");
    assert.ok(!first.blocked && first.details.ok, JSON.stringify(first));
    assert.equal(first.details.outcome, "rescheduled");
    assert.equal(
      w.count(
        "SELECT COUNT(*) AS c FROM nexus_task_steps WHERE task_id = ? AND title LIKE ?",
        t,
        "%[Re-check " + id + "] 邮箱里还没有回复%",
      ),
      1,
    );
    const afterFirst = watchRow(w, id);
    assert.equal(afterFirst.attempts, 1);
    assert.equal(afterFirst.next_check_at, w.now() + HOUR);
    await w.watchRuntime.sync();
    assert.equal(watchRow(w, id).status, "scheduled");
    assert.equal((schedules(w)[1] as Record<string, unknown>).delayMs, HOUR);
    assert.equal(taskStatus(w, t), "watching");

    // the first job ended; a late `finished` for the spent job must not count a second miss
    await finished(w, "job-1");
    assert.equal(watchRow(w, id).attempts, 1);

    w.advance(HOUR);
    await turn(w, id, "run-2");
    const second = await report(w, id, "not_yet", "run-2");
    assert.ok(!second.blocked && second.details.outcome === "rescheduled");
    await w.watchRuntime.sync();
    assert.equal((schedules(w)[2] as Record<string, unknown>).delayMs, 6 * HOUR);

    // a second report for the same check is refused: the watch is no longer firing
    const dup = await report(w, id, "not_yet", "run-2");
    assert.ok(!dup.blocked && dup.details.code === "not_firing");
  });

  it("satisfied needs the claim SUPPORTED in the ledger: saying so is not enough; with evidence the Task leaves watching", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId);
    await turn(w, id, "run-1");

    const liar = await report(w, id, "satisfied", "run-1", "已经办好了");
    assert.ok(!liar.blocked);
    assert.equal(liar.details.ok, false);
    assert.equal(liar.details.code, "claim_not_met");
    assert.equal(watchRow(w, id).status, "firing", "a refused report changes nothing");

    await proveByExecution(w, t, claimId);
    const done = await report(w, id, "satisfied", "run-1", "邮件已确认");
    assert.ok(!done.blocked && done.details.ok, JSON.stringify(done));
    assert.equal(done.details.outcome, "satisfied");
    assert.equal(watchRow(w, id).status, "satisfied");
    assert.equal(taskStatus(w, t), "planning");
    assert.equal(
      w.count("SELECT COUNT(*) AS c FROM decisions WHERE effect_kind = 'acknowledge'"),
      0,
    );
    // the host's own `finished` for that job afterwards is a no-op
    await finished(w, jobOf(w, id));
    assert.equal(watchRow(w, id).status, "satisfied");
  });

  it("running out of attempts hands the Task back to the user once: one acknowledge decision, never duplicated on replay", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId, { maxAttempts: 2 });

    await turn(w, id, "run-1");
    await report(w, id, "not_yet", "run-1");
    await w.watchRuntime.sync();
    w.advance(HOUR);
    await turn(w, id, "run-2");
    const last = await report(w, id, "not_yet", "run-2");
    assert.ok(!last.blocked && last.details.outcome === "exhausted");
    assert.equal(watchRow(w, id).status, "exhausted");
    assert.equal(
      w.count(
        "SELECT COUNT(*) AS c FROM decisions WHERE task_id = ? AND effect_kind = 'acknowledge'",
        t,
      ),
      1,
    );
    assert.equal(taskStatus(w, t), "awaiting_decision");

    // the user acknowledges: the Task goes back to planning (no active watch is left)
    const decisionId = String(
      w.row("SELECT id FROM decisions WHERE task_id = ? AND effect_kind = 'acknowledge'", t).id,
    );
    const acked = await w.rpc("nexus.decision.resolve", { decisionId, resolution: "approved" });
    assert.equal(acked.ok, true, JSON.stringify(acked));
    assert.equal(taskStatus(w, t), "planning");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM action_grants WHERE task_id = ?", t), 0);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM action_executions WHERE task_id = ?", t), 0);

    // restart: the service replays exhausted watches of open Tasks; the decision is not created twice
    await w.watchRuntime.sync({ healExhausted: true });
    await w.watchRuntime.sync({ healExhausted: true });
    assert.equal(
      w.count(
        "SELECT COUNT(*) AS c FROM decisions WHERE task_id = ? AND effect_kind = 'acknowledge'",
        t,
      ),
      1,
    );
    assert.equal(schedules(w).length, 2, "an exhausted watch is not scheduled again");
  });

  it("blocked exhausts at once; a check that ended without any report counts as a miss", async () => {
    const w = world({ claims: true });
    const a = await setup(w, "事项 A");
    const idA = await mkWatch(w, a.t, a.claimId);
    await turn(w, idA, "run-A");
    const blocked = await report(w, idA, "blocked", "run-A", "邮箱没有登录");
    assert.ok(!blocked.blocked && blocked.details.outcome === "exhausted");
    assert.equal(watchRow(w, idA).attempts, 1);
    assert.equal(
      w.count(
        "SELECT COUNT(*) AS c FROM decisions WHERE task_id = ? AND effect_kind = 'acknowledge'",
        a.t,
      ),
      1,
    );
    await finished(w, jobOf(w, idA));

    const b = await setup(w, "事项 B");
    const idB = await mkWatch(w, b.t, b.claimId, { maxAttempts: 2 });
    const { jobId } = await turn(w, idB, "run-B");
    await finished(w, jobId); // the model never called nexus_watch_report
    const miss = watchRow(w, idB);
    assert.equal(miss.status, "pending_schedule");
    assert.equal(miss.attempts, 1);
    assert.equal(miss.next_check_at, w.now() + HOUR);
    await w.watchRuntime.sync();
    assert.equal(watchRow(w, idB).status, "scheduled");
    assert.equal(w.watchRuntime.pendingCount(), 0);
  });

  it("a firing watch whose run vanished is closed by maintenance", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId, { maxAttempts: 1 });
    await turn(w, id, "run-1");
    w.advance(10 * MIN + 31 * MIN);
    await w.watchRuntime.sync();
    assert.equal(watchRow(w, id).status, "exhausted");
    assert.equal(
      w.count(
        "SELECT COUNT(*) AS c FROM decisions WHERE task_id = ? AND effect_kind = 'acknowledge'",
        t,
      ),
      1,
    );
  });
});

describe("cancelling and cleaning up", () => {
  it("nexus_watch_cancel removes the cron job and the Task returns to planning; a second cancel is refused", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId);
    assert.equal(taskStatus(w, t), "watching");
    w.schedulerCalls.length = 0;
    const out = await wcall(w, "nexus_watch_cancel", { watchId: id });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(watchRow(w, id).status, "cancelled");
    assert.equal(taskStatus(w, t), "planning");
    assert.ok(
      w.schedulerCalls.some((call) => call.op === "unschedule" && call.tag === `nexus-watch-${id}`),
    );
    assert.equal((await wcall(w, "nexus_watch_cancel", { watchId: id })).code, "already_closed");
    assert.equal(
      (await wcall(w, "nexus_watch_cancel", { watchId: "WNOSUCH0001" })).code,
      "not_found",
    );
  });

  it("the Task stays watching while another watch is active", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const a = await mkWatch(w, t, claimId, { expect: "条件 A" });
    await mkWatch(w, t, claimId, { expect: "条件 B" });
    await wcall(w, "nexus_watch_cancel", { watchId: a });
    assert.equal(taskStatus(w, t), "watching");
  });

  it("maintenance cancels the watches of a Task that closed and removes their cron jobs", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId);
    w.db.prepare("UPDATE nexus_tasks SET status = 'cancelled' WHERE id = ?").run(t);
    w.schedulerCalls.length = 0;
    await w.watchRuntime.sync();
    assert.equal(watchRow(w, id).status, "cancelled");
    assert.ok(
      w.schedulerCalls.some((call) => call.op === "unschedule" && call.tag === `nexus-watch-${id}`),
    );
  });

  it("a stray `watching` Task with no active watch goes back to planning", async () => {
    const w = world({ claims: true });
    const t = w.newTask();
    w.db.prepare("UPDATE nexus_tasks SET status = 'watching' WHERE id = ?").run(t);
    await w.watchRuntime.sync();
    assert.equal(taskStatus(w, t), "planning");
  });

  it("a decision resolving on a Task with an active watch returns it to watching, not planning", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    await mkWatch(w, t, claimId);
    const actionId = await w.booking(t);
    const decision = await w.run("nexus_decision_request", {
      taskId: t,
      effect: { actionIds: [actionId] },
    });
    assert.equal(taskStatus(w, t), "awaiting_decision");
    const denied = await w.rpc("nexus.decision.resolve", {
      decisionId: decision.decisionId as string,
      resolution: "denied",
    });
    assert.equal(denied.ok, true, JSON.stringify(denied));
    assert.equal(taskStatus(w, t), "watching");
  });

  it("purging a Task deletes its watches and takes the cron jobs down", async () => {
    const w = world({ claims: true, evidence: true, purge: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId);
    const done = await w.rpc("nexus.task.purge", { taskId: t, confirmTaskId: t });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(w.count("SELECT COUNT(*) AS c FROM watches WHERE task_id = ?", t), 0);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM watches WHERE id = ?", id), 0);
  });
});

describe("operator RPC", () => {
  it("lists, gets and cancels watches; unknown ids and bad params are refused", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId);

    const listed = await w.rpc("nexus.watch.list", { taskId: t });
    assert.equal(listed.ok, true);
    const rows = listed.payload?.watches as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, id);
    assert.equal(rows[0]?.status, "scheduled");
    assert.equal(
      (await w.rpc("nexus.watch.list", { statuses: ["nope"] })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (
        (await w.rpc("nexus.watch.list", { statuses: ["satisfied"] })).payload?.watches as
          | unknown[]
          | undefined
      )?.length,
      0,
    );

    const got = await w.rpc("nexus.watch.get", { watchId: id });
    assert.equal((got.payload?.watch as Record<string, unknown> | undefined)?.id, id);
    assert.equal(
      (await w.rpc("nexus.watch.get", { watchId: "WNOSUCH0001" })).error?.code,
      "nexus_not_found",
    );
    assert.equal((await w.rpc("nexus.watch.get", {})).error?.code, "nexus_invalid_params");

    w.schedulerCalls.length = 0;
    const cancelled = await w.rpc("nexus.watch.cancel", { watchId: id });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    assert.equal(watchRow(w, id).status, "cancelled");
    assert.ok(w.schedulerCalls.some((call) => call.op === "unschedule"));
    assert.equal(
      (await w.rpc("nexus.watch.cancel", { watchId: id })).error?.code,
      "nexus_conflict",
    );
  });

  it("owners are isolated: another owner's job id or watch id finds nothing", async () => {
    const w = world({ claims: true });
    const { t, claimId } = await setup(w);
    const id = await mkWatch(w, t, claimId);
    const stranger = { ownerId: "someone-else" };
    assert.equal(await w.store.watchGet({ principal: stranger, watchId: id }), null);
    assert.equal(await w.store.watchGet({ principal: stranger, jobId: jobOf(w, id) }), null);
    const claimed = await w.store.watchClaim({
      principal: stranger,
      jobId: jobOf(w, id),
      sessionKey: "s1",
      now: w.now(),
    });
    assert.equal(claimed.outcome, "unknown_job");
    assert.equal((await w.store.watchGet({ principal: P, watchId: id }))?.id, id);
  });
});
