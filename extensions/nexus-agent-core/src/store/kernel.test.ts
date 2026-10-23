// Task store kernel tests (DESIGN section 13, Stage 1). Runs the real SQL against node:sqlite in memory;
// the tests share one database and run in order, like a single Task's life.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { canonicalJson, requestFingerprint } from "../canonical.js";
import {
  applyMigrations,
  createTaskKernel,
  type CreateInput,
  type UpdateInput,
  type UpdateOutcome,
} from "./kernel.js";
import type { Principal, TaskStatus } from "./types.js";

describe("task store kernel", () => {
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
  const count = (sql: string): number => Number((db.prepare(sql).get() as { c: number }).c);
  const must = <T>(value: T | null | undefined): T => {
    assert.ok(value !== null && value !== undefined);
    return value;
  };
  const applied = applyMigrations(db, tx);
  const k = createTaskKernel(db, tx);
  const P: Principal = { ownerId: "local" };
  const Q: Principal = { ownerId: "other" };
  const entities = { dest: "tokyo", date: "2026-03-12", pax: 2 };
  const goal = { dest: "tokyo" };
  const mk = (id: string, over: Partial<CreateInput> = {}): CreateInput => ({
    principal: P,
    id,
    kind: "flight",
    title: "订东京机票",
    goal,
    entities,
    idempotencyKey: `op_${id}`,
    fingerprint: requestFingerprint({ kind: "flight", entities, goal }),
    sessionKey: "agent:main:main",
    now: 1000,
    ...over,
  });
  const upsert = (patch: UpdateInput["patch"], now: number, over: Partial<UpdateInput> = {}) =>
    k.update({ principal: P, taskId: "T1", patch, sessionKey: "s2", now, ...over });
  const upsertOk = (patch: UpdateInput["patch"], now: number) =>
    upsert(patch, now) as Extract<UpdateOutcome, { outcome: "updated" | "unchanged" }>;

  it("applies the migration once and is idempotent", () => {
    assert.deepEqual(applied, [
      "stage1-0001-task-core",
      "stage2-0001-decision-grant-execution",
      "stage3-0001-claim-evidence-ledger",
      "stage3-0002-blob-reservations",
      "stage3-0003-purge",
      "stage4-0001-preferences",
      "stage4-0002-watches",
      "stage5-0001-vault",
    ]);
    assert.deepEqual(applyMigrations(db, tx), []);
  });
  it("has foreign keys on", () => assert.equal(k.info().foreignKeys, 1));
  it("creates a Task in clarifying with revision 1 and default R1 ceiling", () => {
    const result = k.create(mk("T1"));
    assert.equal(result.outcome, "created");
    assert.equal(result.task.status, "clarifying");
    assert.equal(result.task.revision, 1);
    assert.equal(result.task.riskCeiling, "R1");
  });
  it("replays the same idempotency key with the same fingerprint", () => {
    assert.equal(k.create(mk("T1b", { idempotencyKey: "op_T1" })).outcome, "replayed");
  });
  it("reports a fingerprint conflict instead of reusing the old Task", () => {
    assert.equal(
      k.create(mk("T1c", { idempotencyKey: "op_T1", fingerprint: "x" })).outcome,
      "fingerprint_conflict",
    );
    assert.equal(count("SELECT count(*) AS c FROM nexus_tasks"), 1);
  });
  it("isolates owners on every read and write", () => {
    assert.equal(k.get({ principal: Q, taskId: "T1", now: 1, stepLimit: 5 }), null);
    assert.equal(k.list({ principal: Q, includeClosed: true, limit: 9 }).length, 0);
    assert.equal(upsert({ summary: "x" }, 2, { principal: Q }).outcome, "not_found");
    assert.equal(k.create(mk("TQ", { principal: Q, idempotencyKey: "op_T1" })).outcome, "created");
  });
  it("finds identical-entity duplicates but not other months or other kinds", () => {
    const find = (kind: string, e: unknown) =>
      k.findSimilar({ principal: P, kind, title: "x", entities: e, sinceMs: 0, limit: 5 });
    assert.equal(find("flight", entities)[0]?.task.id, "T1");
    assert.equal(find("flight", { ...entities, date: "2026-04-20" }).length, 0);
    assert.equal(find("hotel", entities).length, 0);
  });
  it("binds the reading session when asked to", () => {
    const detail = must(
      k.get({
        principal: P,
        taskId: "T1",
        bindSessionKey: "agent:main:other",
        now: 3000,
        stepLimit: 5,
      }),
    );
    assert.equal(detail.sessions.length, 2);
    assert.equal(detail.steps.length, 0);
  });
  it("bumps the revision only for title, goal or entities changes", () => {
    const title = upsertOk({ title: "订东京机票(含行李)" }, 4000);
    assert.equal(title.outcome, "updated");
    assert.equal(title.task.revision, 2);
    assert.equal(title.revisionBumped, true);
    const status = upsertOk({ status: "planning", summary: "比价中" }, 5000);
    assert.equal(status.task.revision, 2);
    assert.equal(status.task.status, "planning");
    assert.equal(status.revisionBumped, false);
  });
  it("refuses model-set statuses that belong to later stages or to the operator", () => {
    const refused: TaskStatus[] = [
      "succeeded",
      "watching",
      "cancelled",
      "executing",
      "awaiting_decision",
      "deleted",
      "purging",
      "failed",
      "draft",
    ];
    for (const status of refused) {
      assert.equal(upsert({ status }, 6).outcome, "status_not_allowed", status);
    }
  });
  it("detects revision conflicts and unchanged updates", () => {
    assert.equal(upsert({ summary: "z" }, 7, { expectedRevision: 1 }).outcome, "revision_conflict");
    assert.equal(upsert({ summary: "比价中" }, 8).outcome, "unchanged");
  });
  it("appends notes as sequential steps and returns the last N in order", () => {
    const note = (text: string, stepId: string, now: number) =>
      k.note({ principal: P, taskId: "T1", text, stepId, sessionKey: "s", now });
    const first = note("已比价 3 个方案", "S1", 9);
    const second = note("第二条", "S2", 10);
    assert.ok(first.outcome === "added" && second.outcome === "added");
    assert.equal(first.step.seq, 1);
    assert.equal(second.step.seq, 2);
    const last = must(k.get({ principal: P, taskId: "T1", now: 11, stepLimit: 1 }));
    assert.deepEqual(
      last.steps.map((s) => s.seq),
      [2],
    );
    const all = must(k.get({ principal: P, taskId: "T1", now: 11, stepLimit: 5 }));
    assert.deepEqual(
      all.steps.map((s) => s.seq),
      [1, 2],
    );
  });
  it("searches Chinese and ASCII text, never across owners", () => {
    assert.equal(k.search({ principal: P, query: "东京机票", limit: 5 })[0]?.task.id, "T1");
    assert.ok(
      k.search({ principal: P, query: "tokyo", limit: 5 })[0]?.matchedOn.includes("entities"),
    );
    assert.equal(k.search({ principal: P, query: "完全无关的内容xyz", limit: 5 }).length, 0);
    assert.equal(
      k.search({ principal: Q, query: "东京", limit: 5 }).some((x) => x.task.id === "T1"),
      false,
    );
  });
  it("lists open Tasks for the prompt", () => {
    assert.deepEqual(
      k.listOpen({ principal: P, limit: 8 }).map((t) => t.id),
      ["T1"],
    );
  });
  it("aborts idempotently and then rejects updates and notes", () => {
    assert.equal(k.abort({ principal: P, taskId: "T1", now: 20 }).outcome, "aborted");
    assert.equal(k.abort({ principal: P, taskId: "T1", now: 21 }).outcome, "already_cancelled");
    assert.equal(upsert({ summary: "q" }, 22).outcome, "task_closed");
    assert.equal(
      k.note({ principal: P, taskId: "T1", text: "q", stepId: "S3", sessionKey: "s", now: 23 })
        .outcome,
      "task_closed",
    );
    assert.deepEqual(k.listOpen({ principal: P, limit: 8 }), []);
    assert.equal(
      must(k.get({ principal: P, taskId: "T1", now: 24, stepLimit: 5 })).task.status,
      "cancelled",
    );
  });
  it("soft-deletes: hidden everywhere, rows stay, key still replays", () => {
    const storedRevision = count("SELECT revision AS c FROM nexus_tasks WHERE id = 'T1'");
    const deleted = k.softDelete({ principal: P, taskId: "T1", now: 30 });
    assert.equal(deleted.outcome, "deleted");
    assert.equal(deleted.outcome === "deleted" ? deleted.revision : -1, storedRevision);
    assert.equal(k.softDelete({ principal: P, taskId: "T1", now: 31 }).outcome, "already_deleted");
    assert.equal(k.get({ principal: P, taskId: "T1", now: 32, stepLimit: 5 }), null);
    assert.equal(k.list({ principal: P, includeClosed: true, limit: 9 }).length, 0);
    assert.equal(k.search({ principal: P, query: "东京", limit: 5 }).length, 0);
    assert.equal(count("SELECT count(*) AS c FROM nexus_tasks WHERE id = 'T1'"), 1);
    assert.equal(k.create(mk("T9", { idempotencyKey: "op_T1" })).outcome, "replayed");
  });
  it("hides purging Tasks and refuses to soft-delete them", () => {
    k.create(mk("TP", { idempotencyKey: "op_TP" }));
    db.prepare("UPDATE nexus_tasks SET status = 'purging' WHERE id = 'TP'").run();
    assert.equal(k.get({ principal: P, taskId: "TP", now: 1, stepLimit: 5 }), null);
    assert.equal(k.softDelete({ principal: P, taskId: "TP", now: 1 }).outcome, "purging");
  });
  it("rolls back a failed create without leaving a partial row", () => {
    const before = count("SELECT count(*) AS c FROM nexus_tasks");
    assert.throws(() =>
      k.create(mk("TX", { idempotencyKey: "op_TX", kind: null as unknown as string })),
    );
    assert.equal(count("SELECT count(*) AS c FROM nexus_tasks"), before);
  });
  it("cascades steps and sessions when a Task row is hard-deleted", () => {
    db.prepare("DELETE FROM nexus_tasks WHERE id = 'T1'").run();
    assert.equal(count("SELECT count(*) AS c FROM nexus_task_steps"), 0);
    assert.equal(count("SELECT count(*) AS c FROM nexus_task_sessions WHERE task_id = 'T1'"), 0);
  });
  it("canonical JSON ignores key order", () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});
