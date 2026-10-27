// Goals kernel tests, part 3: the purge protocol (lease, children first, hash-only receipts, resume after a crash).
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A, B, MAX, setup } from "../test-support/goal-kit.js";

describe("goal purge protocol", () => {
  const ctx = setup();
  const { k, now, createViaGrant, mustGoal, db, count } = ctx;
  const begin = (
    goalId: string,
    attemptId: string,
    at = now(),
    principal = A,
    requestedBy = "operator:1",
  ) => k.goalPurgeBegin({ principal, goalId, requestedBy, attemptId, leaseMs: 30_000, now: at });

  it("enters purging for the goal and its sub-goals with stable purge ids and the original requester", () => {
    const parent = mustGoal(createViaGrant(A, "Master a musical instrument").created);
    const kid = mustGoal(
      createViaGrant(A, "Practise scales every day", { parentId: parent.id }).created,
    );
    k.goalEntryAdd({
      principal: A,
      goalId: parent.id,
      kind: "note",
      text: "secret text",
      author: "user",
      allowCompleted: true,
      now: now(),
    });
    k.goalEntryAdd({
      principal: A,
      goalId: kid.id,
      kind: "note",
      text: "more secret text",
      author: "user",
      allowCompleted: true,
      now: now(),
    });
    const out = begin(parent.id, "att-1");
    assert.equal(out.outcome, "started");
    const runs = (out as { runs: { goalId: string; purgeId: string; requestedBy: string }[] }).runs;
    assert.deepEqual(
      runs.map((r) => r.goalId),
      [kid.id, parent.id],
    ); // children first
    assert.notEqual(runs[0]?.purgeId, runs[1]?.purgeId);
    assert.ok(runs.every((r) => r.purgeId.startsWith("GPG_") && r.requestedBy === "operator:1"));
    assert.equal(k.goalGet({ principal: A, goalId: parent.id })?.goal.lifecycle, "purging");
    assert.equal(k.goalGet({ principal: A, goalId: kid.id })?.goal.lifecycle, "purging");
    // invisible to lists, and nothing can be written to it
    assert.equal(k.goalList({ principal: A, query: "instrument", limit: 10 }).total, 0);
    assert.equal(
      k.goalEntryAdd({
        principal: A,
        goalId: parent.id,
        kind: "note",
        text: "n",
        author: "user",
        allowCompleted: true,
        now: now(),
      }).outcome,
      "not_live",
    );
    assert.equal(k.goalDelete({ principal: A, goalId: parent.id, now: now() }).outcome, "purging");
    assert.equal(
      k.goalRestore({ principal: A, goalId: parent.id, maxActive: MAX, now: now() }).outcome,
      "not_deleted",
    );
    // another attempt while the lease is live is told who holds it, with the original requester
    const busy = begin(parent.id, "att-2", now(), A, "someone-else");
    assert.deepEqual(busy, {
      outcome: "worker_active",
      purgeId: runs[0]?.purgeId,
      requestedBy: "operator:1",
    });
    // the parent cannot be finalised before its child, and a stale attempt cannot finalise at all
    const early = k.goalPurgeFinalize({
      ownerId: "owner-a",
      goalId: parent.id,
      attemptId: "att-1",
      leaseMs: 30_000,
      now: now(),
    });
    assert.equal(early.outcome, "children_remain");
    assert.equal(
      k.goalPurgeFinalize({
        ownerId: "owner-a",
        goalId: kid.id,
        attemptId: "att-OLD",
        leaseMs: 30_000,
        now: now(),
      }).outcome,
      "not_holder",
    );
    // finalise child then parent
    const receipts: { purgeId: string; requestedBy: string }[] = [];
    for (const id of [kid.id, parent.id]) {
      const fin = k.goalPurgeFinalize({
        ownerId: "owner-a",
        goalId: id,
        attemptId: "att-1",
        leaseMs: 30_000,
        now: now(),
      });
      assert.equal(fin.outcome, "purged");
      receipts.push((fin as { receipt: { purgeId: string; requestedBy: string } }).receipt);
    }
    assert.deepEqual(
      receipts.map((r) => r.requestedBy),
      ["operator:1", "operator:1"],
    );
    assert.notEqual(receipts[0]?.purgeId, receipts[1]?.purgeId);
    assert.equal(count("SELECT COUNT(*) AS c FROM goals WHERE id IN (?, ?)", parent.id, kid.id), 0);
    assert.equal(
      count("SELECT COUNT(*) AS c FROM goal_entries WHERE goal_id IN (?, ?)", parent.id, kid.id),
      0,
    );
    assert.equal(count("SELECT COUNT(*) AS c FROM goal_purge_runs"), 0);
    // the receipt row carries no raw text
    const dump = JSON.stringify(db.prepare("SELECT * FROM goal_purge_receipts").all());
    for (const text of ["secret text", "Master a musical", "Practise scales"]) {
      assert.ok(!dump.includes(text));
    }
    const rows = k.goalPurgeReceipts({ principal: A, limit: 10 });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.entryCount >= 1 && r.metricCount === 0 && r.reviewCount === 0));
    assert.equal(k.goalPurgeReceipts({ principal: B, limit: 10 }).length, 0);
  });

  it("an expired lease can be taken over, keeping the purge id and requester; a release frees it", () => {
    const g = mustGoal(createViaGrant(A, "Understand index funds").created);
    const first = begin(g.id, "att-a", 5_000_000);
    const purgeId = (first as { runs: { purgeId: string }[] }).runs[0]?.purgeId;
    const late = begin(g.id, "att-b", 5_000_000 + 31_000, A, "ignored-requester");
    assert.equal(late.outcome, "resumed");
    const run = (late as { runs: { purgeId: string; requestedBy: string }[] }).runs[0];
    assert.equal(run?.purgeId, purgeId);
    assert.equal(run?.requestedBy, "operator:1");
    // the previous holder is now stale
    assert.equal(
      k.goalPurgeFinalize({
        ownerId: "owner-a",
        goalId: g.id,
        attemptId: "att-a",
        leaseMs: 1,
        now: 5_040_000,
      }).outcome,
      "not_holder",
    );
    assert.equal(
      k.goalPurgeRelease({ ownerId: "owner-a", attemptId: "att-b", goalIds: [g.id] }),
      1,
    );
    assert.deepEqual(k.goalPurgeResumable({ now: 5_040_000, limit: 10 }), [
      { ownerId: "owner-a", goalId: g.id },
    ]);
    const again = begin(g.id, "att-c", 5_050_000);
    assert.equal(again.outcome, "resumed");
    assert.equal(
      k.goalPurgeFinalize({
        ownerId: "owner-a",
        goalId: g.id,
        attemptId: "att-c",
        leaseMs: 30_000,
        now: 5_060_000,
      }).outcome,
      "purged",
    );
    assert.equal(k.goalPurgeStatus({ principal: A, goalId: g.id, now: 5_060_000 }).outcome, "none");
  });

  it("begin and finalise are owner-scoped and refuse unknown goals", () => {
    const g = mustGoal(createViaGrant(A, "Build a small emergency fund").created);
    assert.equal(begin(g.id, "att-x", now(), B).outcome, "not_found");
    assert.equal(begin("nope", "att-x").outcome, "not_found");
    assert.equal(
      k.goalPurgeFinalize({
        ownerId: "owner-b",
        goalId: g.id,
        attemptId: "att-x",
        leaseMs: 1,
        now: now(),
      }).outcome,
      "not_found",
    );
    // not purging yet: finalise refuses and deletes nothing
    assert.equal(
      k.goalPurgeFinalize({
        ownerId: "owner-a",
        goalId: g.id,
        attemptId: "att-x",
        leaseMs: 1,
        now: now(),
      }).outcome,
      "not_found",
    );
    assert.equal(k.goalGet({ principal: A, goalId: g.id })?.goal.lifecycle, "live");
  });

  it("a purge also removes the goal's creation grant row and leaves linked Tasks alone", () => {
    const g = mustGoal(createViaGrant(A, "Track subscriptions").created);
    ctx.task(A, "T-keep");
    k.goalLinkAdd({ principal: A, goalId: g.id, kind: "task", refId: "T-keep", now: now() });
    assert.equal(
      count("SELECT COUNT(*) AS c FROM goal_creation_grants WHERE goal_id = ?", g.id),
      1,
    );
    begin(g.id, "att-g");
    k.goalPurgeFinalize({
      ownerId: "owner-a",
      goalId: g.id,
      attemptId: "att-g",
      leaseMs: 30_000,
      now: now(),
    });
    assert.equal(
      count("SELECT COUNT(*) AS c FROM goal_creation_grants WHERE goal_id = ?", g.id),
      0,
    );
    assert.equal(count("SELECT COUNT(*) AS c FROM goal_links WHERE goal_id = ?", g.id), 0);
    assert.equal(count("SELECT COUNT(*) AS c FROM nexus_tasks WHERE id = 'T-keep'"), 1);
  });
});
