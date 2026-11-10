// The gateway method for "who answers when the words named several people" (nexus.commitment.resolveJoint) and what create does with
// such words: the waiting mark, the refusal of "any one of them is enough", scope, validation, work_changed, owner isolation.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createCommitmentJointRpcHandlers } from "./commitment-joint-rpc.js";
import { createCommitmentRpcHandlers } from "./commitment-rpc.js";
import { createCounterpartRpcHandlers } from "./counterpart-rpc.js";
import { createEventBridge } from "./events.js";
import type { TaskStore } from "./store/host.js";
import { applyMigrations } from "./store/kernel.js";
import { createNexusKernel } from "./store/nexus-kernel.js";
import type { Principal } from "./store/types.js";
import { createWorkRpcHandlers } from "./work-rpc.js";

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
    ...createCommitmentJointRpcHandlers(deps),
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
  return { call, handlers, as, changed, db };
}

const person = async (call: ReturnType<typeof setup>["call"], name: string) =>
  (await call("nexus.counterpart.create", { displayName: name })).payload?.counterpart.id as string;
const work = async (call: ReturnType<typeof setup>["call"], title: string) =>
  (await call("nexus.work.create", { title })).payload?.workId as string;
const joint = async (call: ReturnType<typeof setup>["call"], name: string, workId?: string) => {
  const out = await call("nexus.commitment.create", {
    requirementText: "一起做报价",
    responsible: { kind: "name", name },
    ...(workId ? { workId } : {}),
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out.payload?.commitment as { id: string; ambiguity?: { names: string[] } };
};

describe("joint responsibility methods", () => {
  it("registers the choice as a write method", () => {
    const { handlers } = setup();
    assert.equal(handlers.get("nexus.commitment.resolveJoint")?.scope, "operator.write");
  });

  it("create keeps several names as typed and says it is waiting; 'any one is enough' is refused with the sentence", async () => {
    const { call } = setup();
    const c = await joint(call, "小王和小李一起");
    assert.deepEqual(c.ambiguity, { kind: "joint", names: ["小王", "小李"] });
    const got = await call("nexus.commitment.get", { commitmentId: c.id });
    assert.equal(got.payload?.commitment.ambiguity?.kind, "joint");
    const refused = await call("nexus.commitment.create", {
      requirementText: "交报价，任一人完成即可",
      responsible: { kind: "name", name: "小王" },
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.error?.code, "nexus_unsupported");
    assert.match(
      refused.error?.message ?? "",
      /请指定一位负责人，其他人可协助，或明确各自需要交付的部分/,
    );
    assert.match(refused.error?.message ?? "", /不会改成两个人都必须完成/);
  });

  it("form 'lead': one answers, the others help, the Work is told", async () => {
    const { call, changed } = setup();
    const wang = await person(call, "王总");
    const li = await person(call, "李明");
    const workId = await work(call, "报价项目");
    const c = await joint(call, "王总和李明一起", workId);
    changed.length = 0;
    const out = await call("nexus.commitment.resolveJoint", {
      commitmentId: c.id,
      choice: "lead",
      leadId: wang,
      helperIds: [li],
      helperRole: "approver",
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.payload?.outcome, "resolved");
    assert.equal(out.payload?.form, "lead");
    assert.equal(out.payload?.ownerId, "owner-a");
    assert.ok(
      changed.some((e) => e.workId === workId),
      "the Work page re-reads",
    );
    const got = await call("nexus.commitment.get", { commitmentId: c.id });
    assert.equal(got.payload?.commitment.responsibleCounterpartId, wang);
    assert.equal(got.payload?.commitment.ambiguity, undefined);
    assert.deepEqual(
      got.payload?.helpers.map((h: { role: string }) => h.role),
      ["approver"],
    );
  });

  it("form 'each': one commitment per person", async () => {
    const { call } = setup();
    const a = await person(call, "甲甲");
    const b = await person(call, "乙乙");
    const c = await joint(call, "甲甲和乙乙一起做");
    const out = await call("nexus.commitment.resolveJoint", {
      commitmentId: c.id,
      choice: "each",
      counterpartIds: [a, b],
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.payload?.commitments.length, 2);
    const list = await call("nexus.commitment.list", {});
    assert.equal(list.payload?.items.length, 2);
  });

  it("checks what it is given and says why a choice is refused", async () => {
    const { call, as } = setup();
    const a = await person(call, "甲二");
    const b = await person(call, "乙二");
    const c = await joint(call, "甲二和乙二一起");
    const bad = async (params: Record<string, unknown>) =>
      call("nexus.commitment.resolveJoint", { commitmentId: c.id, ...params });
    assert.equal((await bad({})).error?.code, "nexus_invalid_params");
    assert.equal((await bad({ choice: "lead" })).error?.code, "nexus_invalid_params");
    assert.equal(
      (await bad({ choice: "lead", leadId: a, helperRole: "boss" })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await bad({ choice: "each", counterpartIds: "x" })).error?.code,
      "nexus_invalid_params",
    );
    const one = await bad({ choice: "each", counterpartIds: [a] });
    assert.deepEqual(
      [one.error?.code, one.error?.message],
      ["nexus_invalid_params", "bad_people_count"],
    );
    const missing = await bad({ choice: "each", counterpartIds: [a, "cp_nobody"] });
    assert.equal(missing.error?.message, "counterpart_not_found");
    assert.equal(
      (
        await call("nexus.commitment.resolveJoint", {
          commitmentId: "cm_nobody",
          choice: "lead",
          leadId: a,
        })
      ).error?.code,
      "nexus_not_found",
    );
    // someone else's commitment is "not found"
    as({ ownerId: "owner-b" } as never);
    assert.equal((await bad({ choice: "lead", leadId: a })).error?.code, "nexus_not_found");
    as(A);
    const ok = await bad({ choice: "lead", leadId: a, helperIds: [b] });
    assert.equal(ok.ok, true);
    // chosen once, not again
    const again = await bad({ choice: "lead", leadId: b });
    assert.equal(again.error?.code, "nexus_commitment_state");
  });

  it("backfillJoint previews by default, marks old rows when told to, and tells the Works", async () => {
    const { call, handlers, changed, db } = setup();
    assert.equal(handlers.get("nexus.commitment.backfillJoint")?.scope, "operator.write");
    const workId = await work(call, "旧项目");
    const c = await joint(call, "小周和小吴一起", workId);
    db.prepare("UPDATE commitments SET ambiguity_json = NULL WHERE id = ?").run(c.id);
    changed.length = 0;
    const preview = await call("nexus.commitment.backfillJoint", {});
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.payload?.dryRun, true);
    assert.equal(preview.payload?.ownerId, "owner-a");
    assert.deepEqual(
      preview.payload?.marked.map((m: { id: string }) => m.id),
      [c.id],
    );
    assert.equal(changed.length, 0);
    assert.equal(
      (await call("nexus.commitment.get", { commitmentId: c.id })).payload?.commitment.ambiguity,
      undefined,
    );

    const done = await call("nexus.commitment.backfillJoint", { dryRun: false });
    assert.equal(done.payload?.dryRun, false);
    assert.deepEqual(done.payload?.workIds, [workId]);
    assert.equal(
      changed.some((e) => e.workId === workId),
      true,
    );
    assert.equal(
      (await call("nexus.commitment.get", { commitmentId: c.id })).payload?.commitment.ambiguity
        ?.kind,
      "joint",
    );
    assert.equal(
      (await call("nexus.commitment.backfillJoint", { dryRun: false })).payload?.marked.length,
      0,
    );
    assert.equal(
      (await call("nexus.commitment.backfillJoint", { dryRun: "no" })).error?.code,
      "nexus_invalid_params",
    );
  });
});
