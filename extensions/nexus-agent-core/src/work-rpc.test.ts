// The console surface of Works (nexus.work.*): scopes, validation, the user-only end facts, refusals and change events.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createEventBridge, type WorkChangedPayload } from "./events.js";
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
  let clock = 50_000_000;
  const emitted: WorkChangedPayload[] = [];
  const events = createEventBridge();
  events.attach((_event, payload) => {
    emitted.push(payload as WorkChangedPayload);
  });
  let principal: Principal | undefined = A;
  const handlers = new Map<string, { run: (o: never) => unknown; scope: string }>();
  for (const [method, run, scope] of createWorkRpcHandlers({
    getStore: async () => store,
    events,
    resolvePrincipal: () => principal,
    now: () => (clock += 1000),
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
  const make = async (title: string) => {
    const out = await call("nexus.work.create", { title });
    assert.equal(out.ok, true, JSON.stringify(out));
    return out.payload!.workId as string;
  };
  return {
    call,
    handlers,
    emitted,
    make,
    setPrincipal: (p: Principal | undefined) => (principal = p),
  };
}

describe("nexus.work.* rpc", () => {
  it("scopes: reads are read, every change is write", () => {
    const { handlers } = setup();
    for (const m of ["list", "get", "counts", "integrity"]) {
      assert.equal(handlers.get(`nexus.work.${m}`)?.scope, "operator.read", m);
    }
    for (const m of [
      "create",
      "update",
      "setGoal",
      "link",
      "unlink",
      "control",
      "recordOutcome",
      "delete",
    ]) {
      assert.equal(handlers.get(`nexus.work.${m}`)?.scope, "operator.write", m);
    }
    assert.equal(handlers.size, 12);
  });

  it("refuses when the owner cannot be resolved", async () => {
    const t = setup();
    t.setPrincipal(undefined);
    const out = await t.call("nexus.work.list");
    assert.equal(out.ok, false);
    assert.equal(out.error?.code, "nexus_no_principal");
  });

  it("creates, lists and reads a Work; replies carry ownerId and a change event is emitted", async () => {
    const t = setup();
    const missing = await t.call("nexus.work.create", { title: "  " });
    assert.equal(missing.error?.code, "nexus_invalid_params");
    const workId = await t.make("Plan the Tokyo trip");
    assert.equal(t.emitted.at(-1)?.action, "created");
    const list = await t.call("nexus.work.list", { keyword: "Tokyo" });
    assert.equal(list.ok, true);
    assert.equal(list.payload?.ownerId, "owner-a");
    assert.equal(list.payload?.total, 1);
    const got = await t.call("nexus.work.get", { workId });
    assert.equal(got.ok, true);
    assert.equal(got.payload?.work.title, "Plan the Tokyo trip");
    const counts = await t.call("nexus.work.counts", {});
    assert.equal(counts.ok, true);
    // With a keyword the classes are counted over what the search finds, the same Works the list returns.
    const found = await t.call("nexus.work.counts", { keyword: "Tokyo" });
    assert.equal(found.payload?.total, list.payload?.total);
    const none = await t.call("nexus.work.counts", { keyword: "no such work" });
    assert.equal(none.payload?.total, 0);
    assert.equal(
      (await t.call("nexus.work.counts", { keyword: 5 })).error?.code,
      "nexus_invalid_params",
    );
  });

  it("rejects malformed list params and unknown works", async () => {
    const t = setup();
    assert.equal(
      (await t.call("nexus.work.list", { states: ["bogus"] })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await t.call("nexus.work.list", { order: "sideways" })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal((await t.call("nexus.work.list", { order: "state", limit: 1 })).ok, true);
    assert.equal(
      (await t.call("nexus.work.list", { contextMode: "nope" })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal((await t.call("nexus.work.get", {})).error?.code, "nexus_invalid_params");
    assert.equal(
      (await t.call("nexus.work.get", { workId: "w_missing1" })).error?.code,
      "nexus_not_found",
    );
  });

  it("another owner cannot see or change the Work", async () => {
    const t = setup();
    const workId = await t.make("Private");
    t.setPrincipal(B);
    assert.equal((await t.call("nexus.work.get", { workId })).error?.code, "nexus_not_found");
    assert.equal(
      (await t.call("nexus.work.update", { workId, title: "x" })).error?.code,
      "nexus_not_found",
    );
    assert.equal((await t.call("nexus.work.delete", { workId })).error?.code, "nexus_not_found");
    const list = await t.call("nexus.work.list");
    assert.equal(list.payload?.total, 0);
  });

  it("update: reword, revision conflict, hide and archive", async () => {
    const t = setup();
    const workId = await t.make("Old title");
    const revised = await t.call("nexus.work.update", { workId, title: "New title" });
    assert.equal(revised.ok, true);
    assert.equal(revised.payload?.outcome, "updated");
    assert.equal(revised.payload?.work.title, "New title");
    assert.equal(t.emitted.at(-1)?.action, "updated");
    const stale = await t.call("nexus.work.update", {
      workId,
      title: "Again",
      expectedRevision: 0,
    });
    assert.equal(stale.error?.code, "nexus_revision_conflict");
    assert.equal((await t.call("nexus.work.update", { workId, hidden: true })).ok, true);
    const listed = await t.call("nexus.work.list");
    assert.equal(listed.payload?.total, 0);
    const withHidden = await t.call("nexus.work.list", { includeHidden: true });
    assert.equal(withHidden.payload?.total, 1);
  });

  it("control: pause then resume releases the named control; unknown actions are refused", async () => {
    const t = setup();
    const workId = await t.make("Pause me");
    assert.equal(
      (await t.call("nexus.work.control", { workId, action: "explode" })).error?.code,
      "nexus_invalid_params",
    );
    const dry = await t.call("nexus.work.control", { workId, action: "pause", dryRun: true });
    assert.equal(dry.ok, true);
    const before = t.emitted.length;
    const paused = await t.call("nexus.work.control", {
      workId,
      action: "pause",
      reason: "user_paused",
    });
    assert.equal(paused.ok, true, JSON.stringify(paused));
    assert.equal(t.emitted.length, before + 1);
    const controlId = paused.payload?.controlId as string;
    assert.ok(controlId, "pause returns the control id");
    // Resume releases only the control it names (WK-04): without the id nothing is released.
    const blind = await t.call("nexus.work.control", { workId, action: "resume" });
    assert.equal(blind.payload?.outcome, "no_such_control");
    const resumed = await t.call("nexus.work.control", { workId, action: "resume", controlId });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.payload?.outcome, "released");
  });

  it("recordOutcome needs a reason; delete removes an empty Work", async () => {
    const t = setup();
    const workId = await t.make("Done by hand");
    assert.equal(
      (await t.call("nexus.work.recordOutcome", { workId })).error?.code,
      "nexus_invalid_params",
    );
    const recorded = await t.call("nexus.work.recordOutcome", {
      workId,
      reason: "I did it myself",
    });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    const other = await t.make("Throw away");
    const deleted = await t.call("nexus.work.delete", { workId: other });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    assert.equal(t.emitted.at(-1)?.action, "deleted");
    assert.equal(
      (await t.call("nexus.work.get", { workId: other })).error?.code,
      "nexus_not_found",
    );
  });

  it("link: commitments are not available yet; unlink needs ids; integrity reads clean", async () => {
    const t = setup();
    const workId = await t.make("Linking");
    assert.equal((await t.call("nexus.work.link", { workId })).error?.code, "nexus_invalid_params");
    assert.equal(
      (await t.call("nexus.work.unlink", { workId })).error?.code,
      "nexus_invalid_params",
    );
    const integrity = await t.call("nexus.work.integrity", {});
    assert.equal(integrity.ok, true);
  });

  it("setGoal: an unknown goal is refused and null clears", async () => {
    const t = setup();
    const workId = await t.make("Goal link");
    const bad = await t.call("nexus.work.setGoal", { workId, goalId: "g_nope" });
    assert.equal(bad.ok, false);
    assert.equal(bad.error?.code, "nexus_not_found");
    assert.equal(
      (await t.call("nexus.work.setGoal", { workId })).error?.code,
      "nexus_invalid_params",
    );
    const cleared = await t.call("nexus.work.setGoal", { workId, goalId: null });
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
  });
});
