// Task tools against the real kernel on in-memory SQLite (DESIGN section 7: de-duplication, idempotency, binding).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createEventBridge, type TaskChangedPayload } from "../events.js";
import type { TaskStore } from "../store/host.js";
import { applyMigrations } from "../store/kernel.js";
import { createNexusKernel } from "../store/nexus-kernel.js";
import type { Principal } from "../store/types.js";
import { createTokenLedger } from "../tokens.js";
import { createTaskTools, normalizeTaskId } from "./task-tools.js";

type Result = Record<string, unknown> & { ok: boolean; code?: string };

describe("task tools", () => {
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
      async (input: unknown) => (fn as (value: unknown) => unknown)(input),
    ]),
  ) as unknown as TaskStore;

  const clock = Date.UTC(2026, 9, 10, 8, 0, 0);
  let counter = 0;
  const emitted: TaskChangedPayload[] = [];
  const events = createEventBridge();
  events.attach((_event, payload) => {
    emitted.push(payload as TaskChangedPayload);
  });
  const ledger = createTokenLedger(
    () => clock,
    (prefix) => `${prefix}_${(counter += 1).toString().padStart(4, "0")}`,
  );
  const owner: Principal = { ownerId: "local" };
  const make = (sessionKey: string, principal: Principal | null = owner) => {
    const tools = createTaskTools(
      {
        getStore: async () => store,
        ledger,
        events,
        resolvePrincipal: () => principal ?? undefined,
        now: () => clock,
        newId: () => `T${(counter += 1).toString().padStart(8, "0")}`,
      },
      { sessionKey, agentId: "main" },
    );
    const call = async (name: string, params: Record<string, unknown>): Promise<Result> => {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `tool ${name} exists`);
      const out = (await tool.execute("call-1", params as never)) as { details: Result };
      return out.details;
    };
    return call;
  };
  const a = make("agent:main:main");
  const b = make("agent:main:other");
  const trip = { dest: "tokyo", date: "2026-03-12", pax: 2 };
  const goal = { want: "round trip flights" };
  let firstId = "";
  let token = "";

  it("registers the six tools", () => {
    const names = createTaskTools(
      { getStore: async () => store, ledger, events, resolvePrincipal: () => owner },
      {},
    ).map((tool) => tool.name);
    assert.deepEqual(names, [
      "nexus_task_reserve",
      "nexus_task_create",
      "nexus_task_get",
      "nexus_task_update",
      "nexus_task_note",
      "nexus_task_search",
    ]);
  });
  it("keeps every tool model-visible when the host defers schemas behind Tool Search", () => {
    const tools = createTaskTools(
      { getStore: async () => store, ledger, events, resolvePrincipal: () => owner },
      {},
    ) as unknown as Array<{ catalogMode?: string; execute: unknown }>;
    assert.equal(tools.length, 6);
    for (const tool of tools) {
      assert.equal(tool.catalogMode, "direct-only");
      assert.equal(typeof tool.execute, "function");
    }
  });
  it("normalizes task ids", () => {
    assert.equal(normalizeTaskId("#T00000007"), "T00000007");
    assert.equal(normalizeTaskId("t7"), undefined);
    assert.equal(normalizeTaskId(7), undefined);
  });
  it("reserve validates kind and returns a token", async () => {
    assert.equal((await a("nexus_task_reserve", { kind: "Flight Booking" })).code, "invalid_kind");
    const reserved = await a("nexus_task_reserve", { kind: "flight_booking", entities: trip });
    assert.equal(reserved.ok, true);
    token = String(reserved.operationToken);
    assert.match(token, /^op_/u);
  });
  it("creates with the token and emits a change event", async () => {
    const created = await a("nexus_task_create", {
      kind: "flight_booking",
      title: "订东京机票",
      goal,
      entities: trip,
      operationToken: token,
    });
    assert.equal(created.ok, true);
    assert.equal(created.created, true);
    assert.equal(created.status, "clarifying");
    firstId = String(created.taskId);
    assert.equal(emitted.at(-1)?.change, "created");
    assert.equal(emitted.at(-1)?.taskId, firstId);
  });
  it("a retry with the same token replays instead of creating a second Task", async () => {
    const before = emitted.length;
    const again = await a("nexus_task_create", {
      kind: "flight_booking",
      title: "订东京机票",
      goal,
      entities: trip,
      operationToken: token,
    });
    assert.equal(again.created, false);
    assert.equal(again.replayed, true);
    assert.equal(again.taskId, firstId);
    assert.equal(emitted.length, before);
  });
  it("the same token with a different goal is a fingerprint conflict", async () => {
    const conflict = await a("nexus_task_create", {
      kind: "flight_booking",
      title: "订东京机票",
      goal: { want: "one way" },
      entities: trip,
      operationToken: token,
    });
    assert.equal(conflict.code, "fingerprint_conflict");
  });
  it("a token reserved for another kind is rejected, and failures say so plainly", async () => {
    const other = String((await a("nexus_task_reserve", { kind: "hotel_booking" })).operationToken);
    const bad = await a("nexus_task_create", {
      kind: "flight_booking",
      title: "订大阪机票",
      goal,
      entities: trip,
      operationToken: other,
    });
    assert.equal(bad.code, "operation_token_invalid");
    assert.equal(bad.ok, false);
    assert.match(String(bad.notice), /FAILED/u);
    assert.equal(
      (
        await a("nexus_task_create", {
          kind: "flight_booking",
          title: "x",
          goal,
          operationToken: "op_nope",
        })
      ).code,
      "operation_token_invalid",
    );
  });
  it("a similar open Task yields candidates and a one-shot override token", async () => {
    const t2 = String(
      (await a("nexus_task_reserve", { kind: "flight_booking", entities: trip })).operationToken,
    );
    const dup = await a("nexus_task_create", {
      kind: "flight_booking",
      title: "东京机票再订一次",
      goal: { want: "second booking" },
      entities: trip,
      operationToken: t2,
    });
    assert.equal(dup.created, false);
    assert.equal((dup.existing_candidates as unknown[]).length, 1);
    const override = String(dup.duplicate_override_token);
    const created = await a("nexus_task_create", {
      kind: "flight_booking",
      title: "东京机票再订一次",
      goal: { want: "second booking" },
      entities: trip,
      operationToken: t2,
      duplicateOverrideToken: override,
    });
    assert.equal(created.created, true);
    assert.notEqual(created.taskId, firstId);
    // The used override token cannot be replayed for yet another Task.
    const t3 = String(
      (await a("nexus_task_reserve", { kind: "flight_booking", entities: trip })).operationToken,
    );
    const third = await a("nexus_task_create", {
      kind: "flight_booking",
      title: "第三次",
      goal: { want: "third" },
      entities: trip,
      operationToken: t3,
      duplicateOverrideToken: override,
    });
    assert.equal(third.created, false);
    assert.ok(third.previousTokenRejected, "the spent override token is rejected");
  });
  it("entities may differ from reserve to create (models rarely repeat them verbatim)", async () => {
    const t = String(
      (await a("nexus_task_reserve", { kind: "visa_application", entities: { country: "japan" } }))
        .operationToken,
    );
    const created = await a("nexus_task_create", {
      kind: "visa_application",
      title: "日本签证",
      goal,
      entities: { country: "japan", extra_field: "added later" },
      operationToken: t,
    });
    assert.equal(created.ok, true);
    assert.equal(created.created, true);
  });
  it("a different month is not a duplicate", async () => {
    const april = { ...trip, date: "2026-04-20" };
    const t = String(
      (await a("nexus_task_reserve", { kind: "flight_booking", entities: april })).operationToken,
    );
    const created = await a("nexus_task_create", {
      kind: "flight_booking",
      title: "四月的东京机票",
      goal,
      entities: april,
      operationToken: t,
    });
    assert.equal(created.created, true);
  });
  it("without a token, same-turn retries collapse via the derived key", async () => {
    const params = {
      kind: "hotel_booking",
      title: "东京酒店",
      goal: { want: "3 nights" },
      entities: { city: "tokyo" },
    };
    const first = await a("nexus_task_create", params);
    const second = await a("nexus_task_create", params);
    assert.equal(first.created, true);
    assert.equal(second.replayed, true);
    assert.equal(second.taskId, first.taskId);
  });
  it("get needs an explicit id, binds the session and hides other owners", async () => {
    assert.equal((await a("nexus_task_get", { taskId: "latest" })).code, "invalid_task_id");
    assert.equal((await a("nexus_task_get", { taskId: "T99999999" })).code, "not_found");
    const read = await b("nexus_task_get", { taskId: `#${firstId}` });
    assert.equal(read.ok, true);
    assert.equal(read.sessions, 2);
    assert.deepEqual(read.pendingDecisions, []);
    const stranger = make("agent:main:main", { ownerId: "someone-else" });
    assert.equal((await stranger("nexus_task_get", { taskId: firstId })).code, "not_found");
  });
  it("update: models cannot close Tasks, revisions are checked, changes emit events", async () => {
    const refused = await a("nexus_task_update", { taskId: firstId, status: "succeeded" });
    assert.equal(refused.code, "status_not_allowed");
    const stale = await a("nexus_task_update", {
      taskId: firstId,
      summary: "x",
      expectedRevision: 5,
    });
    assert.equal(stale.code, "revision_conflict");
    const before = emitted.length;
    const ok = await a("nexus_task_update", {
      taskId: firstId,
      status: "planning",
      summary: "比价中",
      expectedRevision: 1,
    });
    assert.equal(ok.updated, true);
    assert.equal(ok.revisionBumped, false);
    assert.equal(emitted.length, before + 1);
    const retitle = await a("nexus_task_update", {
      taskId: firstId,
      title: "订东京机票（含行李）",
    });
    assert.equal(retitle.revisionBumped, true);
    assert.equal(retitle.revision, 2);
  });
  it("note appends a step and refuses closed Tasks", async () => {
    const added = await a("nexus_task_note", { taskId: firstId, text: "已比价 3 个方案" });
    assert.equal(added.added, true);
    assert.equal(added.seq, 1);
    assert.equal((await a("nexus_task_note", { taskId: firstId, text: "" })).code, "invalid_text");
    await store.abort({ principal: owner, taskId: firstId, now: clock });
    assert.equal(
      (await a("nexus_task_note", { taskId: firstId, text: "晚了" })).code,
      "task_closed",
    );
    assert.equal(
      (await a("nexus_task_update", { taskId: firstId, summary: "晚了" })).code,
      "task_closed",
    );
  });
  it("search returns candidates without binding and flags ambiguity", async () => {
    const found = await a("nexus_task_search", { query: "东京机票" });
    assert.equal(found.ok, true);
    assert.ok((found.candidates as unknown[]).length >= 2);
    assert.equal(found.needs_user_confirmation, true);
    const none = await a("nexus_task_search", { query: "完全无关xyz" });
    assert.deepEqual(none.candidates, []);
    assert.equal(none.needs_user_confirmation, false);
  });
  it("every tool refuses to run without a principal", async () => {
    const nobody = make("agent:main:main", null);
    assert.equal((await nobody("nexus_task_get", { taskId: firstId })).code, "no_principal");
    assert.equal(
      (await nobody("nexus_task_reserve", { kind: "flight_booking" })).code,
      "no_principal",
    );
  });
});
