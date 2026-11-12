// The follow-up plan tools on a real kernel: the Agent can only DRAFT a plan and read what exists; it cannot accept one, and a draft
// starts nothing.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { dispatchKit } from "../test-support/dispatch-kit.js";
import { SCHEDULE_PLAN_TOOL_NAMES, createSchedulePlanTools } from "./schedule-plan-tools.js";

type Result = Record<string, any> & { ok: boolean; code?: string };

function setup() {
  const w = dispatchKit();
  const proposed: string[] = [];
  const tools = (principal: typeof w.A | null = w.A) =>
    createSchedulePlanTools(
      {
        getStore: async () => w.store,
        resolvePrincipal: () => principal ?? undefined,
        now: w.now,
        onProposed: (id) => proposed.push(id),
      },
      { sessionKey: "agent:main:main", agentId: "main" },
    );
  const call = async (name: string, params: Record<string, unknown>, principal = w.A) => {
    const tool = tools(principal).find((t) => t.name === name);
    assert.ok(tool, name);
    return ((await tool.execute("c1", params as never)) as { details: Result }).details;
  };
  return { w, call, proposed, tools };
}

const daily = (extra: Record<string, unknown> = {}) => ({
  kind: "recurring",
  purpose: "看对方有没有回复",
  cadence: { kind: "interval", minutes: 60 },
  tz: "Asia/Shanghai",
  ...extra,
});

describe("schedule plan tools", () => {
  it("exposes exactly the two tools, and none of them can accept a plan", () => {
    const { tools } = setup();
    assert.deepEqual(
      tools().map((t) => t.name),
      [...SCHEDULE_PLAN_TOOL_NAMES],
    );
  });

  it("drafts a plan for a Commitment: a draft only, no schedule, console told", async () => {
    const { w, call, proposed } = setup();
    const wk = w.workWithTask();
    const c = w.commitment();
    const out = await call("nexus_schedule_propose", {
      workId: wk.workId,
      commitmentId: c,
      purpose: "跟进小王的报告",
      schedules: [daily()],
      sources: ["https://example.com/status"],
      limits: ["只读"],
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.status, "draft");
    assert.match(out.message, /DRAFT/u);
    assert.deepEqual(proposed, [wk.workId]);
    const rows = w.db
      .prepare("SELECT status, created_by, plan_owner_type, start_intent FROM delegation_plans")
      .all()
      .map((r) => Object.assign({}, r));
    assert.deepEqual(rows, [
      { status: "draft", created_by: "agent", plan_owner_type: "commitment", start_intent: "none" },
    ]);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM schedules"), 0);
  });

  it("drafts a plan that follows the Work itself", async () => {
    const { w, call } = setup();
    const wk = w.workWithTask();
    const out = await call("nexus_schedule_propose", {
      workId: wk.workId,
      purpose: "盯一下进度",
      schedules: [daily()],
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const row = {
      ...w.db.prepare("SELECT plan_owner_type, plan_owner_id FROM delegation_plans").get(),
    };
    assert.deepEqual(row, { plan_owner_type: "work", plan_owner_id: wk.workId });
  });

  it("the same call twice answers with the draft it made, not a second one", async () => {
    const { w, call, proposed } = setup();
    const wk = w.workWithTask();
    const args = { workId: wk.workId, purpose: "盯一下", schedules: [daily()] };
    const a = await call("nexus_schedule_propose", args);
    const b = await call("nexus_schedule_propose", args);
    assert.equal(b.planId, a.planId);
    assert.equal(b.alreadyDrafted, true);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM delegation_plans"), 1);
    assert.equal(proposed.length, 1);
  });

  it("refuses bad input and unknown or closed owners, changing nothing", async () => {
    const { w, call } = setup();
    const wk = w.workWithTask();
    const base = { workId: wk.workId, purpose: "盯一下", schedules: [daily()] };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, schedules: [daily({ cadence: { kind: "hourly" } })] }, "bad_cadence"],
      [{ ...base, schedules: [daily({ tz: "Mars/Base" })] }, "bad_timezone"],
      [
        { ...base, schedules: [daily({ cadence: { kind: "interval", minutes: 1 } })] },
        "below_minimum",
      ],
      [{ ...base, purpose: "  " }, "bad_purpose"],
      [{ ...base, workId: "nope" }, "work_not_found"],
      [{ ...base, commitmentId: "nope" }, "owner_missing"],
      [{ ...base, schedules: [{ kind: "weekly" }] }, "invalid_schedule"],
      [{ ...base, workId: "bad id!" }, "invalid_params"],
    ];
    for (const [params, code] of cases) {
      const out = await call("nexus_schedule_propose", params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.equal(out.code, code, JSON.stringify(out));
    }
    const closed = w.commitment();
    w.db
      .prepare("UPDATE commitments SET lifecycle='cancelled', cancelled_at=1 WHERE id=?")
      .run(closed);
    const out = await call("nexus_schedule_propose", { ...base, commitmentId: closed });
    assert.equal(out.code, "owner_closed");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM delegation_plans"), 0);
  });

  it("another owner's Work or Commitment is not found", async () => {
    const { w, call } = setup();
    const wk = w.workWithTask();
    const out = await call(
      "nexus_schedule_propose",
      { workId: wk.workId, purpose: "x", schedules: [daily()] },
      { ownerId: "someone-else" } as never,
    );
    assert.equal(out.code, "work_not_found");
  });

  it("does nothing without a principal", async () => {
    const { tools } = setup();
    const tool = tools(null).find((t) => t.name === "nexus_schedule_propose")!;
    const out = ((await tool.execute("c", { workId: "w" } as never)) as { details: Result })
      .details;
    assert.equal(out.code, "no_principal");
  });

  it("get: reports drafts, accepted plans with schedules and recent checks, and an empty answer", async () => {
    const { w, call } = setup();
    const empty = w.workWithTask();
    const none = await call("nexus_schedule_get", { workId: empty.workId });
    assert.equal(none.ok, true);
    assert.deepEqual(none.plans, []);
    assert.match(none.note, /No follow-up plan/u);

    const f = w.follow();
    await w.dispatcher.tick();
    const got = await call("nexus_schedule_get", { workId: f.workId });
    assert.equal(got.plans.length, 1);
    assert.equal(got.plans[0].status, "accepted");
    assert.equal(got.schedules.length, 1);
    assert.equal(got.schedules[0].scheduleId, f.scheduleId);
    assert.equal(got.schedules[0].recentChecks.length, 1);

    const byCommitment = await call("nexus_schedule_get", { commitmentId: f.commitmentId });
    assert.equal(byCommitment.plans[0].planId, f.planId);
    const byPlan = await call("nexus_schedule_get", { planId: f.planId });
    assert.equal(byPlan.schedules.length, 1);

    const draft = await call("nexus_schedule_propose", {
      workId: empty.workId,
      purpose: "盯一下",
      schedules: [daily()],
    });
    const seen = await call("nexus_schedule_get", { workId: empty.workId });
    assert.equal(seen.plans[0].planId, draft.planId);
    assert.equal(seen.plans[0].status, "draft");
    assert.deepEqual(seen.schedules, []);
    assert.match(seen.note, /draft is waiting/u);
  });

  it("get: needs an id, and sees nothing of another owner", async () => {
    const { w, call } = setup();
    assert.equal((await call("nexus_schedule_get", {})).code, "invalid_params");
    const f = w.follow();
    const other = await call("nexus_schedule_get", { planId: f.planId }, { ownerId: "x" } as never);
    assert.deepEqual(other.plans, []);
    assert.deepEqual(other.schedules, []);
  });
});
