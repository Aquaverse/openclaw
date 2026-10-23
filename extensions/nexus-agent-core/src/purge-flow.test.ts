// Stage 3 slice 3 acceptance flows: the hard purge protocol (DESIGN 9.4 P1-P5), single-evidence deletion and the
// `incarnation_gone` switch, through the REAL purge service, RPC handlers and kernel on in-memory SQLite with the
// injectable fake byte store. The first test is also the first time a Task with the whole ledger (decisions, grants,
// executions, claims, evidence, objects) is deleted: the foreign-key order of P5 is pinned by it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";
import { sha256Hex } from "./canonical.js";
import type { EvidenceServiceDeps } from "./evidence/evidence-service.js";
import { createPurgeReceiptsRpcHandlers } from "./purge-rpc.js";
import { P, world, type Details } from "./test-support/decision-world.js";

type World = ReturnType<typeof world>;

const bytes = (text: string) => new TextEncoder().encode(text);
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");
const MIN = 60_000;
const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const purgeWorld = (config?: EvidenceServiceDeps["config"], extra: { leaseMs?: number } = {}) =>
  world({
    claims: true,
    evidence: true,
    purge: true,
    ...(config ? { evidenceConfig: config } : {}),
    ...(extra.leaseMs ? { purgeWorkerLeaseMs: extra.leaseMs } : {}),
  });

function evidenceOf(w: World) {
  assert.ok(w.evidence, "evidence service");
  return w.evidence;
}
function purgeOf(w: World) {
  assert.ok(w.purge, "purge service");
  return w.purge;
}

const up = (w: World, taskId: string, text: string, extra: Record<string, unknown> = {}) =>
  evidenceOf(w).upload({
    principal: P,
    taskId,
    name: "receipt.txt",
    classification: "personal",
    bytes: bytes(text),
    actor: "operator:test",
    ...extra,
  } as never);

async function claimCall(
  w: World,
  name: string,
  params: Record<string, unknown>,
): Promise<Details> {
  const tool = w.claimTools("s1").find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name}`);
  const out = (await tool.execute("call", params as never)) as unknown as { details: Details };
  return out.details;
}

const objectRow = (w: World, blobKey: string) =>
  w.row("SELECT * FROM blob_objects WHERE blob_key = ?", blobKey);
const prod = (w: World) => w.blobs.peek("nexus-ev", P.ownerId);

/** Every table that has a task_id column, with the rows it still holds for this Task (receipts are outside the scope). */
function residue(w: World, taskId: string): Record<string, number> {
  const tables = (
    w.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as {
      name: string;
    }[]
  ).map((row) => row.name);
  const out: Record<string, number> = {};
  for (const table of tables) {
    if (table === "purge_receipts") {
      continue;
    }
    const columns = (w.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (column) => column.name,
    );
    const key =
      table === "nexus_tasks" ? "id" : columns.includes("task_id") ? "task_id" : undefined;
    if (!key) {
      continue;
    }
    const n = (
      w.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${key} = ?`).get(taskId) as {
        c: number;
      }
    ).c;
    if (n > 0) {
      out[table] = n;
    }
  }
  return out;
}

/** A Task that touched every part of the ledger: decision + grant + execution + two claims + execution and uploaded evidence. */
async function fullTask(w: World, text = "bank statement: charge of 100") {
  const t = w.newTask();
  const actionId = await w.booking(t);
  const decision = await w.run("nexus_decision_request", {
    taskId: t,
    effect: { actionIds: [actionId] },
  });
  const resolved = await w.rpc("nexus.decision.resolve", {
    decisionId: decision.decisionId as string,
    resolution: "approved",
  });
  const executionId = resolved.payload?.executionId as string;
  await w.run("nexus_action_commit", { executionId });
  const bound = await claimCall(w, "nexus_claim_add", {
    taskId: t,
    subject: "booking confirmed",
    predicate: "executed",
    value: { actionId },
    completion: "VERIFIED",
  });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  const exec = await claimCall(w, "nexus_evidence_add", {
    taskId: t,
    claimId: bound.claimId,
    ref: { kind: "execution", id: executionId },
  });
  assert.equal(exec.stateAfter, "SUPPORTED", JSON.stringify(exec));
  const linked = await up(w, t, text, {
    name: "statement.txt",
    claimId: bound.claimId as string,
    operatorRelation: { relation: "supports", reason: "the statement shows the charge" },
  });
  assert.ok(linked.outcome === "linked", JSON.stringify(linked));
  return {
    taskId: t,
    claimId: bound.claimId as string,
    evidenceId: linked.evidenceId,
    executionId,
  };
}

describe("hard purge of a Task", () => {
  it("destroys a Task with the whole ledger: every row, the bytes, the object; only a hash-and-count receipt remains", async () => {
    const w = purgeWorld();
    const { taskId } = await fullTask(w);
    const other = w.newTask();
    await up(w, other, "an unrelated Task's bytes");
    const hash = hashOf("bank statement: charge of 100");
    const title = (w.row("SELECT title FROM nexus_tasks WHERE id = ?", taskId) as { title: string })
      .title;
    const head = w.row(
      "SELECT digest FROM claim_events WHERE task_id = ? ORDER BY seq DESC LIMIT 1",
      taskId,
    ) as { digest: string };
    const events = w.count("SELECT COUNT(*) AS c FROM claim_events WHERE task_id = ?", taskId);
    assert.ok(Object.keys(residue(w, taskId)).length > 8, JSON.stringify(residue(w, taskId)));
    assert.ok(prod(w).has(`${hash}.1`));

    const out = await purgeOf(w).purge(P, taskId, "operator:test");
    assert.equal(out.outcome, "purged", JSON.stringify(out));
    assert.ok(out.outcome === "purged");
    assert.deepEqual(residue(w, taskId), {}, "nothing of the Task is left in any table");
    assert.equal(prod(w).has(`${hash}.1`), false, "the bytes are gone");
    assert.equal(objectRow(w, `${hash}.1`).state, "deleted");
    assert.notEqual(objectRow(w, `${hash}.1`).absence_verified_at, null);
    assert.equal(w.blobs.peek("nexus-stg", P.ownerId).size, 0);
    assert.equal(prod(w).size, 1, "the other Task's object is untouched");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM nexus_tasks WHERE id = ?", other), 1);

    assert.equal(out.receipt.taskId, taskId);
    assert.equal(out.receipt.ledgerHeadDigest, head.digest);
    assert.equal(out.receipt.claimEventCount, events);
    assert.equal(out.receipt.evidenceCount, 2);
    assert.equal(out.receipt.objectsDeleted, 1);
    assert.equal(out.receipt.objectsRetained, 0);
    const stored = w.row("SELECT * FROM purge_receipts WHERE id = ?", out.receipt.id);
    assert.equal(stored.task_title_hash, sha256Hex(title));
    assert.equal(stored.purged_scope, "all");
    assert.equal(stored.requested_by, "operator:test");
    assert.ok(!JSON.stringify(stored).includes(title), "the receipt never carries the title");
    // the ledger of the run is gone with the Task
    assert.equal(w.count("SELECT COUNT(*) AS c FROM purge_runs"), 0);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM purge_work_items"), 0);
    // the console is told, with ids only
    const notice = w.emitted.find((entry) => entry.event === "task_purged");
    assert.ok(notice);
    assert.equal(notice.payload.taskId, taskId);
    assert.equal(notice.payload.receiptId, out.receipt.id);
    assert.deepEqual(Object.keys(notice.payload).toSorted(), [
      "executedAt",
      "ownerId",
      "receiptId",
      "taskId",
    ]);
    // a purged Task cannot be purged again
    assert.equal((await purgeOf(w).purge(P, taskId, "operator:test")).outcome, "not_found");
  });

  it("a Task without any bytes purges too, and an object another Task still references is kept", async () => {
    const w = purgeWorld();
    const a = w.newTask();
    const b = w.newTask();
    const bare = w.newTask();
    await up(w, a, "shared bytes");
    await up(w, b, "shared bytes", { name: "copy.txt" });
    const key = `${hashOf("shared bytes")}.1`;
    assert.equal(objectRow(w, key).ref_count, 2);

    const first = await purgeOf(w).purge(P, a, "operator:test");
    assert.ok(first.outcome === "purged", JSON.stringify(first));
    assert.equal(first.receipt.objectsRetained, 1);
    assert.equal(first.receipt.objectsDeleted, 0);
    assert.ok(prod(w).has(key), "B still needs these bytes");
    assert.equal(objectRow(w, key).state, "live");
    assert.equal(objectRow(w, key).ref_count, 1);
    assert.equal(
      w.count("SELECT COUNT(*) AS c FROM evidence WHERE task_id = ? AND blob_key = ?", b, key),
      1,
    );

    const second = await purgeOf(w).purge(P, b, "operator:test");
    assert.ok(second.outcome === "purged", JSON.stringify(second));
    assert.equal(second.receipt.objectsDeleted, 1);
    assert.equal(prod(w).size, 0);
    assert.equal(objectRow(w, key).state, "deleted");

    const empty = await purgeOf(w).purge(P, bare, "operator:test");
    assert.ok(empty.outcome === "purged", JSON.stringify(empty));
    assert.equal(empty.receipt.objectsDeleted + empty.receipt.objectsRetained, 0);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM purge_receipts"), 3);
  });

  it("the RPC needs the Task id repeated; the receipts list is hash-and-count only", async () => {
    const w = purgeWorld();
    const t = w.newTask();
    await up(w, t, "rpc bytes");
    const none = await w.rpc("nexus.task.purge", { taskId: t });
    assert.equal(none.ok, false);
    assert.equal(none.error?.code, "nexus_confirmation_required");
    const wrong = await w.rpc("nexus.task.purge", { taskId: t, confirmTaskId: "something-else" });
    assert.equal(wrong.error?.code, "nexus_confirmation_required");
    assert.equal(
      w.count("SELECT COUNT(*) AS c FROM nexus_tasks WHERE id = ?", t),
      1,
      "nothing happened",
    );
    assert.equal(w.count("SELECT COUNT(*) AS c FROM purge_runs"), 0);

    const missing = await w.rpc("nexus.task.purge", {
      taskId: "TNOSUCH01",
      confirmTaskId: "TNOSUCH01",
    });
    assert.equal(missing.error?.code, "nexus_not_found");
    const done = await w.rpc("nexus.task.purge", { taskId: t, confirmTaskId: t });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.payload?.outcome, "purged");
    assert.match(String(done.payload?.notice), /destroyed/);
    const listed = await w.rpc("nexus.task.purgeReceipts", {});
    const receipts = listed.payload?.receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.taskId, t);
    assert.ok(!("title" in (receipts[0] ?? {})));
    assert.equal(
      (await w.rpc("nexus.task.purgeStatus", { taskId: t })).error?.code,
      "nexus_not_found",
    );
  });

  it("a Task with a pending decision is refused (task_busy) before anything is touched", async () => {
    const w = purgeWorld();
    const t = w.newTask();
    await up(w, t, "busy bytes");
    const actionId = await w.booking(t);
    await w.run("nexus_decision_request", { taskId: t, effect: { actionIds: [actionId] } });
    const out = await purgeOf(w).purge(P, t, "operator:test");
    assert.equal(out.outcome, "task_busy");
    assert.ok(out.outcome === "task_busy");
    assert.ok(out.reasons.includes("decision_pending"));
    assert.equal(w.count("SELECT COUNT(*) AS c FROM purge_runs"), 0);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM evidence WHERE task_id = ?", t), 1);
    assert.equal(prod(w).size, 1);
    const rpc = await w.rpc("nexus.task.purge", { taskId: t, confirmTaskId: t });
    assert.equal(rpc.error?.code, "nexus_task_busy");
  });

  it("a purging Task accepts nothing new: uploads and single deletions are refused", async () => {
    const w = purgeWorld();
    const t = w.newTask();
    const first = await up(w, t, "before purge");
    assert.ok(first.outcome === "registered");
    // fail the first byte delete so the run stays open
    w.blobs.failNextRemove();
    const out = await purgeOf(w).purge(P, t, "operator:test");
    assert.equal(out.outcome, "cleanup_pending", JSON.stringify(out));
    assert.equal(
      (w.row("SELECT status FROM nexus_tasks WHERE id = ?", t) as { status: string }).status,
      "purging",
    );
    const upload = await up(w, t, "after purge started");
    assert.notEqual(upload.outcome, "registered");
    const del = await purgeOf(w).deleteEvidence(P, t, first.evidenceId, "operator:test");
    assert.equal(del.outcome, "task_purging");
  });
});

describe("a purge that cannot finish yet", () => {
  it("a failed byte delete leaves cleanup_pending and NO receipt; the same run continues and finishes after the lease", async () => {
    const w = purgeWorld();
    const t = w.newTask();
    await up(w, t, "stubborn bytes");
    const key = `${hashOf("stubborn bytes")}.1`;
    w.blobs.failNextRemove();
    const first = await purgeOf(w).purge(P, t, "operator:test");
    assert.equal(first.outcome, "cleanup_pending", JSON.stringify(first));
    assert.ok(first.outcome === "cleanup_pending");
    assert.equal(
      w.count("SELECT COUNT(*) AS c FROM purge_receipts"),
      0,
      "no receipt before the proof",
    );
    assert.equal(w.count("SELECT COUNT(*) AS c FROM nexus_tasks WHERE id = ?", t), 1);
    assert.ok(prod(w).has(key), "the bytes are still there");
    const run = w.row("SELECT purge_id, phase FROM purge_runs WHERE task_id = ?", t);
    const status = await w.rpc("nexus.task.purgeStatus", { taskId: t });
    assert.equal(
      (status.payload?.status as { purgeId: string } | undefined)?.purgeId,
      run.purge_id,
    );

    w.advance(5 * MIN);
    const second = await purgeOf(w).purge(P, t, "operator:test");
    assert.equal(second.outcome, "purged", JSON.stringify(second));
    assert.equal(prod(w).size, 0);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM purge_receipts"), 1);
  });

  it("a crashed pass is taken over by a NEW worker attempt of the SAME purge_id", async () => {
    const w = purgeWorld(undefined, { leaseMs: 30_000 });
    const t = w.newTask();
    await up(w, t, "crash bytes");
    // a pass that began and died: it only ran P1
    const begin = w.k.purgeBegin({
      principal: P,
      taskId: t,
      requestedBy: "operator:test",
      workerAttemptId: "PW-dead",
      workerLeaseMs: 30_000,
      now: w.now(),
    });
    assert.equal(begin.outcome, "started");
    assert.ok(begin.outcome === "started");
    const purgeId = begin.purgeId;
    const blocked = await purgeOf(w).purge(P, t, "operator:test");
    assert.equal(blocked.outcome, "worker_active", "the dead pass still holds the lease");

    w.advance(31_000);
    const resumed = await purgeOf(w).resume(P);
    assert.equal(resumed, 1);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM nexus_tasks WHERE id = ?", t), 0);
    const receipt = w.row("SELECT * FROM purge_receipts WHERE task_id = ?", t);
    assert.equal(receipt.requested_by, "system:resume");
    assert.equal(prod(w).size, 0);
    assert.ok(purgeId.length > 0);
  });

  it("a second explicit call during a run continues the same run instead of opening another", async () => {
    const w = purgeWorld();
    const t = w.newTask();
    await up(w, t, "twice bytes");
    const [a, b] = await Promise.all([
      purgeOf(w).purge(P, t, "operator:test"),
      purgeOf(w).purge(P, t, "operator:test"),
    ]);
    assert.equal(a.outcome, "purged");
    assert.equal(b.outcome, "purged");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM purge_receipts"), 1, "one receipt, one run");
  });

  it("a reservation whose writer is still in flight: the purge waits for the real write, then deletes it", async () => {
    const w = purgeWorld();
    const t = w.newTask();
    const h = hashOf("late purge write");
    const hold = w.blobs.holdPut(`${h}.1`);
    const pending = up(w, t, "late purge write");
    await hold.started;
    w.advance(2 * MIN);
    const purging = purgeOf(w).purge(P, t, "operator:test");
    await tick();
    await tick();
    hold.release();
    const [upload, out] = await Promise.all([pending, purging]);
    assert.notEqual(upload.outcome, "registered", "the late writer lost");
    assert.equal(out.outcome, "purged", JSON.stringify(out));
    assert.equal(prod(w).size, 0, "the late write was deleted after it landed");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM evidence"), 0);
    assert.equal(objectRow(w, `${h}.1`).state, "deleted");
    assert.notEqual(objectRow(w, `${h}.1`).absence_verified_at, null);
  });

  it("another process already reclaimed an unfinished write: no receipt until the writer is known quiet, then bytes that came back are deleted again", async () => {
    const w = purgeWorld({ tombstoneIntervalMs: 10 * MIN });
    const t = w.newTask();
    const h = hashOf("zombie purge write");
    const hold = w.blobs.holdPut(`${h}.1`);
    const pending = up(w, t, "zombie purge write");
    await hold.started;
    w.advance(2 * MIN);
    const claim = w.k.blobGcClaim({
      principal: P,
      attemptId: "external",
      limit: 5,
      leases: { writerLeaseMs: 30_000, reservationTtlMs: 60_000, reclaimLeaseMs: 60_000 },
      zeroRefGraceMs: 0,
      now: w.now(),
    });
    const item = claim.items[0];
    assert.ok(item);
    await (await w.blobs.production(P.ownerId)).remove(item.blobKey);
    w.k.blobGcSettle({ principal: P, items: [{ ...item, absent: true }], now: w.now() });
    assert.equal(objectRow(w, `${h}.1`).absence_verified_at, null);

    const early = await purgeOf(w).purge(P, t, "operator:test", { budgetMs: 1000 });
    assert.equal(early.outcome, "cleanup_pending", JSON.stringify(early));
    assert.equal(
      w.count("SELECT COUNT(*) AS c FROM purge_receipts"),
      0,
      "a tombstone without a proof is not enough",
    );

    hold.release();
    const upload = await pending;
    assert.notEqual(upload.outcome, "registered");
    assert.ok(prod(w).has(`${h}.1`), "the late write brought the bytes back");
    const done = await purgeOf(w).purge(P, t, "operator:test");
    assert.equal(done.outcome, "purged", JSON.stringify(done));
    assert.equal(prod(w).size, 0, "the returned bytes were deleted before the receipt");
    assert.notEqual(objectRow(w, `${h}.1`).absence_verified_at, null);
  });
});

describe("single-evidence deletion", () => {
  it("releases the reference, keeps the row and the claim state, and the zero-reference scan reclaims the bytes", async () => {
    const w = purgeWorld();
    const { taskId, claimId, evidenceId } = await fullTask(w);
    const key = `${hashOf("bank statement: charge of 100")}.1`;
    const before = w.k.getClaim({ principal: P, taskId, claimId });
    const none = await w.rpc("nexus.evidence.delete", { taskId, evidenceId });
    assert.equal(none.error?.code, "nexus_confirmation_required");
    assert.ok(prod(w).has(key));

    const done = await w.rpc("nexus.evidence.delete", {
      taskId,
      evidenceId,
      confirmEvidenceId: evidenceId,
    });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.payload?.outcome, "deleted");
    assert.equal(done.payload?.orphaned, true);
    const row = w.row(
      "SELECT blob_key, redaction_state, content_hash FROM evidence WHERE id = ?",
      evidenceId,
    );
    assert.equal(row.blob_key, null);
    assert.equal(row.redaction_state, "purged");
    assert.equal(row.content_hash, hashOf("bank statement: charge of 100"));
    assert.equal(objectRow(w, key).ref_count, 0);
    assert.deepEqual(
      w.k.getClaim({ principal: P, taskId, claimId })?.claim.state,
      before?.claim.state,
      "evidence deletion does not rewrite claim state",
    );
    assert.equal(w.k.verifyChain({ principal: P, taskId })?.ok, true);
    const notice = w.emitted.findLast((entry) => entry.event === "evidence_changed");
    assert.equal(notice?.payload.change, "deleted");

    const again = await w.rpc("nexus.evidence.delete", {
      taskId,
      evidenceId,
      confirmEvidenceId: evidenceId,
    });
    assert.equal(again.error?.code, "nexus_conflict");

    w.advance(10 * MIN);
    const swept = await evidenceOf(w).maintain(P);
    assert.equal(swept.deleted, 1);
    assert.equal(prod(w).size, 0);
    // never silently restored by re-uploading the same bytes
    assert.equal(
      (await up(w, taskId, "bank statement: charge of 100", { name: "statement.txt" })).outcome,
      "evidence_purged",
    );
  });

  it("a shared object stays while another Task references it, and unknown evidence is not_found", async () => {
    const w = purgeWorld();
    const a = w.newTask();
    const b = w.newTask();
    const first = await up(w, a, "shared single");
    const second = await up(w, b, "shared single", { name: "b.txt" });
    assert.ok(first.outcome === "registered" && second.outcome === "registered");
    const done = await purgeOf(w).deleteEvidence(P, a, first.evidenceId, "operator:test");
    assert.ok(done.outcome === "deleted");
    assert.equal(done.orphaned, false);
    w.advance(10 * MIN);
    await evidenceOf(w).maintain(P);
    assert.ok(prod(w).has(first.blobKey), "B still references it");
    const missing = await purgeOf(w).deleteEvidence(P, a, "EVNOSUCH", "operator:test");
    assert.equal(missing.outcome, "not_found");
    const foreign = await purgeOf(w).deleteEvidence(P, a, second.evidenceId, "operator:test");
    assert.equal(
      foreign.outcome,
      "not_found",
      "evidence of another Task is not reachable through this one",
    );
  });
});

describe("incarnation_gone", () => {
  const STARTED = 1_000;
  const addIncarnation = (w: World, id: string, boot: string, supersede = false) =>
    w.k.registerIncarnation({
      principal: P,
      incarnationId: id,
      bootId: boot,
      now: STARTED,
      supersedeOthers: supersede,
    });
  const goneOf = (w: World, id: string) =>
    w.row("SELECT gone_at, gone_basis FROM process_incarnations WHERE incarnation_id = ?", id);

  it("starting under a different boot id supersedes unterminated rows only when the switch is on; same boot id and `unavailable` never do", () => {
    const w = purgeWorld();
    addIncarnation(w, "inc-a", "5:5");
    addIncarnation(w, "inc-b", "5:5", true);
    assert.equal(
      goneOf(w, "inc-a").gone_at,
      null,
      "same boot id: a same-process predecessor is never marked",
    );
    addIncarnation(w, "inc-c", "6:6");
    assert.equal(goneOf(w, "inc-b").gone_at, null, "switch off: provenance only");
    addIncarnation(w, "inc-d", "unavailable", true);
    assert.equal(goneOf(w, "inc-c").gone_at, null, "an unreadable boot id never marks anything");
    const r = addIncarnation(w, "inc-e", "7:7", true);
    assert.ok(r.superseded >= 4);
    for (const id of ["inc-a", "inc-b", "inc-c", "inc-test"]) {
      assert.notEqual(goneOf(w, id).gone_at, null, id);
      assert.equal(goneOf(w, id).gone_basis, "superseded_under_gateway_lock");
    }
    assert.equal(goneOf(w, "inc-e").gone_at, null);
  });

  it("without the switch a crashed writer blocks the receipt; with it the purge completes", async () => {
    const run = async (enabled: boolean) => {
      const w = purgeWorld({ incarnationGoneEnabled: enabled });
      const t = w.newTask();
      const h = hashOf("ghost write");
      w.blobs.failNextPut();
      await up(w, t, "ghost write");
      // the writer's process "died": a new attempt id nobody here is awaiting, owned by an incarnation of an old boot
      addIncarnation(w, "inc-ghost", "5:5");
      w.db.exec(
        `UPDATE blob_objects SET writer_attempt_id = 'ghost-attempt', writer_incarnation = 'inc-ghost', writer_settled_reason = NULL WHERE blob_key = '${h}.1'`,
      );
      w.advance(2 * MIN);
      if (enabled) {
        addIncarnation(w, "inc-new", "6:6", true);
      }
      return { w, t, h, out: await purgeOf(w).purge(P, t, "operator:test", { budgetMs: 1000 }) };
    };
    const off = await run(false);
    assert.equal(off.out.outcome, "cleanup_pending", JSON.stringify(off.out));
    assert.ok(off.out.outcome === "cleanup_pending");
    assert.ok(
      off.out.blockers.some((b) => b.startsWith("writer_not_settled:")),
      JSON.stringify(off.out.blockers),
    );
    assert.equal(off.w.count("SELECT COUNT(*) AS c FROM purge_receipts"), 0);

    const on = await run(true);
    assert.equal(on.out.outcome, "purged", JSON.stringify(on.out));
    assert.equal(objectRow(on.w, `${on.h}.1`).writer_settled_reason, "incarnation_gone");
    assert.notEqual(objectRow(on.w, `${on.h}.1`).absence_verified_at, null);
  });

  it("an incarnation without a boot id is never trusted, even if marked gone by hand", async () => {
    const w = purgeWorld({ incarnationGoneEnabled: true });
    const t = w.newTask();
    const h = hashOf("unknown boot");
    w.blobs.failNextPut();
    await up(w, t, "unknown boot");
    addIncarnation(w, "inc-blind", "unavailable");
    w.db.exec(
      `UPDATE process_incarnations SET gone_at = 5, gone_basis = 'superseded_under_gateway_lock' WHERE incarnation_id = 'inc-blind'`,
    );
    w.db.exec(
      `UPDATE blob_objects SET writer_attempt_id = 'ghost-attempt', writer_incarnation = 'inc-blind', writer_settled_reason = NULL WHERE blob_key = '${h}.1'`,
    );
    w.advance(2 * MIN);
    const out = await purgeOf(w).purge(P, t, "operator:test", { budgetMs: 1000 });
    assert.equal(out.outcome, "cleanup_pending", JSON.stringify(out));
    assert.equal(objectRow(w, `${h}.1`).writer_settled_reason, null);
  });
});

describe("an install without evidence bytes (no purge service) still lists purge receipts", () => {
  it("registers the read-only receipts method, which answers with an empty list instead of 'unknown method'", async () => {
    const w = world({ claims: true });
    assert.equal(w.purge, undefined);
    const handlers = createPurgeReceiptsRpcHandlers({
      getStore: async () => w.store,
      resolvePrincipal: () => P,
    });
    assert.deepEqual(
      handlers.map(([method, , scope]) => [method, scope]),
      [["nexus.task.purgeReceipts", "operator.read"]],
    );
    let reply: { ok: boolean; payload?: unknown } | undefined;
    await handlers[0][1]({
      params: { limit: 100 },
      respond: (ok: boolean, payload?: unknown) => {
        reply = { ok, payload };
      },
    } as never);
    assert.equal(reply?.ok, true);
    assert.deepEqual((reply?.payload as { receipts: unknown[] } | undefined)?.receipts, []);
  });
});
