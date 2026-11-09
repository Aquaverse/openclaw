// The gateway methods of "clear a deleted person" (nexus.counterpart.purge / purgeReceipts, and the name order of
// nexus.counterpart.list): scopes, the repeated number that confirms, validation, previews that change nothing, owner isolation.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createCounterpartPurgeRpcHandlers } from "./counterpart-purge-rpc.js";
import { createCounterpartRpcHandlers } from "./counterpart-rpc.js";
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
    ...createCounterpartPurgeRpcHandlers(deps),
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

describe("counterpart purge methods", () => {
  it("registers the purge as admin and the receipts as read", () => {
    const { handlers } = setup();
    assert.equal(handlers.get("nexus.counterpart.purge")?.scope, "operator.admin");
    assert.equal(handlers.get("nexus.counterpart.purgeReceipts")?.scope, "operator.read");
  });

  it("clears deleted people only after the number of people is typed again, and says what it did", async () => {
    const { call } = setup();
    const made = await call("nexus.counterpart.create", {
      displayName: "钱经理",
      aliases: ["老钱"],
      contacts: [{ type: "email", value: "qian@example.com" }],
    });
    const id = made.payload?.counterpart.id as string;
    const stillHere = await call("nexus.counterpart.create", { displayName: "孙工" });
    const keepId = stillHere.payload?.counterpart.id as string;
    // not deleted yet: nothing to clear, and nothing is touched
    const early = await call("nexus.counterpart.purge", {
      counterpartIds: [id],
      confirmCount: 1,
    });
    assert.equal(early.ok, true);
    assert.equal(early.payload?.outcome, "nothing_to_purge");
    await call("nexus.counterpart.deactivate", { counterpartId: id, reason: "不再合作" });
    // the preview needs no confirmation and changes nothing
    const preview = await call("nexus.counterpart.purge", {
      counterpartIds: [id, keepId],
      dryRun: true,
    });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.payload?.outcome, "preview");
    assert.equal(preview.payload?.items.length, 1);
    assert.deepEqual(preview.payload?.skipped, [{ id: keepId, reason: "not_deleted" }]);
    assert.equal(preview.payload?.total.contacts, 1);
    assert.equal(preview.payload?.total.aliases, 1);
    const listed = await call("nexus.counterpart.list", { lifecycle: "inactive" });
    assert.equal(listed.payload?.total, 1, "still listed as deleted after a preview");
    // no confirmation, a wrong one
    for (const confirmCount of [undefined, 2, "1"]) {
      const refused = await call("nexus.counterpart.purge", {
        counterpartIds: [id],
        ...(confirmCount === undefined ? {} : { confirmCount }),
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.error?.code, "nexus_confirmation_required");
    }
    const done = await call("nexus.counterpart.purge", { counterpartIds: [id], confirmCount: 1 });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.payload?.outcome, "purged");
    assert.equal(done.payload?.ownerId, "owner-a");
    assert.equal(done.payload?.purged[0]?.id, id);
    assert.equal(done.payload?.purged[0]?.displayName, "钱经理");
    assert.equal(
      (await call("nexus.counterpart.list", { lifecycle: "inactive" })).payload?.total,
      0,
    );
    const receipts = await call("nexus.counterpart.purgeReceipts", {});
    assert.equal(receipts.payload?.total, 1);
    assert.equal(receipts.payload?.items[0]?.displayName, "钱经理");
    assert.equal(receipts.payload?.items[0]?.contactCount, 1);
    assert.doesNotMatch(JSON.stringify(receipts.payload), /example\.com|老钱/);
    const restore = await call("nexus.counterpart.restore", { counterpartId: id });
    assert.equal(restore.ok, false);
    assert.equal(restore.error?.code, "nexus_counterpart_state");
  });

  it("rejects a missing, empty, oversized or malformed id list", async () => {
    const { call } = setup();
    for (const counterpartIds of [
      undefined,
      [],
      "cp_1",
      [1],
      ["bad id!"],
      Array.from({ length: 201 }, (_, i) => `cp_${i}`),
    ]) {
      const out = await call("nexus.counterpart.purge", {
        ...(counterpartIds === undefined ? {} : { counterpartIds }),
        confirmCount: 1,
      });
      assert.equal(out.ok, false, JSON.stringify(counterpartIds)?.slice(0, 40));
      assert.equal(out.error?.code, "nexus_invalid_params");
    }
  });

  it("never reaches another owner's people or receipts", async () => {
    const { call, as } = setup();
    const made = await call("nexus.counterpart.create", { displayName: "甲的人" });
    const id = made.payload?.counterpart.id as string;
    await call("nexus.counterpart.deactivate", { counterpartId: id, reason: "x" });
    as(B);
    const out = await call("nexus.counterpart.purge", { counterpartIds: [id], confirmCount: 1 });
    assert.equal(out.payload?.outcome, "nothing_to_purge");
    assert.deepEqual(out.payload?.skipped, [{ id, reason: "not_found" }]);
    assert.equal((await call("nexus.counterpart.purgeReceipts", {})).payload?.total, 0);
    as(A);
    assert.equal(
      (await call("nexus.counterpart.list", { lifecycle: "inactive" })).payload?.total,
      1,
    );
  });

  it("lists in name order, pages, searches, and rejects an unknown order", async () => {
    const { call } = setup();
    for (const name of ["周", "吴", "郑", "王", "李"]) {
      const made = await call("nexus.counterpart.create", { displayName: `${name}清理` });
      await call("nexus.counterpart.deactivate", {
        counterpartId: made.payload?.counterpart.id,
        reason: "x",
      });
    }
    const first = await call("nexus.counterpart.list", {
      lifecycle: "inactive",
      order: "name",
      limit: 3,
      offset: 0,
    });
    const second = await call("nexus.counterpart.list", {
      lifecycle: "inactive",
      order: "name",
      limit: 3,
      offset: 3,
    });
    const names = [...first.payload!.items, ...second.payload!.items].map(
      (p: { displayName: string }) => p.displayName,
    );
    assert.deepEqual(
      names,
      [...names].toSorted((a, b) => a.localeCompare(b, "zh")),
    );
    assert.equal(names.length, 5);
    assert.equal(first.payload?.total, 5);
    const found = await call("nexus.counterpart.list", {
      lifecycle: "inactive",
      order: "name",
      keyword: "吴",
    });
    assert.deepEqual(
      found.payload?.items.map((p: { displayName: string }) => p.displayName),
      ["吴清理"],
    );
    const bad = await call("nexus.counterpart.list", { order: "random" });
    assert.equal(bad.ok, false);
    assert.equal(bad.error?.code, "nexus_invalid_params");
  });
});
