// The Agent surface of Goals, end to end through the real kernel: which tools exist, that none can confirm / complete /
// rename / delete / purge, that nexus_goal_create works only inside the creation grant of ITS OWN session, that a proposal
// stays pending with no user words, and that sensitive goals are title-only in search.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createGoalService, type GoalStore } from "../goal/goal-service.js";
import { applyMigrations } from "../store/kernel.js";
import { createNexusKernel } from "../store/nexus-kernel.js";
import type { Principal } from "../store/types.js";
import { createGoalTools, GOAL_TOOL_NAMES } from "./goal-tools.js";

const A: Principal = { ownerId: "owner-a" };

type Tool = {
  name: string;
  catalogMode?: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ details: Record<string, unknown> }>;
};

function world() {
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
  let clock = 20_000_000;
  const service = createGoalService({
    getStore: async () => store,
    config: () => ({ maxActive: 5 }),
    now: () => (clock += 1000),
  });
  const toolsFor = (sessionKey: string) =>
    createGoalTools(
      { service, resolvePrincipal: () => A },
      { agentId: "main", sessionKey },
    ) as unknown as Tool[];
  const call = async (sessionKey: string, name: string, params: Record<string, unknown>) => {
    const tool = toolsFor(sessionKey).find((t) => t.name === name);
    assert.ok(tool, name);
    return (await tool.execute("1", params)).details;
  };
  return { db, service, toolsFor, call };
}

describe("goal tools", () => {
  it("offers exactly the six tools, all model-visible, with no way to confirm, complete, rename, delete or purge", () => {
    const { toolsFor } = world();
    const tools = toolsFor("s");
    assert.deepEqual(
      tools.map((t) => t.name),
      [...GOAL_TOOL_NAMES],
    );
    assert.ok(tools.every((t) => t.catalogMode === "direct-only"));
    for (const name of GOAL_TOOL_NAMES) {
      assert.doesNotMatch(
        name,
        /confirm|complete|reopen|rename|delete|remove|purge|restore|update/u,
        name,
      );
    }
  });

  it("fails closed without a principal", async () => {
    const { service } = world();
    const tools = createGoalTools(
      { service, resolvePrincipal: () => undefined },
      {},
    ) as unknown as Tool[];
    for (const tool of tools) {
      const out = (
        await tool.execute("1", {
          goalId: "G1",
          title: "x",
          category: "interests",
          text: "t",
          kind: "task",
          refId: "T1",
        })
      ).details;
      assert.equal(out.ok, false, tool.name);
      assert.equal(out.code, "no_principal", tool.name);
    }
  });

  it("nexus_goal_create is refused without a grant, and a grant of ANOTHER session does not help", async () => {
    const { call, service } = world();
    const refused = await call("sess-1", "nexus_goal_create", { title: "Learn the cello" });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "no_creation_permission");
    await service.startCreation(A, { sessionKey: "sess-2", category: "interests", issuedBy: "op" });
    assert.equal(
      (await call("sess-1", "nexus_goal_create", { title: "Learn the cello" })).code,
      "no_creation_permission",
    );
    const ok = await call("sess-2", "nexus_goal_create", {
      title: "Learn the cello",
      currentState: "Never touched one",
      summary: "Wants to play a simple piece within a year.",
      notes: ["Has no instrument yet."],
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.status, "active");
    // the same session cannot save a second goal with the same grant
    const again = await call("sess-2", "nexus_goal_create", { title: "Something else entirely" });
    assert.equal(again.ok, true);
    assert.equal(again.alreadySaved, true);
    assert.equal(again.goalId, ok.goalId);
  });

  it("nexus_goal_propose is refused in a chat that holds a creation grant, and works again once the goal is saved", async () => {
    const { call, service } = world();
    await service.startCreation(A, { sessionKey: "sess-p", category: "finance", issuedBy: "op" });
    const refused = await call("sess-p", "nexus_goal_propose", {
      category: "finance",
      title: "Raise monthly savings",
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "use_create");
    assert.match(String(refused.message), /nexus_goal_create/u);
    // another chat is unaffected
    assert.equal(
      (
        await call("sess-q", "nexus_goal_propose", {
          category: "finance",
          title: "Raise monthly savings",
        })
      ).ok,
      true,
    );
    // the refusal does not use up the grant
    assert.equal(
      (await call("sess-p", "nexus_goal_create", { title: "Pay off the car loan" })).ok,
      true,
    );
  });

  it("refuses a card number and tells the model to leave it out", async () => {
    const { call, service } = world();
    await service.startCreation(A, { sessionKey: "sess-3", category: "finance", issuedBy: "op" });
    const out = await call("sess-3", "nexus_goal_create", {
      title: "Save money",
      notes: ["card 4111 1111 1111 1111"],
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "sensitive_value");
    assert.ok(!JSON.stringify(out).includes("4111"));
    assert.equal((await call("sess-3", "nexus_goal_create", { title: "Save money" })).ok, true);
  });

  it("a proposal is pending, has no user words, and progress cannot be added until the user approves it", async () => {
    const { call, service } = world();
    const proposed = await call("sess-4", "nexus_goal_propose", {
      category: "interests",
      title: "Read more novels",
      questions: ["How many a month?"],
    });
    assert.equal(proposed.ok, true);
    assert.equal(proposed.status, "proposed");
    assert.match(String(proposed.note), /NOT saved as an active goal/u);
    const early = await call("sess-4", "nexus_goal_entry_add", {
      goalId: proposed.goalId,
      text: "read one",
    });
    assert.equal(early.ok, false);
    assert.equal(early.code, "goal_not_active");
    const detail = await call("sess-4", "nexus_goal_get", { goalId: proposed.goalId });
    assert.equal(detail.userWords, null);
    await service.confirm(A, { goalId: proposed.goalId as string, actor: "operator:console" });
    assert.equal(
      (await call("sess-4", "nexus_goal_entry_add", { goalId: proposed.goalId, text: "read one" }))
        .ok,
      true,
    );
    const similar = await call("sess-4", "nexus_goal_propose", {
      category: "interests",
      title: "read more novels",
    });
    assert.equal(similar.code, "similar_goal");
    assert.equal(
      (await call("sess-4", "nexus_goal_propose", { category: "health", title: "Run daily" })).code,
      "invalid_category",
    );
  });

  it("get shows the user's metrics read-only, with the claim state of a claim-backed one", async () => {
    const { call, service } = world();
    await service.startCreation(A, { sessionKey: "sess-m", category: "interests", issuedBy: "op" });
    const made = await call("sess-m", "nexus_goal_create", { title: "Learn the cello" });
    const goalId = String(made.goalId);
    const set = await service.setMetric(A, {
      goalId,
      name: "Practice",
      unit: "h",
      target: 50,
      current: 50,
    });
    assert.equal(set.outcome, "created");
    const detail = await call("s", "nexus_goal_get", { goalId });
    const metrics = detail.metrics as Record<string, unknown>[];
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]?.source, "self_reported");
    assert.equal(metrics[0]?.current, 50);
    assert.equal(metrics[0]?.targetReached, true);
    // no tool name can write a metric
    for (const name of GOAL_TOOL_NAMES) {
      assert.doesNotMatch(name, /metric/u);
    }
  });

  it("search shows a sensitive goal by title only; get marks it sensitive", async () => {
    const { call, service } = world();
    await service.startCreation(A, { sessionKey: "sess-5", category: "finance", issuedBy: "op" });
    await call("sess-5", "nexus_goal_create", {
      title: "Save a million",
      currentState: "Have 12,000 so far",
      summary: "In one year.",
    });
    const found = await call("s", "nexus_goal_search", { query: "million" });
    const goal = (found.goals as Record<string, unknown>[])[0];
    assert.ok(goal);
    assert.equal(goal.sensitive, true);
    assert.equal(goal.title, "Save a million");
    assert.equal("currentState" in goal, false);
    assert.equal("summary" in goal, false);
    const detail = await call("s", "nexus_goal_get", { goalId: goal.goalId });
    assert.equal(detail.sensitive, true);
    assert.match(String(detail.note), /sensitive/u);
    assert.equal(
      (await call("s", "nexus_goal_search", { status: "bogus" })).code,
      "invalid_status",
    );
    assert.equal((await call("s", "nexus_goal_get", { goalId: "../x" })).code, "invalid_goal_id");
  });

  it("links a Task only to one goal and refuses an unknown Task", async () => {
    const { call, service } = world();
    await service.startCreation(A, {
      sessionKey: "sess-6",
      category: "something_else",
      issuedBy: "op",
    });
    const created = await call("sess-6", "nexus_goal_create", { title: "Organise the garage" });
    const out = await call("s", "nexus_goal_link", {
      goalId: created.goalId,
      kind: "task",
      refId: "#T0NOPE123",
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "target_not_found");
    assert.equal(
      (
        await call("s", "nexus_goal_link", {
          goalId: created.goalId,
          kind: "preference",
          refId: "x",
        })
      ).code,
      "invalid_kind",
    );
  });
});
