import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createEventBridge, type TaskChangedPayload } from "./events.js";
import { createTaskRpcHandlers } from "./rpc.js";
import type { TaskStore } from "./store/host.js";
import { applyMigrations } from "./store/kernel.js";
import { createNexusKernel } from "./store/nexus-kernel.js";
import type { Principal } from "./store/types.js";

type Reply = {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
};

describe("task rpc", () => {
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
  const owner: Principal = { ownerId: "local" };
  const emitted: TaskChangedPayload[] = [];
  const events = createEventBridge();
  events.attach((_e, payload) => emitted.push(payload as TaskChangedPayload));
  const handlers = (principal: Principal | undefined) =>
    new Map<
      string,
      { handler: ReturnType<typeof createTaskRpcHandlers>[number][1]; scope: string }
    >(
      createTaskRpcHandlers({
        getStore: async () => store,
        events,
        resolvePrincipal: () => principal,
        now: () => 5000,
      }).map(([method, handler, scope]) => [method, { handler, scope }] as const),
    );
  const call = async (
    principal: Principal | undefined,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Reply> => {
    const entry = handlers(principal).get(method);
    assert.ok(entry, method);
    let reply: Reply | undefined;
    await entry.handler({
      params,
      respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => {
        reply = { ok, payload: payload as Record<string, unknown>, error };
      },
    } as never);
    assert.ok(reply, "handler responded");
    return reply;
  };

  kernel.create({
    principal: owner,
    id: "T00000001",
    kind: "flight_booking",
    title: "订东京机票",
    goal: { want: "x" },
    entities: { dest: "tokyo" },
    idempotencyKey: "k1",
    fingerprint: "f1",
    sessionKey: "s",
    now: 1,
  });

  it("declares read scopes for reads and write scopes for mutations", () => {
    const scopes = Object.fromEntries(
      [...handlers(owner)].map(([method, { scope }]) => [method, scope]),
    );
    assert.deepEqual(scopes, {
      "nexus.task.list": "operator.read",
      "nexus.task.get": "operator.read",
      "nexus.task.abort": "operator.write",
      "nexus.task.delete": "operator.write",
    });
  });
  it("lists and gets with ownerId in every reply, without binding a session", async () => {
    const list = await call(owner, "nexus.task.list", {});
    assert.equal(list.ok, true);
    assert.equal(list.payload?.ownerId, "local");
    assert.equal((list.payload?.tasks as unknown[] | undefined)?.length, 1);
    const get = await call(owner, "nexus.task.get", { taskId: "T00000001" });
    assert.equal(get.payload?.ownerId, "local");
    assert.equal((get.payload?.sessions as unknown[] | undefined)?.length, 1);
  });
  it("validates params", async () => {
    assert.equal(
      (await call(owner, "nexus.task.list", { statuses: ["bogus"] })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal((await call(owner, "nexus.task.get", {})).error?.code, "nexus_invalid_params");
    assert.equal(
      (await call(owner, "nexus.task.get", { taskId: "T99999999" })).error?.code,
      "nexus_not_found",
    );
  });
  it("pages and filters the list, and always reports the total", async () => {
    for (const [id, title, dest, created] of [
      ["T00000002", "订大阪酒店", "osaka", 2000],
      ["T00000003", "订京都酒店", "kyoto", 3000],
      ["T00000004", "查天气", "paris", 4000],
    ] as const) {
      kernel.create({
        principal: owner,
        id,
        kind: "hotel",
        title,
        goal: { dest },
        entities: null,
        idempotencyKey: `k_${id}`,
        fingerprint: `f_${id}`,
        sessionKey: "s",
        now: created,
      });
    }
    const ids = async (params: Record<string, unknown>) =>
      (
        (await call(owner, "nexus.task.list", params)).payload?.tasks as
          | Array<{ id: string }>
          | undefined
      )?.map((task) => task.id);
    const page1 = await call(owner, "nexus.task.list", { limit: 2, includeClosed: true });
    assert.equal(page1.payload?.total, 4);
    assert.equal(page1.payload?.offset, 0);
    assert.deepEqual(await ids({ limit: 2, includeClosed: true }), ["T00000004", "T00000003"]);
    const page2 = await call(owner, "nexus.task.list", {
      limit: 2,
      offset: 2,
      includeClosed: true,
    });
    assert.equal(page2.payload?.total, 4);
    assert.equal(page2.payload?.offset, 2);
    assert.deepEqual(
      (page2.payload?.tasks as Array<{ id: string }> | undefined)?.map((task) => task.id),
      ["T00000002", "T00000001"],
    );
    assert.deepEqual(await ids({ id: "t0000000" }), [
      "T00000004",
      "T00000003",
      "T00000002",
      "T00000001",
    ]);
    assert.deepEqual(await ids({ id: "0003" }), ["T00000003"]);
    assert.deepEqual(await ids({ title: "酒店" }), ["T00000003", "T00000002"]);
    assert.deepEqual(await ids({ keyword: "kyoto" }), ["T00000003"]);
    assert.deepEqual(await ids({ keyword: "酒店 osaka" }), ["T00000002"]);
    assert.deepEqual(await ids({ createdFrom: 3000 }), ["T00000004", "T00000003"]);
    assert.deepEqual(await ids({ createdFrom: 2000, createdTo: 4000 }), ["T00000003", "T00000002"]);
    assert.deepEqual(await ids({ statuses: ["succeeded"] }), []);
    // The total follows the filter, not the page.
    const filtered = await call(owner, "nexus.task.list", { title: "酒店", limit: 1 });
    assert.equal(filtered.payload?.total, 2);
    assert.equal((filtered.payload?.tasks as unknown[] | undefined)?.length, 1);
  });
  it("rejects malformed search and time params", async () => {
    for (const params of [
      { id: 5 },
      { id: "x".repeat(65) },
      { title: "x".repeat(201) },
      { keyword: ["a"] },
      { createdFrom: "yesterday" },
      { createdTo: -1 },
      { createdFrom: Number.NaN },
    ]) {
      assert.equal(
        (await call(owner, "nexus.task.list", params)).error?.code,
        "nexus_invalid_params",
        JSON.stringify(params),
      );
    }
  });
  it("fails closed without a principal", async () => {
    assert.equal((await call(undefined, "nexus.task.list", {})).error?.code, "nexus_no_principal");
  });
  it("aborts once, reports closed afterwards, and emits events", async () => {
    const first = await call(owner, "nexus.task.abort", { taskId: "T00000001" });
    assert.equal(first.payload?.outcome, "aborted");
    assert.equal(emitted.at(-1)?.change, "aborted");
    const second = await call(owner, "nexus.task.abort", { taskId: "T00000001" });
    assert.equal(second.payload?.outcome, "already_cancelled");
  });
  it("soft-deletes and then hides the Task", async () => {
    const del = await call(owner, "nexus.task.delete", { taskId: "T00000001" });
    assert.equal(del.payload?.outcome, "deleted");
    assert.equal(emitted.at(-1)?.change, "deleted");
    assert.equal(emitted.at(-1)?.revision, 1); // real revision, not a placeholder 0
    assert.equal(
      (await call(owner, "nexus.task.get", { taskId: "T00000001" })).error?.code,
      "nexus_not_found",
    );
    assert.equal(
      (await call(owner, "nexus.task.delete", { taskId: "T00000001" })).payload?.outcome,
      "already_deleted",
    );
  });
});
