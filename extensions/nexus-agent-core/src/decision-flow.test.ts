// Stage 2 acceptance flows through the REAL entry points: the hook, the four tools, the RPC handlers and the outbox,
// on the real kernel (in-memory SQLite) with the fake provider. The harness lives in test-support/decision-world.ts.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./decision-runtime.js";
import { P, world, type Details } from "./test-support/decision-world.js";
import { STALE_EXECUTING_MS } from "./tools/action-tools.js";

describe("R2 through the core card", () => {
  it("allow-once: the card is attached to the side-effect-free tool, a slow callback is waited for, commit runs once", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    await w.prompt("run-A");
    const out = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a] } },
      {
        runId: "run-A",
        toolCallId: "call_A|fc_A",
        approval: "allow-once",
        callbackDelayMs: 30,
      },
    );
    assert.ok(!out.blocked);
    const card = out.approval;
    assert.ok(card);
    assert.deepEqual(card.allowedDecisions, ["allow-once", "deny"]);
    assert.equal(card.timeoutMs, DEFAULT_APPROVAL_TIMEOUT_MS);
    assert.equal(card.severity, "warning");
    assert.ok([...card.title].length <= 80 && [...card.description].length <= 512);
    assert.ok(
      card.description.includes("tokyo"),
      "the card shows the Task's entities for the human to check",
    );
    assert.ok(card.description.includes("nexus_action_commit"));
    // A booking is R2: the card must not look like a routine approval, and must say where the second confirmation is.
    assert.ok(card.title.startsWith("【R2】"), card.title);
    assert.ok(card.description.includes("二次确认"), card.description);
    const result = out.result;
    assert.equal(result.status, "decided");
    assert.equal(result.resolution, "approved");
    const executionId = result.executionId as string;
    assert.ok(executionId);
    assert.equal(
      w.count("SELECT COUNT(*) AS c FROM action_executions WHERE state = 'prepared'"),
      1,
    );
    assert.equal(w.provider.stats().writeCalls, 0, "approval alone executes nothing");

    const commit = await w.run("nexus_action_commit", { executionId });
    assert.equal(commit.status, "succeeded");
    assert.equal(w.provider.stats().effects, 1);
    const again = await w.run("nexus_action_commit", { executionId });
    assert.equal(again.status, "succeeded");
    assert.equal(again.replayed, true);
    assert.equal(w.provider.stats().writeCalls, 1, "a replay never reaches the provider");
    assert.equal(
      w.injections.length,
      0,
      "a card approval happens inside the waiting run; nothing is injected",
    );
    assert.ok(
      w.logs.some((line) => line.includes("value=allow-once")),
      "the raw callback value is logged for acceptance",
    );
  });

  it("approval without a card never executes: commit with an invented executionId is refused and the provider is untouched", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    await w.prompt("run-B");
    const out = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a] } },
      { runId: "run-B", approval: "none" },
    );
    assert.ok(!out.blocked && out.result.status === "pending");
    const invented = await w.run("nexus_action_commit", { executionId: "X_invented" });
    assert.equal(invented.ok, false);
    assert.equal(invented.code, "execution_not_found");
    assert.equal(w.provider.stats().writeCalls, 0);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM action_grants"), 0);
  });

  it("passing an actionId to commit is refused with a hint to authorize first, and nothing runs", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    const out = await w.run("nexus_action_commit", { executionId: a });
    assert.equal(out.ok, false);
    assert.equal(out.code, "execution_not_found");
    assert.match(String(out.message), /actionId/u);
    assert.match(String(out.message), /nexus_action_authorize/u);
    assert.equal(w.provider.stats().writeCalls, 0);
  });

  it("deny is final, cancelled and timeout leave the decision pending and completable from the page", async () => {
    const w = world();
    const t = w.newTask();
    const a1 = await w.booking(t, "A");
    const a2 = await w.booking(t, "B");
    const a3 = await w.booking(t, "C");
    const status = (id: string) =>
      w.row(
        "SELECT status, resolution, core_approval_state AS card FROM decisions WHERE task_id = ? AND id IN (SELECT decision_id FROM decision_actions WHERE action_id = ?)",
        t,
        id,
      );
    await w.prompt("r1");
    const denied = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a1] } },
      { runId: "r1", approval: "deny" },
    );
    assert.ok(denied.blocked);
    assert.deepEqual(
      { ...status(a1) },
      { status: "decided", resolution: "denied", card: "resolved" },
    );
    await w.prompt("r2");
    const cancelled = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a2] } },
      { runId: "r2", approval: "cancelled" },
    );
    assert.ok(cancelled.blocked);
    assert.deepEqual({ ...status(a2) }, { status: "pending", resolution: null, card: "cancelled" });
    await w.prompt("r3");
    const timedOut = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a3] } },
      { runId: "r3", approval: "timeout" },
    );
    assert.ok(timedOut.blocked);
    assert.deepEqual({ ...status(a3) }, { status: "pending", resolution: null, card: "timed_out" });
    assert.equal(w.count("SELECT COUNT(*) AS c FROM action_grants"), 0);

    const list = await w.rpc("nexus.decision.list", { statuses: ["pending"] });
    assert.equal((list.payload?.decisions as unknown[]).length, 2);
    const pendingId = (list.payload?.decisions as { id: string }[])[0]?.id as string;
    const resolved = await w.rpc("nexus.decision.resolve", {
      decisionId: pendingId,
      resolution: "approved",
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.payload?.outcome, "approved");
  });

  it("a lost callback leaves the decision pending: no 'approved but not saved', no grant, commit refused", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    await w.prompt("run-L");
    const out = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a] } },
      { runId: "run-L", approval: "lost" },
    );
    assert.ok(!out.blocked);
    assert.equal(out.result.status, "pending");
    assert.equal(w.row("SELECT status FROM decisions").status, "pending");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM action_grants"), 0);
    assert.ok(!String(out.result.message).includes("保存失败"));
  });

  it("late card Deny after the decision page approved (dev A1): the unused execution is withdrawn and commit is refused", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    await w.prompt("run-A1");
    const out = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a] } },
      { runId: "run-A1", approval: "lost" },
    );
    assert.ok(!out.blocked && out.approval);
    const decisionId = String(w.row("SELECT id FROM decisions").id);
    const resolved = await w.rpc("nexus.decision.resolve", {
      decisionId,
      resolution: "approved",
      chosenActionId: a,
    });
    assert.equal(resolved.payload?.outcome, "approved");
    const executionId = String(resolved.payload?.executionId);
    await out.approval.onResolution("deny");
    assert.deepEqual(
      { ...w.row("SELECT status, resolution FROM decisions WHERE id = ?", decisionId) },
      { status: "decided", resolution: "approved" },
    );
    assert.equal(
      w.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "failed",
    );
    assert.ok(
      w.logs.some(
        (line) => line.includes("late core approval click") && line.includes(executionId),
      ),
    );
    assert.ok(
      (
        w.db.prepare("SELECT title FROM nexus_task_steps WHERE task_id = ?").all(t) as Array<{
          title: string;
        }>
      ).some((r) => r.title.includes("Late card rejection")),
    );
    const commit = await w.run("nexus_action_commit", { executionId });
    assert.equal(commit.code, "execution_failed");
    assert.equal(w.provider.stats().writeCalls, 0);
  });

  it("late card Allow once after the decision page denied (dev A2): nothing becomes executable", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    await w.prompt("run-A2");
    const out = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a] } },
      { runId: "run-A2", approval: "lost" },
    );
    assert.ok(!out.blocked && out.approval);
    const decisionId = String(w.row("SELECT id FROM decisions").id);
    assert.equal(
      (await w.rpc("nexus.decision.resolve", { decisionId, resolution: "denied" })).payload
        ?.outcome,
      "denied",
    );
    await out.approval.onResolution("allow-once");
    assert.deepEqual(
      { ...w.row("SELECT status, resolution FROM decisions WHERE id = ?", decisionId) },
      { status: "decided", resolution: "denied" },
    );
    assert.equal(w.count("SELECT COUNT(*) AS c FROM action_executions"), 0);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM action_grants"), 0);
  });

  it("a callback that fails before its transaction leaves the decision pending; one that fails inside ends effect_apply_failed", async () => {
    const before = world();
    const t1 = before.newTask();
    const a1 = await before.booking(t1);
    await before.prompt("rb");
    before.failNext("recordApprovalResolution");
    const out1 = await before.hostCall(
      "nexus_decision_request",
      { taskId: t1, effect: { actionIds: [a1] } },
      { runId: "rb", approval: "allow-once" },
    );
    assert.ok(!out1.blocked);
    assert.equal(before.row("SELECT status FROM decisions").status, "pending");
    assert.ok(
      before.logs.some((line) => line.startsWith("warn") && line.includes("callback failed")),
    );
    assert.equal(before.count("SELECT COUNT(*) AS c FROM action_grants"), 0);

    const inside = world();
    const t2 = inside.newTask();
    const a2 = await inside.booking(t2);
    await inside.prompt("ri");
    inside.db.exec(
      "CREATE TRIGGER nx_fail BEFORE INSERT ON action_grants BEGIN SELECT RAISE(ABORT, 'disk on fire'); END",
    );
    const out2 = await inside.hostCall(
      "nexus_decision_request",
      { taskId: t2, effect: { actionIds: [a2] } },
      { runId: "ri", approval: "allow-once" },
    );
    assert.ok(!out2.blocked);
    assert.equal(inside.row("SELECT status FROM decisions").status, "effect_apply_failed");
    assert.equal(out2.result.status, "effect_apply_failed");
    assert.ok(String(out2.result.message).includes("could not be saved"));
    assert.equal(inside.count("SELECT COUNT(*) AS c FROM action_executions"), 0);
  });
});

describe("trigger split and idempotent re-entry", () => {
  it("cron turn: a pending decision and a notice, but no card; the decision page can finish it", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    await w.prompt("run-C", "cron");
    assert.equal(w.row("SELECT trigger FROM run_triggers WHERE run_id = 'run-C'").trigger, "cron");
    const out = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a] } },
      { runId: "run-C" },
    );
    assert.ok(!out.blocked && out.approval === undefined);
    assert.equal(out.result.status, "pending");
    assert.equal(w.row("SELECT core_approval_state AS s FROM decisions").s, "not_attempted");
    await w.settle();
    assert.ok(
      w.emitted.some(
        (entry) => entry.event === "decision_changed" && entry.payload.kind === "decision_pending",
      ),
    );
    const id = out.result.decisionId as string;
    const done = await w.rpc("nexus.decision.resolve", { decisionId: id, resolution: "approved" });
    assert.equal(done.payload?.outcome, "approved");
  });

  it("no ledger entry or missing runId/sessionKey in the prompt phase: fail closed, decision page only", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    const noLedger = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a] } },
      { runId: "never-prompted" },
    );
    assert.ok(!noLedger.blocked && noLedger.approval === undefined);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM decisions"), 1);

    await w.runtime.recordTrigger({ runId: undefined, sessionKey: "s1", trigger: "user" });
    await w.runtime.recordTrigger({ runId: "r-nosess", sessionKey: undefined, trigger: "user" });
    assert.equal(w.count("SELECT COUNT(*) AS c FROM run_triggers"), 0);
    const t2 = w.newTask("另一件事");
    const a2 = await w.booking(t2);
    const out = await w.hostCall(
      "nexus_decision_request",
      { taskId: t2, effect: { actionIds: [a2] } },
      { runId: "r-nosess" },
    );
    assert.ok(!out.blocked && out.approval === undefined);
  });

  it("a ledger entry recorded for another session does not enable the card", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    await w.prompt("run-S", "user", "other-session");
    const out = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a] } },
      { runId: "run-S", sessionKey: "s1" },
    );
    assert.ok(!out.blocked && out.approval === undefined);
  });

  it("the same (session, run, toolCall) re-entered: one decision, one notice, one card", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    await w.prompt("run-R");
    const same = { runId: "run-R", toolCallId: "call_R|fc_R", approval: "lost" as const };
    const first = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a] } },
      same,
    );
    const second = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a] } },
      same,
    );
    assert.ok(!first.blocked && !second.blocked);
    assert.ok(first.approval, "the first call got the card");
    assert.equal(second.approval, undefined, "the lease holder keeps the only card");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM decisions"), 1);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM outbox WHERE kind = 'decision_pending'"), 1);
    assert.equal(first.result.decisionId, second.result.decisionId);
  });

  it("the same key with different parameters is a conflict, and a later hook that changes them is refused", async () => {
    const w = world();
    const t = w.newTask();
    const a1 = await w.booking(t, "A");
    const a2 = await w.booking(t, "B");
    await w.prompt("run-K");
    const key = { runId: "run-K", toolCallId: "call_K|fc_K", approval: "lost" as const };
    await w.hostCall("nexus_decision_request", { taskId: t, effect: { actionIds: [a1] } }, key);
    // the hook sees a2 under the same key: conflict, hook falls back, the handler refuses the mismatch
    const clash = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a2] } },
      key,
    );
    assert.ok(!clash.blocked);
    assert.equal(clash.result.ok, false);
    assert.equal(clash.result.code, "params_changed");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM decisions"), 1);
  });
});

describe("a later plugin's before_tool_call (the v0.4 regression)", () => {
  it("rewriting actionIds after our hook cannot redirect an approved decision; the approval froze the parameters", async () => {
    const w = world();
    const t = w.newTask();
    const a1 = await w.booking(t, "A");
    const a2 = await w.booking(t, "B");
    await w.prompt("run-M");
    const out = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a1] } },
      {
        runId: "run-M",
        approval: "allow-once",
        otherHooks: [(event) => ({ params: { ...event.params, effect: { actionIds: [a2] } } })],
      },
    );
    assert.ok(!out.blocked);
    assert.deepEqual((out.finalParams as { effect: { actionIds: string[] } }).effect.actionIds, [
      a1,
    ]);
    assert.equal(w.row("SELECT action_id FROM action_grants").action_id, a1);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM action_grants WHERE action_id = ?", a2), 0);
  });

  it("without a card (cron) a later hook can change the parameters: the handler notices and refuses", async () => {
    const w = world();
    const t = w.newTask();
    const a1 = await w.booking(t, "A");
    const a2 = await w.booking(t, "B");
    await w.prompt("run-N", "cron");
    const out = await w.hostCall(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a1] } },
      {
        runId: "run-N",
        otherHooks: [(event) => ({ params: { ...event.params, effect: { actionIds: [a2] } } })],
      },
    );
    assert.ok(!out.blocked);
    assert.equal(out.result.code, "params_changed");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM action_grants"), 0);
  });

  it("blocking commit after our hook consumes nothing; swapping its executionId cannot reach someone else's authority", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    await w.prompt("run-P");
    const dec = await w.run(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a] } },
      { runId: "run-P" },
    );
    const approved = await w.rpc("nexus.decision.resolve", {
      decisionId: dec.decisionId as string,
      resolution: "approved",
    });
    const executionId = approved.payload?.executionId as string;

    const blocked = await w.hostCall(
      "nexus_action_commit",
      { executionId },
      {
        otherHooks: [() => ({ block: true, blockReason: "policy says no" })],
      },
    );
    assert.ok(blocked.blocked);
    assert.equal(w.row("SELECT consumed_at FROM action_grants").consumed_at, null);
    assert.equal(
      w.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "prepared",
    );
    assert.equal(w.provider.stats().writeCalls, 0);

    const swapped = await w.hostCall(
      "nexus_action_commit",
      { executionId },
      {
        otherHooks: [(event) => ({ params: { ...event.params, executionId: "X_other" } })],
      },
    );
    assert.ok(!swapped.blocked);
    assert.equal(swapped.result?.code, "execution_not_found");
    assert.equal(
      w.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "prepared",
    );
    assert.equal(w.provider.stats().writeCalls, 0);
  });
});

describe("commit: admission, concurrency, unknown outcomes", () => {
  const approve = async (w: ReturnType<typeof world>) => {
    const t = w.newTask();
    const a = await w.booking(t);
    const dec = await w.run("nexus_decision_request", { taskId: t, effect: { actionIds: [a] } });
    const res = await w.rpc("nexus.decision.resolve", {
      decisionId: dec.decisionId as string,
      resolution: "approved",
    });
    return { t, a, executionId: res.payload?.executionId as string };
  };

  it("two concurrent commits: exactly one reaches the provider", async () => {
    const w = world();
    const { executionId } = await approve(w);
    const [one, two] = await Promise.all([
      w.run("nexus_action_commit", { executionId }),
      w.run("nexus_action_commit", { executionId }),
    ]);
    const statuses = [one.status, two.status].toSorted();
    assert.deepEqual(statuses, ["pending_confirmation", "succeeded"]);
    assert.equal(w.provider.stats().writeCalls, 1);
    assert.equal(w.provider.stats().effects, 1);
  });

  it("connection drops after the provider processed it: unknown, never replayed, reconcile finds it", async () => {
    const w = world({ mode: "drop_after_success" });
    const { t, executionId } = await approve(w);
    const first = await w.run("nexus_action_commit", { executionId });
    assert.equal(first.status, "unknown");
    assert.ok(String(first.notice).includes("UNCERTAIN"));
    assert.equal(w.row("SELECT status FROM nexus_tasks WHERE id = ?", t).status, "executing");
    const retry = await w.run("nexus_action_commit", { executionId });
    assert.equal(retry.status, "pending_confirmation");
    assert.equal(
      w.provider.stats().writeCalls,
      1,
      "retrying an unknown execution does not call the write interface",
    );
    const recon = await w.rpc("nexus.execution.reconcile", { executionId });
    assert.equal(recon.payload?.outcome, "reconciled_succeeded");
    assert.equal(w.provider.stats().effects, 1);
    assert.equal(
      w.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "succeeded",
    );
    assert.equal(w.row("SELECT status FROM nexus_tasks WHERE id = ?", t).status, "planning");
    const replay = await w.run("nexus_action_commit", { executionId });
    assert.equal(replay.replayed, true);
  });

  it("dropped before send: reconcile finds nothing and the execution stays unknown", async () => {
    const w = world({ mode: "drop_before_send", idempotent: false });
    const { executionId } = await approve(w);
    assert.equal((await w.run("nexus_action_commit", { executionId })).status, "unknown");
    const recon = await w.rpc("nexus.execution.reconcile", { executionId });
    assert.equal(recon.payload?.outcome, "not_found_at_provider");
    assert.equal(
      w.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "unknown",
    );
    assert.equal(
      (await w.run("nexus_action_commit", { executionId })).status,
      "pending_confirmation",
    );
    assert.equal(w.provider.stats().writeCalls, 1);
  });

  it("nexus.task.get (RPC) lists what still waits for the user and what is approved but not yet committed", async () => {
    const w = world();
    const { t, executionId } = await approve(w);
    const second = await w.booking(t, "Another Hotel");
    const pending = await w.run("nexus_decision_request", {
      taskId: t,
      effect: { actionIds: [second] },
    });
    const got = await w.rpc("nexus.task.get", { taskId: t });
    assert.equal(got.ok, true, JSON.stringify(got));
    const pendingDecisions = got.payload?.pendingDecisions as Array<Record<string, unknown>>;
    assert.equal(pendingDecisions.length, 1);
    assert.equal(pendingDecisions[0]?.decisionId, pending.decisionId);
    assert.deepEqual(
      Object.keys(pendingDecisions[0] ?? {}).sort(),
      ["actionIds", "decisionId", "deadlineAt", "question", "riskTier"].sort(),
    );
    const ready = got.payload?.readyExecutions as Array<Record<string, unknown>>;
    assert.ok(
      ready.some((entry) => entry.executionId === executionId),
      JSON.stringify(ready),
    );
    // the Task's status still ignores a merely prepared execution: that is exactly why the console needs the list
    assert.equal(
      w.row("SELECT status FROM nexus_tasks WHERE id = ?", t).status,
      "awaiting_decision",
    );
  });

  it("operator resolve: unknown with no provider record can be ended by a person, with a mandatory note", async () => {
    const w = world({ mode: "drop_before_send", idempotent: false });
    const { t, executionId } = await approve(w);
    assert.equal((await w.run("nexus_action_commit", { executionId })).status, "unknown");
    const noNote = await w.rpc("nexus.execution.resolve", { executionId, resolution: "failed" });
    assert.equal(noNote.ok, false);
    const badRes = await w.rpc("nexus.execution.resolve", {
      executionId,
      resolution: "maybe",
      note: "x",
    });
    assert.equal(badRes.ok, false);
    const done = await w.rpc("nexus.execution.resolve", {
      executionId,
      resolution: "failed",
      note: "供应商后台查无此单",
    });
    assert.equal(done.payload?.outcome, "resolved_failed");
    assert.equal(
      w.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "failed",
    );
    // the step log says WHO closed it by hand and WHY (not only "execution failed")
    const step = w.row(
      "SELECT title, detail_json FROM nexus_task_steps WHERE task_id = ? AND title LIKE 'Operator resolved%' ORDER BY seq DESC LIMIT 1",
      t,
    );
    assert.match(String(step.title), /^Operator resolved as failed/);
    const detail = JSON.parse(String(step.detail_json)) as Record<string, unknown>;
    assert.equal(detail.resolvedBy, "operator:nexus-console");
    assert.equal(detail.note, "供应商后台查无此单");
    assert.equal(detail.state, "failed");
    assert.equal(w.row("SELECT status FROM nexus_tasks WHERE id = ?", t).status, "planning");
    assert.equal(
      w.provider.stats().writeCalls,
      1,
      "resolving never calls the provider write interface",
    );
    const again = await w.rpc("nexus.execution.resolve", {
      executionId,
      resolution: "succeeded",
      note: "late",
    });
    assert.equal(again.payload?.outcome, "already_final");
    const commit = await w.run("nexus_action_commit", { executionId });
    assert.equal(commit.code, "execution_failed");
  });

  it("operator resolve: refuses to mark failed while the provider has a record; accepts an asserted success", async () => {
    const w = world({ mode: "drop_after_success" });
    const { executionId } = await approve(w);
    assert.equal((await w.run("nexus_action_commit", { executionId })).status, "unknown");
    const refused = await w.rpc("nexus.execution.resolve", {
      executionId,
      resolution: "failed",
      note: "我觉得没成功",
    });
    assert.equal(refused.payload?.outcome, "provider_has_record");
    assert.equal(
      w.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "unknown",
    );
    const ok = await w.rpc("nexus.execution.resolve", {
      executionId,
      resolution: "succeeded",
      note: "已在供应商后台确认",
      confirmation: "FAKE-OPS-1",
    });
    assert.equal(ok.payload?.outcome, "resolved_succeeded");
    assert.equal(
      w.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "succeeded",
    );
  });

  it("a provider rejection is a definitive failure and replays as failed", async () => {
    const w = world({ mode: "reject" });
    const { executionId } = await approve(w);
    const first = await w.run("nexus_action_commit", { executionId });
    assert.equal(first.code, "execution_failed");
    const again = await w.run("nexus_action_commit", { executionId });
    assert.equal(again.code, "execution_failed");
    assert.equal(w.provider.stats().writeCalls, 1);
  });

  it("a crash between admission and the provider call: with idempotency the same key is retried once; without it only reconcile", async () => {
    for (const idempotent of [true, false]) {
      const w = world({ idempotent });
      const { executionId } = await approve(w);
      const admitted = await w.store.admitExecution({
        principal: P,
        executionId,
        staleExecutingMs: STALE_EXECUTING_MS,
        now: w.now(),
      });
      assert.equal(admitted.kind, "execute_new");
      w.advance(STALE_EXECUTING_MS + 1000);
      const out = await w.run("nexus_action_commit", { executionId });
      if (idempotent) {
        assert.equal(out.status, "succeeded");
        assert.equal(w.provider.stats().effects, 1);
        assert.equal(
          w.provider.effectsFor(
            w.row("SELECT provider_idempotency_key AS k FROM action_executions").k as string,
          ).length,
          1,
        );
      } else {
        assert.equal(out.status, "pending_confirmation");
        assert.equal(w.provider.stats().writeCalls, 0);
      }
    }
  });

  it("non-idempotent provider, crash AFTER the provider processed it: never re-sent; the tick finds the record and settles", async () => {
    const w = world({ idempotent: false });
    const { executionId } = await approve(w);
    const key = w.row(
      "SELECT provider_idempotency_key AS k FROM action_executions WHERE id = ?",
      executionId,
    ).k as string;
    assert.equal(
      (
        await w.store.admitExecution({
          principal: P,
          executionId,
          staleExecutingMs: STALE_EXECUTING_MS,
          now: w.now(),
        })
      ).kind,
      "execute_new",
    );
    // the effect happened, but the process died before settling
    await w.provider.execute({
      idempotencyKey: key,
      toolName: "fake_booking",
      params: { vendor: "Hotelier", item: "Park Hotel", date: "2026-10-20" },
    } as never);
    w.advance(STALE_EXECUTING_MS + 1000);
    const out = await w.run("nexus_action_commit", { executionId });
    assert.equal(out.status, "pending_confirmation");
    assert.equal(w.provider.stats().writeCalls, 1, "commit did not call the write interface again");
    await w.runtime.tick();
    assert.equal(
      w.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "succeeded",
    );
    assert.equal(w.provider.stats().writeCalls, 1);
    assert.equal(w.provider.stats().effects, 1);
    assert.equal((await w.run("nexus_action_commit", { executionId })).replayed, true);
  });

  it("non-idempotent provider, crash BEFORE the provider call: stays executing, never retried; only a person can end it, and only once it is stale", async () => {
    const w = world({ idempotent: false });
    const t = w.newTask();
    const a = await w.booking(t);
    const dec = await w.run("nexus_decision_request", { taskId: t, effect: { actionIds: [a] } });
    const res = await w.rpc("nexus.decision.resolve", {
      decisionId: dec.decisionId as string,
      resolution: "approved",
    });
    const executionId = res.payload?.executionId as string;
    await w.store.admitExecution({
      principal: P,
      executionId,
      staleExecutingMs: STALE_EXECUTING_MS,
      now: w.now(),
    });
    const early = await w.rpc("nexus.execution.resolve", {
      executionId,
      resolution: "failed",
      note: "还没过期",
    });
    assert.equal(early.payload?.outcome, "not_resolvable");
    assert.equal(
      w.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "executing",
    );
    w.advance(STALE_EXECUTING_MS + 1000);
    assert.equal(
      (await w.run("nexus_action_commit", { executionId })).status,
      "pending_confirmation",
    );
    await w.runtime.tick();
    assert.equal(
      w.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "executing",
      "a lookup miss never decides anything",
    );
    assert.equal(
      (await w.rpc("nexus.execution.reconcile", { executionId })).payload?.outcome,
      "not_found_at_provider",
    );
    assert.equal(w.provider.stats().writeCalls, 0);
    const done = await w.rpc("nexus.execution.resolve", {
      executionId,
      resolution: "failed",
      note: "供应商后台查无此单",
    });
    assert.equal(done.payload?.outcome, "resolved_failed");
    assert.equal(w.row("SELECT status FROM nexus_tasks WHERE id = ?", t).status, "planning");
    assert.equal((await w.run("nexus_action_commit", { executionId })).code, "execution_failed");
    assert.equal(w.provider.stats().writeCalls, 0);
  });

  it("idempotent provider: a stale executing gets at most ONE automatic retry; if that is uncertain it becomes unknown and is never retried again", async () => {
    const w = world({ idempotent: true, mode: "drop_after_success" });
    const { executionId } = await approve(w);
    await w.store.admitExecution({
      principal: P,
      executionId,
      staleExecutingMs: STALE_EXECUTING_MS,
      now: w.now(),
    });
    w.advance(STALE_EXECUTING_MS + 1000);
    const retry = await w.run("nexus_action_commit", { executionId });
    assert.equal(retry.status, "unknown");
    assert.equal(
      w.row("SELECT attempts FROM action_executions WHERE id = ?", executionId).attempts,
      2,
    );
    for (let i = 0; i < 3; i += 1) {
      w.advance(STALE_EXECUTING_MS + 1000);
      assert.equal(
        (await w.run("nexus_action_commit", { executionId })).status,
        "pending_confirmation",
      );
    }
    assert.equal(
      w.row("SELECT attempts FROM action_executions WHERE id = ?", executionId).attempts,
      2,
      "no further attempts",
    );
    assert.equal(w.provider.stats().writeCalls, 1);
    assert.equal(w.provider.stats().effects, 1, "the same key never produced a second effect");
  });

  it("the periodic tick reconciles an unknown execution once the provider confirms", async () => {
    const w = world({ mode: "drop_after_success" });
    const { executionId } = await approve(w);
    await w.run("nexus_action_commit", { executionId });
    await w.runtime.tick();
    assert.equal(
      w.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "unknown",
      "not due yet",
    );
    w.advance(60_000);
    await w.runtime.tick();
    assert.equal(
      w.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "succeeded",
    );
  });
});

describe("R1 end to end", () => {
  it("decision -> standing policy -> authorize (repeatable) -> commit; authorize does not burn the quota", async () => {
    const w = world();
    const t = w.newTask();
    const m1 = await w.prepare(t, "fake_vendor_message", {
      vendor: "Hotelier",
      message: "请问可以改到 20 号吗",
    });
    const none = await w.run("nexus_action_authorize", { actionId: m1 });
    assert.equal(none.code, "no_policy");

    const dec = await w.run("nexus_decision_request", { taskId: t, effect: { actionIds: [m1] } });
    assert.equal(dec.effectKind, "issue_standing_grant");
    const res = await w.rpc("nexus.decision.resolve", {
      decisionId: dec.decisionId as string,
      resolution: "approved",
    });
    assert.ok(res.payload?.standingGrantId);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM action_executions"), 0);

    const first = await w.run("nexus_action_authorize", { actionId: m1 });
    const second = await w.run("nexus_action_authorize", { actionId: m1 });
    assert.equal(first.executionId, second.executionId);
    assert.equal(second.reentry, true);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM grant_uses"), 0);

    const commit = await w.run("nexus_action_commit", { executionId: first.executionId as string });
    assert.equal(commit.status, "succeeded");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM grant_uses"), 1);
    const again = await w.run("nexus_action_authorize", { actionId: m1 });
    assert.equal(again.code, "already_done");

    const m2 = await w.prepare(t, "fake_vendor_message", { vendor: "Hotelier", message: "第二条" });
    const next = await w.run("nexus_action_authorize", { actionId: m2 });
    assert.equal(next.ok, true);
    const other = await w.prepare(t, "fake_vendor_message", {
      vendor: "Somebody Else",
      message: "hi",
    });
    assert.equal((await w.run("nexus_action_authorize", { actionId: other })).code, "no_policy");
    const booking = await w.booking(t);
    assert.equal((await w.run("nexus_action_authorize", { actionId: booking })).code, "not_r1");

    // asking again while a live policy covers the action: answered from the grant, not a second card
    const m3 = await w.prepare(t, "fake_vendor_message", { vendor: "Hotelier", message: "第三条" });
    const repeat = await w.run("nexus_decision_request", {
      taskId: t,
      effect: { actionIds: [m3] },
    });
    assert.equal(repeat.alreadyApproved, true);
  });
});

describe("decision page path, outbox and the Agent injection", () => {
  it("a page approval notifies exactly once and tells the Agent which executionId it may commit; a card approval does not", async () => {
    const w = world();
    const session = "agent:main:main";
    const t = w.newTask();
    const a = await w.booking(t);
    await w.prompt("run-I", "cron", session);
    const dec = await w.run(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a] } },
      { runId: "run-I", sessionKey: session },
    );
    const res = await w.rpc("nexus.decision.resolve", {
      decisionId: dec.decisionId as string,
      resolution: "approved",
    });
    const executionId = res.payload?.executionId as string;
    await w.settle();
    assert.equal(w.injections.length, 1);
    assert.equal(w.injections[0]?.sessionKey, session);
    assert.ok(w.injections[0]?.text.includes(executionId));
    assert.equal(w.injections[0]?.idempotencyKey, `execution_ready:${executionId}`);
    const kinds = w.emitted.map((entry) => `${entry.event}:${entry.payload.kind}`);
    assert.ok(kinds.includes("decision_changed:decision_pending"));
    assert.ok(kinds.includes("decision_changed:decision_resolved"));
    assert.ok(kinds.includes("execution_changed:execution_ready"));
    await w.settle();
    assert.equal(w.injections.length, 1, "delivered rows are not delivered twice");

    // approved on a core card inside the waiting run: nothing is injected
    const t2 = w.newTask("另一件事");
    const a2 = await w.booking(t2);
    await w.prompt("run-J", "user", session);
    await w.run(
      "nexus_decision_request",
      { taskId: t2, effect: { actionIds: [a2] } },
      { runId: "run-J", sessionKey: session, approval: "allow-once" },
    );
    await w.settle();
    assert.equal(w.injections.length, 1);
    assert.equal(
      w.count(
        "SELECT COUNT(*) AS c FROM outbox WHERE state = 'delivered' AND kind = 'execution_ready'",
      ),
      2,
    );
  });

  it("injection: the host call fails -> the outbox row retries with the SAME idempotency key and delivers once; the ttl is passed", async () => {
    const w = world();
    const session = "agent:main:main";
    const t = w.newTask();
    const a = await w.booking(t);
    await w.prompt("run-R", "cron", session);
    const dec = await w.run(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a] } },
      { runId: "run-R", sessionKey: session },
    );
    w.setEnqueue("throw");
    const res = await w.rpc("nexus.decision.resolve", {
      decisionId: dec.decisionId as string,
      resolution: "approved",
    });
    const executionId = res.payload?.executionId as string;
    await w.settle();
    assert.equal(w.injections.length, 1, "one failed attempt");
    const pending = w.row(
      "SELECT state, attempts, last_error AS err FROM outbox WHERE kind = 'execution_ready'",
    );
    assert.equal(pending.state, "pending");
    assert.equal(pending.attempts, 1);
    assert.match(String(pending.err), /session store unavailable/);
    await w.settle();
    assert.equal(w.injections.length, 1, "backoff: not retried immediately");
    w.setEnqueue("ok");
    w.advance(61_000);
    await w.settle();
    assert.equal(w.injections.length, 2);
    assert.equal(w.injections[1]?.idempotencyKey, w.injections[0]?.idempotencyKey);
    assert.equal(w.injections[1]?.idempotencyKey, `execution_ready:${executionId}`);
    assert.equal(w.injections[1]?.ttlMs, 3_600_000);
    assert.equal(
      w.row("SELECT state FROM outbox WHERE kind = 'execution_ready'").state,
      "delivered",
    );
    await w.settle();
    assert.equal(w.injections.length, 2, "delivered rows are final");
  });

  it("injection: a host that refuses (no such session / expired) is logged and not retried forever; the executionId stays discoverable", async () => {
    const w = world();
    const session = "agent:main:gone";
    const t = w.newTask();
    const a = await w.booking(t);
    await w.prompt("run-G", "cron", session);
    const dec = await w.run(
      "nexus_decision_request",
      { taskId: t, effect: { actionIds: [a] } },
      { runId: "run-G", sessionKey: session },
    );
    w.setEnqueue("refused");
    const res = await w.rpc("nexus.decision.resolve", {
      decisionId: dec.decisionId as string,
      resolution: "approved",
    });
    const executionId = res.payload?.executionId as string;
    await w.settle();
    assert.equal(w.injections.length, 1);
    assert.ok(w.logs.some((line) => line.includes("enqueued=false") && line.includes(executionId)));
    assert.equal(
      w.row("SELECT state FROM outbox WHERE kind = 'execution_ready'").state,
      "delivered",
    );
    const ready = await w.store.listReadyExecutions({ principal: P, taskId: t, now: w.now() });
    assert.ok(
      ready.some((entry) => entry.executionId === executionId),
      "readyExecutions still tells the Agent what it may commit",
    );
  });

  it("injection: a decision with no recorded session (created outside a run) is never injected", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    const created = w.k.createDecision({
      principal: P,
      taskId: t,
      actionIds: [a],
      sessionKey: null,
      runId: null,
      toolCallId: null,
      now: w.now(),
    });
    assert.equal(created.outcome, "created");
    const id = (created as Extract<typeof created, { outcome: "created" }>).decision.id;
    assert.equal(
      (await w.rpc("nexus.decision.resolve", { decisionId: id, resolution: "approved" })).payload
        ?.outcome,
      "approved",
    );
    await w.settle();
    assert.equal(w.injections.length, 0);
    assert.equal(
      w.row("SELECT state FROM outbox WHERE kind = 'execution_ready'").state,
      "delivered",
    );
  });

  it("with no event emitter attached rows stay pending; they are delivered after it attaches", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    w.events.attach(undefined);
    await w.run("nexus_decision_request", { taskId: t, effect: { actionIds: [a] } });
    await w.runtime.flushOutbox();
    assert.equal(w.count("SELECT COUNT(*) AS c FROM outbox WHERE state = 'pending'"), 1);
    w.events.attach((event, payload) => {
      w.emitted.push({ event, payload: payload as Record<string, unknown> });
    });
    await w.runtime.flushOutbox();
    assert.equal(w.count("SELECT COUNT(*) AS c FROM outbox WHERE state = 'delivered'"), 1);
  });

  it("task_get shows pending decisions and the executions that can be committed right now", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    const get = async () => {
      const tool = w.taskTools("s1").find((candidate) => candidate.name === "nexus_task_get");
      assert.ok(tool);
      return ((await tool.execute("c", { taskId: t } as never)) as unknown as { details: Details })
        .details;
    };
    assert.deepEqual((await get()).pendingDecisions, []);
    const dec = await w.run("nexus_decision_request", { taskId: t, effect: { actionIds: [a] } });
    const pending = (await get()).pendingDecisions as { decisionId: string }[];
    assert.equal(pending[0]?.decisionId, dec.decisionId);
    await w.rpc("nexus.decision.resolve", {
      decisionId: dec.decisionId as string,
      resolution: "approved",
    });
    const after = await get();
    assert.deepEqual(after.pendingDecisions, []);
    assert.equal((after.readyExecutions as unknown[]).length, 1);
  });

  it("RPC validation, ownership of ids, grant revocation", async () => {
    const w = world();
    const t = w.newTask();
    const a1 = await w.booking(t, "A");
    const a2 = await w.booking(t, "B");
    const dec = await w.run("nexus_decision_request", {
      taskId: t,
      effect: { actionIds: [a1, a2] },
    });
    assert.equal(
      (await w.rpc("nexus.decision.resolve", { decisionId: dec.decisionId as string })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (
        await w.rpc("nexus.decision.resolve", {
          decisionId: dec.decisionId as string,
          resolution: "approved",
        })
      ).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await w.rpc("nexus.decision.resolve", { decisionId: "D_nope", resolution: "approved" }))
        .error?.code,
      "nexus_not_found",
    );
    const ok = await w.rpc("nexus.decision.resolve", {
      decisionId: dec.decisionId as string,
      resolution: "approved",
      chosenActionId: a2,
    });
    assert.equal(ok.payload?.outcome, "approved");
    const late = await w.rpc("nexus.decision.resolve", {
      decisionId: dec.decisionId as string,
      resolution: "denied",
    });
    assert.equal(late.payload?.outcome, "already_resolved");
    const got = await w.rpc("nexus.decision.get", { decisionId: dec.decisionId as string });
    assert.equal((got.payload?.executions as unknown[]).length, 1);
    const grants = await w.rpc("nexus.grant.list", { taskId: t });
    const grantId = (grants.payload?.actionGrants as { id: string }[])[0]?.id as string;
    assert.equal((await w.rpc("nexus.grant.revoke", { grantId })).payload?.outcome, "revoked");
    const execs = await w.rpc("nexus.execution.list", { taskId: t });
    const exec = (execs.payload?.executions as { id: string }[])[0] as { id: string };
    const commit = await w.run("nexus_action_commit", { executionId: exec.id });
    assert.equal(commit.code, "execution_failed");
    assert.equal(w.provider.stats().writeCalls, 0);
    assert.equal(
      (await w.rpc("nexus.grant.revoke", { grantId: "G_nope" })).error?.code,
      "nexus_not_found",
    );
  });
});

describe("tool-level validation", () => {
  it("rejects set_preference, mixed tiers, unknown tools and foreign actions with ok:false and the failure notice", async () => {
    const w = world();
    const t = w.newTask();
    const booking = await w.booking(t);
    const message = await w.prepare(t, "fake_vendor_message", { vendor: "V", message: "hi" });
    const pref = await w.run("nexus_decision_request", {
      taskId: t,
      effect: { kind: "set_preference", actionIds: [booking] },
    });
    assert.equal(pref.ok, false);
    assert.equal(pref.code, "invalid_effect_unsupported_effect");
    assert.ok(String(pref.notice).includes("FAILED"));
    // A free-text kind written by the model ("booking") is ignored; the server derives the kind from the risk tier.
    const freeText = await w.run("nexus_decision_request", {
      taskId: t,
      effect: { kind: "booking", actionIds: [booking] },
    });
    assert.equal(freeText.ok !== false, true);
    assert.equal(freeText.effectKind, "issue_action_grant");
    const mixed = await w.run("nexus_decision_request", {
      taskId: t,
      effect: { actionIds: [booking, message] },
    });
    assert.equal(mixed.code, "invalid_effect_mixed_tier");
    const unknown = await w.run("nexus_action_prepare", {
      taskId: t,
      toolName: "browser",
      params: {},
    });
    assert.equal(unknown.code, "unknown_tool");
    const bad = await w.run("nexus_action_prepare", {
      taskId: t,
      toolName: "fake_payment",
      params: { merchant: "M", amount: "ten", currency: "JPY" },
    });
    assert.equal(bad.code, "invalid_params");
    const same = await w.run("nexus_action_prepare", {
      taskId: t,
      toolName: "fake_booking",
      params: { item: "Park Hotel", vendor: "Hotelier", date: "2026-10-20" },
    });
    assert.equal(same.created, false);
    assert.equal(same.actionId, booking);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM action_grants"), 0);
  });

  it("a second action with identical parameters needs an explicit occurrence", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    const dec = await w.run("nexus_decision_request", { taskId: t, effect: { actionIds: [a] } });
    const res = await w.rpc("nexus.decision.resolve", {
      decisionId: dec.decisionId as string,
      resolution: "approved",
    });
    await w.run("nexus_action_commit", { executionId: res.payload?.executionId as string });
    const again = await w.run("nexus_action_prepare", {
      taskId: t,
      toolName: "fake_booking",
      params: { vendor: "Hotelier", item: "Park Hotel", date: "2026-10-20" },
    });
    assert.equal(again.actionId, a);
    assert.ok(String(again.warning).includes("occurrence"));
    const second = await w.run("nexus_action_prepare", {
      taskId: t,
      toolName: "fake_booking",
      params: { vendor: "Hotelier", item: "Park Hotel", date: "2026-10-20" },
      occurrence: 2,
    });
    assert.notEqual(second.actionId, a);
  });

  it("startup reconciliation reports what is open without inferring anything", async () => {
    const w = world();
    const t = w.newTask();
    const a = await w.booking(t);
    await w.run("nexus_decision_request", { taskId: t, effect: { actionIds: [a] } });
    const report = await w.runtime.startup();
    assert.equal(report?.pendingDecisions.length, 1);
    assert.equal(report?.unfinishedExecutions.length, 0);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM action_grants"), 0);
  });
});
