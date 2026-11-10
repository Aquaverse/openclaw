// The gateway methods of "not the same person" (nexus.counterpart.notSame / notSameRestore): scopes, validation, the mark and its
// undo as the person page reads them, owner isolation.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createCounterpartRpcHandlers } from "./counterpart-rpc.js";
import { createCounterpartSameRpcHandlers } from "./counterpart-same-rpc.js";
import { createEventBridge } from "./events.js";
import type { TaskStore } from "./store/host.js";
import { applyMigrations } from "./store/kernel.js";
import { createNexusKernel } from "./store/nexus-kernel.js";
import type { Principal } from "./store/types.js";

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
  const deps = {
    getStore: async () => store,
    events: createEventBridge(),
    resolvePrincipal: () => principal,
    now: () => (clock += 1000),
  };
  const handlers = new Map<string, { run: (o: never) => unknown; scope: string }>();
  for (const [method, run, scope] of [
    ...createCounterpartRpcHandlers(deps),
    ...createCounterpartSameRpcHandlers(deps),
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
  return { call, handlers, as };
}

describe("counterpart notSame methods", () => {
  it("registers both as writes", () => {
    const { handlers } = setup();
    assert.equal(handlers.get("nexus.counterpart.notSame")?.scope, "operator.write");
    assert.equal(handlers.get("nexus.counterpart.notSameRestore")?.scope, "operator.write");
  });

  it("marks two same-named records as two people, shows the mark on the person, and takes it back", async () => {
    const { call } = setup();
    const a = (await call("nexus.counterpart.create", { displayName: "钱经理" })).payload
      ?.counterpart.id as string;
    const b = (
      await call("nexus.counterpart.create", { displayName: "钱经理", allowSameName: true })
    ).payload?.counterpart.id as string;
    const seen = async () =>
      (await call("nexus.counterpart.get", { counterpartId: a })).payload?.view;
    assert.equal((await seen()).possibleSame.length, 1);
    const marked = await call("nexus.counterpart.notSame", { counterpartId: a, otherId: b });
    assert.equal(marked.payload?.outcome, "marked");
    assert.equal(marked.payload?.ownerId, "owner-a");
    assert.deepEqual((await seen()).possibleSame, []);
    assert.equal((await seen()).notSame[0].id, b);
    assert.equal(
      (await call("nexus.counterpart.notSame", { counterpartId: b, otherId: a })).payload?.outcome,
      "exists",
    );
    const undone = await call("nexus.counterpart.notSameRestore", { counterpartId: b, otherId: a });
    assert.equal(undone.payload?.outcome, "restored");
    assert.equal((await seen()).possibleSame.length, 1);
    const again = await call("nexus.counterpart.notSameRestore", { counterpartId: a, otherId: b });
    assert.equal(again.error?.code, "nexus_not_found");
  });

  it("validates the ids, and does not touch another owner's people", async () => {
    const { call, as } = setup();
    const a = (await call("nexus.counterpart.create", { displayName: "孙工" })).payload?.counterpart
      .id as string;
    assert.equal(
      (await call("nexus.counterpart.notSame", { counterpartId: a })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.counterpart.notSame", { counterpartId: a, otherId: "../x" })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.counterpart.notSame", { counterpartId: a, otherId: a })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.counterpart.notSame", { counterpartId: a, otherId: "cp_nobody" })).error
        ?.code,
      "nexus_not_found",
    );
    as(B);
    const theirs = (await call("nexus.counterpart.create", { displayName: "孙工" })).payload
      ?.counterpart.id as string;
    assert.equal(
      (await call("nexus.counterpart.notSame", { counterpartId: theirs, otherId: a })).error?.code,
      "nexus_not_found",
    );
  });
});
