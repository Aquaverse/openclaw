// Follow-up plan and schedule gateway methods (design 10.2, W4a): scopes, parameter checks, the accept flow through the console,
// the host-capability degrade (new schedules blocked, never "active"), compare-and-set refusals, work_changed and owner isolation.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createCommitmentRpcHandlers } from "./commitment-rpc.js";
import { createCounterpartRpcHandlers } from "./counterpart-rpc.js";
import { createEventBridge } from "./events.js";
import { createScheduleRpcHandlers } from "./schedule-rpc.js";
import type { TaskStore } from "./store/host.js";
import { applyMigrations } from "./store/kernel.js";
import { createNexusKernel } from "./store/nexus-kernel.js";
import type { Principal } from "./store/types.js";
import { createWorkRpcHandlers } from "./work-rpc.js";

const A: Principal = { ownerId: "owner-a" };
const B: Principal = { ownerId: "owner-b" };

function setup(dispatchReady = false) {
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
  let clock = 90_000_000;
  let principal: Principal | undefined = A;
  const changed: Array<Record<string, unknown>> = [];
  const events = createEventBridge();
  events.attach((name: string, payload: unknown) => {
    if (name.endsWith("work_changed")) {
      changed.push(payload as Record<string, unknown>);
    }
  });
  const deps = {
    getStore: async () => store,
    events,
    resolvePrincipal: () => principal,
    now: () => (clock += 1000),
    dispatchReady: () => dispatchReady,
  };
  const handlers = new Map<string, { run: (o: never) => unknown; scope: string }>();
  for (const [method, run, scope] of [
    ...createCounterpartRpcHandlers(deps),
    ...createWorkRpcHandlers(deps),
    ...createCommitmentRpcHandlers(deps),
    ...createScheduleRpcHandlers(deps),
  ]) {
    handlers.set(method, { run: run as never, scope });
  }
  type Answer = {
    ok: boolean;
    payload?: Record<string, any>;
    error?: { code: string; message: string } | undefined;
  };
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<Answer> => {
    let answer: Answer | undefined;
    const respond = (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => {
      answer = { ok, payload: payload as Record<string, any>, error };
    };
    const handler = handlers.get(method);
    assert.ok(handler, `${method} is not registered`);
    await (handler.run as (o: unknown) => Promise<void>)({ params, respond });
    assert.ok(answer, `${method} did not answer`);
    return answer;
  };
  return { call, handlers, as: (p: Principal | undefined) => (principal = p), changed, db, kernel };
}

const kit = (s: ReturnType<typeof setup>) => ({
  work: async () =>
    (await s.call("nexus.work.create", { title: "跟进工作" })).payload?.workId as string,
  commitment: async (workId?: string) => {
    const out = await s.call("nexus.commitment.create", {
      requirementText: "提交报告",
      responsible: { kind: "name", name: "小王" },
      ...(workId ? { workId } : {}),
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    return out.payload?.commitment.id as string;
  },
});
const plan = {
  schedules: [
    {
      scheduleKind: "recurring",
      purpose: "看对方回复",
      cadence: { kind: "daily", times: ["09:00"] },
      tz: "Asia/Shanghai",
    },
  ],
  wontDo: ["不自动催办"],
};

describe("schedule methods: registration", () => {
  it("reads are operator.read and writes are operator.write", () => {
    const { handlers } = setup();
    for (const m of [
      "nexus.delegation.get",
      "nexus.delegation.list",
      "nexus.delegation.carrier",
      "nexus.schedule.get",
      "nexus.schedule.list",
      "nexus.goal.briefing.get",
    ]) {
      assert.equal(handlers.get(m)?.scope, "operator.read", m);
    }
    for (const m of [
      "nexus.delegation.create",
      "nexus.delegation.update",
      "nexus.delegation.confirm",
      "nexus.delegation.revoke",
      "nexus.delegation.end",
      "nexus.schedule.pause",
      "nexus.schedule.resume",
      "nexus.schedule.cancel",
      "nexus.schedule.unblock",
      "nexus.goal.briefing.set",
    ]) {
      assert.equal(handlers.get(m)?.scope, "operator.write", m);
    }
  });
  it("has no method that records a trigger or blocks a schedule: those are the host's, not the console's", () => {
    const { handlers } = setup();
    for (const m of handlers.keys()) {
      assert.ok(!/trigger|\.block$|syncHost|releaseSlot|reconcile/.test(m), m);
    }
  });
});

describe("schedule methods: the accept flow", () => {
  it("creates a draft, accepts it, and with no dispatcher saves the schedule blocked", async () => {
    const s = setup(false);
    const k = kit(s);
    const workId = await k.work();
    const c = await k.commitment();
    const created = await s.call("nexus.delegation.create", {
      workId,
      planOwnerType: "commitment",
      planOwnerId: c,
      purpose: "跟进小王",
      plan,
      requestRef: "ui-1",
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const planId = created.payload?.plan.id as string;
    assert.equal(created.payload?.plan.status, "draft");
    assert.equal(
      (await s.call("nexus.schedule.list", { planId })).payload?.schedules.length,
      0,
      "a draft is not a schedule",
    );

    const done = await s.call("nexus.delegation.confirm", { planId, expectedPlanVersion: 1 });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.payload?.outcome, "accepted");
    assert.equal(done.payload?.dispatchReady, false);
    const sc = done.payload?.schedules[0];
    assert.equal(sc.status, "blocked");
    assert.deepEqual(sc.blockReasons, [
      { code: "prerequisite_missing", ref: "host_capability:scheduled_dispatch", actor: "system" },
    ]);
    assert.ok(s.changed.some((e) => e.workId === workId && e.action === "plan_accepted"));

    const again = await s.call("nexus.delegation.confirm", { planId, expectedPlanVersion: 1 });
    assert.equal(again.payload?.outcome, "already_accepted");
    const carrier = await s.call("nexus.delegation.carrier", { commitmentId: c });
    assert.equal(carrier.payload?.carrier.kind, "active");
    assert.equal(carrier.payload?.carrier.workId, workId);
  });

  it("with a dispatcher the schedule is active", async () => {
    const s = setup(true);
    const k = kit(s);
    const workId = await k.work();
    const c = await k.commitment();
    const planId = (
      await s.call("nexus.delegation.create", {
        workId,
        planOwnerType: "commitment",
        planOwnerId: c,
        purpose: "跟进",
        plan,
      })
    ).payload?.plan.id as string;
    const done = await s.call("nexus.delegation.confirm", { planId, expectedPlanVersion: 1 });
    assert.equal(done.payload?.schedules[0].status, "active");
    const id = done.payload?.schedules[0].id as string;
    assert.equal(
      (await s.call("nexus.schedule.pause", { scheduleId: id })).payload?.outcome,
      "paused",
    );
    const resumed = await s.call("nexus.schedule.resume", { scheduleId: id });
    assert.equal(resumed.payload?.outcome, "resumed");
    assert.equal(
      (await s.call("nexus.schedule.get", { scheduleId: id, triggers: 5 })).payload?.schedule
        .status,
      "active",
    );
    const cancelled = await s.call("nexus.schedule.cancel", { scheduleId: id, reason: "不需要了" });
    assert.equal(cancelled.payload?.schedule.status, "cancelled");
    const stale = await s.call("nexus.schedule.resume", { scheduleId: id });
    assert.equal(stale.error?.code, "nexus_schedule_state");
  });

  it("answers refusals with the right codes", async () => {
    const s = setup(true);
    const k = kit(s);
    const workId = await k.work();
    const c = await k.commitment();
    const base = { workId, planOwnerType: "commitment", planOwnerId: c, purpose: "跟进", plan };
    const planId = (await s.call("nexus.delegation.create", base)).payload?.plan.id as string;
    assert.equal(
      (await s.call("nexus.delegation.confirm", { planId, expectedPlanVersion: 4 })).error?.code,
      "nexus_revision_conflict",
    );
    assert.equal(
      (await s.call("nexus.delegation.confirm", { planId: "dp_nope", expectedPlanVersion: 1 }))
        .error?.code,
      "nexus_not_found",
    );
    assert.equal(
      (await s.call("nexus.delegation.confirm", { planId })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (
        await s.call("nexus.delegation.confirm", {
          planId,
          expectedPlanVersion: 1,
          replaces: { planId: "x" },
        })
      ).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await s.call("nexus.delegation.create", { ...base, purpose: 5 })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await s.call("nexus.delegation.create", { ...base, planOwnerType: "team" })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await s.call("nexus.delegation.create", { ...base, plan: [] })).error?.code,
      "nexus_invalid_params",
    );
    const slow = {
      ...plan,
      schedules: [{ ...plan.schedules[0]!, cadence: { kind: "interval", minutes: 5 } }],
    };
    const refusedFloor = await s.call("nexus.delegation.create", { ...base, plan: slow });
    assert.equal(refusedFloor.error?.code, "nexus_invalid_params");
    assert.equal(refusedFloor.error?.message, "below_minimum");
    assert.equal(
      (await s.call("nexus.delegation.confirm", { planId, expectedPlanVersion: 1 })).ok,
      true,
    );
    const second = (await s.call("nexus.delegation.create", base)).payload?.plan.id as string;
    const exists = await s.call("nexus.delegation.confirm", {
      planId: second,
      expectedPlanVersion: 1,
    });
    assert.equal(exists.error?.code, "nexus_schedule_state");
    const stale = await s.call("nexus.delegation.confirm", {
      planId: second,
      expectedPlanVersion: 1,
      replaces: { planId, planVersion: 8 },
    });
    assert.equal(stale.error?.code, "nexus_revision_conflict");
    assert.equal(
      (
        await s.call("nexus.delegation.update", {
          planId: second,
          expectedPlanVersion: 1,
          changes: { purpose: "x" },
        })
      ).payload?.outcome,
      "updated",
    );
    assert.equal(
      (
        await s.call("nexus.delegation.update", {
          planId: second,
          expectedPlanVersion: 1,
          changes: { purpose: "y" },
        })
      ).error?.code,
      "nexus_revision_conflict",
    );
    assert.equal(
      (await s.call("nexus.delegation.update", { planId: second, expectedPlanVersion: 2 })).error
        ?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await s.call("nexus.delegation.revoke", { planId: second })).payload?.outcome,
      "revoked",
    );
    assert.equal((await s.call("nexus.delegation.end", { planId })).payload?.outcome, "ended");
    assert.equal(
      (await s.call("nexus.schedule.pause", { scheduleId: 7 })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await s.call("nexus.schedule.list", { statuses: ["x"] })).error?.code,
      "nexus_invalid_params",
    );
  });

  it("says what is missing when a schedule cannot resume", async () => {
    const s = setup(true);
    const k = kit(s);
    const workId = await k.work();
    const c = await k.commitment();
    const planId = (
      await s.call("nexus.delegation.create", {
        workId,
        planOwnerType: "commitment",
        planOwnerId: c,
        purpose: "跟进",
        plan,
      })
    ).payload?.plan.id as string;
    const id = (await s.call("nexus.delegation.confirm", { planId, expectedPlanVersion: 1 }))
      .payload?.schedules[0].id as string;
    await s.call("nexus.schedule.pause", { scheduleId: id });
    await s.call("nexus.commitment.cancel", { commitmentId: c, reason: "不做了" });
    const out = await s.call("nexus.schedule.resume", { scheduleId: id });
    assert.equal(out.ok, true);
    assert.equal(out.payload?.outcome, "gaps");
    assert.deepEqual(
      out.payload?.gaps.map((g: { code: string }) => g.code),
      ["owner_closed"],
    );
  });
});

describe("schedule methods: owners and the goal letter", () => {
  it("another owner sees nothing and changes nothing; no principal is refused", async () => {
    const s = setup(true);
    const k = kit(s);
    const workId = await k.work();
    const c = await k.commitment();
    const planId = (
      await s.call("nexus.delegation.create", {
        workId,
        planOwnerType: "commitment",
        planOwnerId: c,
        purpose: "跟进",
        plan,
      })
    ).payload?.plan.id as string;
    const id = (await s.call("nexus.delegation.confirm", { planId, expectedPlanVersion: 1 }))
      .payload?.schedules[0].id as string;
    s.as(B);
    assert.equal((await s.call("nexus.delegation.get", { planId })).error?.code, "nexus_not_found");
    assert.equal(
      (await s.call("nexus.schedule.get", { scheduleId: id })).error?.code,
      "nexus_not_found",
    );
    assert.equal(
      (await s.call("nexus.schedule.cancel", { scheduleId: id })).error?.code,
      "nexus_not_found",
    );
    assert.equal((await s.call("nexus.delegation.list")).payload?.plans.length, 0);
    assert.equal(
      (await s.call("nexus.delegation.carrier", { commitmentId: c })).error?.code,
      "nexus_not_found",
    );
    s.as(undefined);
    assert.equal((await s.call("nexus.schedule.list")).error?.code, "nexus_no_principal");
  });

  it("reads and sets the goal letter policy", async () => {
    const s = setup(true);
    const issued = s.kernel.goalGrantIssue({
      principal: A,
      sessionKey: "agent:main:s1",
      category: "interests",
      issuedBy: "operator",
      maxActive: 20,
      ttlMs: 60_000,
      now: 1_000,
    });
    assert.equal(issued.outcome, "issued");
    const made = s.kernel.goalCreate({
      principal: A,
      sessionKey: "agent:main:s1",
      fields: { title: "读书", currentState: "start" },
      sensitivity: "normal",
      idempotencyKey: "k1",
      maxActive: 20,
      now: 2_000,
    });
    const goalId = (made as { goal: { id: string } }).goal.id;
    const first = await s.call("nexus.goal.briefing.get", { goalId });
    assert.equal(first.payload?.policy.enabled, false);
    assert.equal(
      (await s.call("nexus.goal.briefing.set", { goalId, enabled: true })).error?.code,
      "nexus_invalid_params",
    );
    const saved = await s.call("nexus.goal.briefing.set", {
      goalId,
      enabled: true,
      cadence: { kind: "weekly", weekday: 0 },
      expectedVersion: 0,
    });
    assert.equal(saved.payload?.policy.version, 1);
    assert.equal(
      (await s.call("nexus.goal.briefing.set", { goalId, enabled: false, expectedVersion: 0 }))
        .error?.code,
      "nexus_revision_conflict",
    );
    assert.equal(
      (await s.call("nexus.goal.briefing.get", { goalId: "g_nope" })).error?.code,
      "nexus_not_found",
    );
    assert.equal(
      (await s.call("nexus.goal.briefing.set", { goalId })).error?.code,
      "nexus_invalid_params",
    );
  });
});
