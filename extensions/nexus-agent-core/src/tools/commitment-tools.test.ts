// Commitment tools against the real kernel on in-memory SQLite: what the Agent can record and read, and what it cannot touch.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createEventBridge, type WorkChangedPayload } from "../events.js";
import type { TaskStore } from "../store/host.js";
import { applyMigrations } from "../store/kernel.js";
import { createNexusKernel } from "../store/nexus-kernel.js";
import type { Principal } from "../store/types.js";
import { COMMITMENT_TOOL_NAMES, createCommitmentTools } from "./commitment-tools.js";

type Result = Record<string, any> & { ok: boolean; code?: string };

describe("commitment tools", () => {
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
  const store = Object.fromEntries(
    Object.entries(kernel).map(([name, fn]) => [
      name,
      async (input: unknown) => (fn as (v: unknown) => unknown)(input),
    ]),
  ) as unknown as TaskStore;
  const clock = Date.UTC(2026, 9, 10, 8, 0, 0);
  const emitted: WorkChangedPayload[] = [];
  const events = createEventBridge();
  events.attach((_e, payload) => {
    emitted.push(payload as WorkChangedPayload);
  });
  const owner: Principal = { ownerId: "local" };
  const tools = (principal: Principal | null = owner) =>
    createCommitmentTools(
      {
        getStore: async () => store,
        events,
        resolvePrincipal: () => principal ?? undefined,
        now: () => clock,
      },
      { sessionKey: "agent:main:main", agentId: "main" },
    );
  const call = async (
    name: string,
    params: Record<string, unknown>,
    principal: Principal | null = owner,
  ): Promise<Result> => {
    const tool = tools(principal).find((t) => t.name === name);
    assert.ok(tool, name);
    return ((await tool.execute("c1", params as never)) as { details: Result }).details;
  };
  const record = (over: Record<string, unknown> = {}) =>
    call("nexus_commitment_record", {
      requirementText: "把报价单发给我",
      userStatementRef: "小王说周五前把报价单发我",
      responsibleName: "小王",
      ...over,
    });

  it("exposes exactly the declared tools, and no way to accept, resolve or cancel", () => {
    assert.deepEqual(
      tools().map((t) => t.name),
      [...COMMITMENT_TOOL_NAMES],
    );
    assert.equal(
      tools().some((t) => /resolve|cancel|accept|restore|reopen/.test(t.name)),
      false,
    );
  });

  it("records what the user said, as an open commitment the Agent cannot change", async () => {
    const out = await record();
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.recorded, true);
    assert.equal(out.lifecycle, "open");
    assert.equal(out.responsible, "小王");
    assert.equal(out.responsibleResolved, false);
    assert.equal(out.createdBy, "agent");
    assert.equal(out.acceptance, "unknown");
    const row = db
      .prepare("SELECT origin_kind, origin_ref_id FROM commitments WHERE id = ?")
      .get(out.commitmentId) as { origin_kind: string; origin_ref_id: string };
    assert.equal(row.origin_kind, "native_record");
    assert.equal(row.origin_ref_id, "小王说周五前把报价单发我");
  });

  it("a retried record returns the same commitment", async () => {
    const first = await record({ requirementText: "重复测试", userStatementRef: "重复的话" });
    const second = await record({ requirementText: "重复测试", userStatementRef: "重复的话" });
    assert.equal(second.alreadyRecorded, true);
    assert.equal(second.recorded, false);
    assert.equal(second.commitmentId, first.commitmentId);
  });

  it("refuses a record without the user's words or without exactly one responsible", async () => {
    assert.equal((await record({ userStatementRef: "" })).code, "invalid_params");
    assert.equal((await record({ responsibleName: undefined })).code, "responsible_required");
    assert.equal((await record({ responsibleSelf: true })).code, "responsible_required");
    assert.equal(
      (
        await record({
          responsibleName: undefined,
          responsibleSelf: true,
          requirementText: "我自己做",
        })
      ).ok,
      true,
    );
  });

  it("takes a due date only as ISO with an offset plus a real time zone", async () => {
    assert.equal(
      (await record({ requirementText: "d1", dueAt: "2026-10-16", timezone: "Asia/Shanghai" }))
        .code,
      "invalid_due",
    );
    assert.equal(
      (await record({ requirementText: "d2", dueAt: "2026-10-16T18:00:00+08:00" })).code,
      "invalid_due",
    );
    assert.equal(
      (
        await record({
          requirementText: "d3",
          dueAt: "2026-10-16T18:00:00+08:00",
          timezone: "Not/AZone",
        })
      ).code,
      "invalid",
    );
    const ok = await record({
      requirementText: "d4",
      dueAt: "2026-10-16T18:00:00+08:00",
      timezone: "Asia/Shanghai",
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.dueState, "known");
    assert.equal(ok.dueAt, Date.parse("2026-10-16T10:00:00Z"));
  });

  it("cannot name a person who is not known, and a Work reference stays a reference", async () => {
    assert.equal(
      (
        await record({
          requirementText: "c1",
          responsibleName: undefined,
          counterpartId: "cp_nobody",
        })
      ).code,
      "invalid",
    );
    const created = kernel.workCreate({
      principal: owner,
      spec: { title: "报价", origin: "user" },
      now: clock,
    });
    assert.equal(created.outcome, "created");
    const workId = (created as { workId: string }).workId;
    emitted.length = 0;
    const out = await record({ requirementText: "引用到工作", workId });
    assert.equal(out.ok, true);
    assert.ok(emitted.some((e) => e.workId === workId));
    const link = db
      .prepare("SELECT role FROM work_links WHERE work_id = ? AND target_id = ?")
      .get(workId, out.commitmentId) as { role: string };
    assert.equal(link.role, "reference");
    assert.equal((await record({ requirementText: "x", workId: "bad" })).code, "invalid_work_id");
    assert.equal(
      (await record({ requirementText: "x", workId: "w_missing1" })).code,
      "work_not_found",
    );
  });

  it("get and search read the ledger and stay owner-scoped", async () => {
    const made = await record({ requirementText: "搜索我", userStatementRef: "搜索的话" });
    const got = await call("nexus_commitment_get", { commitmentId: made.commitmentId });
    assert.equal(got.ok, true);
    assert.equal(got.requirement, "搜索我");
    assert.equal(
      (await call("nexus_commitment_get", { commitmentId: "nope" })).code,
      "invalid_commitment_id",
    );
    assert.equal(
      (await call("nexus_commitment_get", { commitmentId: "cm_missing1" })).code,
      "not_found",
    );
    const found = await call("nexus_commitment_search", { keyword: "搜索我" });
    assert.equal(found.total, 1);
    assert.equal(found.commitments[0].commitmentId, made.commitmentId);
    const other: Principal = { ownerId: "someone-else" };
    assert.equal(
      (await call("nexus_commitment_get", { commitmentId: made.commitmentId }, other)).code,
      "not_found",
    );
    assert.equal((await call("nexus_commitment_search", { keyword: "搜索我" }, other)).total, 0);
    assert.equal(
      (await call("nexus_commitment_get", { commitmentId: made.commitmentId }, null)).code,
      "no_principal",
    );
  });

  it("the Agent's view never carries the user's private notes", async () => {
    const made = await record({ requirementText: "私密备注", userStatementRef: "私密的话" });
    const id = made.commitmentId as string;
    await kernel.commitmentAcceptance({
      principal: owner,
      commitmentId: id,
      state: "accepted",
      basis: "对方私下告诉我的原因",
      actor: "user",
      now: clock,
    });
    const got = await call("nexus_commitment_get", { commitmentId: id });
    assert.equal(JSON.stringify(got).includes("对方私下告诉我的原因"), false);
    assert.equal(got.acceptance, "accepted");
  });
  it("refuses an id picked silently when another person has the same name, until the user's choice is quoted", async () => {
    const make = (allowSameName: boolean) => {
      const out = kernel.counterpartCreate({
        principal: owner,
        displayName: "同名人",
        allowSameName,
        now: clock,
      });
      assert.equal(out.outcome, "created");
      return (out as { counterpart: { id: string } }).counterpart.id;
    };
    const first = make(false);
    const base = { requirementText: "回邮件", userStatementRef: "同名人答应回邮件" };
    const ok = await call("nexus_commitment_record", { ...base, counterpartId: first });
    assert.equal(ok.ok, true, "one person with that name: the id is fine");
    const second = make(true);
    const refused = await call("nexus_commitment_record", {
      ...base,
      userStatementRef: "同名人答应周日回邮件",
      counterpartId: first,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "ambiguous_person");
    assert.equal(refused.candidates.length, 2);
    const chosen = await call("nexus_commitment_record", {
      ...base,
      userStatementRef: "同名人答应周日回邮件",
      counterpartId: second,
      userChoiceRef: "是后建的那个同名人",
    });
    assert.equal(chosen.ok, true);
    assert.equal(
      (
        await call("nexus_commitment_record", {
          ...base,
          userStatementRef: "另一句话",
          counterpartId: "cp_missing",
        })
      ).code,
      "invalid",
    );
  });
  it("keeps several people named together as waiting for the user's choice, and tells the Agent not to choose", async () => {
    const out = await record({
      requirementText: "一起做报价",
      userStatementRef: "小王和小李一起做报价",
      responsibleName: "小王和小李一起",
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.responsibleResolved, false);
    assert.match(String(out.waitingForUserChoice), /Only the user can choose/);
    const row = db
      .prepare("SELECT responsible_counterpart_id, ambiguity_json FROM commitments WHERE id = ?")
      .get(out.commitmentId) as {
      responsible_counterpart_id: string | null;
      ambiguity_json: string;
    };
    assert.equal(row.responsible_counterpart_id, null);
    assert.deepEqual(JSON.parse(row.ambiguity_json), { kind: "joint", names: ["小王", "小李"] });
    // reading it back says the same
    const read = await call("nexus_commitment_get", { commitmentId: out.commitmentId });
    assert.match(String(read.waitingForUserChoice), /Only the user can choose/);
    // a single name says nothing of the kind
    assert.equal(
      (await record({ userStatementRef: "单人一句话" })).waitingForUserChoice,
      undefined,
    );
  });

  it("refuses 'any one of them is enough' with the sentence, and records nothing", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM commitments").get() as { n: number }).n;
    const out = await record({
      requirementText: "报价单",
      userStatementRef: "小王或小李谁都行，先做完就算",
      responsibleName: "小王",
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "either_responsible");
    assert.match(String(out.message), /请指定一位负责人，其他人可协助，或明确各自需要交付的部分/);
    assert.match(String(out.message), /Record nothing until they answer/);
    const after = (db.prepare("SELECT COUNT(*) AS n FROM commitments").get() as { n: number }).n;
    assert.equal(after, before);
  });
});
