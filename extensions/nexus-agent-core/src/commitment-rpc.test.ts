// The console surface of Commitments (nexus.commitment.*): scopes, validation, the user's own words stored as a user report,
// previews before a lifecycle change, owner isolation and the work_changed events the Work page listens to.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createCommitmentRpcHandlers } from "./commitment-rpc.js";
import { createEventBridge, type WorkChangedPayload } from "./events.js";
import type { TaskStore } from "./store/host.js";
import { applyMigrations } from "./store/kernel.js";
import { createNexusKernel } from "./store/nexus-kernel.js";
import type { Principal } from "./store/types.js";
import { createWorkRpcHandlers } from "./work-rpc.js";

const A: Principal = { ownerId: "owner-a" };
const B: Principal = { ownerId: "owner-b" };

function setup() {
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
  const kernel = createNexusKernel(db, tx);
  const store = new Proxy(
    {},
    {
      get: (_t, name: string) =>
        name === "then"
          ? undefined
          : async (input: unknown) => (Reflect.get(kernel, name) as (v: unknown) => unknown)(input),
    },
  ) as TaskStore;
  let clock = 60_000_000;
  const emitted: WorkChangedPayload[] = [];
  const events = createEventBridge();
  events.attach((_event, payload) => {
    emitted.push(payload as WorkChangedPayload);
  });
  let principal: Principal | undefined = A;
  const handlers = new Map<string, { run: (o: never) => unknown; scope: string }>();
  const deps = {
    getStore: async () => store,
    events,
    resolvePrincipal: () => principal,
    now: () => (clock += 1000),
  };
  for (const [method, run, scope] of [
    ...createCommitmentRpcHandlers(deps),
    ...createWorkRpcHandlers(deps),
  ]) {
    handlers.set(method, { run: run as never, scope });
  }
  type Answer = {
    ok: boolean;
    payload?: Record<string, any>;
    error?: { code: string; message: string };
  };
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<Answer> => {
    let answer: Answer | undefined;
    await handlers.get(method)!.run({
      params,
      respond: (ok: boolean, payload?: Record<string, any>, error?: any) => {
        answer = { ok, payload, error };
      },
    } as never);
    assert.ok(answer, `${method} did not respond`);
    return answer;
  };
  const work = async (title: string) => {
    const out = await call("nexus.work.create", { title });
    assert.equal(out.ok, true);
    return out.payload!.workId as string;
  };
  const commit = async (over: Record<string, unknown> = {}) => {
    const out = await call("nexus.commitment.create", {
      requirementText: "交周报",
      responsible: { kind: "name", name: "小王" },
      ...over,
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    return out.payload!.commitment as { id: string; revision: number };
  };
  return {
    call,
    handlers,
    emitted,
    work,
    commit,
    setPrincipal: (p: Principal | undefined) => (principal = p),
  };
}

describe("nexus.commitment.* rpc", () => {
  it("scopes: reads are read, every change is write", () => {
    const { handlers } = setup();
    for (const m of ["list", "get", "impact"]) {
      assert.equal(handlers.get(`nexus.commitment.${m}`)?.scope, "operator.read", m);
    }
    for (const m of [
      "create",
      "update",
      "communication",
      "acceptance",
      "resolve",
      "cancel",
      "restore",
      "reopen",
      "setRole",
      "generatePeriods",
    ]) {
      assert.equal(handlers.get(`nexus.commitment.${m}`)?.scope, "operator.write", m);
    }
  });

  it("creates one for a Work, lists it with the link role, and tells the Work page", async () => {
    const t = setup();
    const workId = await t.work("跟进周报");
    t.emitted.length = 0;
    const c = await t.commit({
      workId,
      due: { kind: "known", at: 1_800_000_000_000, tz: "Asia/Shanghai" },
    });
    assert.ok(t.emitted.some((e) => e.workId === workId && e.action === "commitment"));
    const list = await t.call("nexus.commitment.list", { workId });
    assert.equal(list.ok, true);
    assert.equal(list.payload!.total, 1);
    assert.equal(list.payload!.items[0].role, "required");
    assert.equal(list.payload!.items[0].commitment.id, c.id);
    assert.equal(list.payload!.items[0].commitment.dueState, "known");
    const got = await t.call("nexus.commitment.get", { commitmentId: c.id });
    assert.equal(got.ok, true);
    assert.equal(got.payload!.works[0].workId, workId);
    // the Work now waits on it
    const w = await t.call("nexus.work.get", { workId });
    assert.equal(w.payload!.state.primary, "blocked");
  });

  it("validates input", async () => {
    const t = setup();
    for (const params of [
      {},
      { requirementText: "x" },
      { requirementText: "x", responsible: { kind: "alien" } },
      {
        requirementText: "x",
        responsible: { kind: "self" },
        due: { kind: "known", at: "soon", tz: "UTC" },
      },
      { requirementText: "x", responsible: { kind: "self" }, workRole: "coordination" },
      { requirementText: "x", responsible: { kind: "self" }, contextMode: "nope" },
    ]) {
      const out = await t.call("nexus.commitment.create", params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.equal(out.error?.code, "nexus_invalid_params");
    }
    const bad = await t.call("nexus.commitment.create", {
      requirementText: "x",
      responsible: { kind: "self" },
      due: { kind: "known", at: 5, tz: "Not/AZone" },
    });
    assert.equal(bad.error?.code, "nexus_invalid_params");
    assert.equal((await t.call("nexus.commitment.list", { states: ["lost"] })).ok, false);
    assert.equal((await t.call("nexus.commitment.get", {})).ok, false);
    assert.equal(
      (await t.call("nexus.commitment.get", { commitmentId: "cm_none" })).error?.code,
      "nexus_not_found",
    );
  });

  it("a retried create with the same request id returns the same commitment", async () => {
    const t = setup();
    const a = await t.commit({ requestId: "dialog-1" });
    const b = await t.call("nexus.commitment.create", {
      requirementText: "交周报",
      responsible: { kind: "name", name: "小王" },
      requestId: "dialog-1",
    });
    assert.equal(b.payload!.outcome, "exists");
    assert.equal(b.payload!.commitment.id, a.id);
  });

  it("edit reports a version bump, honors revision checks, and refuses closed commitments", async () => {
    const t = setup();
    const c = await t.commit();
    const changed = await t.call("nexus.commitment.update", {
      commitmentId: c.id,
      changes: { responsible: { kind: "self" }, nextStep: "周五前问一下" },
      expectedRevision: c.revision,
      reason: "改由我来做",
    });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.equal(changed.payload!.versioned, true);
    assert.equal(changed.payload!.commitment.responsibleSelf, true);
    const stale = await t.call("nexus.commitment.update", {
      commitmentId: c.id,
      changes: { nextStep: "x" },
      expectedRevision: c.revision,
    });
    assert.equal(stale.error?.code, "nexus_revision_conflict");
    assert.equal(
      (await t.call("nexus.commitment.update", { commitmentId: c.id, changes: { nextStep: 5 } }))
        .error?.code,
      "nexus_invalid_params",
    );
    await t.call("nexus.commitment.cancel", { commitmentId: c.id, reason: "不做了" });
    const closed = await t.call("nexus.commitment.update", {
      commitmentId: c.id,
      changes: { nextStep: "x" },
    });
    assert.equal(closed.error?.code, "nexus_commitment_state");
  });

  it("communication and acceptance: the user's word is stored as a user report", async () => {
    const t = setup();
    const c = await t.commit();
    const told = await t.call("nexus.commitment.communication", {
      commitmentId: c.id,
      state: "submitted",
    });
    assert.equal(told.ok, true);
    assert.equal(told.payload!.commitment.lifecycle, "waiting");
    assert.equal(
      (await t.call("nexus.commitment.communication", { commitmentId: c.id, state: "draft" })).ok,
      false,
    );
    const noBasis = await t.call("nexus.commitment.acceptance", {
      commitmentId: c.id,
      state: "accepted",
    });
    assert.equal(noBasis.error?.code, "nexus_invalid_params");
    const yes = await t.call("nexus.commitment.acceptance", {
      commitmentId: c.id,
      state: "accepted",
      basis: "他在电话里说可以",
      basisKind: "counterpart_source",
    });
    assert.equal(yes.ok, true);
    assert.equal(
      yes.payload!.commitment.acceptanceBasisKind,
      "user_report",
      "the console cannot claim a source record",
    );
  });

  it("resolve and cancel preview first, then apply, and tell every citing Work", async () => {
    const t = setup();
    const w1 = await t.work("甲");
    const w2 = await t.work("乙");
    const c = await t.commit({ workId: w1 });
    await t.call("nexus.work.link", {
      workId: w2,
      role: "reference",
      targetKind: "commitment",
      targetId: c.id,
    });
    const preview = await t.call("nexus.commitment.resolve", {
      commitmentId: c.id,
      reason: "线下交了",
      dryRun: true,
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.payload!.outcome, "preview");
    assert.deepEqual(
      preview.payload!.impact.works.map((w: { workId: string }) => w.workId).toSorted(),
      [w1, w2].toSorted(),
    );
    assert.equal(
      (await t.call("nexus.commitment.get", { commitmentId: c.id })).payload!.commitment.lifecycle,
      "open",
    );
    assert.equal(
      (await t.call("nexus.commitment.resolve", { commitmentId: c.id, reason: "" })).error?.code,
      "nexus_invalid_params",
    );
    t.emitted.length = 0;
    const done = await t.call("nexus.commitment.resolve", {
      commitmentId: c.id,
      reason: "线下交了",
    });
    assert.equal(done.payload!.outcome, "resolved");
    assert.deepEqual(new Set(t.emitted.map((e) => e.workId)), new Set([w1, w2]));
    assert.equal(
      (await t.call("nexus.commitment.resolve", { commitmentId: c.id, reason: "again" })).error
        ?.code,
      "nexus_commitment_state",
    );
    // the Work that needed it is not done: it asks the person
    assert.equal(
      (await t.call("nexus.work.get", { workId: w1 })).payload!.state.primary,
      "needs_you",
    );
    assert.equal(
      (await t.call("nexus.commitment.reopen", { commitmentId: c.id, dryRun: true })).payload!
        .outcome,
      "preview",
    );
    assert.equal(
      (await t.call("nexus.commitment.reopen", { commitmentId: c.id })).payload!.outcome,
      "reopened",
    );
    assert.equal(
      (await t.call("nexus.commitment.cancel", { commitmentId: c.id, reason: "不要了" })).payload!
        .outcome,
      "cancelled",
    );
    assert.equal(
      (await t.call("nexus.commitment.restore", { commitmentId: c.id })).payload!.outcome,
      "restored",
    );
    assert.equal(
      (await t.call("nexus.commitment.restore", { commitmentId: c.id })).error?.code,
      "nexus_commitment_state",
    );
  });

  it("setRole needs an acknowledgement before a required commitment becomes a reference; unlink the same", async () => {
    const t = setup();
    const workId = await t.work("角色");
    const c = await t.commit({ workId });
    const first = await t.call("nexus.commitment.setRole", {
      commitmentId: c.id,
      workId,
      role: "reference",
    });
    assert.equal(first.error?.code, "nexus_gap_ack_required");
    const ok = await t.call("nexus.commitment.setRole", {
      commitmentId: c.id,
      workId,
      role: "reference",
      acknowledgeGap: true,
    });
    assert.equal(ok.payload!.outcome, "changed");
    const list = await t.call("nexus.commitment.list", { workId });
    assert.equal(list.payload!.items[0].role, "reference");
    const back = await t.call("nexus.commitment.setRole", {
      commitmentId: c.id,
      workId,
      role: "required",
    });
    assert.equal(back.payload!.outcome, "changed");
    const link = await t.call("nexus.commitment.list", { workId });
    const linkId = link.payload!.items[0].linkId as string;
    const unlink = await t.call("nexus.work.unlink", { workId, linkId });
    assert.equal(unlink.error?.code, "nexus_gap_ack_required");
    assert.equal(
      (await t.call("nexus.work.unlink", { workId, linkId, acknowledgeGap: true })).ok,
      true,
    );
  });

  it("generatePeriods answers the limit and is idempotent", async () => {
    const t = setup();
    const periods = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        key: `p${i + 1}`,
        index: i + 1,
        start: 1_000_000 * (i + 1),
        end: 1_000_000 * (i + 1) + 1000,
        tz: "UTC",
        dueAt: 1_000_000 * (i + 1) + 900,
      }));
    const base = {
      requestId: "weekly-1",
      requirementText: "交周报",
      responsible: { kind: "self" },
    };
    const many = await t.call("nexus.commitment.generatePeriods", {
      ...base,
      periods: periods(13),
    });
    assert.equal(many.error?.code, "nexus_invalid_params");
    assert.equal(many.error?.message, "too_many_periods");
    const ok = await t.call("nexus.commitment.generatePeriods", { ...base, periods: periods(4) });
    assert.equal(ok.payload!.created.length, 4);
    const again = await t.call("nexus.commitment.generatePeriods", {
      ...base,
      periods: periods(4),
    });
    assert.equal(again.payload!.created.length, 0);
    assert.equal(again.payload!.existing.length, 4);
  });

  it("is owner-scoped and fails closed without an owner", async () => {
    const t = setup();
    const c = await t.commit();
    t.setPrincipal(B);
    assert.equal(
      (await t.call("nexus.commitment.get", { commitmentId: c.id })).error?.code,
      "nexus_not_found",
    );
    assert.equal(
      (await t.call("nexus.commitment.cancel", { commitmentId: c.id, reason: "x" })).error?.code,
      "nexus_not_found",
    );
    assert.equal((await t.call("nexus.commitment.list", {})).payload!.total, 0);
    t.setPrincipal(undefined);
    assert.equal((await t.call("nexus.commitment.list", {})).error?.code, "nexus_no_principal");
  });
});
