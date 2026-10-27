// Shared fixture of the goal kernel tests (goal-ledger*.test.ts): an in-memory database with every migration applied, the
// kernel on top of it, and small helpers. Real SQL on node:sqlite.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { requestFingerprint } from "../canonical.js";
import type { GoalRecord } from "../store/goal-types.js";
import { applyMigrations } from "../store/kernel.js";
import { createNexusKernel } from "../store/nexus-kernel.js";
import type { Principal } from "../store/types.js";

export const A: Principal = { ownerId: "owner-a" };
export const B: Principal = { ownerId: "owner-b" };
export const MAX = 20;

export function setup() {
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
  const k = createNexusKernel(db, tx);
  let clock = 1_000_000;
  const now = () => (clock += 1_000);
  const count = (sql: string, ...params: (string | number)[]): number =>
    (db.prepare(sql).get(...params) as { c: number }).c;
  let seq = 0;
  /** Issue a grant for `session` and create a goal through it, the way the creation chat does. */
  const createViaGrant = (
    principal: Principal,
    title: string,
    over: {
      category?: "finance" | "interests" | "something_else";
      parentId?: string;
      max?: number;
    } = {},
  ) => {
    seq += 1;
    const session = `agent:main:sess-${seq}`;
    const issued = k.goalGrantIssue({
      principal,
      sessionKey: session,
      category: over.category ?? "interests",
      ...(over.parentId ? { parentId: over.parentId } : {}),
      issuedBy: "operator",
      maxActive: over.max ?? MAX,
      ttlMs: 60_000,
      now: now(),
    });
    assert.equal(issued.outcome, "issued");
    const created = k.goalCreate({
      principal,
      sessionKey: session,
      fields: { title, currentState: "just starting" },
      sensitivity: "normal",
      idempotencyKey: `k-${seq}`,
      maxActive: over.max ?? MAX,
      now: now(),
    });
    return { session, created };
  };
  const mustGoal = (out: { outcome: string; goal?: GoalRecord }): GoalRecord => {
    assert.ok(out.goal, `expected a goal, got ${out.outcome}`);
    return out.goal;
  };
  let pseq = 0;
  const propose = (principal: Principal, title: string, over: Record<string, unknown> = {}) => {
    pseq += 1;
    return k.goalPropose({
      principal,
      category: "interests",
      fields: { title },
      sensitivity: "normal",
      idempotencyKey: `p-${pseq}`,
      now: now(),
      ...over,
    } as Parameters<typeof k.goalPropose>[0]);
  };
  const task = (principal: Principal, id: string) => {
    const entities = { n: id };
    const goal = { n: id };
    const out = k.create({
      principal,
      id,
      kind: "misc",
      title: `task ${id}`,
      goal,
      entities,
      idempotencyKey: `op_${id}`,
      fingerprint: requestFingerprint({ kind: "misc", entities, goal }),
      sessionKey: "agent:main:main",
      now: now(),
    });
    assert.equal(out.outcome, "created");
  };
  return { db, tx, k, now, count, createViaGrant, mustGoal, propose, task };
}

/** The vault's hook object, built the same way the kernel does: by storage presence. */
export function createNexusKernelHooks(db: DatabaseSync) {
  return {
    fileHasGoalLinks(ownerId: string, fileId: string): boolean {
      return (
        db
          .prepare(
            "SELECT 1 AS found FROM goal_links WHERE owner_id = ? AND kind = 'vault_file' AND ref_id = ? LIMIT 1",
          )
          .get(ownerId, fileId) !== undefined
      );
    },
    detachFile(ownerId: string, fileId: string): void {
      db.prepare(
        "DELETE FROM goal_links WHERE owner_id = ? AND kind = 'vault_file' AND ref_id = ?",
      ).run(ownerId, fileId);
    },
  };
}
