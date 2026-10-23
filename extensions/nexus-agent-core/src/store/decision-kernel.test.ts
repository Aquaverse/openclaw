/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
// Decision / Grant / Execution kernel against the real SQL on in-memory SQLite (DESIGN section 13, Stage 2).
// Every test goes through the kernel's public entry points; direct SQL appears only to inject faults or to prove
// that the schema itself (not the kernel) refuses a bad row.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { requestFingerprint } from "../canonical.js";
import { CORE_APPROVER } from "./decision-kernel.js";
import type { ProviderCaps } from "./decision-types.js";
import { applyMigrations } from "./kernel.js";
import { createNexusKernel } from "./nexus-kernel.js";
import type { Principal } from "./types.js";

const P: Principal = { ownerId: "local" };
const Q: Principal = { ownerId: "other" };
const T0 = 1_000_000;
const CAPS: ProviderCaps = { fake_booking: true, fake_payment: false, fake_vendor_message: true };
const MIN = 60_000;

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const tx = <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  applyMigrations(db, tx);
  let n = 0;
  const k = createNexusKernel(db, tx, {
    newId: (prefix) => `${prefix}${String((n += 1)).padStart(4, "0")}`,
  });
  const count = (sql: string, ...params: (string | number)[]): number =>
    (db.prepare(sql).get(...params) as { c: number }).c;
  const row = (sql: string, ...params: (string | number)[]) =>
    db.prepare(sql).get(...params) as Record<string, unknown>;
  let taskSeq = 0;
  const task = (
    principal: Principal = P,
    title = "订东京酒店",
    entities: unknown = { city: "tokyo" },
  ) => {
    taskSeq += 1;
    const id = `T${String(taskSeq).padStart(8, "0")}`;
    const goal = { want: title };
    const created = k.create({
      principal,
      id,
      kind: "hotel",
      title,
      goal,
      entities,
      idempotencyKey: `op_${id}`,
      fingerprint: requestFingerprint({ kind: "hotel", entities, goal }),
      sessionKey: "s1",
      now: T0,
    });
    assert.equal(created.outcome, "created");
    return id;
  };
  const action = (
    taskId: string,
    toolName: string,
    params: unknown,
    over: { principal?: Principal; occurrence?: number } = {},
  ) => {
    const out = k.registerAction({
      principal: over.principal ?? P,
      taskId,
      toolName,
      params,
      ...(over.occurrence ? { occurrence: over.occurrence } : {}),
      sessionKey: "s1",
      now: T0,
    });
    assert.ok(out.outcome === "created" || out.outcome === "existing", JSON.stringify(out));
    return out.action.id;
  };
  const booking = (taskId: string, item = "Park Hotel", occurrence?: number) =>
    action(
      taskId,
      "fake_booking",
      { vendor: "Hotelier", item, date: "2026-10-20" },
      { occurrence },
    );
  const decide = (
    taskId: string,
    actionIds: string[],
    over: Partial<Parameters<typeof k.createDecision>[0]> = {},
  ) =>
    k.createDecision({
      principal: P,
      taskId,
      actionIds,
      sessionKey: null,
      runId: null,
      toolCallId: null,
      now: T0,
      ...over,
    });
  const created = (out: ReturnType<typeof decide>) => {
    assert.equal(out.outcome, "created", JSON.stringify(out));
    return (out as Extract<typeof out, { outcome: "created" }>).decision;
  };
  const resolve = (
    decisionId: string,
    over: Partial<Parameters<typeof k.resolveDecision>[0]> = {},
  ) =>
    k.resolveDecision({
      principal: P,
      decisionId,
      resolution: "approved",
      source: "nexus_console",
      resolvedBy: "tester",
      providerCaps: CAPS,
      now: T0 + 1000,
      ...over,
    });
  const approved = (out: ReturnType<typeof resolve>) => {
    assert.equal(out.outcome, "approved", JSON.stringify(out));
    return out as Extract<typeof out, { outcome: "approved" }>;
  };
  const admit = (executionId: string, now = T0 + 2000, principal: Principal = P) =>
    k.admitExecution({ principal, executionId, staleExecutingMs: 120_000, now });
  const fkClean = () => assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  return {
    db,
    tx,
    k,
    count,
    row,
    task,
    action,
    booking,
    decide,
    created,
    resolve,
    approved,
    admit,
    fkClean,
  };
}

describe("actions", () => {
  const f = fixture();
  const t = f.task();

  it("registers a normalized action, derives capability and tier on the server, and reuses an identical one", () => {
    const first = f.k.registerAction({
      principal: P,
      taskId: t,
      toolName: "fake_payment",
      params: { merchant: " Hotelier ", amount: 128.5, currency: "jpy", extra: "ignored" },
      sessionKey: "s1",
      now: T0,
    });
    assert.equal(first.outcome, "created");
    assert.ok(first.outcome === "created");
    assert.equal(first.action.capability, "pay");
    assert.equal(first.action.riskTier, "R3");
    assert.equal(first.action.amount, "128.5");
    assert.equal(first.action.currency, "JPY");
    assert.deepEqual(first.action.params, {
      merchant: "Hotelier",
      amount: "128.5",
      currency: "JPY",
    });
    const again = f.k.registerAction({
      principal: P,
      taskId: t,
      toolName: "fake_payment",
      params: { currency: "JPY", amount: "128.5", merchant: "Hotelier" },
      sessionKey: "s1",
      now: T0 + 5,
    });
    assert.ok(again.outcome === "existing");
    assert.equal(again.action.id, first.action.id);
  });

  it("an explicit occurrence is a different action; unknown tools and bad params are refused", () => {
    const base = f.k.registerAction({
      principal: P,
      taskId: t,
      toolName: "fake_vendor_message",
      params: { vendor: "V", message: "hi" },
      sessionKey: "s1",
      now: T0,
    });
    const second = f.k.registerAction({
      principal: P,
      taskId: t,
      toolName: "fake_vendor_message",
      params: { vendor: "V", message: "hi" },
      occurrence: 2,
      sessionKey: "s1",
      now: T0,
    });
    assert.ok(base.outcome === "created" && second.outcome === "created");
    assert.notEqual(base.action.id, second.action.id);
    assert.equal(
      f.k.registerAction({
        principal: P,
        taskId: t,
        toolName: "browser",
        params: {},
        sessionKey: "s1",
        now: T0,
      }).outcome,
      "unknown_tool",
    );
    const bad = f.k.registerAction({
      principal: P,
      taskId: t,
      toolName: "fake_payment",
      params: { merchant: "M", amount: "-3", currency: "JPY" },
      sessionKey: "s1",
      now: T0,
    });
    assert.equal(bad.outcome, "invalid_params");
  });

  it("is owner-scoped and refuses closed Tasks", () => {
    const other = f.k.registerAction({
      principal: Q,
      taskId: t,
      toolName: "fake_booking",
      params: { vendor: "V", item: "x" },
      sessionKey: "s1",
      now: T0,
    });
    assert.equal(other.outcome, "not_found");
    const t2 = f.task();
    f.k.abort({ principal: P, taskId: t2, now: T0 });
    const closed = f.k.registerAction({
      principal: P,
      taskId: t2,
      toolName: "fake_booking",
      params: { vendor: "V", item: "x" },
      sessionKey: "s1",
      now: T0,
    });
    assert.equal(closed.outcome, "task_closed");
    f.fkClean();
  });
});

describe("decision creation (server-generated content, idempotency, outbox)", () => {
  const f = fixture();

  it("builds question, facts, options and policy on the server and writes the notice in the same transaction", () => {
    const t = f.task(P, "订东京酒店", { city: "tokyo", nights: 2 });
    const a = f.booking(t);
    const d = f.created(f.decide(t, [a], { sessionKey: "s1", runId: "r1", toolCallId: "c|1" }));
    assert.equal(d.status, "pending");
    assert.equal(d.effectKind, "issue_action_grant");
    assert.equal(d.riskTier, "R2");
    assert.ok(d.question.includes("Park Hotel"));
    const facts = d.facts as {
      task: { entities: { key: string; value: string }[] };
      candidates: unknown[];
    };
    assert.deepEqual(facts.task.entities, [
      { key: "city", value: "tokyo" },
      { key: "nights", value: "2" },
    ]);
    assert.equal(facts.candidates.length, 1);
    assert.equal(d.policies[0]?.kind, "action_grant");
    assert.equal(d.policies[0]?.singleUse, true);
    assert.equal(
      f.count("SELECT COUNT(*) AS c FROM outbox WHERE event_key = ?", `decision_pending:${d.id}`),
      1,
    );
    assert.equal(
      f.row("SELECT status FROM nexus_tasks WHERE id = ?", t).status,
      "awaiting_decision",
    );
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_grants"), 0);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_executions"), 0);
  });

  it("replays the same (session, run, toolCall) as one decision and one notice; heals a missing notice", () => {
    const t = f.task();
    const a = f.booking(t);
    const key = { sessionKey: "s1", runId: "r2", toolCallId: "call_x|fc_y" };
    const d = f.created(f.decide(t, [a], key));
    const again = f.decide(t, [a], key);
    assert.equal(again.outcome, "replayed");
    assert.ok(again.outcome === "replayed");
    assert.equal(again.decision.id, d.id);
    assert.equal(again.noticeEnqueued, false);
    f.db.prepare("DELETE FROM outbox WHERE decision_id = ?").run(d.id);
    const healed = f.decide(t, [a], key);
    assert.ok(healed.outcome === "replayed" && healed.noticeEnqueued);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM outbox WHERE decision_id = ?", d.id), 1);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM decisions WHERE task_id = ?", t), 1);
  });

  it("the same key with a different request is a conflict and creates nothing", () => {
    const t = f.task();
    const a1 = f.booking(t, "Hotel A");
    const a2 = f.booking(t, "Hotel B");
    const key = { sessionKey: "s1", runId: "r3", toolCallId: "c3" };
    f.created(f.decide(t, [a1], key));
    const clash = f.decide(t, [a2], key);
    assert.equal(clash.outcome, "fingerprint_conflict");
    assert.equal(f.count("SELECT COUNT(*) AS c FROM decisions WHERE task_id = ?", t), 1);
  });

  it("the same toolCallId in another run or session is a different decision (scoped key)", () => {
    const t = f.task();
    const a = f.booking(t, "Hotel C");
    const d1 = f.created(f.decide(t, [a], { sessionKey: "s1", runId: "rA", toolCallId: "c" }));
    f.k.resolveDecision({
      principal: P,
      decisionId: d1.id,
      resolution: "denied",
      source: "nexus_console",
      resolvedBy: "u",
      providerCaps: CAPS,
      now: T0 + 1,
    });
    const d2 = f.created(
      f.decide(t, [a], { sessionKey: "s1", runId: "rB", toolCallId: "c", now: T0 + 2 }),
    );
    assert.notEqual(d1.id, d2.id);
  });

  it("an identical pending decision is reused instead of stacking a second one", () => {
    const t = f.task();
    const a = f.booking(t);
    const d = f.created(f.decide(t, [a]));
    const second = f.decide(t, [a], { sessionKey: "s9", runId: "r9", toolCallId: "c9" });
    assert.ok(second.outcome === "reused_pending");
    assert.equal(second.decision.id, d.id);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM decisions WHERE task_id = ?", t), 1);
  });

  it("validates the effect against server-side tiers", () => {
    const t = f.task();
    const booking = f.booking(t);
    const payment = f.action(t, "fake_payment", { merchant: "M", amount: "10", currency: "JPY" });
    const message = f.action(t, "fake_vendor_message", { vendor: "V", message: "hi" });
    const bad = (out: ReturnType<typeof f.decide>) =>
      out.outcome === "invalid_effect" ? out.invalid : out;
    assert.deepEqual(bad(f.decide(t, [])), { code: "no_actions" });
    assert.deepEqual(bad(f.decide(t, [booking, payment])), { code: "mixed_tier" });
    assert.deepEqual(bad(f.decide(t, [message], { effectKind: "issue_action_grant" })), {
      code: "wrong_kind",
      expected: "issue_standing_grant",
    });
    assert.deepEqual(bad(f.decide(t, [booking], { effectKind: "issue_standing_grant" })), {
      code: "wrong_kind",
      expected: "issue_action_grant",
    });
    assert.deepEqual(bad(f.decide(t, [booking], { effectKind: "set_preference" })), {
      code: "unsupported_effect",
      kind: "set_preference",
    });
    assert.deepEqual(bad(f.decide(t, ["A_nope"])), {
      code: "action_not_found",
      actionId: "A_nope",
    });
    const other = f.task();
    const foreign = f.booking(other, "elsewhere");
    assert.deepEqual(bad(f.decide(t, [foreign])), { code: "action_not_found", actionId: foreign });
    assert.equal(f.decide("T99999999", [booking]).outcome, "not_found");
    assert.equal(
      f.k.createDecision({
        principal: Q,
        taskId: t,
        actionIds: [booking],
        sessionKey: null,
        runId: null,
        toolCallId: null,
        now: T0,
      }).outcome,
      "not_found",
    );
    f.fkClean();
  });
});

describe("resolve: one function, effect dispatch, authority hash", () => {
  const f = fixture();

  it("approve R2 issues exactly one grant and one prepared execution, and nothing runs", () => {
    const t = f.task();
    const a = f.booking(t);
    const d = f.created(f.decide(t, [a]));
    const out = f.approved(f.resolve(d.id));
    assert.ok(out.executionId && out.actionGrantId);
    assert.equal(out.decision.status, "decided");
    assert.equal(out.decision.resolution, "approved");
    assert.equal(out.decision.chosenActionId, a);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_grants WHERE task_id = ?", t), 1);
    const exec = f.row("SELECT * FROM action_executions WHERE id = ?", out.executionId as string);
    assert.equal(exec.state, "prepared");
    assert.equal(exec.provider_idempotency_supported, 1);
    assert.equal(exec.action_grant_id, out.actionGrantId);
    assert.equal(
      f.count(
        "SELECT COUNT(*) AS c FROM outbox WHERE task_id = ? AND kind IN ('decision_resolved','execution_ready')",
        t,
      ),
      2,
    );
    assert.equal(f.row("SELECT status FROM nexus_tasks WHERE id = ?", t).status, "planning");
    f.fkClean();
  });

  it("a second resolve only reads the terminal state; deny after approve changes nothing", () => {
    const t = f.task();
    const d = f.created(f.decide(t, [f.booking(t)]));
    f.approved(f.resolve(d.id));
    const late = f.resolve(d.id, { resolution: "denied" });
    assert.equal(late.outcome, "already_resolved");
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_grants WHERE task_id = ?", t), 1);
    assert.equal(
      f.row("SELECT resolution FROM decisions WHERE id = ?", d.id).resolution,
      "approved",
    );
  });

  it("deny is final: resolution denied, no grant, no execution", () => {
    const t = f.task();
    const d = f.created(f.decide(t, [f.booking(t)]));
    const out = f.resolve(d.id, {
      resolution: "denied",
      source: "core_approval",
      resolvedBy: CORE_APPROVER,
    });
    assert.equal(out.outcome, "denied");
    const row = f.row(
      "SELECT status, resolution, resolution_source, resolved_by FROM decisions WHERE id = ?",
      d.id,
    );
    assert.deepEqual(
      { ...row },
      {
        status: "decided",
        resolution: "denied",
        resolution_source: "core_approval",
        resolved_by: CORE_APPROVER,
      },
    );
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_grants WHERE task_id = ?", t), 0);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_executions WHERE task_id = ?", t), 0);
  });

  it("with several candidates the human must choose, and only among the candidates", () => {
    const t = f.task();
    const a1 = f.booking(t, "Hotel A");
    const a2 = f.booking(t, "Hotel B");
    const outsider = f.booking(t, "Hotel C");
    const d = f.created(f.decide(t, [a1, a2]));
    assert.equal(f.resolve(d.id).outcome, "choice_required");
    assert.equal(f.resolve(d.id, { chosenActionId: outsider }).outcome, "invalid_choice");
    assert.equal(f.row("SELECT status FROM decisions WHERE id = ?", d.id).status, "pending");
    const ok = f.approved(f.resolve(d.id, { chosenActionId: a2 }));
    assert.equal(ok.decision.chosenActionId, a2);
    const grant = f.row("SELECT action_id FROM action_grants WHERE from_decision_id = ?", d.id);
    assert.equal(grant.action_id, a2);
  });

  it("changing the Task's meaning after the question was shown supersedes the decision; no authority is issued", () => {
    const t = f.task();
    const d = f.created(f.decide(t, [f.booking(t)]));
    const upd = f.k.update({
      principal: P,
      taskId: t,
      patch: { entities: { city: "osaka" } },
      sessionKey: "s1",
      now: T0 + 10,
    });
    assert.equal(upd.outcome, "updated");
    const out = f.resolve(d.id);
    assert.equal(out.outcome, "superseded");
    assert.equal(f.row("SELECT status FROM decisions WHERE id = ?", d.id).status, "superseded");
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_grants WHERE task_id = ?", t), 0);
  });

  it("a tampered grant policy changes the authority hash and is caught at resolve time", () => {
    const t = f.task();
    const d = f.created(f.decide(t, [f.booking(t)]));
    f.db
      .prepare(
        "UPDATE decisions SET grant_policy_snapshot = replace(grant_policy_snapshot, '1800000', '99999999') WHERE id = ?",
      )
      .run(d.id);
    assert.equal(f.resolve(d.id).outcome, "superseded");
  });

  it("an expired decision cannot be approved and the Task goes back to planning", () => {
    const t = f.task();
    const d = f.created(f.decide(t, [f.booking(t)]));
    const out = f.resolve(d.id, { now: T0 + 25 * 3_600_000 });
    assert.equal(out.outcome, "expired");
    assert.equal(
      f.row("SELECT resolution FROM decisions WHERE id = ?", d.id).resolution,
      "timed_out",
    );
    assert.equal(f.row("SELECT status FROM nexus_tasks WHERE id = ?", t).status, "planning");
  });

  it("an aborted Task supersedes its pending decision instead of issuing a grant", () => {
    const t = f.task();
    const d = f.created(f.decide(t, [f.booking(t)]));
    f.k.abort({ principal: P, taskId: t, now: T0 + 5 });
    const out = f.resolve(d.id);
    assert.ok(out.outcome === "superseded" && out.reason === "task_closed");
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_grants WHERE task_id = ?", t), 0);
  });

  it("another owner cannot see or resolve the decision", () => {
    const t = f.task();
    const d = f.created(f.decide(t, [f.booking(t)]));
    assert.equal(
      f.k.resolveDecision({
        principal: Q,
        decisionId: d.id,
        resolution: "approved",
        source: "nexus_console",
        resolvedBy: "x",
        providerCaps: CAPS,
        now: T0,
      }).outcome,
      "not_found",
    );
    assert.equal(f.k.getDecision({ principal: Q, decisionId: d.id }), null);
    assert.equal(f.k.listDecisions({ principal: Q, limit: 10 }).length, 0);
  });

  it("acknowledge writes only the decision row (no grant, no execution)", () => {
    const t = f.task();
    const d = f.created(f.decide(t, [], { effectKind: "acknowledge" }));
    assert.equal(d.effectKind, "acknowledge");
    const out = f.approved(f.resolve(d.id));
    assert.equal(out.executionId, null);
    assert.equal(out.actionGrantId, null);
    assert.equal(out.standingGrantId, null);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_grants WHERE task_id = ?", t), 0);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM standing_grants WHERE task_id = ?", t), 0);
  });

  it("the schema itself refuses authority built on a decision that is not an approved grant decision", () => {
    const t = f.task();
    const a = f.booking(t);
    const ack = f.created(f.decide(t, [], { effectKind: "acknowledge" }));
    f.approved(f.resolve(ack.id));
    const pending = f.created(f.decide(t, [a]));
    const insertGrant = (decisionId: string) =>
      f.db
        .prepare(
          "INSERT INTO action_grants (id, owner_id, task_id, from_decision_id, capability, tool_name, action_id, action_hash, task_revision, nonce, created_at, expires_at) " +
            "VALUES ('GX', 'local', ?, ?, 'book', 'fake_booking', ?, 'h', 1, 'n', 1, 2)",
        )
        .run(t, decisionId, a);
    assert.throws(() => insertGrant(ack.id), /FOREIGN KEY/);
    assert.throws(() => insertGrant(pending.id), /FOREIGN KEY/);
  });
});

describe("grant rotation (section 8.5): three old-grant states", () => {
  it("unconsumed and unexpired: the old grant is superseded and its execution can no longer be committed", () => {
    const f = fixture();
    const t = f.task();
    const a1 = f.booking(t, "Hotel A");
    const a2 = f.booking(t, "Hotel B");
    const d1 = f.created(f.decide(t, [a1]));
    const d2 = f.created(f.decide(t, [a1, a2]));
    const g1 = f.approved(f.resolve(d1.id));
    const g2 = f.approved(f.resolve(d2.id, { chosenActionId: a1, now: T0 + 2000 }));
    assert.notEqual(g1.actionGrantId, g2.actionGrantId);
    const old = f.row(
      "SELECT superseded_by, revoked_at FROM action_grants WHERE id = ?",
      g1.actionGrantId as string,
    );
    assert.equal(old.superseded_by, g2.actionGrantId);
    const oldExec = f.admit(g1.executionId as string, T0 + 3000);
    assert.equal(oldExec.kind, "replay_failed");
    const fresh = f.admit(g2.executionId as string, T0 + 3000);
    assert.equal(fresh.kind, "execute_new");
    f.fkClean();
  });

  it("expired but never retired: it must not block the new grant", () => {
    const f = fixture();
    const t = f.task();
    const a = f.booking(t);
    const d1 = f.created(f.decide(t, [a]));
    const g1 = f.approved(f.resolve(d1.id));
    const later = T0 + 31 * MIN;
    const d2 = f.created(f.decide(t, [a], { now: later }));
    const g2 = f.approved(f.resolve(d2.id, { now: later + 1 }));
    const old = f.row(
      "SELECT revoked_at, superseded_by FROM action_grants WHERE id = ?",
      g1.actionGrantId as string,
    );
    assert.equal(old.revoked_at, later + 1);
    assert.equal(old.superseded_by, null);
    assert.equal(
      f.row("SELECT state FROM action_executions WHERE id = ?", g1.executionId as string).state,
      "failed",
    );
    assert.equal(f.admit(g2.executionId as string, later + 2).kind, "execute_new");
    f.fkClean();
  });

  it("already consumed: the old row is left alone", () => {
    const f = fixture();
    const t = f.task();
    const a = f.booking(t);
    const d1 = f.created(f.decide(t, [a]));
    const g1 = f.approved(f.resolve(d1.id));
    assert.equal(f.admit(g1.executionId as string).kind, "execute_new");
    const d2 = f.created(f.decide(t, [a], { now: T0 + 5000 }));
    const g2 = f.approved(f.resolve(d2.id, { now: T0 + 6000 }));
    const old = f.row(
      "SELECT consumed_at, superseded_by, revoked_at FROM action_grants WHERE id = ?",
      g1.actionGrantId as string,
    );
    assert.equal(old.consumed_at, T0 + 2000);
    assert.equal(old.superseded_by, null);
    assert.equal(old.revoked_at, null);
    assert.notEqual(g2.actionGrantId, g1.actionGrantId);
    f.fkClean();
  });

  it("a live grant makes a repeated request answer already_approved instead of a second card", () => {
    const f = fixture();
    const t = f.task();
    const a = f.booking(t);
    const d = f.created(f.decide(t, [a]));
    const g = f.approved(f.resolve(d.id));
    const again = f.decide(t, [a], { now: T0 + 10 });
    assert.ok(again.outcome === "already_approved");
    assert.equal(again.executionId, g.executionId);
  });
});

describe("admission and settlement (section 8.4)", () => {
  const prepared = (supported = true) => {
    const f = fixture();
    const t = f.task();
    const a = supported
      ? f.booking(t)
      : f.action(t, "fake_payment", { merchant: "M", amount: "10.00", currency: "JPY" });
    const d = f.created(f.decide(t, [a]));
    const g = f.approved(f.resolve(d.id));
    return { f, t, a, d, executionId: g.executionId as string, grantId: g.actionGrantId as string };
  };

  it("admits once: the grant is consumed in the same transaction and a concurrent commit is not executed", () => {
    const { f, t, executionId, grantId } = prepared();
    const first = f.admit(executionId);
    assert.equal(first.kind, "execute_new");
    assert.ok(first.kind === "execute_new");
    assert.equal(first.action.toolName, "fake_booking");
    assert.equal(first.execution.state, "executing");
    assert.equal(
      f.row("SELECT consumed_by_execution FROM action_grants WHERE id = ?", grantId)
        .consumed_by_execution,
      executionId,
    );
    assert.equal(f.row("SELECT status FROM nexus_tasks WHERE id = ?", t).status, "executing");
    const second = f.admit(executionId, T0 + 2001);
    assert.ok(second.kind === "reconcile_only" && second.reason === "in_flight");
    f.fkClean();
  });

  it("settled executions replay their recorded result and never reach the provider again", () => {
    const { f, t, executionId } = prepared();
    f.admit(executionId);
    const settled = f.k.settleExecution({
      principal: P,
      executionId,
      outcome: { kind: "succeeded", result: { confirmation: "C-1" }, providerOperationId: "op1" },
      now: T0 + 3000,
    });
    assert.equal(settled.outcome, "settled");
    const replay = f.admit(executionId, T0 + 4000);
    assert.ok(replay.kind === "replay_succeeded");
    assert.deepEqual(replay.execution.result, { confirmation: "C-1" });
    assert.equal(replay.execution.providerOperationId, "op1");
    assert.equal(f.row("SELECT status FROM nexus_tasks WHERE id = ?", t).status, "planning");
    const again = f.k.settleExecution({
      principal: P,
      executionId,
      outcome: { kind: "failed", error: "late" },
      now: T0 + 5000,
    });
    assert.equal(again.outcome, "already_settled");
    assert.equal(
      f.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "succeeded",
    );
  });

  it("a definitive failure replays as failed", () => {
    const { f, executionId } = prepared();
    f.admit(executionId);
    f.k.settleExecution({
      principal: P,
      executionId,
      outcome: { kind: "failed", error: { code: "declined" } },
      now: T0 + 3000,
    });
    const replay = f.admit(executionId, T0 + 4000);
    assert.ok(replay.kind === "replay_failed");
    assert.deepEqual(replay.execution.error, { code: "declined" });
  });

  it("unknown never replays: it goes to reconcile, and the Task stays executing", () => {
    const { f, t, executionId } = prepared();
    f.admit(executionId);
    f.k.settleExecution({
      principal: P,
      executionId,
      outcome: { kind: "unknown", error: "connection reset" },
      now: T0 + 3000,
    });
    const out = f.admit(executionId, T0 + 4000);
    assert.ok(out.kind === "reconcile_only" && out.reason === "unknown");
    assert.ok(out.execution.nextReconcileAt !== null);
    assert.equal(f.row("SELECT status FROM nexus_tasks WHERE id = ?", t).status, "executing");
    const reconciled = f.k.settleExecution({
      principal: P,
      executionId,
      outcome: { kind: "succeeded", result: { ok: true } },
      from: ["unknown"],
      now: T0 + 9000,
    });
    assert.equal(reconciled.outcome, "settled");
    assert.equal(f.row("SELECT status FROM nexus_tasks WHERE id = ?", t).status, "planning");
  });

  it("stale executing: without provider idempotency only reconcile; with it exactly one retrier wins", () => {
    const no = prepared(false);
    no.f.admit(no.executionId);
    const stale = no.f.admit(no.executionId, T0 + 2000 + 200_000);
    assert.ok(stale.kind === "reconcile_only" && stale.reason === "stale_executing");
    assert.equal(
      no.f.row(
        "SELECT provider_idempotency_supported AS s FROM action_executions WHERE id = ?",
        no.executionId,
      ).s,
      0,
    );

    const yes = prepared(true);
    yes.f.admit(yes.executionId);
    const late = T0 + 2000 + 200_000;
    const retry = yes.f.admit(yes.executionId, late);
    assert.equal(retry.kind, "retry_provider_idempotently");
    assert.ok(retry.kind === "retry_provider_idempotently");
    assert.equal(retry.execution.attempts, 2);
    const racer = yes.f.admit(yes.executionId, late);
    assert.ok(racer.kind === "reconcile_only" && racer.reason === "in_flight");
  });

  it("rejects, and permanently fails the execution, when authority is gone", () => {
    const expired = prepared();
    const out = expired.f.admit(expired.executionId, T0 + 31 * MIN);
    assert.ok(out.kind === "rejected" && out.reason === "grant_expired");
    assert.equal(
      expired.f.row("SELECT state FROM action_executions WHERE id = ?", expired.executionId).state,
      "failed",
    );
    assert.equal(expired.f.admit(expired.executionId, T0 + 32 * MIN).kind, "replay_failed");

    const revoked = prepared();
    assert.equal(
      revoked.f.k.revokeGrant({ principal: P, grantId: revoked.grantId, now: T0 + 1500 }).outcome,
      "revoked",
    );
    assert.equal(revoked.f.admit(revoked.executionId).kind, "replay_failed");

    const changed = prepared();
    changed.f.k.update({
      principal: P,
      taskId: changed.t,
      patch: { goal: { want: "something else" } },
      sessionKey: "s1",
      now: T0 + 1500,
    });
    const moved = changed.f.admit(changed.executionId);
    assert.ok(moved.kind === "rejected" && moved.reason === "task_revision_changed");

    const closed = prepared();
    closed.f.k.abort({ principal: P, taskId: closed.t, now: T0 + 1500 });
    const gone = closed.f.admit(closed.executionId);
    assert.ok(gone.kind === "rejected" && gone.reason === "task_closed");
    assert.equal(
      closed.f.count("SELECT COUNT(*) AS c FROM action_grants WHERE consumed_at IS NOT NULL"),
      0,
    );
  });

  it("an executionId from another owner or a made-up one is rejected", () => {
    const { f, executionId } = prepared();
    const foreign = f.admit(executionId, T0 + 2000, Q);
    assert.ok(foreign.kind === "rejected" && foreign.reason === "execution_not_found");
    assert.equal(f.admit("X_nope").kind, "rejected");
    assert.equal(
      f.row("SELECT state FROM action_executions WHERE id = ?", executionId).state,
      "prepared",
    );
  });

  it("a payment grant carries the exact amount and currency the human saw", () => {
    const { f, executionId, grantId } = prepared(false);
    const grant = f.row("SELECT max_amount, currency FROM action_grants WHERE id = ?", grantId);
    assert.deepEqual({ ...grant }, { max_amount: "10.00", currency: "JPY" });
    assert.equal(f.admit(executionId).kind, "execute_new");
  });
});

describe("R1: standing policy and nexus_action_authorize (section 8.6)", () => {
  const standing = () => {
    const f = fixture();
    const t = f.task();
    const m1 = f.action(t, "fake_vendor_message", { vendor: "Hotelier", message: "第一条" });
    const d = f.created(f.decide(t, [m1]));
    const g = f.approved(f.resolve(d.id));
    return { f, t, m1, d, standingGrantId: g.standingGrantId as string };
  };
  const authorize = (f: ReturnType<typeof fixture>, actionId: string, now = T0 + 3000) =>
    f.k.authorizeAction({ principal: P, actionId, providerCaps: CAPS, sessionKey: "s1", now });

  it("approval signs a policy only: no execution, no grant_uses", () => {
    const { f, standingGrantId, d } = standing();
    assert.ok(standingGrantId);
    assert.equal(d.effectKind, "issue_standing_grant");
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_executions"), 0);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM grant_uses"), 0);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_grants"), 0);
  });

  it("authorize signs an execution; repeating it returns the SAME executionId and burns no quota", () => {
    const { f, m1 } = standing();
    const first = authorize(f, m1);
    assert.ok(first.outcome === "authorized" && !first.reentry);
    const second = authorize(f, m1, T0 + 3500);
    assert.ok(second.outcome === "authorized" && second.reentry);
    assert.equal(second.executionId, first.executionId);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_executions"), 1);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM grant_uses"), 0);
  });

  it("end to end: commit writes one grant_uses row at admission; later authorize is refused until a new action", () => {
    const { f, m1 } = standing();
    const a = authorize(f, m1);
    assert.ok(a.outcome === "authorized");
    assert.equal(f.admit(a.executionId).kind, "execute_new");
    assert.equal(f.count("SELECT COUNT(*) AS c FROM grant_uses"), 1);
    assert.equal(authorize(f, m1, T0 + 4000).outcome, "in_progress");
    f.k.settleExecution({
      principal: P,
      executionId: a.executionId,
      outcome: { kind: "succeeded", result: { sent: true } },
      now: T0 + 4500,
    });
    assert.equal(authorize(f, m1, T0 + 5000).outcome, "already_done");
    assert.equal(f.admit(a.executionId, T0 + 5000).kind, "replay_succeeded");
    assert.equal(f.count("SELECT COUNT(*) AS c FROM grant_uses"), 1);
    f.fkClean();
  });

  it("the usage limit counts admissions: the policy runs out after three uses", () => {
    const { f, t, m1 } = standing();
    const ids = [m1];
    for (const occurrence of [2, 3, 4]) {
      ids.push(
        f.action(
          t,
          "fake_vendor_message",
          { vendor: "Hotelier", message: "第一条" },
          { occurrence },
        ),
      );
    }
    for (const [index, id] of ids.entries()) {
      const out = authorize(f, id, T0 + 3000 + index * 10);
      if (index < 3) {
        assert.ok(out.outcome === "authorized", `use ${index}`);
        assert.equal(f.admit(out.executionId, T0 + 3005 + index * 10).kind, "execute_new");
        f.k.settleExecution({
          principal: P,
          executionId: out.executionId,
          outcome: { kind: "succeeded", result: {} },
          now: T0 + 3008 + index * 10,
        });
      } else {
        assert.ok(out.outcome === "policy_not_applicable" && out.reason === "max_uses_reached");
      }
    }
  });

  it("only covers its own capability and counterparty; R2 and R3 never go through authorize", () => {
    const { f, t, m1 } = standing();
    const otherVendor = f.action(t, "fake_vendor_message", {
      vendor: "Someone Else",
      message: "hi",
    });
    assert.equal(authorize(f, otherVendor).outcome, "no_policy");
    const booking = f.booking(t);
    const notR1 = authorize(f, booking);
    assert.ok(notR1.outcome === "not_r1" && notR1.tier === "R2");
    assert.equal(authorize(f, "A_nope").outcome, "not_found");
    assert.equal(
      f.k.authorizeAction({
        principal: Q,
        actionId: m1,
        providerCaps: CAPS,
        sessionKey: "s",
        now: T0,
      }).outcome,
      "not_found",
    );
  });

  it("without any approval there is no policy; after revocation or a Task change it is not applicable", () => {
    const f = fixture();
    const t = f.task();
    const m = f.action(t, "fake_vendor_message", { vendor: "V", message: "hi" });
    assert.equal(authorize(f, m).outcome, "no_policy");

    const s = standing();
    const a = authorize(s.f, s.m1);
    assert.ok(a.outcome === "authorized");
    s.f.k.revokeGrant({ principal: P, grantId: s.standingGrantId, now: T0 + 3100 });
    assert.equal(s.f.admit(a.executionId, T0 + 3200).kind, "replay_failed");
    const again = authorize(s.f, s.m1, T0 + 3300);
    assert.equal(again.outcome, "already_done");

    const c = standing();
    c.f.k.update({
      principal: P,
      taskId: c.t,
      patch: { title: "新的事项" },
      sessionKey: "s1",
      now: T0 + 3100,
    });
    const m2 = c.f.action(c.t, "fake_vendor_message", { vendor: "Hotelier", message: "第二条" });
    const stale = authorize(c.f, m2, T0 + 3200);
    assert.ok(
      stale.outcome === "policy_not_applicable" && stale.reason === "task_revision_changed",
    );
  });
});

describe("core approval attempt (section 8.8.3 / 8.9)", () => {
  const APPROVAL_TIMEOUT_MS = 600_000;
  const pending = () => {
    const f = fixture();
    const t = f.task();
    const d = f.created(f.decide(t, [f.booking(t)]));
    const claim = (now: number, workerId = "w1") =>
      f.k.claimCoreApproval({
        principal: P,
        decisionId: d.id,
        approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
        workerId,
        now,
      });
    const callback = (attemptId: string, value: string, now = T0 + 5000) =>
      f.k.recordApprovalResolution({
        principal: P,
        decisionId: d.id,
        attemptId,
        value,
        providerCaps: CAPS,
        now,
      });
    const state = () =>
      f.row(
        "SELECT status, resolution, core_approval_state AS card FROM decisions WHERE id = ?",
        d.id,
      );
    return { f, t, d, claim, callback, state };
  };

  it("while the card may still be alive no second attempt is granted; after approvalTimeout + 60 s it can be taken over", () => {
    const { claim } = pending();
    const first = claim(T0 + 100);
    assert.ok(first);
    assert.equal(claim(T0 + 100 + 300_000), null);
    assert.equal(claim(T0 + 100 + APPROVAL_TIMEOUT_MS + 60_000 - 1), null);
    const takeover = claim(T0 + 100 + APPROVAL_TIMEOUT_MS + 60_001, "w2");
    assert.ok(takeover);
    assert.notEqual(takeover.attemptId, first.attemptId);
  });

  it("a superseded attempt's late callback is dropped and changes nothing", () => {
    const { claim, callback, state } = pending();
    const first = claim(T0);
    const second = claim(T0 + APPROVAL_TIMEOUT_MS + 61_000);
    assert.ok(first && second);
    assert.deepEqual(callback(first.attemptId, "allow-once"), { outcome: "stale_attempt" });
    assert.deepEqual({ ...state() }, { status: "pending", resolution: null, card: "attempted" });
  });

  it("allow-once resolves through the same function and records the unavailable reviewer", () => {
    const { f, claim, callback, d } = pending();
    const a = claim(T0);
    assert.ok(a);
    const out = callback(a.attemptId, "allow-once");
    assert.ok(out.outcome === "resolved" && out.result.outcome === "approved");
    const row = f.row(
      "SELECT status, resolution, resolution_source, resolved_by, core_approval_state FROM decisions WHERE id = ?",
      d.id,
    );
    assert.deepEqual(
      { ...row },
      {
        status: "decided",
        resolution: "approved",
        resolution_source: "core_approval",
        resolved_by: CORE_APPROVER,
        core_approval_state: "resolved",
      },
    );
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_executions"), 1);
    assert.equal(callback(a.attemptId, "allow-once").outcome, "ignored");
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_grants"), 1);
  });

  it("deny is a final user decision; cancelled, timeout and a stray allow-always leave the decision pending", () => {
    const denyCase = pending();
    const a = denyCase.claim(T0);
    assert.ok(a);
    const denied = denyCase.callback(a.attemptId, "deny");
    assert.ok(denied.outcome === "resolved" && denied.result.outcome === "denied");
    assert.equal(denyCase.state().resolution, "denied");

    for (const [value, card] of [
      ["cancelled", "cancelled"],
      ["timeout", "timed_out"],
      ["allow-always", "cancelled"],
    ] as const) {
      const c = pending();
      const claim = c.claim(T0);
      assert.ok(claim);
      const out = c.callback(claim.attemptId, value);
      assert.ok(out.outcome === "noted", value);
      assert.deepEqual({ ...c.state() }, { status: "pending", resolution: null, card });
      assert.equal(c.f.count("SELECT COUNT(*) AS c FROM action_grants"), 0);
    }
  });

  it("a lost callback leaves the decision pending and the decision page can still complete it", () => {
    const { f, claim, d, state } = pending();
    claim(T0);
    assert.equal(state().status, "pending");
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_grants"), 0);
    const viaPage = f.resolve(d.id);
    assert.equal(viaPage.outcome, "approved");
  });

  it("core callback and decision page race: exactly one wins and both use the same code path", () => {
    const { f, claim, callback, d } = pending();
    const a = claim(T0);
    assert.ok(a);
    const page = f.resolve(d.id, { now: T0 + 4000 });
    assert.equal(page.outcome, "approved");
    const late = callback(a.attemptId, "allow-once", T0 + 4001);
    assert.ok(late.outcome === "resolved" && late.result.outcome === "already_resolved");
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_grants"), 1);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_executions"), 1);
  });

  const stepTitles = (f: ReturnType<typeof fixture>, taskId: string) =>
    (
      f.db
        .prepare("SELECT title FROM nexus_task_steps WHERE task_id = ? ORDER BY seq")
        .all(taskId) as Array<{ title: string }>
    ).map((r) => r.title);

  it("late Deny after the page approved: the unused execution and grant are withdrawn, the decision stays approved, a step records it", () => {
    const { f, t, claim, callback, d, state } = pending();
    const a = claim(T0);
    assert.ok(a);
    const g = f.approved(f.resolve(d.id, { now: T0 + 4000 }));
    const out = callback(a.attemptId, "deny", T0 + 5000);
    assert.ok(out.outcome === "resolved" && out.result.outcome === "already_resolved");
    assert.deepEqual(out.late?.revokedExecutionIds, [g.executionId]);
    assert.deepEqual(
      { ...state() },
      { status: "decided", resolution: "approved", card: "resolved" },
    );
    const exec = f.row(
      "SELECT state, error_canonical AS err FROM action_executions WHERE id = ?",
      g.executionId as string,
    );
    assert.equal(exec.state, "failed");
    assert.match(String(exec.err), /late_deny_revoked/);
    assert.notEqual(
      f.row("SELECT revoked_at FROM action_grants WHERE id = ?", g.actionGrantId as string)
        .revoked_at,
      null,
    );
    assert.ok(
      stepTitles(f, t).some(
        (title) => title.includes("Late card rejection") && title.includes("revoked"),
      ),
    );
    assert.equal(
      f.count(
        "SELECT COUNT(*) AS c FROM outbox WHERE event_key = ?",
        `execution_settled:${g.executionId}:failed`,
      ),
      1,
    );
    // the withdrawn execution cannot be committed any more
    const again = f.admit(g.executionId as string, T0 + 6000);
    assert.ok(again.kind === "replay_failed");
    assert.equal(f.row("SELECT status FROM nexus_tasks WHERE id = ?", t).status, "planning");
    f.fkClean();
  });

  it("late Deny after the execution already started: nothing is withdrawn, the click is only recorded", () => {
    const { f, t, claim, callback, d } = pending();
    const a = claim(T0);
    assert.ok(a);
    const g = f.approved(f.resolve(d.id, { now: T0 + 4000 }));
    assert.equal(f.admit(g.executionId as string, T0 + 4500).kind, "execute_new");
    const out = callback(a.attemptId, "deny", T0 + 5000);
    assert.ok(out.outcome === "resolved" && out.result.outcome === "already_resolved");
    assert.deepEqual(out.late?.revokedExecutionIds, []);
    assert.equal(
      f.row("SELECT state FROM action_executions WHERE id = ?", g.executionId as string).state,
      "executing",
    );
    assert.equal(
      f.row("SELECT revoked_at FROM action_grants WHERE id = ?", g.actionGrantId as string)
        .revoked_at,
      null,
    );
    assert.ok(stepTitles(f, t).some((title) => title.includes("recorded only")));
  });

  it("late Allow after the page denied: nothing is created, the click is only recorded", () => {
    const { f, t, claim, callback, d, state } = pending();
    const a = claim(T0);
    assert.ok(a);
    assert.equal(f.resolve(d.id, { resolution: "denied", now: T0 + 4000 }).outcome, "denied");
    const out = callback(a.attemptId, "allow-once", T0 + 5000);
    assert.ok(out.outcome === "resolved" && out.result.outcome === "already_resolved");
    assert.deepEqual({ ...state() }, { status: "decided", resolution: "denied", card: "resolved" });
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_grants"), 0);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_executions"), 0);
    assert.ok(stepTitles(f, t).some((title) => title.includes("ignored")));
  });

  it("late Allow after the page approved is only recorded and does not touch the execution", () => {
    const { f, claim, callback, d } = pending();
    const a = claim(T0);
    assert.ok(a);
    const g = f.approved(f.resolve(d.id, { now: T0 + 4000 }));
    const out = callback(a.attemptId, "allow-once", T0 + 5000);
    assert.ok(out.outcome === "resolved" && out.result.outcome === "already_resolved");
    assert.deepEqual(out.late?.revokedExecutionIds, []);
    assert.equal(
      f.row("SELECT state FROM action_executions WHERE id = ?", g.executionId as string).state,
      "prepared",
    );
  });

  it("late Deny on an approved standing policy: revoked while unused; kept (only recorded) once it has been used", () => {
    const f = fixture();
    const make = (message: string) => {
      const t = f.task(P, `msg ${message}`);
      const m = f.action(t, "fake_vendor_message", { vendor: "Hotelier", message });
      const d = f.created(f.decide(t, [m]));
      const claim = f.k.claimCoreApproval({
        principal: P,
        decisionId: d.id,
        approvalTimeoutMs: 600_000,
        workerId: "w1",
        now: T0,
      });
      assert.ok(claim);
      const g = f.approved(f.resolve(d.id, { now: T0 + 4000 }));
      return { t, m, d, claim, g };
    };
    const unused = make("A");
    const out = f.k.recordApprovalResolution({
      principal: P,
      decisionId: unused.d.id,
      attemptId: unused.claim.attemptId,
      value: "deny",
      providerCaps: CAPS,
      now: T0 + 5000,
    });
    assert.ok(out.outcome === "resolved" && out.result.outcome === "already_resolved");
    assert.notEqual(
      f.row(
        "SELECT revoked_at FROM standing_grants WHERE id = ?",
        unused.g.standingGrantId as string,
      ).revoked_at,
      null,
    );
    const authorized = f.k.authorizeAction({
      principal: P,
      actionId: unused.m,
      providerCaps: CAPS,
      sessionKey: "s1",
      now: T0 + 6000,
    });
    assert.notEqual(authorized.outcome, "authorized");

    const used = make("B");
    const auth = f.k.authorizeAction({
      principal: P,
      actionId: used.m,
      providerCaps: CAPS,
      sessionKey: "s1",
      now: T0 + 4500,
    });
    assert.ok(auth.outcome === "authorized");
    assert.equal(f.admit(auth.executionId, T0 + 4600).kind, "execute_new");
    const out2 = f.k.recordApprovalResolution({
      principal: P,
      decisionId: used.d.id,
      attemptId: used.claim.attemptId,
      value: "deny",
      providerCaps: CAPS,
      now: T0 + 5000,
    });
    assert.ok(out2.outcome === "resolved");
    assert.deepEqual(out2.late?.revokedExecutionIds, []);
    assert.equal(
      f.row("SELECT revoked_at FROM standing_grants WHERE id = ?", used.g.standingGrantId as string)
        .revoked_at,
      null,
    );
    f.fkClean();
  });

  it("an allow-once whose effect cannot be written ends as effect_apply_failed; the page path throws and stays pending", () => {
    const { f, claim, callback, d, state } = pending();
    f.db.exec(
      "CREATE TRIGGER nx_fail BEFORE INSERT ON action_grants BEGIN SELECT RAISE(ABORT, 'disk on fire'); END",
    );
    assert.throws(() => f.resolve(d.id), /disk on fire/);
    assert.equal(state().status, "pending");
    const a = claim(T0);
    assert.ok(a);
    const out = callback(a.attemptId, "allow-once");
    assert.ok(out.outcome === "resolved" && out.result.outcome === "effect_apply_failed");
    assert.deepEqual(
      { ...state() },
      { status: "effect_apply_failed", resolution: "approved", card: "resolved" },
    );
    f.db.exec("DROP TRIGGER nx_fail");
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_grants"), 0);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM action_executions"), 0);
    // the failed decision no longer counts as pending, so a fresh request creates a new one
    const t = f.row("SELECT task_id FROM decisions WHERE id = ?", d.id).task_id as string;
    const a2 = f.booking(t, "Another");
    assert.equal(f.decide(t, [a2]).outcome, "created");
  });
});

describe("run_triggers (section 8.8.1)", () => {
  const f = fixture();
  const rec = (over: Partial<Parameters<typeof f.k.recordRunTrigger>[0]> = {}) =>
    f.k.recordRunTrigger({
      principal: P,
      runId: "r1",
      sessionKey: "s1",
      trigger: "user",
      ttlMs: 3_600_000,
      now: T0,
      ...over,
    });
  const read = (over: Partial<Parameters<typeof f.k.readRunTrigger>[0]> = {}) =>
    f.k.readRunTrigger({ principal: P, runId: "r1", sessionKey: "s1", now: T0 + 1000, ...over });

  it("records once, never rewrites, and flags a conflicting rewrite", () => {
    assert.equal(rec().outcome, "recorded");
    assert.equal(rec({ now: T0 + 5 }).outcome, "existing");
    assert.equal(rec({ trigger: "cron", now: T0 + 6 }).outcome, "conflict");
    assert.equal(read()?.trigger, "user");
  });

  it("the same runId under two owners does not shadow each other", () => {
    assert.equal(
      f.k.recordRunTrigger({
        principal: Q,
        runId: "r1",
        sessionKey: "s1",
        trigger: "cron",
        jobId: "j",
        ttlMs: 3_600_000,
        now: T0,
      }).outcome,
      "recorded",
    );
    assert.equal(read()?.trigger, "user");
    assert.equal(
      f.k.readRunTrigger({ principal: Q, runId: "r1", sessionKey: "s1", now: T0 + 1 })?.trigger,
      "cron",
    );
  });

  it("fails closed: wrong session, expired, other owner's run", () => {
    assert.equal(read({ sessionKey: "s2" }), null);
    assert.equal(read({ now: T0 + 3_600_001 }), null);
    assert.equal(read({ runId: "nope" }), null);
    assert.equal(f.k.purgeRunTriggers({ principal: P, now: T0 + 3_600_001 }), 1);
    assert.equal(f.count("SELECT COUNT(*) AS c FROM run_triggers"), 1);
  });
});

describe("outbox (section 8.8.3)", () => {
  const seeded = () => {
    const f = fixture();
    const t = f.task();
    f.created(f.decide(t, [f.booking(t)]));
    return f;
  };
  it("claim is a CAS: the second worker gets nothing; delivered rows are final", () => {
    const f = seeded();
    const a = f.k.claimOutbox({ principal: P, workerId: "w1", limit: 10, now: T0 });
    const b = f.k.claimOutbox({ principal: P, workerId: "w2", limit: 10, now: T0 });
    assert.equal(a.length, 1);
    assert.equal(b.length, 0);
    assert.equal(a[0]?.kind, "decision_pending");
    assert.equal(
      f.k.finishOutbox({
        principal: P,
        id: a[0]?.id as string,
        workerId: "w2",
        ok: true,
        maxAttempts: 5,
        now: T0,
      }).outcome,
      "not_claimed",
    );
    assert.equal(
      f.k.finishOutbox({
        principal: P,
        id: a[0]?.id as string,
        workerId: "w1",
        ok: true,
        maxAttempts: 5,
        now: T0,
      }).outcome,
      "delivered",
    );
    assert.equal(
      f.k.claimOutbox({ principal: P, workerId: "w1", limit: 10, now: T0 + 10_000_000 }).length,
      0,
    );
  });
  it("failures back off, then give up; stale delivering rows return to pending on recovery", () => {
    const f = seeded();
    let [claimed] = f.k.claimOutbox({ principal: P, workerId: "w1", limit: 10, now: T0 });
    assert.equal(
      f.k.finishOutbox({
        principal: P,
        id: claimed?.id as string,
        workerId: "w1",
        ok: false,
        error: "boom",
        maxAttempts: 3,
        now: T0,
      }).outcome,
      "retry",
    );
    assert.equal(
      f.k.claimOutbox({ principal: P, workerId: "w1", limit: 10, now: T0 + 1000 }).length,
      0,
    );
    [claimed] = f.k.claimOutbox({ principal: P, workerId: "w1", limit: 10, now: T0 + 60_000 });
    assert.ok(claimed);
    assert.equal(
      f.k.recoverOutbox({ principal: P, staleMs: 120_000, now: T0 + 60_000 + 119_000 }),
      0,
    );
    assert.equal(
      f.k.recoverOutbox({ principal: P, staleMs: 120_000, now: T0 + 60_000 + 121_000 }),
      1,
    );
    [claimed] = f.k.claimOutbox({ principal: P, workerId: "w2", limit: 10, now: T0 + 400_000 });
    assert.ok(claimed);
    assert.equal(
      f.k.finishOutbox({
        principal: P,
        id: claimed.id,
        workerId: "w2",
        ok: false,
        error: "x",
        maxAttempts: 2,
        now: T0 + 400_000,
      }).outcome,
      "failed",
    );
    assert.equal(f.row("SELECT state, last_error FROM outbox").state, "failed");
  });
});

describe("orphan core-approval attempts and the process boot id (section 9.5.1)", () => {
  const TIMEOUT = 600_000;
  const attempted = (workerId: string) => {
    const f = fixture();
    const t = f.task();
    const d = f.created(f.decide(t, [f.booking(t)]));
    const claim = f.k.claimCoreApproval({
      principal: P,
      decisionId: d.id,
      approvalTimeoutMs: TIMEOUT,
      workerId,
      now: T0 + 100,
    });
    assert.ok(claim);
    const card = () =>
      f.row(
        "SELECT core_approval_state AS card, core_approval_attempt_by AS by FROM decisions WHERE id = ?",
        d.id,
      );
    const restart = (bootId?: string | null) =>
      f.k.reconcileOnStart({
        principal: P,
        now: T0 + 1000,
        outboxStaleMs: 120_000,
        ...(bootId !== undefined ? { bootId } : {}),
      });
    return { f, d, card, restart };
  };

  it("an attempt made by ANOTHER process is put back to not_attempted at once, without waiting for the lease", () => {
    const { card, restart, f, d } = attempted("nexus@111:5000#aaaaaa");
    assert.equal(card().card, "attempted");
    const out = restart("222:9000");
    assert.equal(out.orphanAttemptsReset, 1);
    assert.equal(card().card, "not_attempted");
    assert.equal(card().by, null);
    assert.ok(
      f.k.claimCoreApproval({
        principal: P,
        decisionId: d.id,
        approvalTimeoutMs: TIMEOUT,
        workerId: "w2",
        now: T0 + 1100,
      }),
      "a new attempt is possible immediately",
    );
  });

  it("the same boot id (a plugin reload keeps the process) is never touched", () => {
    const { card, restart } = attempted("nexus@111:5000#aaaaaa");
    assert.equal(restart("111:5000").orphanAttemptsReset, 0);
    assert.equal(card().card, "attempted");
  });

  it("unreadable ids never match anything: unavailable on either side, legacy worker ids, and no boot id at all", () => {
    const unavailableWorker = attempted("nexus@unavailable#aaaaaa");
    assert.equal(unavailableWorker.restart("222:9000").orphanAttemptsReset, 0);
    assert.equal(unavailableWorker.card().card, "attempted");
    const legacy = attempted("nexus-4242-abcdef");
    assert.equal(legacy.restart("222:9000").orphanAttemptsReset, 0);
    assert.equal(legacy.card().card, "attempted");
    const noBootId = attempted("nexus@111:5000#aaaaaa");
    assert.equal(noBootId.restart(null).orphanAttemptsReset, 0);
    assert.equal(noBootId.restart().orphanAttemptsReset, 0);
    assert.equal(noBootId.restart("unavailable").orphanAttemptsReset, 0);
    assert.equal(noBootId.card().card, "attempted");
  });

  it("a different boot id with the same pid is a different process (pid reuse)", () => {
    const { card, restart } = attempted("nexus@111:5000#aaaaaa");
    assert.equal(restart("111:7777").orphanAttemptsReset, 1);
    assert.equal(card().card, "not_attempted");
  });
});

describe("startup reconciliation (section 8.9.1 #3)", () => {
  it("returns what is still pending or unfinished, expires overdue decisions, infers nothing", () => {
    const f = fixture();
    const t = f.task();
    const a1 = f.booking(t, "A");
    const a2 = f.booking(t, "B");
    const d1 = f.created(f.decide(t, [a1]));
    const d2 = f.created(f.decide(t, [a2], { now: T0 + 1 }));
    const g = f.approved(f.resolve(d2.id));
    f.admit(g.executionId as string);
    const out = f.k.reconcileOnStart({
      principal: P,
      now: T0 + 25 * 3_600_000,
      outboxStaleMs: 120_000,
    });
    assert.deepEqual(
      out.expired.map((entry) => entry.id),
      [d1.id],
    );
    assert.equal(out.pendingDecisions.length, 0);
    assert.deepEqual(
      out.unfinishedExecutions.map((entry) => entry.id),
      [g.executionId],
    );
    assert.equal(
      f.row("SELECT state FROM action_executions WHERE id = ?", g.executionId as string).state,
      "executing",
    );
    assert.equal(
      f.count("SELECT COUNT(*) AS c FROM action_grants WHERE consumed_at IS NOT NULL"),
      1,
    );
  });
});

describe("read models", () => {
  it("lists ready executions only while the authority is live", () => {
    const f = fixture();
    const t = f.task();
    const g = f.approved(f.resolve(f.created(f.decide(t, [f.booking(t)])).id));
    const ready = f.k.listReadyExecutions({ principal: P, taskId: t, now: T0 + 5000 });
    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.executionId, g.executionId);
    assert.equal(
      f.k.listReadyExecutions({ principal: P, taskId: t, now: T0 + 40 * MIN }).length,
      0,
    );
    const detail = f.k.getDecision({ principal: P, decisionId: g.decision.id });
    assert.equal(detail?.executions.length, 1);
    assert.equal(detail?.actions.length, 1);
    assert.equal(f.k.listGrants({ principal: P, taskId: t, limit: 10 }).actionGrants.length, 1);
    assert.equal(f.k.listGrants({ principal: Q, limit: 10 }).actionGrants.length, 0);
  });
});
