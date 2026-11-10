// The Agent applying a choice the USER already stated (design 6.8a item 3, W3c-6): nexus_commitment_choose_responsible and
// nexus_commitment_add_helper against the real kernel. The Agent must quote the user, may only name people the user stated, and
// leaves a trace that it (not the console) did it.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { createEventBridge, type WorkChangedPayload } from "../events.js";
import type { TaskStore } from "../store/host.js";
import { applyMigrations } from "../store/kernel.js";
import { createNexusKernel } from "../store/nexus-kernel.js";
import type { Principal } from "../store/types.js";
import { createCommitmentTools } from "./commitment-tools.js";

type Result = Record<string, any> & { ok: boolean; code?: string };

describe("commitment tools: apply the user's stated choice", () => {
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
  const other: Principal = { ownerId: "someone-else" };
  const call = async (
    name: string,
    params: Record<string, unknown>,
    principal = owner,
  ): Promise<Result> => {
    const tool = createCommitmentTools(
      { getStore: async () => store, events, resolvePrincipal: () => principal, now: () => clock },
      { sessionKey: "agent:main:main", agentId: "main" },
    ).find((t) => t.name === name);
    assert.ok(tool, name);
    return ((await tool.execute("c1", params as never)) as { details: Result }).details;
  };
  let n = 0;
  const person = (
    name: string,
    confirmation: "stated" | "proposed" = "stated",
    principal = owner,
  ) => {
    const out = kernel.counterpartCreate({ principal, displayName: name, now: clock });
    assert.equal(out.outcome, "created");
    const id = (out as { counterpart: { id: string } }).counterpart.id;
    if (confirmation !== "stated") {
      db.prepare("UPDATE counterparts SET confirmation = ? WHERE id = ?").run(confirmation, id);
    }
    return id;
  };
  const waiting = async (names: string, workId?: string) => {
    n += 1;
    const out = await call("nexus_commitment_record", {
      requirementText: `一起做 ${n}`,
      userStatementRef: `用户说：${names}一起做 ${n}`,
      responsibleName: names,
      ...(workId ? { workId } : {}),
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.ok(out.waitingForUserChoice);
    return out.commitmentId as string;
  };
  const events_of = (id: string) =>
    db
      .prepare(
        "SELECT actor, payload_json FROM commitment_events WHERE commitment_id = ? ORDER BY seq",
      )
      .all(id) as Array<{ actor: string; payload_json: string }>;

  it("declares both tools and tells the Agent how a waiting commitment is resolved", async () => {
    const id = await waiting("甲一和乙一");
    const read = await call("nexus_commitment_get", { commitmentId: id });
    assert.match(String(read.waitingForUserChoice), /nexus_commitment_choose_responsible/);
  });

  it("form 'lead': one answers, the others help, and the trace says the Agent did it from the user's words", async () => {
    const lead = person("甲二");
    const helper = person("乙二");
    const id = await waiting("甲二和乙二");
    const out = await call("nexus_commitment_choose_responsible", {
      commitmentId: id,
      form: "lead",
      leadId: lead,
      helperIds: [helper],
      helperRole: "participant",
      userStatementRef: "甲二负责，乙二协助",
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.form, "lead");
    const got = await call("nexus_commitment_get", { commitmentId: id });
    assert.equal(got.responsibleResolved, true);
    assert.equal(got.waitingForUserChoice, undefined);
    const link = db
      .prepare(
        "SELECT status, basis_text FROM commitment_participant_links WHERE commitment_id = ?",
      )
      .get(id) as { status: string; basis_text: string };
    assert.equal(link.status, "stated");
    assert.match(link.basis_text, /乙二协助/);
    assert.equal(
      events_of(id).some((e) => e.actor === "agent" && e.payload_json.includes("helper_added")),
      true,
    );
  });

  it("form 'each': one commitment per person, created by the Agent, cited as reference only", async () => {
    const a = person("甲三");
    const b = person("乙三");
    const created = kernel.workCreate({
      principal: owner,
      spec: { title: "报价项目三", origin: "user" },
      now: clock,
    });
    assert.equal(created.outcome, "created");
    const workId = (created as { workId: string }).workId;
    const id = await waiting("甲三和乙三", workId);
    const out = await call("nexus_commitment_choose_responsible", {
      commitmentId: id,
      form: "each",
      counterpartIds: [a, b],
      userStatementRef: "甲三和乙三各做一份",
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.commitments.length, 2);
    const rows = db
      .prepare(
        "SELECT created_by FROM commitments WHERE requirement_text LIKE ? ORDER BY created_at",
      )
      .all(`一起做 ${n}`) as Array<{ created_by: string }>;
    assert.equal(rows.length, 2);
    const roles = db
      .prepare(
        "SELECT l.role FROM work_links l WHERE l.target_kind = 'commitment' AND l.work_id = ?",
      )
      .all(workId) as Array<{ role: string }>;
    assert.equal(
      roles.every((r) => r.role === "reference"),
      true,
    );
    assert.equal(
      emitted.some((e) => e.workId === workId),
      true,
    );
  });

  it("needs the user's words, a known and stated person, a waiting commitment, and the user's own data", async () => {
    const lead = person("甲四");
    const guess = person("乙四", "proposed");
    const id = await waiting("甲四和乙四");
    const base = { commitmentId: id, form: "lead", leadId: lead };
    assert.equal((await call("nexus_commitment_choose_responsible", base)).code, "invalid_params");
    assert.equal(
      (await call("nexus_commitment_choose_responsible", { ...base, userStatementRef: "  " })).code,
      "invalid_params",
    );
    const unstated = await call("nexus_commitment_choose_responsible", {
      ...base,
      helperIds: [guess],
      userStatementRef: "甲四负责",
    });
    assert.equal(unstated.ok, false);
    assert.equal(unstated.code, "counterpart_not_confirmed");
    assert.equal(
      (
        await call("nexus_commitment_choose_responsible", {
          commitmentId: id,
          form: "each",
          counterpartIds: [lead],
          userStatementRef: "x",
        })
      ).code,
      "bad_people_count",
    );
    assert.equal(
      (
        await call(
          "nexus_commitment_choose_responsible",
          { ...base, userStatementRef: "甲四负责" },
          other,
        )
      ).code,
      "not_found",
    );
    const done = await call("nexus_commitment_choose_responsible", {
      ...base,
      userStatementRef: "甲四负责",
    });
    assert.equal(done.ok, true, JSON.stringify(done));
    const again = await call("nexus_commitment_choose_responsible", {
      ...base,
      userStatementRef: "甲四负责",
    });
    assert.equal(again.code, "not_waiting");
    assert.equal(
      (
        await call("nexus_commitment_choose_responsible", {
          ...base,
          form: "either",
          userStatementRef: "x",
        })
      ).code,
      "invalid_params",
    );
  });

  it("adds a helper to an ordinary commitment, refuses the responsible person and unstated people, and is repeatable", async () => {
    const boss = person("张总五");
    const lead = person("王五");
    const guess = person("陌生五", "proposed");
    const made = await call("nexus_commitment_record", {
      requirementText: "交报价五",
      userStatementRef: "王五说周五交报价",
      responsibleName: "王五",
    });
    const id = made.commitmentId as string;
    // the typed name is not yet a person: make the lead the responsible one
    kernel.commitmentUpdate({
      principal: owner,
      commitmentId: id,
      changes: { responsible: { kind: "counterpart", counterpartId: lead } },
      actor: "user",
      now: clock,
    });
    const args = {
      commitmentId: id,
      counterpartId: boss,
      role: "approver",
      userStatementRef: "发给张总五审批",
    };
    const added = await call("nexus_commitment_add_helper", args);
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(added.added, true);
    assert.equal((await call("nexus_commitment_add_helper", args)).alreadyHelping, true);
    assert.equal(
      (await call("nexus_commitment_add_helper", { ...args, counterpartId: lead })).code,
      "is_responsible",
    );
    assert.equal(
      (await call("nexus_commitment_add_helper", { ...args, counterpartId: guess })).code,
      "counterpart_not_confirmed",
    );
    assert.equal(
      (await call("nexus_commitment_add_helper", { ...args, userStatementRef: "" })).code,
      "invalid_params",
    );
    assert.equal(
      (await call("nexus_commitment_add_helper", { ...args, role: "owner" })).code,
      "invalid_params",
    );
    assert.equal((await call("nexus_commitment_add_helper", args, other)).code, "not_found");
    const got = await call("nexus_commitment_get", { commitmentId: id });
    assert.equal(got.responsible, "王五");
  });
});
