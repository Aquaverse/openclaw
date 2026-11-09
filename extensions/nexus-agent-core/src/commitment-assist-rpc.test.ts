// The gateway methods of "the people who help with a Commitment" (nexus.commitment.assistAdd / assistRemove, and `helpers` /
// `participantCount` on the reads): scope, validation, the refusals, work_changed after a change, owner isolation.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createCommitmentAssistRpcHandlers } from "./commitment-assist-rpc.js";
import { createCommitmentRpcHandlers } from "./commitment-rpc.js";
import { createCounterpartRpcHandlers } from "./counterpart-rpc.js";
import { createEventBridge } from "./events.js";
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
  let clock = 80_000_000;
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
  };
  const handlers = new Map<string, { run: (o: never) => unknown; scope: string }>();
  for (const [method, run, scope] of [
    ...createCounterpartRpcHandlers(deps),
    ...createWorkRpcHandlers(deps),
    ...createCommitmentRpcHandlers(deps),
    ...createCommitmentAssistRpcHandlers(deps),
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
  const as = (p: Principal | undefined) => {
    principal = p;
  };
  return { call, handlers, as, changed };
}

const person = async (call: ReturnType<typeof setup>["call"], name: string) =>
  (await call("nexus.counterpart.create", { displayName: name })).payload?.counterpart.id as string;
const made = async (
  call: ReturnType<typeof setup>["call"],
  responsible: string,
  workId?: string,
) => {
  const out = await call("nexus.commitment.create", {
    requirementText: "周五前交报价表",
    responsible: { kind: "counterpart", counterpartId: responsible },
    ...(workId ? { workId } : {}),
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.payload?.commitment.id as string;
};

describe("commitment helper methods", () => {
  it("registers both as write methods", () => {
    const { handlers } = setup();
    assert.equal(handlers.get("nexus.commitment.assistAdd")?.scope, "operator.write");
    assert.equal(handlers.get("nexus.commitment.assistRemove")?.scope, "operator.write");
  });

  it("adds and removes a helper, and the reads show him", async () => {
    const { call } = setup();
    const wang = await person(call, "王总");
    const li = await person(call, "李明");
    const commitmentId = await made(call, wang);
    const added = await call("nexus.commitment.assistAdd", {
      commitmentId,
      counterpartId: li,
      role: "approver",
      purpose: "报价要他点头",
    });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(added.payload?.outcome, "added");
    assert.equal(added.payload?.helper.role, "approver");
    assert.equal(added.payload?.helper.purpose, "报价要他点头");
    const got = await call("nexus.commitment.get", { commitmentId });
    assert.deepEqual(
      got.payload?.helpers.map((h: { displayName: string; role: string }) => [
        h.displayName,
        h.role,
      ]),
      [["李明", "approver"]],
    );
    assert.equal(got.payload?.commitment.participantCount, 1);
    const list = await call("nexus.commitment.list", {});
    assert.equal(list.payload?.items[0]?.commitment.participantCount, 1);
    // adding him again with the same role says "exists" and adds nothing
    const again = await call("nexus.commitment.assistAdd", {
      commitmentId,
      counterpartId: li,
      role: "approver",
    });
    assert.equal(again.payload?.outcome, "exists");
    const removed = await call("nexus.commitment.assistRemove", {
      commitmentId,
      linkId: added.payload?.helper.id,
    });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(removed.payload?.outcome, "removed");
    const after = await call("nexus.commitment.get", { commitmentId });
    assert.equal(after.payload?.helpers.length, 0);
    assert.equal(after.payload?.commitment.participantCount, undefined);
    const gone = await call("nexus.commitment.assistRemove", {
      commitmentId,
      linkId: added.payload?.helper.id,
    });
    assert.equal(gone.ok, false);
    assert.equal(gone.error?.code, "nexus_not_found");
  });

  it("refuses the responsible person, bad input and a closed commitment, with codes the page can read", async () => {
    const { call } = setup();
    const wang = await person(call, "王总二");
    const li = await person(call, "李明二");
    const commitmentId = await made(call, wang);
    const bad = async (params: Record<string, unknown>) =>
      call("nexus.commitment.assistAdd", {
        commitmentId,
        counterpartId: li,
        role: "participant",
        ...params,
      });
    for (const params of [
      { commitmentId: "bad id" },
      { counterpartId: undefined },
      { role: "responsible" },
      { role: "assignee" },
      { role: undefined },
      { purpose: "x".repeat(201) },
      { purpose: 12 },
    ]) {
      const out = await bad(params);
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.equal(out.error?.code, "nexus_invalid_params", JSON.stringify(params));
    }
    const self = await bad({ counterpartId: wang });
    assert.equal(self.error?.code, "nexus_invalid_params");
    assert.equal(self.error?.message, "is_responsible");
    const missing = await bad({ counterpartId: "cp_nobody" });
    assert.equal(missing.error?.message, "counterpart_not_found");
    const nope = await bad({ commitmentId: "cm_nope" });
    assert.equal(nope.error?.code, "nexus_not_found");
    await call("nexus.commitment.cancel", { commitmentId, reason: "不做了" });
    const closed = await bad({});
    assert.equal(closed.error?.code, "nexus_commitment_state");
  });

  it("tells the Works that cite the commitment (work_changed) after a change", async () => {
    const { call, changed } = setup();
    const work = await call("nexus.work.create", { title: "华东报价" });
    const workId = work.payload?.workId as string;
    const wang = await person(call, "王总三");
    const li = await person(call, "李明三");
    const commitmentId = await made(call, wang, workId);
    changed.length = 0;
    const added = await call("nexus.commitment.assistAdd", {
      commitmentId,
      counterpartId: li,
      role: "recipient",
    });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.deepEqual(
      changed.map((c) => c.workId),
      [workId],
    );
    await call("nexus.commitment.assistRemove", { commitmentId, linkId: added.payload?.helper.id });
    assert.equal(changed.length, 2);
  });

  it("never reaches another owner's commitment", async () => {
    const { call, as } = setup();
    const wang = await person(call, "王总四");
    const commitmentId = await made(call, wang);
    as(B);
    const theirs = await person(call, "乙的人");
    const out = await call("nexus.commitment.assistAdd", {
      commitmentId,
      counterpartId: theirs,
      role: "participant",
    });
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, "nexus_not_found");
    as(A);
    const got = await call("nexus.commitment.get", { commitmentId });
    assert.equal(got.payload?.helpers.length, 0);
  });
});
