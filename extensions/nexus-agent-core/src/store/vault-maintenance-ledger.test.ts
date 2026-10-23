/* oxlint-disable max-lines -- TODO: split this oversized file (one kernel/service unit per file for now). */
// Vault maintenance kernel tests (Vault design 5.2 recovery table, 5.3 reclaim / tombstones / hard purge), F1 slice 1b.
// Real SQL against node:sqlite in memory; the suite shares one database and every test uses its own files.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { applyMigrations } from "./kernel.js";
import { createNexusKernel } from "./nexus-kernel.js";
import type { Principal } from "./types.js";
import { vaultReceiptFileHash } from "./vault-ledger.js";
import type { VaultPurgeHooks, VaultWriterQuiet } from "./vault-maintenance-types.js";
import type { VaultFileDraft, VaultLimits } from "./vault-types.js";

const LIMITS: VaultLimits = { maxFileBytes: 1000, ownerQuotaBytes: 100_000 };
const A: Principal = { ownerId: "owner-a" };
const B: Principal = { ownerId: "owner-b" };
const hashOf = (letter: string) => letter.charCodeAt(0).toString(16).padStart(2, "0").repeat(32);
const LEASE = 30_000;
const GRACE = 5_000;

/** noUncheckedIndexedAccess: the first element, or a failed assertion instead of an undefined. */
function firstOf<T>(items: T[]): T {
  const item = items[0];
  assert.ok(item !== undefined, "expected at least one element");
  return item;
}

describe("vault maintenance: recovery, reclaim, tombstones and hard purge", () => {
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
  const count = (sql: string, ...params: (string | number)[]): number =>
    (db.prepare(sql).get(...params) as { c: number }).c;
  const get = (sql: string, ...params: (string | number)[]) => {
    const row = db.prepare(sql).get(...params);
    return row ? ({ ...row } as Record<string, string | number | null>) : undefined;
  };
  applyMigrations(db, tx);

  const goalLinks = new Set<string>();
  const detached: string[] = [];
  const hooks: VaultPurgeHooks = {
    detachFile: (owner, fileId) => {
      detached.push(`${owner}:${fileId}`);
      goalLinks.delete(`${owner}:${fileId}`);
    },
    fileHasGoalLinks: (owner, fileId) => goalLinks.has(`${owner}:${fileId}`),
  };
  const k = createNexusKernel(db, tx, { vaultPurgeHooks: hooks });

  let clock = 1_000_000;
  const now = () => (clock += 1);
  const INC = "inc-1";
  const OLD_INC = "inc-old";
  k.registerIncarnation({ principal: A, incarnationId: OLD_INC, bootId: "boot-old", now: now() });
  k.registerIncarnation({ principal: A, incarnationId: INC, bootId: "boot-1", now: now() });
  let attemptNo = 0;
  const attempt = (label: string) => `${label}-${(attemptNo += 1)}`;
  const quietAwaited: VaultWriterQuiet = {
    currentIncarnationId: INC,
    awaited: true,
    incarnationGoneEnabled: false,
  };
  const notQuiet: VaultWriterQuiet = {
    currentIncarnationId: INC,
    awaited: false,
    incarnationGoneEnabled: false,
  };

  const draft = (name = "notes.txt"): VaultFileDraft => ({
    displayName: name,
    collection: "vault",
    source: "upload",
    importedBy: "operator",
  });
  const reserve = (principal: Principal, incarnationId = INC) => {
    const out = k.vaultReserve({
      principal,
      now: now(),
      expectedSize: 10,
      limits: LIMITS,
      ttlMs: 60_000,
      writerAttemptId: attempt("w"),
      incarnationId,
    });
    assert.equal(out.outcome, "reserved");
    if (out.outcome !== "reserved") {
      throw new Error("unreachable");
    }
    return out.reservation;
  };
  const ingest = (principal: Principal, hash: string, name = "notes.txt", size = 10) => {
    const r = reserve(principal);
    assert.equal(
      k.vaultMarkWritten({
        principal,
        reservationId: r.id,
        contentHash: hash,
        byteSize: size,
        now: now(),
        limits: LIMITS,
      }).outcome,
      "written",
    );
    const plan = k.vaultPlanPromote({ principal, reservationId: r.id });
    if (plan.outcome === "promote") {
      k.vaultMarkPromoted({ principal, reservationId: r.id, now: now() });
    }
    const out = k.vaultCommit({
      principal,
      reservationId: r.id,
      now: now(),
      mime: "text/plain",
      file: draft(name),
      inboxRetentionMs: 5_000,
    });
    assert.equal(out.outcome, "committed");
    if (out.outcome !== "committed") {
      throw new Error("unreachable");
    }
    return { reservation: r, ...out };
  };
  const addJobAndText = (owner: string, objectId: string, pages: number) => {
    const t = now();
    db.prepare(
      "INSERT INTO vault_jobs (owner_id, id, object_id, stage, state, attempts, next_run_at, created_at, updated_at) VALUES (?, ?, ?, 'extract', 'ready', 0, NULL, ?, ?)",
    ).run(owner, `job-${objectId}`, objectId, t, t);
    for (let page = 0; page < pages; page += 1) {
      db.prepare(
        "INSERT INTO vault_text (owner_id, object_id, page, extractor, extractor_version, job_id, text) VALUES (?, ?, ?, 'x', '1', ?, 'text')",
      ).run(owner, objectId, page, `job-${objectId}`);
    }
  };

  /** Drives one full purge the way the service will: begin, record, evaluate, reclaim, settle, finish. */
  const purgeFile = (principal: Principal, fileId: string, requestedBy = "operator") => {
    const worker = attempt("pw");
    const begin = k.vaultPurgeBegin({
      principal,
      fileId,
      requestedBy,
      workerAttemptId: worker,
      now: now(),
      leaseMs: LEASE,
    });
    assert.ok(begin.outcome === "started" || begin.outcome === "resumed");
    if (begin.outcome !== "started" && begin.outcome !== "resumed") {
      throw new Error("unreachable");
    }
    const ref = { principal, fileId, purgeId: begin.purgeId, workerAttemptId: worker };
    const lease = () => ({ now: now(), leaseMs: LEASE });
    const recorded = k.vaultPurgeRecordItems({ ...ref, ...lease() });
    assert.equal(recorded.outcome, "recorded");
    const items = k.vaultPurgeItems({ ...ref, ...lease() });
    if (items.outcome !== "ok") {
      throw new Error(`items ${items.outcome}`);
    }
    for (const item of items.items) {
      let result = k.vaultPurgeEvaluateItem({
        ...ref,
        ...lease(),
        objectId: item.objectId,
        reclaimAttemptId: attempt("rc"),
      });
      if (result.outcome === "reclaim_claimed") {
        const rc = result.reclaimAttemptId;
        const data = k.vaultReclaimPurgeData({
          principal,
          objectId: item.objectId,
          reclaimAttemptId: rc,
          now: now(),
          leaseMs: LEASE,
          purgeRef: { fileId, purgeId: begin.purgeId },
        });
        assert.equal(data.outcome, "ok");
        assert.equal(
          k.vaultReclaimSettle({
            principal,
            objectId: item.objectId,
            reclaimAttemptId: rc,
            now: now(),
          }).outcome,
          "deleted",
        );
        result = k.vaultPurgeEvaluateItem({
          ...ref,
          ...lease(),
          objectId: item.objectId,
          reclaimAttemptId: attempt("rc"),
        });
      }
      assert.ok(
        ["verified_gone", "retained_shared"].includes(result.outcome),
        `item ended ${result.outcome}`,
      );
    }
    const finish = k.vaultPurgeFinish({ ...ref, ...lease() });
    return { begin, ref, recorded, finish };
  };

  // ------------------------------------------------------------------ reclaim

  it("reclaim: only unreferenced, past-grace live objects are claimed; settle writes the absence proof", () => {
    const f = ingest(A, hashOf("a"));
    // referenced objects are never eligible
    assert.deepEqual(
      k.vaultReclaimClaim({
        principal: A,
        objectId: f.objectId,
        reclaimAttemptId: attempt("rc"),
        now: now(),
        leaseMs: LEASE,
        graceMs: 0,
      }),
      { outcome: "not_eligible", reason: "referenced" },
    );
    assert.equal(
      k
        .vaultReclaimCandidates({ principal: A, now: now() + 1_000_000, graceMs: GRACE, limit: 50 })
        .some((c) => c.objectId === f.objectId),
      false,
    );
    // drop the reference by hand (a purge does this through vaultPurgeRecordItems)
    db.prepare("DELETE FROM vault_versions WHERE owner_id = ? AND object_id = ?").run(
      "owner-a",
      f.objectId,
    );
    const created = Number(
      get("SELECT created_at AS c FROM vault_objects WHERE id = ?", f.objectId)?.c,
    );
    assert.deepEqual(
      k.vaultReclaimClaim({
        principal: A,
        objectId: f.objectId,
        reclaimAttemptId: attempt("rc"),
        now: created + 1,
        leaseMs: LEASE,
        graceMs: GRACE,
      }),
      { outcome: "not_eligible", reason: "grace" },
    );
    const later = created + GRACE + 10;
    assert.ok(
      k
        .vaultReclaimCandidates({ principal: A, now: later, graceMs: GRACE, limit: 50 })
        .some((c) => c.objectId === f.objectId && c.state === "live"),
    );
    addJobAndText("owner-a", f.objectId, 3);
    db.prepare(
      "INSERT INTO vault_jobs (owner_id, id, object_id, stage, state, attempts, next_run_at, created_at, updated_at) VALUES (?, 'job-run', ?, 'index', 'running', 0, NULL, ?, ?)",
    ).run("owner-a", f.objectId, later, later);
    const mine = attempt("rc");
    const claim = k.vaultReclaimClaim({
      principal: A,
      objectId: f.objectId,
      reclaimAttemptId: mine,
      now: later,
      leaseMs: LEASE,
      graceMs: GRACE,
    });
    assert.equal(claim.outcome, "claimed");
    assert.equal(get("SELECT state FROM vault_jobs WHERE id = 'job-run'")?.state, "cancelled");
    // a second claimer sees the live lease
    assert.deepEqual(
      k.vaultReclaimClaim({
        principal: A,
        objectId: f.objectId,
        reclaimAttemptId: attempt("rc"),
        now: later + 5,
        leaseMs: LEASE,
        graceMs: GRACE,
      }),
      { outcome: "busy", leaseUntil: later + LEASE },
    );
    // only the claimer can purge data or settle
    assert.deepEqual(
      k.vaultReclaimPurgeData({
        principal: A,
        objectId: f.objectId,
        reclaimAttemptId: "stranger",
        now: later,
        leaseMs: LEASE,
      }),
      { outcome: "not_owner" },
    );
    assert.deepEqual(
      k.vaultReclaimSettle({
        principal: A,
        objectId: f.objectId,
        reclaimAttemptId: "stranger",
        now: later,
      }),
      { outcome: "not_owner" },
    );
    const data = k.vaultReclaimPurgeData({
      principal: A,
      objectId: f.objectId,
      reclaimAttemptId: mine,
      now: later,
      leaseMs: LEASE,
    });
    assert.deepEqual(data, { outcome: "ok", textPages: 3, jobs: 2 });
    assert.equal(count("SELECT COUNT(*) AS c FROM vault_text WHERE object_id = ?", f.objectId), 0);
    assert.equal(count("SELECT COUNT(*) AS c FROM vault_jobs WHERE object_id = ?", f.objectId), 0);
    assert.deepEqual(
      k.vaultReclaimSettle({
        principal: A,
        objectId: f.objectId,
        reclaimAttemptId: mine,
        now: later + 1,
      }),
      { outcome: "deleted" },
    );
    const object = get(
      "SELECT state, absence_verified_at AS at, absence_verified_attempt_id AS who, reclaim_attempt_id AS r FROM vault_objects WHERE id = ?",
      f.objectId,
    );
    assert.deepEqual(object, { state: "deleted", at: later + 1, who: mine, r: null });
    assert.deepEqual(
      k.vaultReclaimClaim({
        principal: A,
        objectId: f.objectId,
        reclaimAttemptId: attempt("rc"),
        now: later + 2,
        leaseMs: LEASE,
        graceMs: 0,
      }),
      { outcome: "already_deleted", hasProof: true },
    );
    // the file row that still pointed at the object is test scaffolding: remove it so later tests start clean
    db.prepare("DELETE FROM vault_files WHERE owner_id = 'owner-a' AND id = ?").run(f.fileId);
  });

  it("reclaim: an expired lease can be taken over, and a candidate list shows it", () => {
    const f = ingest(A, hashOf("b"));
    db.prepare("DELETE FROM vault_versions WHERE owner_id = 'owner-a' AND object_id = ?").run(
      f.objectId,
    );
    const t0 = now() + GRACE + 10;
    const first = attempt("rc");
    assert.equal(
      k.vaultReclaimClaim({
        principal: A,
        objectId: f.objectId,
        reclaimAttemptId: first,
        now: t0,
        leaseMs: LEASE,
        graceMs: 0,
      }).outcome,
      "claimed",
    );
    const t1 = t0 + LEASE + 1;
    assert.ok(
      k
        .vaultReclaimCandidates({ principal: A, now: t1, graceMs: GRACE, limit: 50 })
        .some((c) => c.objectId === f.objectId && c.state === "reclaiming"),
    );
    const second = attempt("rc");
    const taken = k.vaultReclaimClaim({
      principal: A,
      objectId: f.objectId,
      reclaimAttemptId: second,
      now: t1,
      leaseMs: LEASE,
      graceMs: 0,
    });
    assert.equal(taken.outcome === "claimed" && taken.takeover, true);
    // the superseded attempt is no longer the owner
    assert.deepEqual(
      k.vaultReclaimSettle({
        principal: A,
        objectId: f.objectId,
        reclaimAttemptId: first,
        now: t1,
      }),
      { outcome: "not_owner" },
    );
    assert.equal(
      k.vaultReclaimSettle({
        principal: A,
        objectId: f.objectId,
        reclaimAttemptId: second,
        now: t1,
      }).outcome,
      "deleted",
    );
    db.prepare("DELETE FROM vault_files WHERE owner_id = 'owner-a' AND id = ?").run(f.fileId);
  });

  it("reclaim: a reference that appears after the claim blocks settle and the object stays reclaiming", () => {
    const f = ingest(A, hashOf("c"));
    db.prepare("DELETE FROM vault_versions WHERE owner_id = 'owner-a' AND object_id = ?").run(
      f.objectId,
    );
    const rc = attempt("rc");
    const t = now() + GRACE + 10;
    assert.equal(
      k.vaultReclaimClaim({
        principal: A,
        objectId: f.objectId,
        reclaimAttemptId: rc,
        now: t,
        leaseMs: LEASE,
        graceMs: 0,
      }).outcome,
      "claimed",
    );
    db.prepare(
      "INSERT INTO vault_versions (owner_id, file_id, seq, object_id, created_at) VALUES ('owner-a', ?, 1, ?, ?)",
    ).run(f.fileId, f.objectId, t);
    assert.deepEqual(
      k.vaultReclaimSettle({ principal: A, objectId: f.objectId, reclaimAttemptId: rc, now: t }),
      { outcome: "referenced" },
    );
    assert.equal(
      get("SELECT state FROM vault_objects WHERE id = ?", f.objectId)?.state,
      "reclaiming",
    );
    db.prepare("DELETE FROM vault_versions WHERE owner_id = 'owner-a' AND object_id = ?").run(
      f.objectId,
    );
    assert.equal(
      k.vaultReclaimSettle({ principal: A, objectId: f.objectId, reclaimAttemptId: rc, now: t })
        .outcome,
      "deleted",
    );
    db.prepare("DELETE FROM vault_files WHERE owner_id = 'owner-a' AND id = ?").run(f.fileId);
  });

  it("absence proof: a tombstone without one is listed and gets it exactly once", () => {
    const f = ingest(A, hashOf("d"));
    db.prepare("DELETE FROM vault_versions WHERE owner_id = 'owner-a' AND object_id = ?").run(
      f.objectId,
    );
    db.prepare("DELETE FROM vault_files WHERE owner_id = 'owner-a' AND id = ?").run(f.fileId);
    db.prepare("UPDATE vault_objects SET state = 'deleted' WHERE id = ?").run(f.objectId); // backup-restore style tombstone
    const listed = k
      .vaultReclaimCandidates({ principal: A, now: now(), graceMs: 0, limit: 50 })
      .find((c) => c.objectId === f.objectId);
    assert.deepEqual(listed, { objectId: f.objectId, state: "deleted", needsProof: true });
    assert.deepEqual(
      k.vaultAbsenceProof({ principal: A, objectId: f.objectId, attemptId: "ap-1", now: now() }),
      { outcome: "proved" },
    );
    assert.deepEqual(
      k.vaultAbsenceProof({ principal: A, objectId: f.objectId, attemptId: "ap-2", now: now() }),
      { outcome: "noop" },
    );
    assert.equal(
      get("SELECT absence_verified_attempt_id AS a FROM vault_objects WHERE id = ?", f.objectId)?.a,
      "ap-1",
    );
  });

  // ------------------------------------------------------------------ hard purge

  it("purge: one object, two versions of it -> item_count 1, version_count 2, receipt without names", () => {
    const f = ingest(A, hashOf("e"), "secret-name.txt");
    db.prepare(
      "INSERT INTO vault_versions (owner_id, file_id, seq, object_id, created_at) VALUES ('owner-a', ?, 2, ?, ?)",
    ).run(f.fileId, f.objectId, now());
    db.prepare(
      "INSERT INTO vault_user_state (owner_id, file_id, pinned_at, favorite, last_opened_at) VALUES ('owner-a', ?, 1, 1, 1)",
    ).run(f.fileId);
    db.prepare(
      "INSERT INTO vault_links (owner_id, id, file_id, kind, ref_id, created_at) VALUES ('owner-a', 'lnk-1', ?, 'task', 'T1', 1)",
    ).run(f.fileId);
    addJobAndText("owner-a", f.objectId, 2);
    goalLinks.add(`owner-a:${f.fileId}`);
    const { begin, recorded, finish } = purgeFile(A, f.fileId, "alice");
    assert.equal(begin.outcome, "started");
    assert.ok(begin.outcome === "started" && begin.purgeId.startsWith("VPG_"));
    assert.deepEqual(recorded, { outcome: "recorded", itemCount: 1, versionCount: 2 });
    assert.equal(finish.outcome, "completed");
    assert.ok(detached.includes(`owner-a:${f.fileId}`), "Goals detach hook ran");
    assert.equal(count("SELECT COUNT(*) AS c FROM vault_files WHERE id = ?", f.fileId), 0);
    assert.equal(count("SELECT COUNT(*) AS c FROM vault_links WHERE file_id = ?", f.fileId), 0);
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_user_state WHERE file_id = ?", f.fileId),
      0,
    );
    assert.equal(count("SELECT COUNT(*) AS c FROM vault_versions WHERE file_id = ?", f.fileId), 0);
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_purge_runs WHERE file_id = ?", f.fileId),
      0,
    );
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_purge_items WHERE file_id = ?", f.fileId),
      0,
    );
    assert.equal(get("SELECT state FROM vault_objects WHERE id = ?", f.objectId)?.state, "deleted");
    const receipts = k.vaultPurgeReceipts({
      principal: A,
      purgeId: begin.outcome === "started" ? begin.purgeId : "",
    });
    assert.equal(receipts.receipts.length, 1);
    const receipt = firstOf(receipts.receipts);
    assert.equal(receipt.requestedBy, "alice");
    assert.equal(receipt.versionCount, 2);
    assert.equal(receipt.textPageCount, 2);
    assert.equal(receipt.retainedObjectCount, 0);
    assert.deepEqual(receipt.contentHashes, [hashOf("e")]);
    assert.equal(receipt.fileIdHash, vaultReceiptFileHash("owner-a", f.fileId));
    assert.equal(JSON.stringify(receipt).includes("secret-name"), false);
    assert.deepEqual(k.vaultPurgeStatus({ principal: A, fileId: f.fileId }).outcome, "completed");
  });

  it("purge: a goal link left behind blocks the receipt until the relation is gone", () => {
    const f = ingest(A, hashOf("f"));
    const worker = attempt("pw");
    const begin = k.vaultPurgeBegin({
      principal: A,
      fileId: f.fileId,
      requestedBy: "op",
      workerAttemptId: worker,
      now: now(),
      leaseMs: LEASE,
    });
    if (begin.outcome !== "started") {
      throw new Error("unreachable");
    }
    goalLinks.add(`owner-a:${f.fileId}`); // a link created after the detach (a bug or a race): the gate catches it
    const ref = { principal: A, fileId: f.fileId, purgeId: begin.purgeId, workerAttemptId: worker };
    k.vaultPurgeRecordItems({ ...ref, now: now(), leaseMs: LEASE });
    const item = firstOf(
      (
        k.vaultPurgeItems({ ...ref, now: now(), leaseMs: LEASE }) as {
          items: { objectId: string }[];
        }
      ).items,
    );
    const ev = k.vaultPurgeEvaluateItem({
      ...ref,
      now: now(),
      leaseMs: LEASE,
      objectId: item.objectId,
      reclaimAttemptId: "rc-f",
    });
    assert.equal(ev.outcome, "reclaim_claimed");
    k.vaultReclaimPurgeData({
      principal: A,
      objectId: item.objectId,
      reclaimAttemptId: "rc-f",
      now: now(),
      leaseMs: LEASE,
    });
    k.vaultReclaimSettle({
      principal: A,
      objectId: item.objectId,
      reclaimAttemptId: "rc-f",
      now: now(),
    });
    assert.equal(
      k.vaultPurgeEvaluateItem({
        ...ref,
        now: now(),
        leaseMs: LEASE,
        objectId: item.objectId,
        reclaimAttemptId: "x",
      }).outcome,
      "verified_gone",
    );
    assert.deepEqual(k.vaultPurgeFinish({ ...ref, now: now(), leaseMs: LEASE }), {
      outcome: "not_ready",
      reason: "goal_links",
    });
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_purge_receipts WHERE purge_id = ?", begin.purgeId),
      0,
    );
    goalLinks.delete(`owner-a:${f.fileId}`);
    assert.equal(k.vaultPurgeFinish({ ...ref, now: now(), leaseMs: LEASE }).outcome, "completed");
  });

  it("purge: the gate refuses an empty set before the items are recorded", () => {
    const f = ingest(A, hashOf("g"));
    const worker = attempt("pw");
    const begin = k.vaultPurgeBegin({
      principal: A,
      fileId: f.fileId,
      requestedBy: "op",
      workerAttemptId: worker,
      now: now(),
      leaseMs: LEASE,
    });
    if (begin.outcome !== "started") {
      throw new Error("unreachable");
    }
    const ref = { principal: A, fileId: f.fileId, purgeId: begin.purgeId, workerAttemptId: worker };
    assert.deepEqual(k.vaultPurgeFinish({ ...ref, now: now(), leaseMs: LEASE }), {
      outcome: "not_ready",
      reason: "wrong_phase",
    });
    assert.deepEqual(k.vaultPurgeItems({ ...ref, now: now(), leaseMs: LEASE }), {
      outcome: "wrong_phase",
    });
    assert.equal(get("SELECT state FROM vault_files WHERE id = ?", f.fileId)?.state, "purging");
    // recording twice is idempotent
    const first = k.vaultPurgeRecordItems({ ...ref, now: now(), leaseMs: LEASE });
    const second = k.vaultPurgeRecordItems({ ...ref, now: now(), leaseMs: LEASE });
    assert.deepEqual(first, second);
    // pending items keep the gate closed
    assert.deepEqual(k.vaultPurgeFinish({ ...ref, now: now(), leaseMs: LEASE }), {
      outcome: "not_ready",
      reason: "pending",
    });
  });

  it("purge: a file with no versions has item_count 0 and completes with an empty receipt", () => {
    const f = ingest(A, hashOf("h"));
    db.prepare("DELETE FROM vault_versions WHERE file_id = ?").run(f.fileId);
    db.prepare("DELETE FROM vault_files WHERE id = ?").run(f.fileId);
    const g = ingest(A, hashOf("i"));
    db.prepare("DELETE FROM vault_versions WHERE file_id = ?").run(g.fileId);
    const { recorded, finish } = purgeFile(A, g.fileId);
    assert.deepEqual(recorded, { outcome: "recorded", itemCount: 0, versionCount: 0 });
    assert.equal(finish.outcome, "completed");
  });

  it("purge: a shared object is retained; the second purge reclaims it; text pages are counted once", () => {
    const first = ingest(A, hashOf("j"), "one.txt");
    const second = ingest(A, hashOf("j"), "two.txt");
    assert.equal(first.objectId, second.objectId);
    addJobAndText("owner-a", first.objectId, 4);
    const a = purgeFile(A, first.fileId);
    assert.equal(a.finish.outcome, "completed");
    assert.equal(
      get("SELECT state FROM vault_objects WHERE id = ?", first.objectId)?.state,
      "live",
    );
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_text WHERE object_id = ?", first.objectId),
      4,
      "shared text untouched",
    );
    const receiptA = firstOf(
      k.vaultPurgeReceipts({
        principal: A,
        purgeId: a.begin.outcome === "started" ? a.begin.purgeId : "",
      }).receipts,
    );
    assert.equal(receiptA.retainedObjectCount, 1);
    assert.deepEqual(receiptA.contentHashes, []);
    assert.equal(receiptA.textPageCount, 0);
    const b = purgeFile(A, second.fileId);
    assert.equal(b.finish.outcome, "completed");
    const receiptB = firstOf(
      k.vaultPurgeReceipts({
        principal: A,
        purgeId: b.begin.outcome === "started" ? b.begin.purgeId : "",
      }).receipts,
    );
    assert.equal(receiptB.textPageCount, 4);
    assert.deepEqual(receiptB.contentHashes, [hashOf("j")]);
    assert.equal(
      get("SELECT state FROM vault_objects WHERE id = ?", first.objectId)?.state,
      "deleted",
    );
  });

  it("purge: retained_shared goes back to pending when the other file is purged in between (fixed interleaving)", () => {
    const x = ingest(A, hashOf("k"), "x.txt");
    const y = ingest(A, hashOf("k"), "y.txt");
    const wx = attempt("pw");
    const bx = k.vaultPurgeBegin({
      principal: A,
      fileId: x.fileId,
      requestedBy: "op",
      workerAttemptId: wx,
      now: now(),
      leaseMs: LEASE,
    });
    if (bx.outcome !== "started") {
      throw new Error("unreachable");
    }
    const refX = { principal: A, fileId: x.fileId, purgeId: bx.purgeId, workerAttemptId: wx };
    k.vaultPurgeRecordItems({ ...refX, now: now(), leaseMs: LEASE });
    assert.equal(
      k.vaultPurgeEvaluateItem({
        ...refX,
        now: now(),
        leaseMs: LEASE,
        objectId: x.objectId,
        reclaimAttemptId: "r1",
      }).outcome,
      "retained_shared",
    );
    // the other file is purged completely before x's gate runs
    const y2 = purgeFile(A, y.fileId);
    assert.equal(y2.finish.outcome, "completed");
    assert.equal(get("SELECT state FROM vault_objects WHERE id = ?", x.objectId)?.state, "deleted");
    assert.deepEqual(k.vaultPurgeFinish({ ...refX, now: now(), leaseMs: LEASE }), {
      outcome: "not_ready",
      reason: "reevaluate",
    });
    assert.equal(
      get("SELECT state FROM vault_purge_items WHERE file_id = ?", x.fileId)?.state,
      "pending",
    );
    // re-evaluation adopts the existing absence proof: no second reclaim, nothing counted twice
    assert.equal(
      k.vaultPurgeEvaluateItem({
        ...refX,
        now: now(),
        leaseMs: LEASE,
        objectId: x.objectId,
        reclaimAttemptId: "r2",
      }).outcome,
      "verified_gone",
    );
    assert.equal(k.vaultPurgeFinish({ ...refX, now: now(), leaseMs: LEASE }).outcome, "completed");
    const receiptX = firstOf(k.vaultPurgeReceipts({ principal: A, purgeId: bx.purgeId }).receipts);
    assert.deepEqual(receiptX.contentHashes, [hashOf("k")]);
    assert.equal(receiptX.textPageCount, 0);
  });

  it("purge: a verified_gone item whose proof changed is sent back by the gate", () => {
    const f = ingest(A, hashOf("l"));
    const w = attempt("pw");
    const begin = k.vaultPurgeBegin({
      principal: A,
      fileId: f.fileId,
      requestedBy: "op",
      workerAttemptId: w,
      now: now(),
      leaseMs: LEASE,
    });
    if (begin.outcome !== "started") {
      throw new Error("unreachable");
    }
    const ref = { principal: A, fileId: f.fileId, purgeId: begin.purgeId, workerAttemptId: w };
    k.vaultPurgeRecordItems({ ...ref, now: now(), leaseMs: LEASE });
    k.vaultPurgeEvaluateItem({
      ...ref,
      now: now(),
      leaseMs: LEASE,
      objectId: f.objectId,
      reclaimAttemptId: "rc-l",
    });
    k.vaultReclaimPurgeData({
      principal: A,
      objectId: f.objectId,
      reclaimAttemptId: "rc-l",
      now: now(),
      leaseMs: LEASE,
    });
    k.vaultReclaimSettle({
      principal: A,
      objectId: f.objectId,
      reclaimAttemptId: "rc-l",
      now: now(),
    });
    k.vaultPurgeEvaluateItem({
      ...ref,
      now: now(),
      leaseMs: LEASE,
      objectId: f.objectId,
      reclaimAttemptId: "x",
    });
    db.prepare(
      "UPDATE vault_objects SET absence_verified_attempt_id = 'someone-else' WHERE id = ?",
    ).run(f.objectId);
    assert.deepEqual(k.vaultPurgeFinish({ ...ref, now: now(), leaseMs: LEASE }), {
      outcome: "not_ready",
      reason: "reevaluate",
    });
    assert.equal(
      k.vaultPurgeEvaluateItem({
        ...ref,
        now: now(),
        leaseMs: LEASE,
        objectId: f.objectId,
        reclaimAttemptId: "y",
      }).outcome,
      "verified_gone",
    );
    assert.equal(k.vaultPurgeFinish({ ...ref, now: now(), leaseMs: LEASE }).outcome, "completed");
  });

  it("purge: a referenced non-live object is cleanup_pending and writes no receipt", () => {
    const f = ingest(A, hashOf("m"));
    const g = ingest(A, hashOf("m"), "other.txt");
    const w = attempt("pw");
    const begin = k.vaultPurgeBegin({
      principal: A,
      fileId: f.fileId,
      requestedBy: "op",
      workerAttemptId: w,
      now: now(),
      leaseMs: LEASE,
    });
    if (begin.outcome !== "started") {
      throw new Error("unreachable");
    }
    const ref = { principal: A, fileId: f.fileId, purgeId: begin.purgeId, workerAttemptId: w };
    k.vaultPurgeRecordItems({ ...ref, now: now(), leaseMs: LEASE });
    db.prepare("UPDATE vault_objects SET state = 'deleted' WHERE id = ?").run(f.objectId); // broken: g still references it
    assert.equal(
      k.vaultPurgeEvaluateItem({
        ...ref,
        now: now(),
        leaseMs: LEASE,
        objectId: f.objectId,
        reclaimAttemptId: "z",
      }).outcome,
      "cleanup_pending",
    );
    assert.deepEqual(k.vaultPurgeFinish({ ...ref, now: now(), leaseMs: LEASE }), {
      outcome: "cleanup_pending",
      count: 1,
    });
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_purge_receipts WHERE purge_id = ?", begin.purgeId),
      0,
    );
    assert.ok(g.fileId);
  });

  // ------------------------------------------------------------------ run lease protocol

  it("run lease: active holder -> worker_active; expiry -> resumed with the same purge id and requester; stale pass is not_owner", () => {
    const f = ingest(A, hashOf("n"));
    const w1 = attempt("pw");
    const t0 = now();
    const begin = k.vaultPurgeBegin({
      principal: A,
      fileId: f.fileId,
      requestedBy: "alice",
      workerAttemptId: w1,
      now: t0,
      leaseMs: LEASE,
    });
    if (begin.outcome !== "started") {
      throw new Error("unreachable");
    }
    const w2 = attempt("pw");
    const active = k.vaultPurgeBegin({
      principal: A,
      fileId: f.fileId,
      requestedBy: "mallory",
      workerAttemptId: w2,
      now: t0 + 10,
      leaseMs: LEASE,
    });
    assert.deepEqual(active, {
      outcome: "worker_active",
      purgeId: begin.purgeId,
      requestedBy: "alice",
      leaseUntil: t0 + LEASE,
    });
    // the second pass had no side effects: still sealed, still held by w1
    assert.equal(
      get("SELECT worker_attempt_id AS w FROM vault_purge_runs WHERE file_id = ?", f.fileId)?.w,
      w1,
    );
    // ownership check from a non-holder
    const stale = { principal: A, fileId: f.fileId, purgeId: begin.purgeId, workerAttemptId: w2 };
    assert.deepEqual(k.vaultPurgeRecordItems({ ...stale, now: t0 + 10, leaseMs: LEASE }), {
      outcome: "not_owner",
    });
    assert.deepEqual(k.vaultPurgeRelease(stale), { released: false });
    // expiry -> takeover keeps the original identifiers
    const resumed = k.vaultPurgeBegin({
      principal: A,
      fileId: f.fileId,
      requestedBy: "mallory",
      workerAttemptId: w2,
      now: t0 + LEASE + 1,
      leaseMs: LEASE,
    });
    assert.deepEqual(resumed, {
      outcome: "resumed",
      purgeId: begin.purgeId,
      requestedBy: "alice",
      phase: "sealed",
    });
    // the late first pass can no longer record anything or write a receipt
    const late = { principal: A, fileId: f.fileId, purgeId: begin.purgeId, workerAttemptId: w1 };
    assert.deepEqual(k.vaultPurgeRecordItems({ ...late, now: t0 + LEASE + 2, leaseMs: LEASE }), {
      outcome: "not_owner",
    });
    assert.deepEqual(k.vaultPurgeFinish({ ...late, now: t0 + LEASE + 2, leaseMs: LEASE }), {
      outcome: "not_owner",
    });
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_purge_receipts WHERE purge_id = ?", begin.purgeId),
      0,
    );
    // conditional release: holder true, then a second begin by anyone resumes immediately
    assert.deepEqual(k.vaultPurgeRelease({ ...stale }), { released: true });
    assert.deepEqual(k.vaultPurgeRelease({ ...stale }), { released: false });
    assert.ok(
      k
        .vaultPurgeListRuns({ principal: A, now: now(), limit: 50 })
        .runs.some((r) => r.fileId === f.fileId),
    );
    const status = k.vaultPurgeStatus({ principal: A, fileId: f.fileId });
    assert.equal(status.outcome === "running" && status.requestedBy, "alice");
    assert.equal(status.outcome === "running" && status.workerActive, false);
    // finish it so the shared database stays clean
    const done = purgeFile(A, f.fileId, "ignored");
    assert.equal(done.begin.outcome, "resumed");
    assert.equal(done.finish.outcome, "completed");
    const receipt = firstOf(
      k.vaultPurgeReceipts({ principal: A, purgeId: begin.purgeId }).receipts,
    );
    assert.equal(receipt.requestedBy, "alice");
  });

  it("run lease: the same pass renews, two simultaneous claims at expiry give one winner", () => {
    const f = ingest(A, hashOf("o"));
    const w1 = attempt("pw");
    const t0 = now();
    const begin = k.vaultPurgeBegin({
      principal: A,
      fileId: f.fileId,
      requestedBy: "op",
      workerAttemptId: w1,
      now: t0,
      leaseMs: LEASE,
    });
    if (begin.outcome !== "started") {
      throw new Error("unreachable");
    }
    const again = k.vaultPurgeBegin({
      principal: A,
      fileId: f.fileId,
      requestedBy: "op",
      workerAttemptId: w1,
      now: t0 + 5,
      leaseMs: LEASE,
    });
    assert.equal(again.outcome, "resumed");
    const expiry = t0 + LEASE + 100;
    const r1 = k.vaultPurgeBegin({
      principal: A,
      fileId: f.fileId,
      requestedBy: "a",
      workerAttemptId: "race-1",
      now: expiry,
      leaseMs: LEASE,
    });
    const r2 = k.vaultPurgeBegin({
      principal: A,
      fileId: f.fileId,
      requestedBy: "b",
      workerAttemptId: "race-2",
      now: expiry,
      leaseMs: LEASE,
    });
    assert.equal(r1.outcome, "resumed");
    assert.equal(r2.outcome, "worker_active");
    clock = expiry + 2 * LEASE; // both leases have run out
    const done = purgeFile(A, f.fileId);
    assert.equal(done.finish.outcome, "completed");
  });

  it("purge ids: unique per owner (run table), reused text allowed across owners, a second run cannot share an id", () => {
    const f1 = ingest(A, hashOf("p"));
    const f2 = ingest(A, hashOf("q"));
    const w = attempt("pw");
    const b1 = k.vaultPurgeBegin({
      principal: A,
      fileId: f1.fileId,
      requestedBy: "op",
      workerAttemptId: w,
      now: now(),
      leaseMs: LEASE,
    });
    if (b1.outcome !== "started") {
      throw new Error("unreachable");
    }
    k.vaultPurgeBegin({
      principal: A,
      fileId: f2.fileId,
      requestedBy: "op",
      workerAttemptId: w,
      now: now(),
      leaseMs: LEASE,
    });
    const second = get(
      "SELECT purge_id AS p FROM vault_purge_runs WHERE file_id = ?",
      f2.fileId,
    )?.p;
    assert.notEqual(second, b1.purgeId);
    assert.throws(
      () =>
        db
          .prepare("UPDATE vault_purge_runs SET purge_id = ? WHERE file_id = ?")
          .run(b1.purgeId, f2.fileId),
      /UNIQUE/,
    );
    // a purge id already present in a receipt is never reused for a new run
    const o = ingest(B, hashOf("p"));
    const ob = k.vaultPurgeBegin({
      principal: B,
      fileId: o.fileId,
      requestedBy: "op",
      workerAttemptId: "wb",
      now: now(),
      leaseMs: LEASE,
    });
    assert.equal(ob.outcome, "started");
    clock += 2 * LEASE; // the begin passes above held leases; let them run out
    for (const [principal, fileId] of [
      [A, f1.fileId],
      [A, f2.fileId],
      [B, o.fileId],
    ] as const) {
      const status = k.vaultPurgeStatus({ principal, fileId });
      if (status.outcome === "running") {
        const done = purgeFile(principal, fileId);
        assert.ok(done.finish.outcome === "completed");
      }
    }
  });

  it("owner isolation: another owner can neither see, claim nor purge a file", () => {
    const f = ingest(A, hashOf("r"));
    assert.deepEqual(
      k.vaultPurgeBegin({
        principal: B,
        fileId: f.fileId,
        requestedBy: "op",
        workerAttemptId: "wb",
        now: now(),
        leaseMs: LEASE,
      }),
      { outcome: "not_found" },
    );
    assert.deepEqual(k.vaultPurgeStatus({ principal: B, fileId: f.fileId }), { outcome: "none" });
    assert.deepEqual(
      k.vaultReclaimClaim({
        principal: B,
        objectId: f.objectId,
        reclaimAttemptId: "x",
        now: now(),
        leaseMs: LEASE,
        graceMs: 0,
      }),
      { outcome: "not_found" },
    );
    assert.equal(k.vaultPurgeReceipts({ principal: B }).receipts.length >= 0, true);
    assert.equal(purgeFile(A, f.fileId).finish.outcome, "completed");
  });

  it("purge refuses files in a state that cannot be purged and a missing file", () => {
    const f = ingest(A, hashOf("s"));
    assert.deepEqual(
      k.vaultPurgeBegin({
        principal: A,
        fileId: "nope",
        requestedBy: "op",
        workerAttemptId: "w",
        now: now(),
        leaseMs: LEASE,
      }),
      { outcome: "not_found" },
    );
    assert.equal(purgeFile(A, f.fileId).finish.outcome, "completed");
  });

  // ------------------------------------------------------------------ receipts

  it("receipt compaction: one UPDATE nulls the hashes, keeps the row and counts, and reads back as compacted", () => {
    const f = ingest(A, hashOf("t"));
    const done = purgeFile(A, f.fileId, "bob");
    assert.equal(done.finish.outcome, "completed");
    const purgeId = done.begin.outcome === "started" ? done.begin.purgeId : "";
    const before = firstOf(k.vaultPurgeReceipts({ principal: A, purgeId }).receipts);
    assert.equal(before.compacted, false);
    assert.ok(before.fileIdHash && before.contentHashes);
    assert.deepEqual(
      k.vaultCompactReceipts({ principal: A, now: before.executedAt + 10, retentionMs: 1_000_000 }),
      { compacted: 0 },
    );
    const out = k.vaultCompactReceipts({
      principal: A,
      now: before.executedAt + 1_000_001,
      retentionMs: 1_000_000,
    });
    assert.ok(out.compacted >= 1);
    const after = firstOf(k.vaultPurgeReceipts({ principal: A, purgeId }).receipts);
    assert.equal(after.compacted, true);
    assert.equal(after.fileIdHash, null);
    assert.equal(after.contentHashes, null);
    assert.equal(after.requestedBy, "bob");
    assert.equal(after.versionCount, before.versionCount);
    assert.deepEqual(
      k.vaultCompactReceipts({
        principal: A,
        now: before.executedAt + 2_000_000,
        retentionMs: 1_000_000,
      }),
      { compacted: 0 },
    );
  });

  // ------------------------------------------------------------------ tombstones and diagnostic reservations

  it("tombstones retire only after retention and only when nothing references them; reservations go in the same transaction", () => {
    const first = ingest(A, hashOf("u"));
    const reuse = (() => {
      const r = reserve(A);
      k.vaultMarkWritten({
        principal: A,
        reservationId: r.id,
        contentHash: hashOf("u"),
        byteSize: 10,
        now: now(),
        limits: LIMITS,
      });
      k.vaultPlanPromote({ principal: A, reservationId: r.id });
      const out = k.vaultCommit({
        principal: A,
        reservationId: r.id,
        now: now(),
        mime: "text/plain",
        file: draft("copy.txt"),
        inboxRetentionMs: 5_000,
      });
      assert.equal(out.outcome === "committed" && out.newObject, false);
      return { r, out };
    })();
    const second = reuse.out.outcome === "committed" ? reuse.out.fileId : "";
    purgeFile(A, first.fileId);
    purgeFile(A, second);
    const proofAt = Number(
      get("SELECT absence_verified_at AS a FROM vault_objects WHERE id = ?", first.objectId)?.a,
    );
    k.vaultRetireTombstones({ principal: A, now: proofAt + 500, retentionMs: 1_000, limit: 500 }); // older tombstones of other tests may go
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_objects WHERE id = ?", first.objectId),
      1,
      "inside the retention period",
    );
    const retired = k.vaultRetireTombstones({
      principal: A,
      now: proofAt + 1_001 + 1_000_000,
      retentionMs: 1_000,
      limit: 500,
    });
    assert.ok(retired.retired >= 1);
    assert.equal(count("SELECT COUNT(*) AS c FROM vault_objects WHERE id = ?", first.objectId), 0);
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_reservations WHERE id = ?", first.reservation.id),
      0,
    );
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_reservations WHERE id = ?", reuse.r.id),
      0,
      "reuse reservation retired with the object it points at",
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });

  it("a tombstone that something still references is not retired", () => {
    const f = ingest(A, hashOf("v"));
    purgeFile(A, f.fileId);
    const proofAt = Number(
      get("SELECT absence_verified_at AS a FROM vault_objects WHERE id = ?", f.objectId)?.a,
    );
    db.prepare(
      "INSERT INTO vault_purge_runs (owner_id, file_id, purge_id, requested_by, requested_at, phase, created_at, updated_at) SELECT 'owner-a', id, 'VPG_hold', 'op', 1, 'sealed', 1, 1 FROM vault_files LIMIT 0",
    ).run();
    // a leftover work item is enough to keep the tombstone: simulate with a fresh file + run + item pointing at it
    const g = ingest(A, hashOf("w"));
    db.prepare("UPDATE vault_files SET state = 'purging' WHERE id = ?").run(g.fileId);
    db.prepare(
      "INSERT INTO vault_purge_runs (owner_id, file_id, purge_id, requested_by, requested_at, phase, item_count, version_count, created_at, updated_at) VALUES ('owner-a', ?, 'VPG_hold2', 'op', 1, 'items_recorded', 1, 1, 1, 1)",
    ).run(g.fileId);
    db.prepare(
      "INSERT INTO vault_purge_items (owner_id, file_id, purge_id, object_id, state, created_at, updated_at) VALUES ('owner-a', ?, 'VPG_hold2', ?, 'pending', 1, 1)",
    ).run(g.fileId, f.objectId);
    k.vaultRetireTombstones({
      principal: A,
      now: proofAt + 10_000_000,
      retentionMs: 1_000,
      limit: 500,
    });
    assert.equal(count("SELECT COUNT(*) AS c FROM vault_objects WHERE id = ?", f.objectId), 1);
    db.prepare("DELETE FROM vault_purge_items WHERE purge_id = 'VPG_hold2'").run();
    db.prepare("DELETE FROM vault_purge_runs WHERE purge_id = 'VPG_hold2'").run();
    db.prepare("UPDATE vault_files SET state = 'active' WHERE id = ?").run(g.fileId);
  });

  it("failed / expired / reuse reservations are pruned after retention, ledger reservations never", () => {
    const failing = reserve(A);
    k.vaultFailReservation({
      principal: A,
      reservationId: failing.id,
      now: now(),
      reason: "cancelled",
    });
    const kept = ingest(A, hashOf("x"));
    const t = now();
    assert.deepEqual(
      k.vaultPruneReservations({ principal: A, now: t, retentionMs: 1_000_000, limit: 100 }),
      { pruned: 0 },
    );
    const out = k.vaultPruneReservations({
      principal: A,
      now: t + 2_000_000,
      retentionMs: 1_000_000,
      limit: 100,
    });
    assert.ok(out.pruned >= 1);
    assert.equal(count("SELECT COUNT(*) AS c FROM vault_reservations WHERE id = ?", failing.id), 0);
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_reservations WHERE id = ?", kept.reservation.id),
      1,
    );
  });

  // ------------------------------------------------------------------ reservation recovery

  it("recovery: an expired reserved/written reservation needs a quiet writer, then deletes staging and expires", () => {
    const r = reserve(A);
    const later = now() + 70_000;
    const listed = k
      .vaultListRecoverable({ principal: A, now: later, limit: 50 })
      .find((i) => i.reservationId === r.id);
    assert.equal(listed?.kind, "expire");
    assert.deepEqual(
      k.vaultRecoverCheck({ principal: A, reservationId: r.id, now: later, quiet: notQuiet }),
      { outcome: "skip", reason: "writer_not_quiet" },
    );
    const check = k.vaultRecoverCheck({
      principal: A,
      reservationId: r.id,
      now: later,
      quiet: quietAwaited,
    });
    assert.deepEqual(check, {
      outcome: "delete",
      kind: "expire",
      stagingKey: `staging/${r.id}`,
      objectKey: `objects/${r.newObjectId.slice(0, 2)}/${r.newObjectId}`,
    });
    assert.deepEqual(
      k.vaultReservationExpire({ principal: A, reservationId: r.id, now: later, quiet: notQuiet }),
      { outcome: "skip", reason: "writer_not_quiet" },
    );
    assert.deepEqual(
      k.vaultReservationExpire({
        principal: A,
        reservationId: r.id,
        now: later,
        quiet: quietAwaited,
      }),
      { outcome: "expired" },
    );
    assert.deepEqual(
      k.vaultReservationExpire({
        principal: A,
        reservationId: r.id,
        now: later,
        quiet: quietAwaited,
      }),
      { outcome: "noop", state: "expired" },
    );
  });

  it("recovery: an unexpired reservation is not touched while its writer may still be running", () => {
    const r = reserve(A);
    assert.deepEqual(
      k.vaultRecoverCheck({ principal: A, reservationId: r.id, now: now(), quiet: notQuiet }),
      { outcome: "skip", reason: "not_due" },
    );
    assert.deepEqual(
      k.vaultReservationExpire({ principal: A, reservationId: r.id, now: now(), quiet: notQuiet }),
      { outcome: "skip", reason: "writer_not_quiet" },
    );
    k.vaultFailReservation({ principal: A, reservationId: r.id, now: now(), reason: "cancelled" });
  });

  it("recovery: a writer whose incarnation is gone may be abandoned early, but only with incarnation_gone enabled", () => {
    const r = reserve(A, OLD_INC);
    const r2 = reserve(A, OLD_INC);
    db.prepare(
      "UPDATE process_incarnations SET gone_at = ?, gone_basis = 'superseded_under_gateway_lock' WHERE incarnation_id = ?",
    ).run(now(), OLD_INC);
    const t = now();
    const off: VaultWriterQuiet = {
      currentIncarnationId: INC,
      awaited: false,
      incarnationGoneEnabled: false,
    };
    const on: VaultWriterQuiet = {
      currentIncarnationId: INC,
      awaited: false,
      incarnationGoneEnabled: true,
    };
    assert.ok(
      k
        .vaultListRecoverable({ principal: A, now: t, limit: 50 })
        .some((i) => i.reservationId === r.id && i.kind === "expire"),
    );
    assert.equal(
      k.vaultRecoverCheck({ principal: A, reservationId: r.id, now: t, quiet: off }).outcome,
      "skip",
    );
    assert.equal(
      k.vaultRecoverCheck({ principal: A, reservationId: r.id, now: t, quiet: on }).outcome,
      "delete",
    );
    assert.equal(
      k.vaultReservationExpire({ principal: A, reservationId: r.id, now: t, quiet: on }).outcome,
      "expired",
    );
    // a boot id of `unavailable` is never accepted as proof
    db.prepare(
      "UPDATE process_incarnations SET process_boot_id = 'unavailable' WHERE incarnation_id = ?",
    ).run(OLD_INC);
    assert.equal(
      k.vaultRecoverCheck({ principal: A, reservationId: r2.id, now: t, quiet: on }).outcome,
      "skip",
    );
    db.prepare(
      "UPDATE process_incarnations SET process_boot_id = 'boot-old' WHERE incarnation_id = ?",
    ).run(OLD_INC);
    k.vaultReservationExpire({ principal: A, reservationId: r2.id, now: t, quiet: on });
  });

  it("recovery: a clean shutdown of the writer's incarnation proves quiet even with incarnation_gone off", () => {
    k.registerIncarnation({
      principal: A,
      incarnationId: "inc-clean",
      bootId: "boot-clean",
      now: now(),
    });
    const r = reserve(A, "inc-clean");
    k.closeIncarnation({ principal: A, incarnationId: "inc-clean", now: now() });
    const off: VaultWriterQuiet = {
      currentIncarnationId: INC,
      awaited: false,
      incarnationGoneEnabled: false,
    };
    assert.equal(
      k.vaultRecoverCheck({ principal: A, reservationId: r.id, now: now(), quiet: off }).outcome,
      "delete",
    );
    assert.equal(
      k.vaultReservationExpire({ principal: A, reservationId: r.id, now: now(), quiet: off })
        .outcome,
      "expired",
    );
  });

  it("recovery: promoted and expired without an object row deletes objects/<new_object_id> as well", () => {
    const r = reserve(A);
    k.vaultMarkWritten({
      principal: A,
      reservationId: r.id,
      contentHash: hashOf("y"),
      byteSize: 10,
      now: now(),
      limits: LIMITS,
    });
    const plan = k.vaultPlanPromote({ principal: A, reservationId: r.id });
    assert.equal(plan.outcome, "promote");
    k.vaultMarkPromoted({ principal: A, reservationId: r.id, now: now() });
    const later = now() + 70_000;
    const check = k.vaultRecoverCheck({
      principal: A,
      reservationId: r.id,
      now: later,
      quiet: quietAwaited,
    });
    assert.equal(check.outcome, "delete");
    assert.equal(
      check.outcome === "delete" && check.objectKey,
      `objects/${r.newObjectId.slice(0, 2)}/${r.newObjectId}`,
    );
    assert.equal(
      k.vaultReservationExpire({
        principal: A,
        reservationId: r.id,
        now: later,
        quiet: quietAwaited,
      }).outcome,
      "expired",
    );
  });

  it("recovery: the loser of a dedup race is deleted only after four conditions, including no object row for its id", () => {
    const r1 = reserve(A);
    const r2 = reserve(A);
    for (const r of [r1, r2]) {
      k.vaultMarkWritten({
        principal: A,
        reservationId: r.id,
        contentHash: hashOf("z"),
        byteSize: 10,
        now: now(),
        limits: LIMITS,
      });
      k.vaultPlanPromote({ principal: A, reservationId: r.id });
      k.vaultMarkPromoted({ principal: A, reservationId: r.id, now: now() });
    }
    k.vaultCommit({
      principal: A,
      reservationId: r1.id,
      now: now(),
      mime: "text/plain",
      file: draft("w1.txt"),
      inboxRetentionMs: 5_000,
    });
    k.vaultCommit({
      principal: A,
      reservationId: r2.id,
      now: now(),
      mime: "text/plain",
      file: draft("w2.txt"),
      inboxRetentionMs: 5_000,
    });
    const t = now();
    assert.ok(
      k
        .vaultListRecoverable({ principal: A, now: t, limit: 100 })
        .some((i) => i.reservationId === r2.id && i.kind === "loser_cleanup"),
    );
    assert.equal(
      k
        .vaultListRecoverable({ principal: A, now: t, limit: 100 })
        .some((i) => i.reservationId === r1.id),
      false,
      "the winner owns its file",
    );
    assert.deepEqual(
      k.vaultRecoverCheck({ principal: A, reservationId: r1.id, now: t, quiet: quietAwaited }),
      { outcome: "skip", reason: "state" },
    );
    assert.deepEqual(
      k.vaultRecoverCheck({ principal: A, reservationId: r2.id, now: t, quiet: notQuiet }),
      { outcome: "skip", reason: "writer_not_quiet" },
    );
    const ok = k.vaultRecoverCheck({
      principal: A,
      reservationId: r2.id,
      now: t,
      quiet: quietAwaited,
    });
    assert.deepEqual(ok, {
      outcome: "delete",
      kind: "loser_cleanup",
      stagingKey: `staging/${r2.id}`,
      objectKey: `objects/${r2.newObjectId.slice(0, 2)}/${r2.newObjectId}`,
    });
    // repair or a backup restore gave new_object_id an object row: that file may be real, do not delete it
    const winnerObject = get(
      "SELECT * FROM vault_objects WHERE content_hash = ? AND state = 'live' AND owner_id = 'owner-a'",
      hashOf("z"),
    );
    db.exec("PRAGMA defer_foreign_keys = ON");
    db.prepare(
      "INSERT INTO vault_objects (owner_id, id, reservation_id, content_hash, size, mime, state, created_at, updated_at) VALUES ('owner-a', ?, ?, ?, 10, 'text/plain', 'deleted', 1, 1)",
    ).run(r2.newObjectId, r2.id, "ff".repeat(32));
    assert.deepEqual(
      k.vaultRecoverCheck({ principal: A, reservationId: r2.id, now: t, quiet: quietAwaited }),
      { outcome: "skip", reason: "object_row_exists" },
    );
    db.prepare("DELETE FROM vault_objects WHERE id = ?").run(r2.newObjectId);
    assert.ok(winnerObject);
  });

  it("recovery: promoted + object row + empty result is repaired only when the object matches; mismatches fail without deleting", () => {
    const good = ingest(A, hashOf("1"));
    db.prepare(
      "UPDATE vault_reservations SET state = 'promoted', result_object_id = NULL WHERE id = ?",
    ).run(good.reservation.id);
    const t = now();
    assert.ok(
      k
        .vaultListRecoverable({ principal: A, now: t, limit: 100 })
        .some((i) => i.reservationId === good.reservation.id && i.kind === "repair_promoted"),
    );
    assert.deepEqual(
      k.vaultRecoverCheck({
        principal: A,
        reservationId: good.reservation.id,
        now: t,
        quiet: notQuiet,
      }),
      { outcome: "repair", kind: "repair_promoted" },
    );
    assert.deepEqual(
      k.vaultRepairPromoted({ principal: A, reservationId: good.reservation.id, now: t }),
      { outcome: "committed" },
    );
    assert.equal(
      get("SELECT result_object_id AS r FROM vault_reservations WHERE id = ?", good.reservation.id)
        ?.r,
      good.objectId,
    );
    assert.deepEqual(
      k.vaultRepairPromoted({ principal: A, reservationId: good.reservation.id, now: t }),
      { outcome: "noop", state: "committed" },
    );

    const bad = ingest(A, hashOf("2"));
    db.prepare(
      "UPDATE vault_reservations SET state = 'promoted', result_object_id = NULL WHERE id = ?",
    ).run(bad.reservation.id);
    db.prepare("UPDATE vault_objects SET size = 99 WHERE id = ?").run(bad.objectId);
    assert.deepEqual(
      k.vaultRepairPromoted({ principal: A, reservationId: bad.reservation.id, now: t }),
      { outcome: "failed", reason: "mismatch" },
    );
    assert.equal(
      get("SELECT state FROM vault_reservations WHERE id = ?", bad.reservation.id)?.state,
      "failed",
    );
    assert.equal(get("SELECT state FROM vault_objects WHERE id = ?", bad.objectId)?.state, "live");
    db.prepare("UPDATE vault_objects SET size = 10 WHERE id = ?").run(bad.objectId);

    const gone = ingest(A, hashOf("3"));
    db.prepare(
      "UPDATE vault_reservations SET state = 'promoted', result_object_id = NULL WHERE id = ?",
    ).run(gone.reservation.id);
    db.prepare(
      "UPDATE vault_objects SET state = 'reclaiming', reclaim_attempt_id = 'a', reclaim_lease_until = 1 WHERE id = ?",
    ).run(gone.objectId);
    assert.deepEqual(
      k.vaultRepairPromoted({ principal: A, reservationId: gone.reservation.id, now: t }),
      { outcome: "failed", reason: "object_not_live" },
    );
    db.prepare(
      "UPDATE vault_objects SET state = 'live', reclaim_attempt_id = NULL, reclaim_lease_until = NULL WHERE id = ?",
    ).run(gone.objectId);
  });

  // ------------------------------------------------------------------ due work

  it("due list: expired inbox entries and trashed entries past retention", () => {
    const inbox = (() => {
      const r = reserve(A);
      k.vaultMarkWritten({
        principal: A,
        reservationId: r.id,
        contentHash: hashOf("4"),
        byteSize: 10,
        now: now(),
        limits: LIMITS,
      });
      k.vaultPlanPromote({ principal: A, reservationId: r.id });
      k.vaultMarkPromoted({ principal: A, reservationId: r.id, now: now() });
      const out = k.vaultCommit({
        principal: A,
        reservationId: r.id,
        now: 5_000_000,
        mime: "text/plain",
        file: { ...draft("inbox.txt"), collection: "inbox" },
        inboxRetentionMs: 5_000,
      });
      return out.outcome === "committed" ? out.fileId : "";
    })();
    const trashed = ingest(A, hashOf("5"));
    k.vaultTrash({ principal: A, fileId: trashed.fileId, now: 5_000_000 });
    assert.deepEqual(
      k.vaultListDue({ principal: A, now: 5_001_000, trashRetentionMs: 10_000, limit: 50 }),
      { expiredInbox: [], trashedDue: [] },
    );
    const due = k.vaultListDue({
      principal: A,
      now: 5_020_000,
      trashRetentionMs: 10_000,
      limit: 50,
    });
    assert.deepEqual(due.expiredInbox, [inbox]);
    assert.deepEqual(due.trashedDue, [trashed.fileId]);
    assert.deepEqual(
      k.vaultListDue({ principal: B, now: 5_020_000, trashRetentionMs: 10_000, limit: 50 }),
      { expiredInbox: [], trashedDue: [] },
    );
    assert.equal(purgeFile(A, trashed.fileId).finish.outcome, "completed");
  });
  it("integrity: the verify batch pages over active and trashed files of one owner, and marking damaged is one-way", () => {
    const a1 = ingest(A, hashOf("6"), "v1.txt", 11);
    const a2 = ingest(A, hashOf("7"), "v2.txt", 22);
    const b1 = ingest(B, hashOf("8"), "v3.txt", 33);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const page: {
        items: { fileId: string; size: number; objectId: string }[];
        nextCursor: string | null;
      } = k.vaultVerifyBatch({ principal: A, afterFileId: cursor, limit: 1 });
      seen.push(...page.items.map((item) => item.fileId));
      if (page.nextCursor === null) {
        break;
      }
      cursor = page.nextCursor;
    }
    assert.ok(seen.includes(a1.fileId) && seen.includes(a2.fileId));
    assert.equal(seen.includes(b1.fileId), false, "another owner's files are never listed");
    assert.equal(new Set(seen).size, seen.length, "no file is listed twice");
    const all = k.vaultVerifyBatch({ principal: A, afterFileId: null, limit: 1000 });
    assert.equal(all.items.find((item) => item.fileId === a2.fileId)?.size, 22);

    assert.equal(
      k.vaultMarkDamaged({ principal: A, fileId: a1.fileId, now: now() }).outcome,
      "marked",
    );
    assert.equal(get("SELECT state FROM vault_files WHERE id = ?", a1.fileId)?.state, "damaged");
    assert.equal(
      k.vaultMarkDamaged({ principal: A, fileId: a1.fileId, now: now() }).outcome,
      "noop",
    );
    assert.equal(
      k.vaultMarkDamaged({ principal: B, fileId: a2.fileId, now: now() }).outcome,
      "not_found",
    );
    assert.equal(
      k
        .vaultVerifyBatch({ principal: A, afterFileId: null, limit: 1000 })
        .items.some((item) => item.fileId === a1.fileId),
      false,
      "a damaged file is not checked again",
    );
  });
});
