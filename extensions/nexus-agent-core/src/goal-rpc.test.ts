// The console surface of Goals (nexus.goal.*): scopes, the creation click, the user-only transitions, refusals and the purge.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createGoalRpcHandlers } from "./goal-rpc.js";
import { createGoalService, type GoalChangeEvent, type GoalStore } from "./goal/goal-service.js";
import { applyMigrations } from "./store/kernel.js";
import { createNexusKernel } from "./store/nexus-kernel.js";
import type { Principal } from "./store/types.js";

const A: Principal = { ownerId: "owner-a" };

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
  ) as GoalStore;
  let clock = 30_000_000;
  const events: GoalChangeEvent[] = [];
  const service = createGoalService({
    getStore: async () => store,
    config: () => ({ maxActive: 2 }),
    now: () => (clock += 1000),
    onChanged: (event) => events.push(event),
  });
  let principal: Principal | undefined = A;
  const handlers = new Map<string, { run: (o: never) => unknown; scope: string }>();
  for (const [method, run, scope] of createGoalRpcHandlers({
    service,
    resolvePrincipal: () => principal,
  })) {
    handlers.set(method, { run: run as never, scope });
  }
  type Answer = {
    ok: boolean;
    payload?: Record<string, any>;
    error?: { code: string; message: string; details?: any };
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
  let seq = 0;
  /** What the page does: a session, the click, then (in the chat) the Agent saves the goal. */
  const makeGoal = async (title: string, category = "interests", parentId?: string) => {
    seq += 1;
    const sessionKey = `agent:main:dash-${seq}`;
    const started = await call("nexus.goal.startCreation", {
      category,
      sessionKey,
      ...(parentId ? { parentId } : {}),
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    const created = await service.create(A, { sessionKey, fields: { title } });
    assert.equal(created.outcome, "created");
    return (created as { goal: { id: string } }).goal.id;
  };
  return {
    call,
    handlers,
    service,
    events,
    makeGoal,
    setPrincipal: (p: Principal | undefined) => (principal = p),
  };
}

describe("nexus.goal.* rpc", () => {
  it("scopes: reads are read, edits and the creation click are write, purge alone is admin", () => {
    const { handlers } = setup();
    for (const m of ["list", "get", "purgeStatus", "purgeReceipts", "forFile"]) {
      assert.equal(handlers.get(`nexus.goal.${m}`)?.scope, "operator.read", m);
    }
    for (const m of [
      "startCreation",
      "update",
      "confirm",
      "complete",
      "reopen",
      "delete",
      "restore",
      "entry.add",
      "entry.retract",
      "link.add",
      "link.remove",
    ]) {
      assert.equal(handlers.get(`nexus.goal.${m}`)?.scope, "operator.write", m);
    }
    assert.equal(handlers.get("nexus.goal.purge")?.scope, "operator.admin");
    // there is no direct create: a goal is made in a chat, by the grant this click opens
    assert.equal(handlers.has("nexus.goal.create"), false);
  });

  it("answers nexus_no_principal when the owner cannot be resolved", async () => {
    const { call, setPrincipal } = setup();
    setPrincipal(undefined);
    assert.equal((await call("nexus.goal.list")).error?.code, "nexus_no_principal");
  });

  it("startCreation validates, issues a grant and enforces the cap at the click", async () => {
    const { call, makeGoal } = setup();
    assert.equal(
      (await call("nexus.goal.startCreation", { category: "health", sessionKey: "s" })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.goal.startCreation", { category: "finance" })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.goal.startCreation", { category: "finance", sessionKey: "bad key!" }))
        .error?.code,
      "nexus_invalid_params",
    );
    const ok = await call("nexus.goal.startCreation", {
      category: "finance",
      sessionKey: "agent:main:s1",
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.payload?.grant.category, "finance");
    await makeGoal("Learn the cello");
    await makeGoal("Run a half marathon");
    const full = await call("nexus.goal.startCreation", {
      category: "interests",
      sessionKey: "agent:main:s9",
    });
    assert.equal(full.error?.code, "nexus_limit_reached");
    assert.equal(full.error?.details.max, 2);
  });

  it("list and get return what the page needs; the user words and the first system entry are there", async () => {
    const { call, makeGoal } = setup();
    const id = await makeGoal("Learn the cello");
    const list = await call("nexus.goal.list", { status: "active" });
    assert.equal(list.payload?.total, 1);
    assert.equal(list.payload?.goals[0].title, "Learn the cello");
    const got = await call("nexus.goal.get", { goalId: id });
    assert.equal(got.payload?.goal.id, id);
    assert.equal(got.payload?.entries[0].kind, "system");
    assert.equal(
      (await call("nexus.goal.get", { goalId: "G-missing" })).error?.code,
      "nexus_not_found",
    );
    assert.equal(
      (await call("nexus.goal.list", { status: "weird" })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.goal.list", { limit: 1000 })).error?.code,
      "nexus_invalid_params",
    );
  });

  it("the user ticks, reopens, renames and notes; the rename keeps the user's words; numbers are refused", async () => {
    const { call, makeGoal, service, events } = setup();
    const id = await makeGoal("Learn the cello");
    const renamed = await call("nexus.goal.update", {
      goalId: id,
      patch: { title: "Play the cello" },
    });
    assert.equal(renamed.ok, true);
    assert.equal(renamed.payload?.goal.title, "Play the cello");
    assert.equal(
      (await call("nexus.goal.update", { goalId: id, patch: { summary: "id 11010519491231002X" } }))
        .error?.code,
      "nexus_sensitive_value",
    );
    assert.equal(
      (await call("nexus.goal.update", { goalId: id, patch: { category: "health" } })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.goal.complete", { goalId: id })).payload?.goal.status,
      "completed",
    );
    assert.equal((await call("nexus.goal.complete", { goalId: id })).payload?.changed, false);
    assert.equal(
      (await call("nexus.goal.entry.add", { goalId: id, text: "performed at home" })).ok,
      true,
    );
    assert.equal((await call("nexus.goal.reopen", { goalId: id })).payload?.goal.status, "active");
    assert.equal(
      (await call("nexus.goal.entry.add", { goalId: id, text: "x", kind: "system" })).error?.code,
      "nexus_invalid_params",
    );
    assert.ok(events.some((e) => e.action === "completed"));
    void service;
  });

  it("delete is soft, restore brings it back, a deleted goal refuses edits", async () => {
    const { call, makeGoal } = setup();
    const id = await makeGoal("Plan a vegetable garden", "something_else");
    assert.equal((await call("nexus.goal.delete", { goalId: id })).ok, true);
    assert.equal((await call("nexus.goal.list", { status: "active" })).payload?.total, 0);
    assert.equal((await call("nexus.goal.list", { lifecycle: "deleted" })).payload?.total, 1);
    assert.equal(
      (await call("nexus.goal.update", { goalId: id, patch: { title: "x" } })).error?.code,
      "nexus_conflict",
    );
    assert.equal((await call("nexus.goal.restore", { goalId: id })).ok, true);
    assert.equal((await call("nexus.goal.restore", { goalId: id })).error?.code, "nexus_conflict");
  });

  it("confirm: only a pending proposal can be approved, with edits, and the cap holds", async () => {
    const { call, service, makeGoal } = setup();
    const proposed = await service.propose(A, {
      category: "interests",
      fields: { title: "Read more novels" },
      questions: ["How many?"],
    });
    const id = (proposed as { goal: { id: string } }).goal.id;
    const approved = await call("nexus.goal.confirm", {
      goalId: id,
      edits: { title: "Read twelve novels" },
    });
    assert.equal(approved.ok, true);
    assert.equal(approved.payload?.goal.status, "active");
    assert.equal(approved.payload?.goal.title, "Read twelve novels");
    assert.equal((await call("nexus.goal.confirm", { goalId: id })).error?.code, "nexus_conflict");
    await makeGoal("Learn the cello");
    const extra = await service.propose(A, {
      category: "something_else",
      fields: { title: "Clear the attic" },
    });
    const full = await call("nexus.goal.confirm", {
      goalId: (extra as { goal: { id: string } }).goal.id,
    });
    assert.equal(full.error?.code, "nexus_limit_reached");
  });

  it("purge needs the id typed twice, removes goal and sub-goals and leaves a text-free receipt", async () => {
    const { call, makeGoal } = setup();
    const parent = await makeGoal("Become a better cook");
    const child = await makeGoal("Cook one new dish a week", "interests", parent);
    assert.equal(
      (await call("nexus.goal.purge", { goalId: parent })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.goal.purge", { goalId: parent, confirmGoalId: child })).error?.code,
      "nexus_invalid_params",
    );
    const out = await call("nexus.goal.purge", { goalId: parent, confirmGoalId: parent });
    assert.equal(out.ok, true);
    assert.equal(out.payload?.receipts.length, 2);
    assert.equal((await call("nexus.goal.get", { goalId: parent })).error?.code, "nexus_not_found");
    const receipts = await call("nexus.goal.purgeReceipts", {});
    assert.equal(receipts.payload?.receipts.length, 2);
    assert.ok(!JSON.stringify(receipts.payload).includes("cook"));
    assert.equal(
      (await call("nexus.goal.purge", { goalId: parent, confirmGoalId: parent })).error?.code,
      "nexus_not_found",
    );
  });
});
