/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
// Stage 3 slice 2 acceptance flows: evidence bytes through the REAL service, tools and RPC handlers on the real kernel
// (in-memory SQLite) with an injectable fake byte store. The real openBlobStore is only exercised on the gateway
// (spikes/blob-flow.mts). What is pinned here: the four-phase protocol (A0 / A1 / A2 / B), the three branches, the
// reservation + object state machine, quotas that fail closed with an R0 notice, and the two-layer reclaim that keeps a
// late write or a late delete from ever hurting a live object.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { decodeBase64 } from "./evidence-rpc.js";
import {
  EvidenceBytesUnavailableError,
  blobStoreTrustRefusal,
  guardBlobStores,
  namespaceFor,
  type EvidenceBlobStores,
} from "./evidence/blob-store.js";
import { normalizeUploadName, type EvidenceServiceDeps } from "./evidence/evidence-service.js";
import { P, world, type Details } from "./test-support/decision-world.js";

type World = ReturnType<typeof world>;

const bytes = (text: string) => new TextEncoder().encode(text);
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");
const b64 = (text: string) => Buffer.from(text).toString("base64");
const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
const MIN = 60_000;

const evidenceWorld = (config?: EvidenceServiceDeps["config"]) =>
  world({ claims: true, evidence: true, ...(config ? { evidenceConfig: config } : {}) });

function service(w: World) {
  assert.ok(w.evidence, "evidence service");
  return w.evidence;
}

async function up(
  w: World,
  taskId: string,
  text: string,
  extra: Partial<Parameters<ReturnType<typeof service>["upload"]>[0]> = {},
) {
  return service(w).upload({
    principal: P,
    taskId,
    name: "receipt.txt",
    classification: "personal",
    bytes: bytes(text),
    actor: "operator:test",
    ...extra,
  });
}

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
const reservationRow = (w: World, hash: string) =>
  w.row(
    "SELECT * FROM blob_reservations WHERE content_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    hash,
  );
const prod = (w: World) => w.blobs.peek("nexus-ev", P.ownerId);
const stage = (w: World) => w.blobs.peek("nexus-stg", P.ownerId);

describe("namespaces, names and base64", () => {
  it("namespaces are fixed-length digests, never the raw owner id", () => {
    const a = namespaceFor("nexus-ev", "local");
    assert.match(a, /^nexus-ev-[0-9a-f]{32}$/);
    assert.match(namespaceFor("nexus-stg", "local"), /^nexus-stg-[0-9a-f]{32}$/);
    assert.notEqual(a, namespaceFor("nexus-ev", "other"));
    // an owner id that would be an unsafe path segment still yields a safe namespace
    assert.match(
      namespaceFor("nexus-ev", "a/b@example.com ".repeat(20)),
      /^nexus-ev-[0-9a-f]{32}$/,
    );
  });

  it("upload names are normalised and bounded", () => {
    assert.equal(normalizeUploadName("  re\u0000ceipt.pdf \n"), "receipt.pdf");
    assert.equal(normalizeUploadName("   "), undefined);
    assert.equal(normalizeUploadName(7), undefined);
    assert.equal(Array.from(normalizeUploadName("x".repeat(500)) ?? "").length, 200);
  });

  it("base64 is decoded strictly: padding, alphabet and size are all enforced", () => {
    assert.deepEqual([...(decodeBase64(b64("abc"), 100) as Uint8Array)], [97, 98, 99]);
    assert.equal(decodeBase64("abc", 100), "invalid");
    assert.equal(decodeBase64("ab!d", 100), "invalid");
    assert.equal(decodeBase64("", 100), "invalid");
    assert.equal(decodeBase64(b64("x".repeat(200)), 100), "too_large");
    assert.equal(decodeBase64(12, 100), "invalid");
  });
});

describe("the three branches (A1)", () => {
  it("new_object: stages, promotes under <hash>.<generation>, then admits in one transaction", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const h = hashOf("hello receipt");
    const r = await up(w, t, "hello receipt");
    assert.equal(r.outcome, "registered");
    assert.ok(r.outcome === "registered");
    assert.equal(r.branch, "new_object");
    assert.equal(r.blobKey, `${h}.1`);
    assert.ok(prod(w).has(`${h}.1`), "bytes are in the production namespace");
    assert.equal(stage(w).size, 0, "the staging copy is deleted after admission");
    const object = objectRow(w, `${h}.1`);
    assert.equal(object.state, "live");
    assert.equal(object.ref_count, 1);
    assert.equal(object.writer_attempt_id, null);
    assert.equal(object.writer_lease_until, null);
    assert.equal(object.writer_incarnation, null);
    assert.equal(object.writer_settled_reason, "committed");
    assert.equal(object.settled_writer_incarnation, "inc-test");
    assert.equal(reservationRow(w, h).state, "consumed");
    const evidence = w.row("SELECT * FROM evidence WHERE id = ?", r.evidenceId);
    assert.equal(evidence.source_group, "user_upload");
    assert.equal(evidence.kind, "uploaded_file");
    assert.equal(evidence.source_ref_kind, "blob");
    assert.equal(evidence.source_ref_id, `${h}.1`);
    assert.equal(evidence.source_group_rule_version, 2);
    assert.equal(evidence.byte_size, "hello receipt".length);
    assert.equal(
      evidence.source_identity_hash,
      sha256Hex(
        canonicalJson({ locator: "upload:receipt.txt", version: `content:${h}`, contentHash: h }),
      ),
    );
    assert.equal(w.count("SELECT COUNT(*) AS c FROM claim_events"), 0, "no claim named, no event");
  });

  it("reuse_evidence: the same material twice in a Task is one row and writes no bytes", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    await up(w, t, "same bytes");
    const putsBefore = w.blobs.calls.put.filter((c) => c.startsWith("ev:")).length;
    const again = await up(w, t, "same bytes");
    assert.ok(again.outcome === "registered");
    assert.equal(again.branch, "reuse_evidence");
    assert.equal(again.reusedEvidence, true);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM evidence"), 1);
    assert.equal(w.blobs.calls.put.filter((c) => c.startsWith("ev:")).length, putsBefore);
    assert.equal(objectRow(w, `${hashOf("same bytes")}.1`).ref_count, 1);
  });

  it("attach_live_object: another name for bytes the owner already holds is a new evidence row on the same object", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const t2 = w.newTask();
    await up(w, t, "shared bytes");
    const putsBefore = w.blobs.calls.put.filter((c) => c.startsWith("ev:")).length;
    const second = await up(w, t2, "shared bytes", { name: "copy.txt" });
    assert.ok(second.outcome === "registered");
    assert.equal(second.branch, "attach_live_object");
    assert.equal(second.reusedEvidence, false);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM evidence"), 2);
    assert.equal(w.blobs.calls.put.filter((c) => c.startsWith("ev:")).length, putsBefore);
    const object = objectRow(w, `${hashOf("shared bytes")}.1`);
    assert.equal(object.ref_count, 2);
    assert.equal(
      w.count("SELECT COUNT(*) AS c FROM blob_objects"),
      1,
      "one physical object, however many Tasks reference it",
    );
    assert.equal(w.k.blobStats({ principal: P }).ownerBytes, "shared bytes".length);
  });

  it("two parallel uploads of the same bytes write the object once", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const [a, b] = await Promise.all([up(w, t, "race bytes"), up(w, t, "race bytes")]);
    assert.ok(a.outcome === "registered" && b.outcome === "registered");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM evidence"), 1);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM blob_objects"), 1);
    assert.equal(w.blobs.calls.put.filter((c) => c.startsWith("ev:")).length, 1);
    assert.equal(
      [a, b].filter((r) => r.outcome === "registered" && r.branch === "new_object").length,
      1,
    );
  });

  it("a piece of evidence deleted on request is never silently restored", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const first = await up(w, t, "to be deleted");
    assert.ok(first.outcome === "registered");
    // what a single-evidence delete does (DESIGN 9.4): blob_key NULL, redaction purged, the hash stays
    w.db.exec(
      `UPDATE evidence SET blob_key = NULL, redaction_state = 'purged' WHERE id = '${first.evidenceId}'`,
    );
    const again = await up(w, t, "to be deleted");
    assert.equal(again.outcome, "evidence_purged");
  });
});

describe("evidence on claims: the relation is never the model's call", () => {
  it("an operator upload with a declared relation plus an execution receipt is two independent groups: VERIFIED", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "booking",
      predicate: "executed",
      completion: "VERIFIED",
    });
    assert.equal(claim.ok, true, JSON.stringify(claim));
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
    // the claim's value must name the action for the v1 verifier; re-assert is refused (value conflict), so use a fresh claim
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
    const linked = await up(w, t, "bank statement: charge of 100", {
      name: "statement.txt",
      claimId: bound.claimId as string,
      operatorRelation: { relation: "supports", reason: "the statement shows the charge" },
    });
    assert.ok(linked.outcome === "linked", JSON.stringify(linked));
    assert.equal(linked.relation, "supports");
    assert.equal(linked.stateAfter, "VERIFIED");
    const detail = w.k.getClaim({ principal: P, taskId: t, claimId: bound.claimId as string });
    assert.equal(detail?.supportGroups, 2);
    const event = w.row(
      "SELECT relation, relation_rule_version, relation_reason FROM claim_event_evidence WHERE evidence_id = ?",
      linked.evidenceId,
    );
    assert.equal(event.relation, "supports");
    assert.equal(event.relation_rule_version, 2);
    assert.match(String(event.relation_reason), /operator declared/);
    assert.equal(w.k.verifyChain({ principal: P, taskId: t })?.ok, true);
  });

  it("an Agent attaching an uploaded file by blob ref stays unclassified and counts for nothing", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "refund",
      predicate: "refunded",
    });
    const personal = await up(w, t, "refund email text", { name: "refund.eml" });
    const financial = await up(w, t, "account statement", {
      name: "secret-account.pdf",
      classification: "financial",
    });
    assert.ok(personal.outcome === "registered" && financial.outcome === "registered");

    const listed = await claimCall(w, "nexus_claim_verify", { taskId: t });
    const unlinked = listed.unlinkedEvidence as Array<Record<string, unknown>>;
    assert.equal(unlinked.length, 2);
    const byKey = new Map(unlinked.map((row) => [row.blobKey, row]));
    assert.equal(byKey.get(personal.blobKey)?.name, "refund.eml");
    assert.equal(
      byKey.get(financial.blobKey)?.name,
      undefined,
      "names of financial material are not shown to the model",
    );
    assert.equal(byKey.get(financial.blobKey)?.classification, "financial");

    const attached = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId: claim.claimId,
      ref: { kind: "blob", id: personal.blobKey },
    });
    assert.equal(attached.ok, true, JSON.stringify(attached));
    assert.equal(attached.relation, "unclassified");
    assert.equal(attached.stateAfter, "ASSERTED");
    assert.match(String(attached.notice), /NOT supported/);
    const detail = w.k.getClaim({ principal: P, taskId: t, claimId: claim.claimId as string });
    assert.equal(detail?.supportGroups, 0);

    // attaching again is idempotent
    const twice = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId: claim.claimId,
      ref: { kind: "blob", id: personal.blobKey },
    });
    assert.equal(twice.alreadyLinked, true);

    // the operator can then declare the relation: it upgrades the unclassified link
    const declared = await w.rpc("nexus.evidence.link", {
      taskId: t,
      claimId: claim.claimId,
      blobKey: personal.blobKey,
      relation: "supports",
      relationReason: "the email confirms the refund",
    });
    assert.equal(declared.ok, true, JSON.stringify(declared));
    assert.equal(declared.payload?.outcome, "linked");
    assert.equal(declared.payload?.stateAfter, "SUPPORTED");
    assert.equal(w.k.verifyChain({ principal: P, taskId: t })?.ok, true);
  });

  it("a blob ref carries its source facts from the first registration: it cannot be relabelled", async () => {
    const w = evidenceWorld();
    const t1 = w.newTask();
    const t2 = w.newTask();
    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t2,
      subject: "x",
      predicate: "p",
    });
    const first = await up(w, t1, "cross task bytes", {
      name: "orig.txt",
      classification: "sensitive",
    });
    assert.ok(first.outcome === "registered");
    const attached = await claimCall(w, "nexus_evidence_add", {
      taskId: t2,
      claimId: claim.claimId,
      ref: { kind: "blob", id: first.blobKey },
    });
    assert.equal(attached.ok, true, JSON.stringify(attached));
    const copy = w.row(
      "SELECT * FROM evidence WHERE task_id = ? AND blob_key = ?",
      t2,
      first.blobKey,
    );
    assert.equal(copy.source_group, "user_upload");
    assert.equal(copy.source_locator_canonical, "upload:orig.txt");
    assert.equal(copy.content_classification, "sensitive");
    assert.equal(objectRow(w, first.blobKey).ref_count, 2);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM blob_objects"), 1);
  });

  it("another owner cannot reach the object; a missing or altered object is never linked", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "x",
      predicate: "p",
    });
    const stored = await up(w, t, "tamper me");
    assert.ok(stored.outcome === "registered");
    const other = { ownerId: "someone-else" };
    const foreign = await service(w).attachBlob({
      principal: other,
      taskId: t,
      claimId: claim.claimId as string,
      blobKey: stored.blobKey,
      actor: "agent:test",
      eventSource: "store",
    });
    assert.equal(foreign.outcome, "not_found");

    prod(w).set(stored.blobKey, bytes("tamper me!"));
    const altered = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId: claim.claimId,
      ref: { kind: "blob", id: stored.blobKey },
    });
    assert.equal(altered.code, "blob_corrupt");
    assert.equal(
      w.count("SELECT COUNT(*) AS c FROM claim_events WHERE transition = 'evidence'"),
      0,
    );

    prod(w).delete(stored.blobKey);
    const missing = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId: claim.claimId,
      ref: { kind: "blob", id: stored.blobKey },
    });
    assert.equal(missing.code, "blob_corrupt");
    const unknown = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId: claim.claimId,
      ref: { kind: "blob", id: `${"0".repeat(64)}.1` },
    });
    assert.equal(unknown.code, "ref_not_found");
  });

  it("blob refs are not supported while evidence bytes are off", async () => {
    const w = world({ claims: true });
    const t = w.newTask();
    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "x",
      predicate: "p",
    });
    const out = await claimCall(w, "nexus_evidence_add", {
      taskId: t,
      claimId: claim.claimId,
      ref: { kind: "blob", id: `${"a".repeat(64)}.1` },
    });
    assert.equal(out.code, "ref_kind_not_supported");
  });
});

describe("quotas fail closed and tell the user (R0 notice)", () => {
  const small = { limits: { taskQuotaBytes: 100, ownerQuotaBytes: 1000, maxEntryBytes: 500 } };

  it("a Task over its soft quota is refused before any byte is written, with one R0 decision", async () => {
    const w = evidenceWorld(small);
    const t = w.newTask();
    const ok = await up(w, t, "a".repeat(60));
    assert.equal(ok.outcome, "registered");
    const putsBefore = w.blobs.calls.put.length;
    const refused = await up(w, t, "b".repeat(60));
    assert.equal(refused.outcome, "quota_exceeded");
    assert.ok(refused.outcome === "quota_exceeded");
    assert.equal(refused.scope, "task");
    assert.equal(refused.used, 60);
    assert.equal(typeof refused.noticeDecisionId, "string");
    assert.equal(w.blobs.calls.put.length, putsBefore, "nothing was staged or promoted");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM blob_objects"), 1);
    assert.equal(w.count("SELECT COUNT(*) AS c FROM blob_reservations"), 1);
    const decision = w.row(
      "SELECT * FROM decisions WHERE id = ?",
      refused.noticeDecisionId as string,
    );
    assert.equal(decision.decision_type, "evidence_quota");
    assert.equal(decision.risk_tier, "R0");
    assert.equal(decision.effect_kind, "acknowledge");
    assert.equal(decision.status, "pending");
    assert.match(String(decision.question), /证据空间已满/);
    // a second refusal reuses the pending card instead of stacking another
    const again = await up(w, t, "c".repeat(60));
    assert.ok(again.outcome === "quota_exceeded");
    assert.equal(again.noticeDecisionId, refused.noticeDecisionId);
    assert.equal(
      w.count("SELECT COUNT(*) AS c FROM decisions WHERE decision_type = 'evidence_quota'"),
      1,
    );
  });

  it("identical bytes the Task already holds still go through when the quota is full", async () => {
    const w = evidenceWorld(small);
    const t = w.newTask();
    await up(w, t, "d".repeat(95));
    const again = await up(w, t, "d".repeat(95));
    assert.equal(again.outcome, "registered");
  });

  it("the owner quota counts physical objects across Tasks", async () => {
    const w = evidenceWorld({
      limits: { taskQuotaBytes: 1000, ownerQuotaBytes: 100, maxEntryBytes: 500 },
    });
    const t1 = w.newTask();
    const t2 = w.newTask();
    await up(w, t1, "e".repeat(60));
    const refused = await up(w, t2, "f".repeat(60));
    assert.ok(refused.outcome === "quota_exceeded");
    assert.equal(refused.scope, "owner");
    const shared = await up(w, t2, "e".repeat(60), { name: "again.txt" });
    assert.equal(shared.outcome, "registered", "the same physical bytes are not charged twice");
  });

  it("a piece larger than the entry limit is refused without a notice", async () => {
    const w = evidenceWorld(small);
    const t = w.newTask();
    const refused = await up(w, t, "g".repeat(501));
    assert.ok(refused.outcome === "quota_exceeded");
    assert.equal(refused.scope, "entry");
    assert.equal(refused.noticeDecisionId, null);
    assert.equal(
      w.count("SELECT COUNT(*) AS c FROM decisions WHERE decision_type = 'evidence_quota'"),
      0,
    );
  });

  it("a failed phase B keeps counting against the quota until reclaim (the bytes are not unowned)", async () => {
    const w = evidenceWorld(small);
    const t = w.newTask();
    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "x",
      predicate: "p",
    });
    const hold = w.blobs.holdPut(`${hashOf("h".repeat(60))}.1`);
    const pending = up(w, t, "h".repeat(60), {
      claimId: claim.claimId as string,
      expectedHeadEventId: claim.headEventId as string,
      operatorRelation: { relation: "supports", reason: "r" },
    });
    await hold.started;
    // the claim moves while the bytes are being written
    await claimCall(w, "nexus_claim_add", {
      taskId: t,
      claimId: claim.claimId,
      subject: "x",
      predicate: "p",
      state: "UNKNOWN",
    });
    hold.release();
    const out = await pending;
    assert.equal(out.outcome, "stale_head");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM evidence"), 0);
    assert.equal(reservationRow(w, hashOf("h".repeat(60))).state, "reserved");
    assert.equal(objectRow(w, `${hashOf("h".repeat(60))}.1`).state, "writing");
    const refused = await up(w, t, "i".repeat(60));
    assert.ok(refused.outcome === "quota_exceeded", "the stranded 60 bytes still count");
    assert.equal(refused.used, 60);
  });
});

describe("reclaim: two layers, so a late write or a late delete never hurts a live object", () => {
  it("an A2 that failed leaves a reservation; after expiry reclaim deletes the object and proves absence", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const h = hashOf("fail me");
    w.blobs.failNextPut();
    const out = await up(w, t, "fail me");
    assert.equal(out.outcome, "storage_error");
    assert.equal(objectRow(w, `${h}.1`).state, "writing");
    assert.equal(reservationRow(w, h).state, "reserved");
    assert.equal(prod(w).size, 0);
    assert.equal(stage(w).size, 0, "staging is cleaned even on failure");
    assert.equal(w.k.blobStats({ principal: P }).ownerBytes, "fail me".length);

    const early = await service(w).maintain(P);
    assert.equal(
      early.claimed,
      0,
      "nothing is claimed before the reservation and the writer lease expire",
    );

    w.advance(2 * MIN);
    const report = await service(w).maintain(P);
    assert.equal(report.claimed, 1);
    assert.equal(report.deleted, 1);
    const object = objectRow(w, `${h}.1`);
    assert.equal(object.state, "deleted");
    assert.equal(object.writer_settled_reason, "awaited");
    assert.notEqual(object.absence_verified_at, null);
    assert.equal(object.reclaim_attempt_id, null);
    assert.equal(reservationRow(w, h).state, "abandoned");
    assert.equal(w.k.blobStats({ principal: P }).ownerBytes, 0);

    // the same content can now be written again: a NEW generation, never the old key
    const retry = await up(w, t, "fail me");
    assert.ok(retry.outcome === "registered");
    assert.equal(retry.blobKey, `${h}.2`);
  });

  it("late A2 write (design case 1): reclaim waits for the real write to settle, so no unowned bytes are left", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const h = hashOf("late write");
    const hold = w.blobs.holdPut(`${h}.1`);
    const pending = up(w, t, "late write");
    await hold.started;
    w.advance(2 * MIN);
    const reclaim = service(w).maintain(P);
    await tick();
    await tick();
    assert.equal(objectRow(w, `${h}.1`).state, "reclaiming", "claimed before the write finished");
    hold.release();
    const [upload, report] = await Promise.all([pending, reclaim]);
    assert.equal(upload.outcome, "reservation_lost");
    assert.equal(report.deleted, 1);
    assert.equal(prod(w).size, 0, "the late write was deleted after it landed");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM evidence"), 0);
    const object = objectRow(w, `${h}.1`);
    assert.equal(object.state, "deleted");
    assert.equal(object.writer_settled_reason, "awaited");
    assert.notEqual(object.absence_verified_at, null);
  });

  it("late A2 write after ANOTHER process reclaimed it: the tombstone scan deletes it again and withdraws the proof", async () => {
    const w = evidenceWorld({ tombstoneIntervalMs: 10 * MIN });
    const t = w.newTask();
    const h = hashOf("zombie write");
    const hold = w.blobs.holdPut(`${h}.1`);
    const pending = up(w, t, "zombie write");
    await hold.started;
    w.advance(2 * MIN);
    // "another process": it uses the kernel directly and knows nothing about our in-flight writer
    const claim = w.k.blobGcClaim({
      principal: P,
      attemptId: "external",
      limit: 5,
      leases: { writerLeaseMs: 30_000, reservationTtlMs: 60_000, reclaimLeaseMs: 60_000 },
      zeroRefGraceMs: 0,
      now: w.now(),
    });
    assert.equal(claim.items.length, 1);
    const item = claim.items[0];
    assert.ok(item);
    const production = await w.blobs.production(P.ownerId);
    await production.remove(item.blobKey);
    const settled = w.k.blobGcSettle({
      principal: P,
      items: [{ ...item, absent: true }],
      now: w.now(),
    });
    assert.equal(settled.deleted, 1);
    assert.equal(
      objectRow(w, `${h}.1`).absence_verified_at,
      null,
      "no proof without a settled writer",
    );

    hold.release();
    const upload = await pending;
    assert.equal(upload.outcome, "reservation_lost");
    assert.ok(prod(w).has(`${h}.1`), "the late write brought the bytes back");

    w.advance(11 * MIN);
    const scan = await service(w).maintain(P);
    assert.equal(scan.tombstonesReappeared, 1);
    assert.equal(prod(w).size, 0);
    assert.equal(objectRow(w, `${h}.1`).absence_invalidated_count, 1);
    // the key is never reused: a fresh upload gets generation 2 and is untouched by any of this
    const fresh = await up(w, t, "zombie write");
    assert.ok(fresh.outcome === "registered");
    assert.equal(fresh.blobKey, `${h}.2`);
    w.advance(11 * MIN);
    await service(w).maintain(P);
    assert.ok(prod(w).has(`${h}.2`), "a tombstone scan never touches another generation");
    assert.equal(objectRow(w, `${h}.2`).state, "live");
  });

  it("a late delete (design case 2) cannot hit a newer generation", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const h = hashOf("late delete");
    w.blobs.failNextPut();
    await up(w, t, "late delete");
    w.advance(2 * MIN);
    const hold = w.blobs.holdRemove(`${h}.1`);
    const slowReclaim = service(w).maintain(P);
    await hold.started;
    // meanwhile the content is written again: generation 2 cannot exist yet (generation 1 is still reclaiming)
    const during = await up(w, t, "late delete");
    assert.notEqual(during.outcome, "registered");
    hold.release();
    await slowReclaim;
    assert.equal(objectRow(w, `${h}.1`).state, "deleted");
    const fresh = await up(w, t, "late delete");
    assert.ok(fresh.outcome === "registered");
    assert.equal(fresh.blobKey, `${h}.2`);
    assert.ok(prod(w).has(`${h}.2`));
  });

  it("an expired reservation is not enough: the writer lease must be over too", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const leases = { writerLeaseMs: 10 * MIN, reservationTtlMs: 1_000, reclaimLeaseMs: MIN };
    const planned = w.k.blobPlan({
      principal: P,
      taskId: t,
      contentHash: hashOf("lease"),
      byteSize: 5,
      facts: {
        kind: "uploaded_file",
        locator: "upload:l",
        version: null,
        sourceGroup: "user_upload",
        classification: "personal",
        meta: {},
      },
      attemptId: "W1",
      incarnationId: "inc-test",
      limits: { taskQuotaBytes: 1000, ownerQuotaBytes: 1000, maxEntryBytes: 1000 },
      leases,
      now: w.now(),
    });
    assert.equal(planned.outcome, "planned");
    w.advance(5_000);
    const early = w.k.blobGcClaim({
      principal: P,
      attemptId: "g1",
      limit: 5,
      leases,
      zeroRefGraceMs: 0,
      now: w.now(),
    });
    assert.equal(early.items.length, 0, "the writer may still be inside its lease");
    w.advance(11 * MIN);
    const late = w.k.blobGcClaim({
      principal: P,
      attemptId: "g2",
      limit: 5,
      leases,
      zeroRefGraceMs: 0,
      now: w.now(),
    });
    assert.equal(late.items.length, 1);
    assert.equal(late.items[0]?.writerAttemptId, "W1");
  });

  it("phase B and reclaim cannot both win: a consumed reservation is never claimed", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const done = await up(w, t, "normal path");
    assert.ok(done.outcome === "registered");
    w.advance(10 * MIN);
    const report = await service(w).maintain(P);
    assert.equal(report.claimed, 0);
    assert.equal(objectRow(w, done.blobKey).state, "live");
    assert.ok(prod(w).has(done.blobKey));
  });

  it("a crash between claim and delete is taken over after the lease with a NEW attempt id", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const h = hashOf("crashy");
    w.blobs.failNextPut();
    await up(w, t, "crashy");
    w.advance(2 * MIN);
    w.blobs.failNextRemove();
    const first = await service(w).maintain(P);
    assert.equal(first.claimed, 1);
    assert.equal(first.deleted, 0, "the delete threw: left reclaiming");
    const stuck = objectRow(w, `${h}.1`);
    assert.equal(stuck.state, "reclaiming");
    const firstAttempt = stuck.reclaim_attempt_id;
    w.advance(2 * MIN);
    const second = await service(w).maintain(P);
    assert.equal(second.deleted, 1);
    assert.equal(objectRow(w, `${h}.1`).state, "deleted");
    assert.notEqual(firstAttempt, null);
    assert.equal(reservationRow(w, h).state, "abandoned");
  });

  it("references are counted from evidence.blob_key, never from ref_count", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const done = await up(w, t, "counted right");
    assert.ok(done.outcome === "registered");
    // ref_count drifts to 0 while the evidence row still owns the bytes
    w.db.exec(`UPDATE blob_objects SET ref_count = 0 WHERE blob_key = '${done.blobKey}'`);
    w.advance(10 * MIN);
    const kept = await service(w).maintain(P);
    assert.equal(kept.claimed, 0, "a drifted projection is not permission to delete");
    assert.ok(prod(w).has(done.blobKey));
    // the evidence is really gone: now the object is garbage
    w.db.exec(`DELETE FROM evidence WHERE id = '${done.evidenceId}'`);
    const swept = await service(w).maintain(P);
    assert.equal(swept.deleted, 1);
    assert.equal(prod(w).size, 0);
    assert.equal(objectRow(w, done.blobKey).state, "deleted");
  });

  it("reconcile reports missing, altered and untracked bytes without deleting anything", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const a = await up(w, t, "alpha alpha");
    const b = await up(w, t, "beta beta beta");
    assert.ok(a.outcome === "registered" && b.outcome === "registered");
    prod(w).delete(a.blobKey);
    prod(w).set(b.blobKey, bytes("x"));
    prod(w).set("stray-key", bytes("stray"));
    const report = await service(w).reconcile(P);
    assert.deepEqual(report.missing, [a.blobKey]);
    assert.deepEqual(report.sizeMismatch, [b.blobKey]);
    assert.deepEqual(report.untracked, ["stray-key"]);
    assert.ok(prod(w).has("stray-key"), "reconcile only reports");
  });
});

describe("phase B revalidates everything after the last await", () => {
  it("a Task that closed while the bytes were being written admits nothing", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const hold = w.blobs.holdPut(`${hashOf("closing")}.1`);
    const pending = up(w, t, "closing");
    await hold.started;
    w.db.exec(`UPDATE nexus_tasks SET status = 'cancelled' WHERE id = '${t}'`);
    hold.release();
    const out = await pending;
    assert.equal(out.outcome, "task_closed");
    assert.equal(w.count("SELECT COUNT(*) AS c FROM evidence"), 0);
    assert.equal(reservationRow(w, hashOf("closing")).state, "reserved");
  });

  it("a closed Task is refused in A0 without touching the byte store", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    w.db.exec(`UPDATE nexus_tasks SET status = 'cancelled' WHERE id = '${t}'`);
    const out = await up(w, t, "too late");
    assert.equal(out.outcome, "task_closed");
    assert.equal(w.blobs.calls.put.length, 0);
    const missing = await up(w, "T99999999", "nobody home");
    assert.equal(missing.outcome, "not_found");
    assert.equal(w.blobs.calls.put.length, 0);
  });
});

describe("nexus.evidence.* RPC", () => {
  it("upload validates its input, links with a declared relation, and lists what it stored", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const claim = await claimCall(w, "nexus_claim_add", {
      taskId: t,
      subject: "x",
      predicate: "p",
    });

    const noName = await w.rpc("nexus.evidence.upload", { taskId: t, dataBase64: b64("abc") });
    assert.equal(noName.error?.code, "nexus_invalid_params");
    const badData = await w.rpc("nexus.evidence.upload", {
      taskId: t,
      name: "a.txt",
      dataBase64: "ab!d",
    });
    assert.equal(badData.error?.code, "nexus_invalid_params");
    const badClass = await w.rpc("nexus.evidence.upload", {
      taskId: t,
      name: "a.txt",
      dataBase64: b64("abc"),
      classification: "public",
    });
    assert.equal(badClass.error?.code, "nexus_invalid_params");
    const noRelation = await w.rpc("nexus.evidence.upload", {
      taskId: t,
      claimId: claim.claimId,
      name: "a.txt",
      dataBase64: b64("abc"),
    });
    assert.equal(
      noRelation.error?.code,
      "nexus_invalid_params",
      "linking needs a stated relation and reason",
    );
    const orphanRelation = await w.rpc("nexus.evidence.upload", {
      taskId: t,
      name: "a.txt",
      dataBase64: b64("abc"),
      relation: "supports",
      relationReason: "r",
    });
    assert.equal(orphanRelation.error?.code, "nexus_invalid_params");
    const huge = await w.rpc("nexus.evidence.upload", {
      taskId: t,
      name: "a.txt",
      dataBase64: b64("x".repeat(17 * 1024 * 1024)),
    });
    assert.equal(huge.error?.code, "nexus_quota_exceeded");
    assert.equal(w.blobs.calls.put.length, 0, "nothing was written for any of the refusals");

    const stored = await w.rpc("nexus.evidence.upload", {
      taskId: t,
      name: "note.txt",
      mediaType: "text/plain",
      dataBase64: b64("hello"),
    });
    assert.equal(stored.ok, true, JSON.stringify(stored));
    assert.equal(stored.payload?.outcome, "registered");
    assert.equal(w.emitted.filter((e) => e.event === "evidence_changed").length, 1);

    const linked = await w.rpc("nexus.evidence.upload", {
      taskId: t,
      claimId: claim.claimId,
      name: "proof.txt",
      dataBase64: b64("proof"),
      relation: "supports",
      relationReason: "shows it",
    });
    assert.equal(linked.ok, true, JSON.stringify(linked));
    assert.equal(linked.payload?.outcome, "linked");
    assert.equal(linked.payload?.stateAfter, "SUPPORTED");

    const list = await w.rpc("nexus.evidence.list", { taskId: t });
    const rows = list.payload?.evidence as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    const only = await w.rpc("nexus.evidence.list", { taskId: t, onlyUnlinked: true });
    assert.equal((only.payload?.evidence as unknown[] | undefined)?.length, 1);

    const stats = await w.rpc("nexus.evidence.stats");
    assert.equal(
      (stats.payload?.stats as { ownerBytes: number } | undefined)?.ownerBytes,
      "hello".length + "proof".length,
    );
    const recon = await w.rpc("nexus.evidence.reconcile");
    assert.deepEqual(recon.payload?.missing, []);
    const maintain = await w.rpc("nexus.evidence.maintain");
    assert.equal(maintain.ok, true);
  });

  it("the SDK byte limits are what the real adapter would be opened with", async () => {
    const { SDK_LIMITS, STAGING_LIMITS } = await import("./evidence/blob-store.js");
    assert.equal(SDK_LIMITS.pluginBytes, 512 * 1024 * 1024);
    assert.equal(SDK_LIMITS.entryBytes, 100 * 1024 * 1024);
    assert.ok(STAGING_LIMITS.bytes < SDK_LIMITS.pluginBytes);
  });
});

describe("read handles (nexus.evidence.handle / nexus.evidence.read)", () => {
  const readAll = async (w: World, handleId: string, chunk?: number) => {
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (;;) {
      const out = await service(w).readHandle(P, handleId, offset, chunk ?? 1024 * 1024);
      assert.equal(out.outcome, "chunk", JSON.stringify(out));
      if (out.outcome !== "chunk") {
        throw new Error("unreachable");
      }
      parts.push(out.data);
      offset += out.data.byteLength;
      if (out.eof) {
        return Buffer.concat(parts);
      }
    }
  };

  it("opens a short-lived handle without bytes, reads the object in chunks and checks the hash every time", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const big = "x".repeat(2_500_000) + "tail";
    const up1 = await up(w, t, big, { name: "big.txt" });
    assert.ok(up1.outcome === "registered");
    const opened = await service(w).openReadHandle(P, t, up1.evidenceId);
    assert.ok(opened.outcome === "opened");
    assert.equal(opened.byteSize, big.length);
    assert.equal(opened.contentHash, hashOf(big));
    assert.equal(opened.expiresAt, w.now() + 60_000);
    assert.ok(!("data" in opened), "opening a handle never carries bytes");
    const whole = await readAll(w, opened.handleId);
    assert.equal(whole.toString(), big);
    // a small chunk size and an arbitrary offset
    const mid = await service(w).readHandle(P, opened.handleId, 2_499_998, 100);
    assert.ok(mid.outcome === "chunk");
    assert.equal(Buffer.from(mid.data).toString(), "xxtail");
    assert.equal(mid.eof, true);
    const atEnd = await service(w).readHandle(P, opened.handleId, big.length, 10);
    assert.ok(atEnd.outcome === "chunk" && atEnd.data.byteLength === 0 && atEnd.eof);
    assert.equal(
      (await service(w).readHandle(P, opened.handleId, big.length + 1, 10)).outcome,
      "out_of_range",
    );
  });

  it("a handle expires, is scoped to its owner and its evidence, and unknown ids are refused", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const other = w.newTask();
    const a = await up(w, t, "handle bytes");
    assert.ok(a.outcome === "registered");
    const opened = await service(w).openReadHandle(P, t, a.evidenceId);
    assert.ok(opened.outcome === "opened");
    assert.equal(
      (await service(w).readHandle({ ...P, ownerId: "someone-else" }, opened.handleId, 0, 10))
        .outcome,
      "handle_invalid",
    );
    assert.equal((await service(w).readHandle(P, "EHNOSUCH", 0, 10)).outcome, "handle_invalid");
    // evidence of another Task cannot be opened through this Task
    assert.equal((await service(w).openReadHandle(P, other, a.evidenceId)).outcome, "not_found");
    assert.equal((await service(w).openReadHandle(P, t, "EVNOSUCH")).outcome, "not_found");
    w.advance(60_001);
    assert.equal(
      (await service(w).readHandle(P, opened.handleId, 0, 10)).outcome,
      "handle_invalid",
    );
  });

  it("altered or missing bytes are never served, and a deleted piece of evidence closes its open handle", async () => {
    const w = world({ claims: true, evidence: true, purge: true });
    const t = w.newTask();
    const a = await up(w, t, "original bytes here");
    assert.ok(a.outcome === "registered");
    const opened = await service(w).openReadHandle(P, t, a.evidenceId);
    assert.ok(opened.outcome === "opened");
    const store = prod(w);
    const original = store.get(a.blobKey);
    assert.ok(original);
    store.set(a.blobKey, bytes("tampered bytes here"));
    const bad = await service(w).readHandle(P, opened.handleId, 0, 100);
    assert.deepEqual(bad, { outcome: "integrity_error", reason: "hash_mismatch" });
    store.delete(a.blobKey);
    assert.deepEqual(await service(w).readHandle(P, opened.handleId, 0, 100), {
      outcome: "integrity_error",
      reason: "missing",
    });
    store.set(a.blobKey, original);
    assert.equal((await service(w).readHandle(P, opened.handleId, 0, 100)).outcome, "chunk");

    const deleted = await w.rpc("nexus.evidence.delete", {
      taskId: t,
      evidenceId: a.evidenceId,
      confirmEvidenceId: a.evidenceId,
    });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    assert.deepEqual(await service(w).readHandle(P, opened.handleId, 0, 10), { outcome: "gone" });
    const again = await service(w).openReadHandle(P, t, a.evidenceId);
    assert.equal(again.outcome, "no_bytes");
  });

  it("the RPC pair returns base64 chunks and maps every refusal to a stable code", async () => {
    const w = evidenceWorld();
    const t = w.newTask();
    const a = await up(w, t, "rpc handle bytes");
    assert.ok(a.outcome === "registered");
    const noParams = await w.rpc("nexus.evidence.handle", {});
    assert.equal(noParams.error?.code, "nexus_invalid_params");
    assert.equal(
      (await w.rpc("nexus.evidence.handle", { taskId: t, evidenceId: "EVNOSUCH" })).error?.code,
      "nexus_not_found",
    );
    const opened = await w.rpc("nexus.evidence.handle", { taskId: t, evidenceId: a.evidenceId });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const handleId = String(opened.payload?.handleId);
    const chunk = await w.rpc("nexus.evidence.read", { handleId, offset: 4, length: 6 });
    assert.equal(chunk.ok, true, JSON.stringify(chunk));
    assert.equal(Buffer.from(String(chunk.payload?.dataBase64), "base64").toString(), "handle");
    assert.equal(chunk.payload?.totalBytes, "rpc handle bytes".length);
    assert.equal(chunk.payload?.eof, false);
    assert.equal(chunk.payload?.contentHash, hashOf("rpc handle bytes"));
    assert.equal((await w.rpc("nexus.evidence.read", {})).error?.code, "nexus_invalid_params");
    assert.equal(
      (await w.rpc("nexus.evidence.read", { handleId, length: 0 })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await w.rpc("nexus.evidence.read", { handleId, offset: 999 })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await w.rpc("nexus.evidence.read", { handleId: "EHNOSUCH" })).error?.code,
      "nexus_not_found",
    );
    w.advance(61_000);
    assert.equal((await w.rpc("nexus.evidence.read", { handleId })).error?.code, "nexus_not_found");
  });
});

describe("a host that refuses the blob store (non-bundled install) turns evidence bytes off, nothing else", () => {
  const REFUSAL =
    'openBlobStore is only available for trusted plugins in this release. Plugin "nexus-agent-core" loaded from "/x" with origin "global"; reason=origin-path. Reinstall from the official npm package.';

  it("recognises the host's refusal and nothing else", () => {
    assert.equal(
      blobStoreTrustRefusal(new Error(REFUSAL)),
      "openBlobStore is only available for trusted plugins in this release",
    );
    assert.equal(blobStoreTrustRefusal(new Error("disk full")), undefined);
    assert.equal(blobStoreTrustRefusal("nope"), undefined);
  });

  it("the guard reports once, stays unavailable, and lets other errors through untouched", async () => {
    const reasons: string[] = [];
    const refusing: EvidenceBlobStores = {
      production: async () => {
        throw new Error(REFUSAL);
      },
      staging: async () => {
        throw new Error(REFUSAL);
      },
    };
    const guarded = guardBlobStores(refusing, { onUnavailable: (reason) => reasons.push(reason) });
    assert.equal(guarded.unavailableReason(), undefined);
    await assert.rejects(guarded.production("local"), EvidenceBytesUnavailableError);
    await assert.rejects(guarded.staging("local"), EvidenceBytesUnavailableError);
    await assert.rejects(guarded.production("local"), EvidenceBytesUnavailableError);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0] ?? "", /only available for trusted plugins/u);
    assert.equal(guarded.unavailableReason(), reasons[0]);

    const broken = guardBlobStores(
      {
        production: async () => {
          throw new Error("disk full");
        },
        staging: async () => {
          throw new Error("disk full");
        },
      },
      { onUnavailable: (reason) => reasons.push(reason) },
    );
    await assert.rejects(broken.production("local"), /disk full/u);
    assert.equal(broken.unavailableReason(), undefined);
    assert.equal(reasons.length, 1);
  });

  it("RPC and tool report evidence_bytes_unavailable; claims, execution evidence and task RPC keep working", async () => {
    const reasons: string[] = [];
    let refuse = false;
    // a world whose byte store the host starts refusing after one successful upload
    const gated = world({
      claims: true,
      evidence: true,
      wrapBlobs: (inner) =>
        guardBlobStores(
          {
            production: async (owner) => {
              if (refuse) {
                throw new Error(REFUSAL);
              }
              return inner.production(owner);
            },
            staging: async (owner) => {
              if (refuse) {
                throw new Error(REFUSAL);
              }
              return inner.staging(owner);
            },
          },
          { onUnavailable: (reason) => reasons.push(reason) },
        ),
    });
    const t = gated.newTask();
    const claim = await claimCall(gated, "nexus_claim_add", {
      taskId: t,
      subject: "doc",
      predicate: "uploaded",
    });
    assert.equal(claim.ok, true, JSON.stringify(claim));
    const stored = await up(gated, t, "bytes that were stored while the host still allowed it");
    assert.ok(stored.outcome === "registered", JSON.stringify(stored));

    refuse = true;
    const upload = await gated.rpc("nexus.evidence.upload", {
      taskId: t,
      name: "late.txt",
      classification: "personal",
      dataBase64: b64("more"),
    });
    assert.equal(upload.error?.code, "nexus_evidence_unavailable", JSON.stringify(upload));
    const opened = await gated.rpc("nexus.evidence.handle", {
      taskId: t,
      evidenceId: stored.evidenceId,
    });
    const handleId = opened.payload?.handleId as string;
    assert.ok(handleId, JSON.stringify(opened));
    const chunk = await gated.rpc("nexus.evidence.read", { handleId, offset: 0, length: 10 });
    assert.equal(chunk.error?.code, "nexus_evidence_unavailable", JSON.stringify(chunk));
    const attached = await claimCall(gated, "nexus_evidence_add", {
      taskId: t,
      claimId: claim.claimId,
      ref: { kind: "blob", id: stored.blobKey },
    });
    assert.equal(attached.ok, false);
    assert.equal(attached.code, "evidence_bytes_unavailable", JSON.stringify(attached));
    assert.equal(reasons.length, 1, "the refusal is reported once, not per call");

    const list = await gated.rpc("nexus.evidence.list", { taskId: t });
    assert.equal(list.ok, true, JSON.stringify(list));
    assert.equal((await gated.rpc("nexus.claim.list", { taskId: t })).error, undefined);
    const another = await claimCall(gated, "nexus_claim_add", {
      taskId: t,
      subject: "still works",
      predicate: "p",
    });
    assert.equal(another.ok, true, JSON.stringify(another));
  });
});
