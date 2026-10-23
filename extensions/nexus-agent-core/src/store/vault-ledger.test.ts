// Vault kernel tests (Vault design sections 4-6, F1 slice 1): the write protocol R / W / P / C with dedup, quotas, owner
// isolation and the lifecycle edits. Runs the real SQL against node:sqlite in memory; the suite shares one database.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { applyMigrations } from "./kernel.js";
import { createNexusKernel } from "./nexus-kernel.js";
import type { Principal } from "./types.js";
import {
  normalizeVaultFolder,
  normalizeVaultName,
  type VaultFileDraft,
  type VaultLimits,
} from "./vault-types.js";

const LIMITS: VaultLimits = { maxFileBytes: 1000, ownerQuotaBytes: 5000 };
const A: Principal = { ownerId: "owner-a" };
const B: Principal = { ownerId: "owner-b" };
// Any letter maps to a valid lowercase hex digit so each letter is a distinct content hash.
const hashOf = (letter: string) => letter.charCodeAt(0).toString(16).padStart(2, "0").repeat(32);

describe("vault kernel: write protocol, dedup and lifecycle", () => {
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
  const applied = applyMigrations(db, tx);
  const k = createNexusKernel(db, tx);
  let clock = 1_000;
  const now = () => (clock += 1);
  const INC = "inc-1";
  k.registerIncarnation({ principal: A, incarnationId: INC, bootId: "boot-1", now: now() });

  const draft = (over: Partial<VaultFileDraft> = {}): VaultFileDraft => ({
    displayName: "notes.txt",
    collection: "vault",
    source: "upload",
    importedBy: "operator",
    ...over,
  });
  const reserve = (principal: Principal, expectedSize: number | null = 10) => {
    const out = k.vaultReserve({
      principal,
      now: now(),
      expectedSize,
      limits: LIMITS,
      ttlMs: 60_000,
      writerAttemptId: `attempt-${clock}`,
      incarnationId: INC,
    });
    assert.equal(out.outcome, "reserved");
    if (out.outcome !== "reserved") {
      throw new Error("unreachable");
    }
    return out.reservation;
  };
  const write = (principal: Principal, id: string, hash: string, size = 10) =>
    k.vaultMarkWritten({
      principal,
      reservationId: id,
      contentHash: hash,
      byteSize: size,
      now: now(),
      limits: LIMITS,
    });
  const promote = (principal: Principal, id: string) => {
    const plan = k.vaultPlanPromote({ principal, reservationId: id });
    if (plan.outcome === "promote") {
      assert.equal(
        k.vaultMarkPromoted({ principal, reservationId: id, now: now() }).outcome,
        "promoted",
      );
    }
    return plan;
  };
  const commit = (principal: Principal, id: string, file = draft()) =>
    k.vaultCommit({
      principal,
      reservationId: id,
      now: now(),
      mime: "text/plain",
      file,
      inboxRetentionMs: 5_000,
    });
  /** R, W, P, C for one file of the given content. */
  const ingest = (principal: Principal, hash: string, file = draft(), size = 10) => {
    const r = reserve(principal, size);
    assert.equal(write(principal, r.id, hash, size).outcome, "written");
    promote(principal, r.id);
    const out = commit(principal, r.id, file);
    assert.equal(out.outcome, "committed");
    if (out.outcome !== "committed") {
      throw new Error("unreachable");
    }
    return { reservation: r, ...out };
  };

  it("registers the vault migration after the watches migration", () => {
    assert.equal(applied[applied.length - 1], "stage5-0001-vault");
    assert.ok(applied.indexOf("stage5-0001-vault") > applied.indexOf("stage4-0002-watches"));
    for (const table of [
      "vault_reservations",
      "vault_objects",
      "vault_files",
      "vault_versions",
      "vault_purge_runs",
      "vault_purge_items",
      "vault_purge_receipts",
    ]) {
      assert.equal(
        count("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = ?", table),
        1,
        table,
      );
    }
  });

  it("name and folder rules are metadata-only and reject path-like input", () => {
    assert.equal(normalizeVaultName("  report.pdf "), "report.pdf");
    for (const bad of ["", "   ", "a/b", "a\\b", "..", ".", "x\u0000y", "x".repeat(256)]) {
      assert.equal(normalizeVaultName(bad), null, JSON.stringify(bad));
    }
    assert.equal(normalizeVaultFolder("/travel/japan/"), "travel/japan");
    assert.equal(normalizeVaultFolder(""), "");
    for (const bad of ["a/../b", "a//b", "./a", "a\\b", "a/ b", "1/2/3/4/5/6/7/8/9"]) {
      assert.equal(normalizeVaultFolder(bad), null, bad);
    }
  });

  it("R: reserves with a staging key equal to the reservation id and a long random object id", () => {
    const r = reserve(A);
    assert.equal(r.stagingKey, r.id);
    assert.ok(r.newObjectId.length >= 20);
    assert.notEqual(r.newObjectId, r.id);
    const row = db
      .prepare("SELECT state, staging_path_key FROM vault_reservations WHERE id = ?")
      .get(r.id) as {
      state: string;
      staging_path_key: string;
    };
    assert.deepEqual({ ...row }, { state: "reserved", staging_path_key: r.id });
    k.vaultFailReservation({ principal: A, reservationId: r.id, now: now(), reason: "cancelled" });
  });

  it("R: refuses an unknown or closed writer incarnation", () => {
    const out = k.vaultReserve({
      principal: A,
      now: now(),
      expectedSize: 1,
      limits: LIMITS,
      ttlMs: 1000,
      writerAttemptId: "x",
      incarnationId: "no-such-incarnation",
    });
    assert.equal(out.outcome, "writer_unregistered");
  });

  it("R / W: single-file cap and owner quota (unsettled reservations count)", () => {
    const tooBig = k.vaultReserve({
      principal: A,
      now: now(),
      expectedSize: 1001,
      limits: LIMITS,
      ttlMs: 1000,
      writerAttemptId: "x",
      incarnationId: INC,
    });
    assert.deepEqual(tooBig, {
      outcome: "quota_exceeded",
      scope: "file",
      limit: 1000,
      used: 0,
      requested: 1001,
    });
    // owner B fills most of the quota with promises; the check is per owner, so A is not affected
    const held = [
      reserve(B, 1000),
      reserve(B, 1000),
      reserve(B, 1000),
      reserve(B, 1000),
      reserve(B, 1000),
    ];
    const full = k.vaultReserve({
      principal: B,
      now: now(),
      expectedSize: 1,
      limits: LIMITS,
      ttlMs: 1000,
      writerAttemptId: "x",
      incarnationId: INC,
    });
    assert.equal(full.outcome === "quota_exceeded" && full.scope, "owner");
    const aOk = reserve(A, 1000);
    for (const r of held) {
      k.vaultFailReservation({
        principal: B,
        reservationId: r.id,
        now: now(),
        reason: "cancelled",
      });
    }
    k.vaultFailReservation({
      principal: A,
      reservationId: aOk.id,
      now: now(),
      reason: "cancelled",
    });
    // unknown size is allowed at R but enforced at W
    const streaming = reserve(A, null);
    const over = write(A, streaming.id, hashOf("1"), 1001);
    assert.equal(over.outcome === "quota_exceeded" && over.scope, "file");
    k.vaultFailReservation({
      principal: A,
      reservationId: streaming.id,
      now: now(),
      reason: "rejected",
    });
  });

  it("W: rejects bad hashes, wrong states and unknown reservations", () => {
    const r = reserve(A);
    assert.equal(write(A, r.id, "nothex").outcome, "invalid");
    assert.equal(write(A, r.id, hashOf("2")).outcome, "written");
    assert.deepEqual(write(A, r.id, hashOf("2")), { outcome: "wrong_state", state: "written" });
    assert.equal(write(A, "missing", hashOf("2")).outcome, "not_found");
    assert.equal(write(B, r.id, hashOf("2")).outcome, "not_found");
    k.vaultFailReservation({ principal: A, reservationId: r.id, now: now(), reason: "cancelled" });
    assert.equal(
      k.vaultFailReservation({ principal: A, reservationId: r.id, now: now(), reason: "cancelled" })
        .outcome,
      "wrong_state",
    );
  });

  it("R W P C: a new file becomes one object, one file, one version", () => {
    const out = ingest(A, hashOf("a"), draft({ displayName: "first.txt", folder: "docs" }));
    assert.equal(out.newObject, true);
    assert.equal(out.loser, null);
    assert.equal(out.objectId, out.reservation.newObjectId);
    const got = k.vaultGet({ principal: A, fileId: out.fileId });
    assert.equal(got.outcome, "ok");
    if (got.outcome === "ok") {
      assert.equal(got.file.displayName, "first.txt");
      assert.equal(got.file.folder, "docs");
      assert.equal(got.file.collection, "vault");
      assert.equal(got.file.state, "active");
      assert.equal(got.file.versionCount, 1);
      assert.equal(got.file.size, 10);
      assert.equal(got.file.expiresAt, null);
    }
    const res = db
      .prepare("SELECT state, result_object_id FROM vault_reservations WHERE id = ?")
      .get(out.reservation.id) as {
      state: string;
      result_object_id: string;
    };
    assert.deepEqual({ ...res }, { state: "committed", result_object_id: out.objectId });
  });

  it("C: running commit again is a safe no-op", () => {
    const first = ingest(A, hashOf("b"));
    const again = commit(A, first.reservation.id);
    assert.deepEqual(again, { outcome: "noop", state: "committed" });
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM vault_files WHERE owner_id = ? AND object_id = ?",
        "owner-a",
        first.objectId,
      ),
      1,
    );
  });

  it("C: two reservations promoted before either commits end with ONE object and two files; the loser is reported", () => {
    const r1 = reserve(A);
    const r2 = reserve(A);
    write(A, r1.id, hashOf("c"));
    write(A, r2.id, hashOf("c"));
    assert.equal(promote(A, r1.id).outcome, "promote");
    assert.equal(promote(A, r2.id).outcome, "promote");
    const c1 = commit(A, r1.id, draft({ displayName: "one.txt" }));
    const c2 = commit(A, r2.id, draft({ displayName: "two.txt" }));
    assert.equal(c1.outcome === "committed" && c1.newObject, true);
    assert.equal(c2.outcome === "committed" && c2.newObject, false);
    if (c1.outcome !== "committed" || c2.outcome !== "committed") {
      throw new Error("unreachable");
    }
    assert.equal(c2.objectId, c1.objectId);
    assert.deepEqual(c2.loser, { newObjectId: r2.newObjectId, stagingKey: r2.id });
    assert.equal(c1.loser, null);
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_objects WHERE content_hash = ?", hashOf("c")),
      1,
    );
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_files WHERE object_id = ?", c1.objectId),
      2,
    );
    const loser = db
      .prepare("SELECT state, result_object_id, new_object_id FROM vault_reservations WHERE id = ?")
      .get(r2.id) as Record<string, string>;
    assert.equal(loser.state, "committed");
    assert.equal(loser.result_object_id, c1.objectId);
    assert.notEqual(loser.result_object_id, loser.new_object_id);
    assert.equal(count("SELECT COUNT(*) AS c FROM vault_reservations WHERE state = 'promoted'"), 0);
  });

  it("P / C: an existing live object is reused without moving anything", () => {
    const base = ingest(A, hashOf("d"));
    const r = reserve(A);
    write(A, r.id, hashOf("d"));
    const plan = k.vaultPlanPromote({ principal: A, reservationId: r.id });
    assert.deepEqual(plan, { outcome: "reuse", objectId: base.objectId });
    const out = commit(A, r.id, draft({ displayName: "copy.txt" }));
    assert.equal(out.outcome === "committed" && out.newObject, false);
    assert.equal(out.outcome === "committed" && out.loser, null);
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_objects WHERE content_hash = ?", hashOf("d")),
      1,
    );
  });

  it("C: a `written` reservation whose winner has gone must go back to P (need_promote), and then commits as new", () => {
    const base = ingest(A, hashOf("e"));
    const r = reserve(A);
    write(A, r.id, hashOf("e"));
    assert.equal(k.vaultPlanPromote({ principal: A, reservationId: r.id }).outcome, "reuse");
    // the winner is reclaimed between P and C (modelled directly: the reclaim protocol is tested separately)
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      "UPDATE vault_objects SET state = 'deleted', absence_verified_at = 1, absence_verified_attempt_id = 'x' WHERE id = ?",
    ).run(base.objectId);
    db.exec("PRAGMA foreign_keys = ON");
    assert.deepEqual(commit(A, r.id), { outcome: "need_promote" });
    assert.equal(
      db.prepare("SELECT state FROM vault_reservations WHERE id = ?").get(r.id)?.state,
      "written",
    );
    assert.equal(promote(A, r.id).outcome, "promote");
    const out = commit(A, r.id);
    assert.equal(out.outcome === "committed" && out.newObject, true);
  });

  it("the partial unique index is the backstop: a second live object with the same content is refused by the database", () => {
    const first = ingest(A, hashOf("f"));
    const r = reserve(A);
    write(A, r.id, hashOf("f"));
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO vault_objects (owner_id, id, reservation_id, content_hash, size, mime, state, created_at, updated_at) " +
              "VALUES ('owner-a', 'dupe', ?, ?, 10, 'text/plain', 'live', 1, 1)",
          )
          .run(r.id, hashOf("f")),
      /UNIQUE constraint failed/,
    );
    assert.ok(first.objectId);
    k.vaultFailReservation({ principal: A, reservationId: r.id, now: now(), reason: "cancelled" });
  });

  it("C validates the name, folder and collection before touching anything", () => {
    const r = reserve(A);
    write(A, r.id, hashOf("g"));
    promote(A, r.id);
    assert.deepEqual(commit(A, r.id, draft({ displayName: "a/b" })), {
      outcome: "invalid",
      reason: "name",
    });
    assert.deepEqual(commit(A, r.id, draft({ folder: "../x" })), {
      outcome: "invalid",
      reason: "folder",
    });
    assert.equal(
      db.prepare("SELECT state FROM vault_reservations WHERE id = ?").get(r.id)?.state,
      "promoted",
    );
    assert.equal(commit(A, r.id).outcome, "committed");
  });

  it("owner isolation: the same bytes make a separate object; reads and edits never cross owners", () => {
    const a = ingest(A, hashOf("h"), draft({ displayName: "mine.txt" }));
    const b = ingest(B, hashOf("h"), draft({ displayName: "theirs.txt" }));
    assert.notEqual(a.objectId, b.objectId);
    assert.equal(k.vaultGet({ principal: B, fileId: a.fileId }).outcome, "not_found");
    assert.equal(
      k.vaultRename({ principal: B, fileId: a.fileId, now: now(), displayName: "x" }).outcome,
      "not_found",
    );
    assert.equal(k.vaultTrash({ principal: B, fileId: a.fileId, now: now() }).outcome, "not_found");
    assert.equal(k.vaultReadRef({ principal: B, fileId: a.fileId }).outcome, "not_found");
    const found = k.vaultFindByHash({ principal: B, contentHash: hashOf("h") });
    assert.deepEqual(
      found.files.map((f) => f.displayName),
      ["theirs.txt"],
    );
    assert.equal(k.vaultFindByHash({ principal: A, contentHash: hashOf("9") }).objectId, null);
    assert.ok(k.vaultList({ principal: B }).items.every((f) => f.id !== a.fileId));
  });

  it("inbox: expiry is stamped, keep promotes to the vault, discard and restore keep the collection", () => {
    const inbox = ingest(
      A,
      hashOf("i"),
      draft({ displayName: "inbox.txt", collection: "inbox", source: "chat" }),
    );
    const before = k.vaultGet({ principal: A, fileId: inbox.fileId });
    assert.equal(before.outcome === "ok" && before.file.expiresAt !== null, true);
    const kept = k.vaultKeep({
      principal: A,
      fileId: inbox.fileId,
      now: now(),
      folder: "keep/here",
    });
    assert.equal(kept.outcome, "ok");
    if (kept.outcome === "ok") {
      assert.equal(kept.file.collection, "vault");
      assert.equal(kept.file.expiresAt, null);
      assert.equal(kept.file.folder, "keep/here");
    }
    assert.equal(
      k.vaultKeep({ principal: A, fileId: inbox.fileId, now: now() }).outcome,
      "wrong_state",
    );
    const second = ingest(A, hashOf("j"), draft({ displayName: "junk.txt", collection: "inbox" }));
    assert.equal(k.vaultDiscard({ principal: A, fileId: second.fileId, now: now() }).outcome, "ok");
    assert.equal(
      k.vaultList({ principal: A, state: "trashed" }).items.some((f) => f.id === second.fileId),
      true,
    );
    const back = k.vaultRestore({ principal: A, fileId: second.fileId, now: now() });
    assert.equal(back.outcome === "ok" && back.file.collection, "inbox");
    assert.equal(back.outcome === "ok" && back.file.state, "active");
    assert.equal(
      k.vaultDiscard({
        principal: A,
        fileId: kept.outcome === "ok" ? kept.file.id : "",
        now: now(),
      }).outcome,
      "wrong_state",
    );
  });

  it("soft delete keeps the bytes and the object; restore brings the file back; both are state-checked", () => {
    const f = ingest(A, hashOf("k"), draft({ displayName: "soft.txt" }));
    const t = k.vaultTrash({ principal: A, fileId: f.fileId, now: now() });
    assert.equal(t.outcome === "ok" && t.file.state, "trashed");
    assert.equal(t.outcome === "ok" && t.file.trashedAt !== null, true);
    assert.equal(
      k.vaultTrash({ principal: A, fileId: f.fileId, now: now() }).outcome,
      "wrong_state",
    );
    assert.equal(
      k.vaultRename({ principal: A, fileId: f.fileId, now: now(), displayName: "z" }).outcome,
      "wrong_state",
    );
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_objects WHERE id = ? AND state = 'live'", f.objectId),
      1,
    );
    assert.equal(
      k.vaultList({ principal: A }).items.some((x) => x.id === f.fileId),
      false,
    );
    assert.equal(k.vaultRestore({ principal: A, fileId: f.fileId, now: now() }).outcome, "ok");
    assert.equal(
      k.vaultRestore({ principal: A, fileId: f.fileId, now: now() }).outcome,
      "wrong_state",
    );
  });

  it("rename, move and sensitivity edits validate input and only touch active (or trashed, for sensitivity) files", () => {
    const f = ingest(A, hashOf("l"), draft({ displayName: "edit.txt" }));
    assert.equal(
      k.vaultRename({ principal: A, fileId: f.fileId, now: now(), displayName: "a/b" }).outcome,
      "invalid",
    );
    const renamed = k.vaultRename({
      principal: A,
      fileId: f.fileId,
      now: now(),
      displayName: "renamed.txt",
    });
    assert.equal(renamed.outcome === "ok" && renamed.file.displayName, "renamed.txt");
    assert.equal(
      k.vaultMove({ principal: A, fileId: f.fileId, now: now(), folder: "x/../y" }).outcome,
      "invalid",
    );
    const moved = k.vaultMove({ principal: A, fileId: f.fileId, now: now(), folder: "/a/b/" });
    assert.equal(moved.outcome === "ok" && moved.file.folder, "a/b");
    const s = k.vaultSetSensitivity({
      principal: A,
      fileId: f.fileId,
      now: now(),
      sensitivity: "sensitive",
      by: "user",
    });
    assert.equal(s.outcome === "ok" && s.file.sensitivity, "sensitive");
    assert.equal(s.outcome === "ok" && s.file.sensitivityBy, "user");
  });

  it("pin and favorite live in their own table and survive edits", () => {
    const f = ingest(A, hashOf("m"), draft({ displayName: "pinned.txt" }));
    const p = k.vaultPin({ principal: A, fileId: f.fileId, now: now(), pinned: true });
    assert.equal(p.outcome === "ok" && p.file.pinnedAt !== null, true);
    const fav = k.vaultPin({ principal: A, fileId: f.fileId, now: now(), favorite: true });
    assert.equal(fav.outcome === "ok" && fav.file.favorite, true);
    assert.equal(fav.outcome === "ok" && fav.file.pinnedAt !== null, true);
    const un = k.vaultPin({ principal: A, fileId: f.fileId, now: now(), pinned: false });
    assert.equal(un.outcome === "ok" && un.file.pinnedAt, null);
    assert.equal(un.outcome === "ok" && un.file.favorite, true);
    k.vaultPin({ principal: A, fileId: f.fileId, now: now(), pinned: true });
    assert.equal(k.vaultList({ principal: A, pinnedFirst: true }).items[0]?.id, f.fileId);
  });

  it("list: filters by collection, folder, name and sensitivity, and paginates with a stable total", () => {
    const only = (principal: Principal) => k.vaultList({ principal, limit: 200 }).items;
    const before = only(B).length;
    const x1 = ingest(
      B,
      hashOf("n"),
      draft({ displayName: "Tokyo Plan.md", folder: "travel/japan" }),
    );
    ingest(B, hashOf("o"), draft({ displayName: "tax-2025.pdf", folder: "money" }));
    const sens = ingest(B, hashOf("p"), draft({ displayName: "passport.png", folder: "ids" }));
    k.vaultSetSensitivity({
      principal: B,
      fileId: sens.fileId,
      now: now(),
      sensitivity: "sensitive",
      by: "user",
    });
    assert.equal(only(B).length, before + 3);
    assert.deepEqual(
      k.vaultList({ principal: B, folder: "travel/japan" }).items.map((f) => f.id),
      [x1.fileId],
    );
    assert.deepEqual(
      k.vaultList({ principal: B, nameContains: "TOKYO" }).items.map((f) => f.id),
      [x1.fileId],
    );
    assert.equal(k.vaultList({ principal: B, nameContains: "%" }).total, 0);
    assert.equal(
      k
        .vaultList({ principal: B, includeSensitive: false })
        .items.some((f) => f.id === sens.fileId),
      false,
    );
    assert.equal(
      k.vaultList({ principal: B, includeSensitive: true }).items.some((f) => f.id === sens.fileId),
      true,
    );
    const page = k.vaultList({ principal: B, limit: 2, offset: 0 });
    const next = k.vaultList({ principal: B, limit: 2, offset: 2 });
    assert.equal(page.items.length, 2);
    assert.equal(page.total, next.total);
    assert.equal(
      page.items.some((a) => next.items.some((b) => b.id === a.id)),
      false,
    );
    assert.equal(k.vaultList({ principal: B, folder: "../bad" }).total, 0);
  });

  it("readRef: only active files are readable (trashed needs allowTrashed); touch stamps last_opened_at", () => {
    const f = ingest(A, hashOf("q"), draft({ displayName: "read.txt" }));
    const ok = k.vaultReadRef({ principal: A, fileId: f.fileId, touchAt: 777 });
    assert.equal(ok.outcome, "ok");
    assert.equal(
      k.vaultGet({ principal: A, fileId: f.fileId }).outcome === "ok" &&
        (k.vaultGet({ principal: A, fileId: f.fileId }) as { file: { lastOpenedAt: number } }).file
          .lastOpenedAt,
      777,
    );
    k.vaultTrash({ principal: A, fileId: f.fileId, now: now() });
    assert.deepEqual(k.vaultReadRef({ principal: A, fileId: f.fileId }), {
      outcome: "not_readable",
      state: "trashed",
    });
    assert.equal(
      k.vaultReadRef({ principal: A, fileId: f.fileId, allowTrashed: true }).outcome,
      "ok",
    );
  });

  it("stats: counts files per collection and state, object bytes once per object", () => {
    const s = k.vaultStats({ principal: A });
    assert.ok(s.objects >= 1);
    assert.ok(s.objectBytes >= 10);
    assert.equal(s.reservedBytes, 0);
    assert.ok((s.files["vault:active"] ?? 0) >= 1);
  });
});
