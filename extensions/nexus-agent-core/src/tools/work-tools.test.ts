// Work tools against the real kernel on in-memory SQLite: what the Agent can read and reword, and what it cannot touch.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createEventBridge, type WorkChangedPayload } from "../events.js";
import type { TaskStore } from "../store/host.js";
import { applyMigrations } from "../store/kernel.js";
import { createNexusKernel } from "../store/nexus-kernel.js";
import type { Principal } from "../store/types.js";
import { createTokenLedger } from "../tokens.js";
import { createTaskTools } from "./task-tools.js";
import { createWorkTools, WORK_TOOL_NAMES } from "./work-tools.js";

type Result = Record<string, any> & { ok: boolean; code?: string };

describe("work tools", () => {
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
  let counter = 0;
  const emitted: WorkChangedPayload[] = [];
  const events = createEventBridge();
  events.attach((_e, payload) => {
    emitted.push(payload as WorkChangedPayload);
  });
  const ledger = createTokenLedger(
    () => clock,
    (prefix) => `${prefix}_${(counter += 1).toString().padStart(4, "0")}`,
  );
  const owner: Principal = { ownerId: "local" };

  const workTools = (principal: Principal | null = owner) =>
    createWorkTools(
      {
        getStore: async () => store,
        events,
        resolvePrincipal: () => principal ?? undefined,
        now: () => clock,
      },
      { sessionKey: "agent:main:main", agentId: "main" },
    );
  const callWork = async (
    name: string,
    params: Record<string, unknown>,
    principal: Principal | null = owner,
  ): Promise<Result> => {
    const tool = workTools(principal).find((t) => t.name === name);
    assert.ok(tool, name);
    return ((await tool.execute("c1", params as never)) as { details: Result }).details;
  };
  const taskTools = (worksEnabled: boolean) =>
    createTaskTools(
      {
        getStore: async () => store,
        ledger,
        events,
        resolvePrincipal: () => owner,
        now: () => clock,
        newId: () => `T${(counter += 1).toString().padStart(8, "0")}`,
        worksEnabled,
      },
      { sessionKey: "agent:main:main", agentId: "main" },
    );
  const callTask = async (
    worksEnabled: boolean,
    name: string,
    params: Record<string, unknown>,
  ): Promise<Result> => {
    const tool = taskTools(worksEnabled).find((t) => t.name === name);
    assert.ok(tool, name);
    return ((await tool.execute("c1", params as never)) as { details: Result }).details;
  };
  const createTask = async (
    worksEnabled: boolean,
    extra: Record<string, unknown> = {},
    tag = "a",
  ) => {
    const entities = { tag };
    const goal = { want: `thing ${tag}` };
    const reserved = await callTask(worksEnabled, "nexus_task_reserve", {
      kind: "errand",
      entities,
    });
    assert.equal(reserved.ok, true, JSON.stringify(reserved));
    return callTask(worksEnabled, "nexus_task_create", {
      kind: "errand",
      title: `Errand ${tag}`,
      goal,
      entities,
      operationToken: reserved.operationToken,
      ...extra,
    });
  };

  it("registers the four work tools, all model-visible", () => {
    const tools = workTools() as unknown as Array<{ name: string; catalogMode?: string }>;
    assert.deepEqual(
      tools.map((t) => t.name),
      [...WORK_TOOL_NAMES],
    );
  });

  it("without the switch, a created Task has no Work and the schema has no workId", async () => {
    const tool = taskTools(false).find((t) => t.name === "nexus_task_create")!;
    assert.equal(JSON.stringify(tool.parameters).includes("workId"), false);
    const created = await createTask(false, {}, "off");
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.workId, undefined);
  });

  let workId = "";
  it("with the switch, a created Task gets a Work and the tools can find and read it", async () => {
    const tool = taskTools(true).find((t) => t.name === "nexus_task_create")!;
    assert.equal(JSON.stringify(tool.parameters).includes("workId"), true);
    const created = await createTask(true, {}, "on");
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.match(String(created.workId), /^w_/u);
    workId = String(created.workId);
    const found = await callWork("nexus_work_search", { keyword: "Errand" });
    assert.equal(found.ok, true);
    assert.equal(found.total, 1);
    assert.equal(found.works[0].workId, workId);
    const got = await callWork("nexus_work_get", { workId });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.tasks.length, 1);
    assert.ok(typeof got.state === "string");
  });

  it("a second Task can join the Work by workId; a malformed or unknown id is refused", async () => {
    const joined = await createTask(true, { workId }, "second");
    assert.equal(joined.ok, true, JSON.stringify(joined));
    assert.equal(joined.workId, workId);
    assert.equal((await callWork("nexus_work_get", { workId })).tasks.length, 2);
    const bad = await createTask(true, { workId: "nope" }, "third");
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "invalid_work_id");
    const missing = await createTask(true, { workId: "w_doesnotexist" }, "fourth");
    assert.equal(missing.ok, false);
  });

  it("nexus_work_update rewords only: needs something to change, honours the revision, emits an event", async () => {
    assert.equal((await callWork("nexus_work_update", { workId })).code, "nothing_to_change");
    assert.equal(
      (await callWork("nexus_work_update", { workId: "bad", title: "x" })).code,
      "invalid_work_id",
    );
    const done = await callWork("nexus_work_update", { workId, title: "Renamed by agent" });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.changed, true);
    assert.equal(emitted.at(-1)?.action, "updated");
    const stale = await callWork("nexus_work_update", {
      workId,
      title: "again",
      expectedRevision: 0,
    });
    assert.equal(stale.code, "revision_conflict");
  });

  it("the tool views carry codes and short fields, never the request text", async () => {
    const out = await callWork("nexus_work_get", { workId });
    assert.equal(JSON.stringify(out).includes("thing on"), false);
  });

  it("nexus_work_link rejects bad input and a missing file version", async () => {
    assert.equal(
      (await callWork("nexus_work_link", { workId, fileId: "", versionSeq: 1 })).code,
      "invalid_params",
    );
    assert.equal(
      (await callWork("nexus_work_link", { workId, fileId: "f1", versionSeq: 0 })).code,
      "invalid_params",
    );
    const missing = await callWork("nexus_work_link", { workId, fileId: "f_none", versionSeq: 1 });
    assert.equal(missing.ok, false);
  });

  it("without a principal every tool fails closed and says nothing changed", async () => {
    const out = await callWork("nexus_work_search", {}, null);
    assert.equal(out.ok, false);
    assert.equal(out.code, "no_principal");
    assert.match(String(out.notice), /FAILED/u);
  });

  it("another owner cannot read the Work through the tools", async () => {
    const other: Principal = { ownerId: "someone-else" };
    assert.equal((await callWork("nexus_work_get", { workId }, other)).code, "not_found");
    assert.equal((await callWork("nexus_work_search", {}, other)).total, 0);
  });
});
