// The console and Agent surface of people (nexus.counterpart.*, nexus_counterpart_*): scopes, validation, the name-taken and
// preview answers the page needs, owner isolation, the work_changed events, and what the Agent can and cannot do.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createCommitmentRpcHandlers } from "./commitment-rpc.js";
import { createCounterpartRpcHandlers } from "./counterpart-rpc.js";
import { createEventBridge, type WorkChangedPayload } from "./events.js";
import type { TaskStore } from "./store/host.js";
import { applyMigrations } from "./store/kernel.js";
import { createNexusKernel } from "./store/nexus-kernel.js";
import type { Principal } from "./store/types.js";
import { COUNTERPART_TOOL_NAMES, createCounterpartTools } from "./tools/counterpart-tools.js";
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
  let clock = 70_000_000;
  const emitted: WorkChangedPayload[] = [];
  const events = createEventBridge();
  events.attach((_event, payload) => {
    emitted.push(payload as WorkChangedPayload);
  });
  let principal: Principal | undefined = A;
  const handlers = new Map<string, { run: (o: never) => unknown; scope: string }>();
  const deps = {
    getStore: async () => store,
    events,
    resolvePrincipal: () => principal,
    now: () => (clock += 1000),
  };
  for (const [method, run, scope] of [
    ...createCounterpartRpcHandlers(deps),
    ...createCommitmentRpcHandlers(deps),
    ...createWorkRpcHandlers(deps),
  ]) {
    handlers.set(method, { run: run as never, scope });
  }
  type Answer = {
    ok: boolean;
    payload?: Record<string, any>;
    error?: { code: string; message: string };
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
  const tool = async (name: string, params: Record<string, unknown>) => {
    const found = createCounterpartTools(
      { getStore: async () => store, resolvePrincipal: () => principal, now: () => clock },
      { sessionKey: "agent:main:main", agentId: "main" },
    ).find((t) => t.name === name);
    assert.ok(found, name);
    return ((await found.execute("c1", params as never)) as { details: Record<string, any> })
      .details;
  };
  return {
    call,
    tool,
    emitted,
    handlers,
    as: (next: Principal | undefined) => {
      principal = next;
    },
  };
}

describe("counterpart rpc", () => {
  const s = setup();
  const create = async (displayName: string, over: Record<string, unknown> = {}) => {
    const out = await s.call("nexus.counterpart.create", { displayName, ...over });
    assert.equal(out.ok, true, JSON.stringify(out.error));
    return out;
  };

  it("registers reads under operator.read and writes under operator.write", () => {
    const scopes = Object.fromEntries([...s.handlers].map(([m, h]) => [m, h.scope]));
    for (const m of ["list", "get", "resolve", "pending"]) {
      assert.equal(scopes[`nexus.counterpart.${m}`], "operator.read", m);
    }
    for (const m of [
      "create",
      "update",
      "contactAdd",
      "contactRemove",
      "deactivate",
      "restore",
      "claim",
    ]) {
      assert.equal(scopes[`nexus.counterpart.${m}`], "operator.write", m);
    }
  });

  it("creates, answers name_taken with the candidates, then allows the same name when told to", async () => {
    const first = await create("钱经理", {
      relation: { relation: "client", scopeLabel: "华东" },
      aliases: ["老钱"],
      contacts: [{ type: "email", value: "q@example.com" }],
    });
    assert.equal(first.payload?.outcome, "created");
    assert.equal(first.payload?.counterpart.confirmation, "confirmed");
    const taken = await s.call("nexus.counterpart.create", { displayName: "钱经理" });
    assert.equal(taken.ok, true);
    assert.equal(taken.payload?.outcome, "name_taken");
    assert.equal(taken.payload?.candidates.length, 1);
    const again = await create("钱经理", { allowSameName: true });
    assert.equal(again.payload?.outcome, "created");
    const found = await s.call("nexus.counterpart.resolve", { name: "老钱" });
    assert.equal(found.payload?.match, "one");
    const bad = await s.call("nexus.counterpart.create", {
      displayName: "x",
      relation: { relation: "boss" },
    });
    assert.equal(bad.error?.code, "nexus_invalid_params");
    const badContact = await s.call("nexus.counterpart.create", {
      displayName: "y",
      contacts: [{ type: "fax", value: "1" }],
    });
    assert.equal(badContact.error?.code, "nexus_invalid_params");
  });

  it("previews a deactivation, needs a reason, tells the Work page, and lists the person as inactive", async () => {
    const p = (await create("孙工")).payload?.counterpart;
    const w = await s.call("nexus.work.create", { title: "孙工的工作" });
    const workId = w.payload?.workId ?? w.payload?.work?.id;
    assert.ok(workId);
    const cm = await s.call("nexus.commitment.create", {
      requirementText: "交图纸",
      responsible: { kind: "counterpart", counterpartId: p.id },
      workId,
    });
    assert.equal(cm.ok, true, JSON.stringify(cm.error));
    const preview = await s.call("nexus.counterpart.deactivate", {
      counterpartId: p.id,
      dryRun: true,
    });
    assert.equal(preview.payload?.outcome, "preview");
    assert.equal(preview.payload?.impact.openCommitments, 1);
    assert.equal(preview.payload?.impact.works[0]?.workId, workId);
    const noReason = await s.call("nexus.counterpart.deactivate", { counterpartId: p.id });
    assert.equal(noReason.payload?.outcome, "reason_required");
    s.emitted.length = 0;
    const done = await s.call("nexus.counterpart.deactivate", {
      counterpartId: p.id,
      reason: "不再合作",
      expectedRevision: p.revision,
    });
    assert.equal(done.payload?.outcome, "deactivated");
    assert.ok(s.emitted.some((e) => e.workId === workId));
    const inactive = await s.call("nexus.counterpart.list", { lifecycle: "inactive" });
    assert.ok(inactive.payload?.items.some((i: { id: string }) => i.id === p.id));
    const again = await s.call("nexus.counterpart.deactivate", {
      counterpartId: p.id,
      reason: "x",
    });
    assert.equal(again.error?.code, "nexus_counterpart_state");
    const pending = await s.call("nexus.counterpart.pending");
    assert.ok(pending.payload?.groups.some((g: { raw: string }) => g.raw === "孙工"));
    const claim = await s.call("nexus.counterpart.claim", { counterpartId: p.id, raw: "孙工" });
    assert.equal(
      claim.error?.code,
      "nexus_not_found",
      "an inactive person cannot take Commitments",
    );
    const back = await s.call("nexus.counterpart.restore", { counterpartId: p.id });
    assert.equal(back.payload?.outcome, "restored");
    const claimed = await s.call("nexus.counterpart.claim", { counterpartId: p.id, raw: "孙工" });
    assert.equal(claimed.payload?.outcome, "claimed");
    assert.equal(claimed.payload?.resolved, 1);
    const view = await s.call("nexus.counterpart.get", { counterpartId: p.id });
    assert.equal(view.payload?.view.responsible.length, 1);
    assert.equal(view.payload?.view.related[0]?.title, "孙工的工作");
  });

  it("edits contact methods and keeps every owner apart", async () => {
    const p = (await create("周老师")).payload?.counterpart;
    const add = await s.call("nexus.counterpart.contactAdd", {
      counterpartId: p.id,
      contact: { type: "im", value: "zhou_wx", label: "微信" },
    });
    assert.equal(add.payload?.outcome, "added");
    const endpointId = add.payload?.counterpart.contacts[0]?.id;
    const stale = await s.call("nexus.counterpart.update", {
      counterpartId: p.id,
      changes: { displayName: "周教授" },
      expectedRevision: 1,
    });
    assert.equal(stale.error?.code, "nexus_revision_conflict");
    s.as(B);
    assert.equal(
      (await s.call("nexus.counterpart.get", { counterpartId: p.id })).error?.code,
      "nexus_not_found",
    );
    assert.equal(
      (await s.call("nexus.counterpart.contactRemove", { counterpartId: p.id, endpointId })).error
        ?.code,
      "nexus_not_found",
    );
    assert.equal((await s.call("nexus.counterpart.list")).payload?.items.length, 0);
    s.as(undefined);
    assert.equal((await s.call("nexus.counterpart.list")).error?.code, "nexus_no_principal");
    s.as(A);
    const removed = await s.call("nexus.counterpart.contactRemove", {
      counterpartId: p.id,
      endpointId,
    });
    assert.equal(removed.payload?.outcome, "removed");
    assert.equal(removed.payload?.counterpart.contacts.length, 0);
  });
});

describe("counterpart tools", () => {
  const s = setup();

  it("names the tools the manifest declares and refuses a call with no quoted words", async () => {
    assert.deepEqual(
      [...COUNTERPART_TOOL_NAMES],
      ["nexus_counterpart_ensure", "nexus_counterpart_get", "nexus_counterpart_search"],
    );
    const noRef = await s.tool("nexus_counterpart_ensure", {
      name: "韩梅梅",
      userStatementRef: " ",
    });
    assert.equal(noRef.ok, false);
    assert.match(noRef.notice, /FAILED/);
  });

  it("creates a stated person, reuses it, and hands back candidates instead of choosing between two", async () => {
    const created = await s.tool("nexus_counterpart_ensure", {
      name: "韩梅梅",
      userStatementRef: "让韩梅梅周五前交稿",
    });
    assert.equal(created.ok, true);
    assert.equal(created.created, true);
    assert.equal(created.confirmedByUser, false);
    const again = await s.tool("nexus_counterpart_ensure", {
      name: "韩梅梅",
      userStatementRef: "再提醒韩梅梅",
    });
    assert.equal(again.created, false);
    assert.equal(again.counterpartId, created.counterpartId);
    await s.call("nexus.counterpart.create", { displayName: "韩梅梅", allowSameName: true });
    const many = await s.tool("nexus_counterpart_ensure", {
      name: "韩梅梅",
      userStatementRef: "韩梅梅说",
    });
    assert.equal(many.ambiguous, true);
    assert.equal(many.candidates.length, 2);
    assert.equal(many.counterpartId, undefined);
  });

  it("never shows contact values, searches by name, and rejects bad ids and kinds", async () => {
    const made = await s.call("nexus.counterpart.create", {
      displayName: "吴总",
      contacts: [{ type: "phone", value: "13800000000" }],
    });
    const id = made.payload?.counterpart.id;
    const got = await s.tool("nexus_counterpart_get", { counterpartId: id });
    assert.equal(got.hasContactInfo, true);
    assert.equal(JSON.stringify(got).includes("13800000000"), false);
    const found = await s.tool("nexus_counterpart_search", { keyword: "吴" });
    assert.equal(found.people[0]?.counterpartId, id);
    assert.equal(JSON.stringify(found).includes("13800000000"), false);
    assert.equal(
      (await s.tool("nexus_counterpart_get", { counterpartId: "../x" })).code,
      "invalid_counterpart_id",
    );
    assert.equal(
      (
        await s.tool("nexus_counterpart_ensure", {
          name: "某",
          userStatementRef: "x",
          kind: "robot",
        })
      ).code,
      "invalid_params",
    );
    s.as(undefined);
    assert.equal((await s.tool("nexus_counterpart_search", {})).code, "no_principal");
  });
});
