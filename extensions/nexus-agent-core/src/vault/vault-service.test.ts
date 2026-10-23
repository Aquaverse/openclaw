// Vault service tests (Vault design 5.2 / 5.3 / 5.6): the byte side of the write protocol against a REAL directory tree,
// with failure and hold injection around the file store, and the kernel running real SQL in memory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { applyMigrations } from "../store/kernel.js";
import { createNexusKernel } from "../store/nexus-kernel.js";
import type { Principal } from "../store/types.js";
import { vaultObjectKey } from "../store/vault-types.js";
import { createFsVaultFileStore, withVaultStoreFaults } from "./vault-file-store.js";
import { openImportSource } from "./vault-import.js";
import { classifyVaultName, sniffVaultMime } from "./vault-rules.js";
import { createVaultService, type VaultConfig, type VaultStore } from "./vault-service.js";

const A: Principal = { ownerId: "owner-a" };
const B: Principal = { ownerId: "owner-b" };
const MIB = 1024 * 1024;
const text = (value: string) => new TextEncoder().encode(value);

describe("vault service", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-svc-"));
  const root = path.join(dir, "vault");
  const importRoot = path.join(dir, "Downloads");
  const outside = path.join(dir, "elsewhere");
  const stateDir = path.join(importRoot, "state");
  for (const folder of [importRoot, outside, stateDir]) {
    fs.mkdirSync(folder, { recursive: true });
  }

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
      get: (_target, name: string) =>
        // `then` must stay undefined or `await getStore()` would treat the proxy as a thenable
        name === "then"
          ? undefined
          : async (input: unknown) =>
              (Reflect.get(kernel, name) as (value: unknown) => unknown)(input),
    },
  ) as VaultStore;
  const count = (sql: string, ...params: (string | number)[]): number =>
    (db.prepare(sql).get(...params) as { c: number }).c;
  const row = (sql: string, ...params: (string | number)[]) =>
    db.prepare(sql).get(...params) as Record<string, string | number | null> | undefined;

  let clock = 5_000_000;
  const faults = withVaultStoreFaults(createFsVaultFileStore(root));
  const baseConfig: VaultConfig = {
    limits: { maxFileBytes: MIB, ownerQuotaBytes: 8 * MIB },
    inboxRetentionMs: 1000 * 60,
    trashRetentionMs: 1000 * 60 * 10,
    reservationTtlMs: 60_000,
    minFreeBytes: 0,
    reservationRetentionMs: 1000 * 60 * 60,
    tombstoneRetentionMs: 1000 * 60 * 60,
    receiptHashRetentionMs: 1000 * 60 * 60 * 24,
    reclaimGraceMs: 5_000,
    import: { roots: [importRoot], forbidden: [stateDir], maxBytes: MIB },
  };
  let config = baseConfig;
  const warnings: string[] = [];
  const events: string[] = [];
  const makeService = (incarnation: string) =>
    createVaultService({
      getStore: async () => store,
      files: faults,
      incarnationId: () => incarnation,
      incarnationGoneEnabled: false,
      config: () => config,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      logger: { warn: (message) => warnings.push(message) },
      onChanged: (event) => events.push(`${event.action}:${event.fileId}`),
    });
  kernel.registerIncarnation({
    principal: A,
    incarnationId: "inc-1",
    bootId: "boot-1",
    now: clock,
  });
  kernel.registerIncarnation({
    principal: A,
    incarnationId: "inc-2",
    bootId: "boot-2",
    now: clock,
  });
  let liveInc = "inc-1";
  let svc = makeService(liveInc);
  const upload = (
    principal: Principal,
    name: string,
    body: string | Uint8Array,
    extra: object = {},
  ) =>
    svc.ingest(principal, {
      displayName: name,
      bytes: typeof body === "string" ? text(body) : body,
      source: "upload",
      importedBy: "operator",
      ...extra,
    });
  const must = async (promise: ReturnType<typeof upload>) => {
    const out = await promise;
    assert.equal(out.outcome, "ok", JSON.stringify(out));
    if (out.outcome !== "ok") {
      throw new Error("unreachable");
    }
    return out;
  };
  const onDisk = (key: string) => fs.existsSync(path.join(root, key));
  const filesIn = (sub: string): string[] => {
    const base = path.join(root, sub);
    if (!fs.existsSync(base)) {
      return [];
    }
    return fs
      .readdirSync(base, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  };

  // ------------------------------------------------------------------ rules

  it("rules: the media type comes from the bytes, and only sensitive-looking names raise sensitivity", () => {
    assert.equal(
      sniffVaultMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), "x.txt"),
      "image/png",
    );
    assert.equal(sniffVaultMime(text("%PDF-1.7 ..."), "a.txt"), "application/pdf");
    assert.equal(sniffVaultMime(text("hello"), "a.md"), "text/markdown");
    assert.equal(sniffVaultMime(text("hello"), "a.exe"), "text/plain");
    assert.equal(sniffVaultMime(new Uint8Array([0, 1, 2, 3]), "a.txt"), "application/octet-stream");
    assert.equal(
      sniffVaultMime(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]), "r.docx"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    assert.equal(
      sniffVaultMime(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]), "r.bin"),
      "application/zip",
    );
    assert.equal(classifyVaultName("My_Passport-scan.PDF"), "sensitive");
    assert.equal(classifyVaultName("身份证正面.jpg"), "sensitive");
    assert.equal(classifyVaultName("holiday plan.txt"), "normal");
  });

  // ------------------------------------------------------------------ happy path

  it("upload: bytes land in objects/, staging is empty, the entry is readable, the name never reaches the path", async () => {
    const out = await must(upload(A, "../weird name?.txt".replace("../", ""), "hello vault"));
    assert.equal(out.deduplicated, false);
    assert.equal(out.file.mime, "text/plain");
    assert.equal(out.file.size, 11);
    assert.ok(onDisk(vaultObjectKey(out.file.objectId)));
    assert.equal(filesIn("staging").length, 0);
    for (const name of filesIn("objects")) {
      assert.equal(name.includes("weird"), false, "the display name is metadata only");
    }
    const read = await svc.read(A, { fileId: out.file.id });
    assert.equal(read.outcome === "ok" && new TextDecoder().decode(read.bytes), "hello vault");
    assert.equal(read.outcome === "ok" && read.eof, true);
    const part = await svc.read(A, { fileId: out.file.id, offset: 6, length: 3 });
    assert.equal(part.outcome === "ok" && new TextDecoder().decode(part.bytes), "vau");
    assert.equal(part.outcome === "ok" && part.eof, false);
    assert.equal(
      row("SELECT last_opened_at AS t FROM vault_user_state WHERE file_id = ?", out.file.id)?.t,
      clock,
    );
    assert.deepEqual(await svc.read(B, { fileId: out.file.id }), { outcome: "not_found" });
    assert.ok(events.some((e) => e === `imported:${out.file.id}`));
  });

  it("upload: the object file and directories are private (0600 / 0700)", async () => {
    const out = await must(upload(A, "private.txt", "x"));
    const file = path.join(root, vaultObjectKey(out.file.objectId));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  });

  it("upload: a sensitive-looking name is marked sensitive by rule", async () => {
    const out = await must(upload(A, "passport-scan.txt", "data"));
    assert.equal(out.file.sensitivity, "sensitive");
    assert.equal(out.file.sensitivityBy, "rule");
  });

  it("upload: a streamed body is hashed and written in chunks", async () => {
    async function* body() {
      yield text("part one, ");
      yield text("part two");
    }
    const out = await must(
      svc.ingest(A, {
        displayName: "streamed.txt",
        bytes: body(),
        source: "upload",
        importedBy: "op",
      }),
    );
    const read = await svc.read(A, { fileId: out.file.id });
    assert.equal(
      read.outcome === "ok" && new TextDecoder().decode(read.bytes),
      "part one, part two",
    );
  });

  // ------------------------------------------------------------------ dedup

  it("dedup: the same bytes make a second entry on ONE object, and the unneeded copy is deleted", async () => {
    const first = await must(upload(A, "a.txt", "same bytes"));
    const second = await must(upload(A, "b.txt", "same bytes"));
    assert.equal(second.deduplicated, true);
    assert.equal(second.file.objectId, first.file.objectId);
    assert.notEqual(second.file.id, first.file.id);
    assert.equal(filesIn("staging").length, 0);
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM vault_objects WHERE content_hash = ? AND state = 'live'",
        String(
          row("SELECT content_hash AS h FROM vault_objects WHERE id = ?", first.file.objectId)?.h,
        ),
      ),
      1,
    );
    const other = await must(upload(B, "c.txt", "same bytes"));
    assert.notEqual(other.file.objectId, first.file.objectId, "no cross-owner dedup");
  });

  it("dedup race: both writers reach P before either commits -> one object, two entries, the loser's file is deleted", async () => {
    const hold = faults.holdNext("promote");
    const slow = upload(A, "slow.txt", "raced content");
    await hold.started; // the first writer is suspended inside its rename
    const fast = await must(upload(A, "fast.txt", "raced content"));
    assert.equal(fast.deduplicated, false);
    hold.release();
    const late = await must(slow);
    assert.equal(late.deduplicated, true);
    assert.equal(late.file.objectId, fast.file.objectId);
    assert.equal(count("SELECT COUNT(*) AS c FROM vault_reservations WHERE state = 'promoted'"), 0);
    // exactly one physical file for this content: the loser's renamed file is gone
    const keys = faults.calls.filter((c) => c.startsWith("promote:"));
    assert.ok(keys.length >= 2);
    assert.equal(onDisk(vaultObjectKey(fast.file.objectId)), true);
    const loser = row(
      "SELECT new_object_id AS n FROM vault_reservations WHERE state = 'committed' AND result_object_id <> new_object_id ORDER BY updated_at DESC LIMIT 1",
    );
    assert.ok(loser);
    assert.equal(onDisk(vaultObjectKey(String(loser?.n))), false);
  });

  // ------------------------------------------------------------------ limits and failures

  it("name and folder are refused before any reservation exists", async () => {
    const before = count("SELECT COUNT(*) AS c FROM vault_reservations");
    assert.deepEqual(await upload(A, "a/b.txt", "x"), { outcome: "invalid", reason: "name" });
    assert.deepEqual(await upload(A, "ok.txt", "x", { folder: "../up" }), {
      outcome: "invalid",
      reason: "folder",
    });
    assert.equal(count("SELECT COUNT(*) AS c FROM vault_reservations"), before);
  });

  it("single-file cap: an unknown-size stream is cut off, staging removed, reservation failed", async () => {
    async function* endless() {
      for (let i = 0; i < 100; i += 1) {
        yield new Uint8Array(64 * 1024);
      }
    }
    const out = await svc.ingest(A, {
      displayName: "huge.bin",
      bytes: endless(),
      source: "upload",
      importedBy: "op",
    });
    assert.equal(out.outcome, "quota_exceeded");
    assert.equal(out.outcome === "quota_exceeded" && out.scope, "file");
    assert.equal(filesIn("staging").length, 0);
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_reservations WHERE state IN ('reserved','written')"),
      0,
    );
  });

  it("a known oversize file is refused at R without touching the disk", async () => {
    const calls = faults.calls.length;
    const out = await svc.ingest(A, {
      displayName: "big.bin",
      bytes: new Uint8Array(1),
      expectedSize: 2 * MIB,
      source: "upload",
      importedBy: "op",
    });
    assert.equal(out.outcome === "quota_exceeded" && out.scope, "file");
    assert.equal(faults.calls.length, calls);
  });

  it("owner quota: unsettled reservations count and a full owner is refused", async () => {
    config = { ...baseConfig, limits: { maxFileBytes: MIB, ownerQuotaBytes: 5 } };
    const out = await svc.ingest(A, {
      displayName: "q.bin",
      bytes: new Uint8Array(10),
      expectedSize: 10,
      source: "upload",
      importedBy: "op",
    });
    assert.equal(out.outcome === "quota_exceeded" && out.scope, "owner");
    config = baseConfig;
  });

  it("disk space: refused when the volume would fall below the safety margin", async () => {
    config = { ...baseConfig, minFreeBytes: 2 * MIB };
    faults.setFreeBytes(MIB);
    const out = await upload(A, "nospace.txt", "x");
    assert.equal(out.outcome, "disk_low");
    faults.setFreeBytes(undefined);
    config = baseConfig;
    assert.equal((await upload(A, "space.txt", "x")).outcome, "ok");
  });

  it("injected failures at every I/O step leave no staging file, no promoted reservation and no orphan object", async () => {
    for (const method of ["createStaging", "write", "finish", "promote"] as const) {
      faults.failNext(method);
      const out = await upload(A, `fail-${method}.txt`, `content for ${method}`);
      assert.equal(out.outcome, "write_failed", method);
      assert.equal(filesIn("staging").length, 0, `${method}: staging`);
      assert.equal(
        count(
          "SELECT COUNT(*) AS c FROM vault_reservations WHERE state IN ('reserved','written','promoted')",
        ),
        0,
        `${method}: reservation`,
      );
      assert.equal(
        count("SELECT COUNT(*) AS c FROM vault_files WHERE display_name = ?", `fail-${method}.txt`),
        0,
        `${method}: no entry`,
      );
    }
    const onlyKnown = new Set(
      (db.prepare("SELECT id FROM vault_objects").all() as { id: string }[]).map((r) => r.id),
    );
    for (const key of fs
      .readdirSync(path.join(root, "objects"), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())) {
      assert.ok(onlyKnown.has(key.name), `orphan object file ${key.name}`);
    }
  });

  // ------------------------------------------------------------------ crash windows

  /** A new process (inc-2) starts after inc-1 died in the middle of a write. */
  const restartAfter = (ms: number) => {
    clock += ms;
    kernel.closeIncarnation({ principal: A, incarnationId: "inc-1", now: clock });
    liveInc = "inc-2";
    svc = makeService(liveInc);
    return svc;
  };

  const reserveByHand = (hash: string, size: number) => {
    const out = kernel.vaultReserve({
      principal: A,
      now: clock,
      expectedSize: size,
      limits: baseConfig.limits,
      ttlMs: 60_000,
      writerAttemptId: `hand-${clock}`,
      incarnationId: liveInc,
    });
    if (out.outcome !== "reserved") {
      throw new Error("unreachable");
    }
    return { reservation: out.reservation, hash, size };
  };
  const putFile = (key: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, key)), { recursive: true });
    fs.writeFileSync(path.join(root, key), body);
  };

  it("crash windows: every unfinished write is cleaned by the next process, files and rows together", async () => {
    // window 1: reserved, nothing on disk
    const w1 = reserveByHand("", 0);
    // window 2: reserved, partial staging
    const w2 = reserveByHand("", 0);
    putFile(`staging/${w2.reservation.id}`, "par");
    // window 3: written (hash recorded), staging complete
    const w3 = reserveByHand("", 0);
    putFile(`staging/${w3.reservation.id}`, "complete bytes");
    kernel.vaultMarkWritten({
      principal: A,
      reservationId: w3.reservation.id,
      contentHash: "ab".repeat(32),
      byteSize: 14,
      now: clock,
      limits: baseConfig.limits,
    });
    // window 4: the rename landed but the state was not recorded (still `written`)
    const w4 = reserveByHand("", 0);
    putFile(vaultObjectKey(w4.reservation.newObjectId), "renamed bytes");
    kernel.vaultMarkWritten({
      principal: A,
      reservationId: w4.reservation.id,
      contentHash: "cd".repeat(32),
      byteSize: 13,
      now: clock,
      limits: baseConfig.limits,
    });
    // window 5: promoted, never committed
    const w5 = reserveByHand("", 0);
    putFile(vaultObjectKey(w5.reservation.newObjectId), "promoted bytes");
    kernel.vaultMarkWritten({
      principal: A,
      reservationId: w5.reservation.id,
      contentHash: "ef".repeat(32),
      byteSize: 14,
      now: clock,
      limits: baseConfig.limits,
    });
    kernel.vaultPlanPromote({ principal: A, reservationId: w5.reservation.id });
    kernel.vaultMarkPromoted({ principal: A, reservationId: w5.reservation.id, now: clock });

    const next = restartAfter(120_000);
    const report = await next.maintain(A);
    assert.equal(report.errors.length, 0, report.errors.join("; "));
    assert.ok(report.recovered.expired >= 5);
    for (const w of [w1, w2, w3, w4, w5]) {
      assert.equal(
        row("SELECT state FROM vault_reservations WHERE id = ?", w.reservation.id)?.state,
        "expired",
      );
      assert.equal(onDisk(`staging/${w.reservation.id}`), false, "staging gone");
      assert.equal(onDisk(vaultObjectKey(w.reservation.newObjectId)), false, "object file gone");
    }
  });

  it("crash window 6: a committed loser whose files were not deleted is cleaned, the winner's file is untouched", async () => {
    const winner = await must(upload(A, "win.txt", "loser scenario"));
    const r = reserveByHand("", 0);
    putFile(`staging/${r.reservation.id}`, "loser scenario");
    kernel.vaultMarkWritten({
      principal: A,
      reservationId: r.reservation.id,
      contentHash: String(
        row("SELECT content_hash AS h FROM vault_objects WHERE id = ?", winner.file.objectId)?.h,
      ),
      byteSize: 14,
      now: clock,
      limits: baseConfig.limits,
    });
    kernel.vaultPlanPromote({ principal: A, reservationId: r.reservation.id });
    kernel.vaultCommit({
      principal: A,
      reservationId: r.reservation.id,
      now: clock,
      mime: "text/plain",
      file: { displayName: "dup.txt", collection: "vault", source: "upload", importedBy: "op" },
      inboxRetentionMs: 1000,
    });
    assert.equal(
      onDisk(`staging/${r.reservation.id}`),
      true,
      "the crash left the staging copy behind",
    );
    const report = await svc.maintain(A);
    assert.ok(report.recovered.losersDeleted >= 1);
    assert.equal(onDisk(`staging/${r.reservation.id}`), false);
    assert.equal(onDisk(vaultObjectKey(winner.file.objectId)), true);
  });

  it("recovery never touches a reservation whose writer is still running in this process", async () => {
    const hold = faults.holdNext("write");
    const running = upload(A, "inflight.txt", "slow writer");
    await hold.started;
    clock += 10 * 60_000; // far past the TTL: the reservation looks expired, but its writer is alive here
    const report = await svc.maintain(A);
    assert.equal(report.recovered.expired, 0);
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM vault_reservations WHERE state = 'reserved' AND writer_incarnation = ?",
        liveInc,
      ) >= 1,
      true,
    );
    hold.release();
    await running; // the write itself completes or fails; either way nothing was deleted under it
  });

  // ------------------------------------------------------------------ path import

  const makeFile = (folder: string, name: string, body: string) => {
    const file = path.join(folder, name);
    fs.writeFileSync(file, body);
    return file;
  };

  it("import: a file inside the root is copied; the original stays; only the base name is kept", async () => {
    const original = makeFile(importRoot, "report.txt", "imported text");
    const out = await svc.importPath(A, { path: original, importedBy: "op" });
    assert.equal(out.outcome, "ok");
    assert.ok(out.outcome === "ok" && out.file.source === "local_import");
    assert.equal(out.outcome === "ok" && out.file.displayName, "report.txt");
    assert.equal(out.outcome === "ok" && out.file.sourceRef, null);
    assert.equal(fs.existsSync(original), true);
    const meta = JSON.stringify(db.prepare("SELECT * FROM vault_files").all());
    assert.equal(meta.includes(importRoot), false, "no full path stored anywhere");
    assert.equal(meta.includes("Downloads"), false);
  });

  it("import: refusals - outside the roots, symlink escape, state dir, directory, FIFO, relative path, too large", async () => {
    const secret = makeFile(outside, "secret.txt", "top secret");
    assert.deepEqual(await svc.importPath(A, { path: secret, importedBy: "op" }), {
      outcome: "refused",
      reason: "outside_roots",
    });
    const link = path.join(importRoot, "link.txt");
    fs.symlinkSync(secret, link);
    assert.deepEqual(await svc.importPath(A, { path: link, importedBy: "op" }), {
      outcome: "refused",
      reason: "outside_roots",
    });
    const dirLink = path.join(importRoot, "dirlink");
    fs.symlinkSync(outside, dirLink);
    assert.deepEqual(
      await svc.importPath(A, { path: path.join(dirLink, "secret.txt"), importedBy: "op" }),
      { outcome: "refused", reason: "outside_roots" },
    );
    const dotted = path.join(importRoot, "..", "elsewhere", "secret.txt");
    assert.deepEqual(await svc.importPath(A, { path: dotted, importedBy: "op" }), {
      outcome: "refused",
      reason: "outside_roots",
    });
    const inState = makeFile(stateDir, "nexus.sqlite", "db");
    assert.deepEqual(await svc.importPath(A, { path: inState, importedBy: "op" }), {
      outcome: "refused",
      reason: "forbidden_location",
    });
    assert.deepEqual(await svc.importPath(A, { path: importRoot, importedBy: "op" }), {
      outcome: "refused",
      reason: "not_regular_file",
    });
    const fifo = path.join(importRoot, "pipe");
    execFileSync("mkfifo", [fifo]);
    assert.deepEqual(await svc.importPath(A, { path: fifo, importedBy: "op" }), {
      outcome: "refused",
      reason: "not_regular_file",
    });
    assert.deepEqual(await svc.importPath(A, { path: "relative/file.txt", importedBy: "op" }), {
      outcome: "refused",
      reason: "not_absolute",
    });
    assert.deepEqual(
      await svc.importPath(A, { path: path.join(importRoot, "missing.txt"), importedBy: "op" }),
      { outcome: "refused", reason: "not_found" },
    );
    const big = makeFile(importRoot, "big.bin", "x".repeat(MIB + 1));
    assert.deepEqual(await svc.importPath(A, { path: big, importedBy: "op" }), {
      outcome: "refused",
      reason: "too_large",
    });
    assert.equal(filesIn("staging").length, 0, "no refusal left a staging file");
  });

  it("import: a symlink that stays inside the root is followed to its real file", async () => {
    const real = makeFile(importRoot, "real-target.txt", "inside link");
    const inside = path.join(importRoot, "inside-link.txt");
    fs.symlinkSync(real, inside);
    const out = await svc.importPath(A, { path: inside, importedBy: "op" });
    assert.equal(out.outcome, "ok");
    assert.equal(out.outcome === "ok" && out.file.displayName, "real-target.txt");
  });

  it("import: a file that changes while it is being read voids the read and leaves nothing behind", async () => {
    const file = makeFile(importRoot, "moving.txt", "initial content");
    const opened = await openImportSource(file, {
      roots: [importRoot],
      forbidden: [],
      maxBytes: MIB,
    });
    assert.ok(opened.ok);
    if (!opened.ok) {
      return;
    }
    fs.appendFileSync(file, " and more"); // grows after the handle was opened
    const out = await svc.ingest(A, {
      displayName: "moving.txt",
      bytes: opened.source.chunks,
      expectedSize: opened.source.size,
      source: "local_import",
      importedBy: "op",
    });
    assert.equal(out.outcome, "write_failed");
    assert.equal(filesIn("staging").length, 0);
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM vault_reservations WHERE state IN ('reserved','written','promoted')",
      ),
      0,
    );
    await opened.source.close();
  });

  it("import: a file swapped for another between the checks and the open is refused (same device + inode required)", async () => {
    const file = makeFile(importRoot, "swap.txt", "original");
    const replacement = makeFile(
      importRoot,
      "swap-new.txt",
      "a different file that sits in its place",
    );
    const result = await openImportSource(file, {
      roots: [importRoot],
      forbidden: [],
      maxBytes: MIB,
      afterChecks: async () => {
        fs.renameSync(replacement, file); // atomic swap while the old inode still exists, so the inode must differ
      },
    });
    assert.deepEqual(result, { ok: false, reason: "replaced_while_opening" });
  });

  // ------------------------------------------------------------------ reads

  it("read: trashed and missing-byte cases are explicit", async () => {
    const out = await must(upload(A, "reader.txt", "readable"));
    await store.vaultTrash({ principal: A, fileId: out.file.id, now: clock });
    assert.deepEqual(await svc.read(A, { fileId: out.file.id }), {
      outcome: "not_readable",
      state: "trashed",
    });
    assert.equal((await svc.read(A, { fileId: out.file.id, allowTrashed: true })).outcome, "ok");
    fs.rmSync(path.join(root, vaultObjectKey(out.file.objectId)));
    assert.deepEqual(await svc.read(A, { fileId: out.file.id, allowTrashed: true }), {
      outcome: "bytes_missing",
    });
    await store.vaultRestore({ principal: A, fileId: out.file.id, now: clock });
  });

  // ------------------------------------------------------------------ purge and reclaim

  it("purge: bytes and derivatives are deleted, the receipt carries hashes and counts, the entry is gone", async () => {
    const out = await must(upload(A, "to-purge.txt", "purge me please"));
    const derived = path.join(root, "derived", out.file.objectId.slice(0, 2), out.file.objectId);
    fs.mkdirSync(derived, { recursive: true });
    fs.writeFileSync(path.join(derived, "thumb.png"), "png");
    const result = await svc.purge(A, out.file.id, "alice");
    assert.equal(result.outcome, "purged");
    assert.equal(result.outcome === "purged" && result.receipt.requestedBy, "alice");
    assert.equal(result.outcome === "purged" && result.receipt.versionCount, 1);
    assert.equal(onDisk(vaultObjectKey(out.file.objectId)), false);
    assert.equal(fs.existsSync(derived), false);
    assert.equal(count("SELECT COUNT(*) AS c FROM vault_files WHERE id = ?", out.file.id), 0);
    assert.equal(
      row("SELECT state FROM vault_objects WHERE id = ?", out.file.objectId)?.state,
      "deleted",
    );
    assert.ok(events.includes(`purged:${out.file.id}`));
  });

  it("purge: a shared object keeps its bytes until the last entry is purged", async () => {
    const one = await must(upload(A, "share-1.txt", "shared purge bytes"));
    const two = await must(upload(A, "share-2.txt", "shared purge bytes"));
    const first = await svc.purge(A, one.file.id, "op");
    assert.equal(first.outcome === "purged" && first.receipt.retainedObjectCount, 1);
    assert.equal(onDisk(vaultObjectKey(one.file.objectId)), true);
    const second = await svc.purge(A, two.file.id, "op");
    assert.equal(second.outcome === "purged" && second.receipt.contentHashes?.length, 1);
    assert.equal(onDisk(vaultObjectKey(one.file.objectId)), false);
  });

  it("purge: a failing delete pauses with cleanup_pending, then a later pass finishes after the leases run out", async () => {
    const out = await must(upload(A, "stubborn.txt", "stubborn bytes"));
    faults.failNext("remove");
    const first = await svc.purge(A, out.file.id, "op", { budgetMs: 1_000 });
    assert.equal(first.outcome, "cleanup_pending");
    assert.equal(row("SELECT state FROM vault_files WHERE id = ?", out.file.id)?.state, "purging");
    assert.equal(onDisk(vaultObjectKey(out.file.objectId)), true);
    clock += 60_000; // the object's reclaim lease and the run lease both expired
    const second = await svc.purge(A, out.file.id, "someone-else");
    assert.equal(second.outcome, "purged");
    assert.equal(
      second.outcome === "purged" && second.receipt.requestedBy,
      "op",
      "the original requester is kept",
    );
    assert.equal(onDisk(vaultObjectKey(out.file.objectId)), false);
  });

  it("purge: a second pass while the first holds the run gets worker_active and does nothing", async () => {
    const out = await must(upload(A, "busy.txt", "busy bytes"));
    const hold = faults.holdNext("remove");
    const running = svc.purge(A, out.file.id, "op", { budgetMs: 5_000 });
    await hold.started;
    const other = await svc.purge(A, out.file.id, "other");
    assert.equal(other.outcome, "worker_active");
    hold.release();
    assert.equal((await running).outcome, "purged");
  });

  it("purge: refuses a missing entry and another owner's entry", async () => {
    const out = await must(upload(A, "mine.txt", "mine only"));
    assert.deepEqual(await svc.purge(A, "nope", "op"), { outcome: "not_found" });
    assert.deepEqual(await svc.purge(B, out.file.id, "op"), { outcome: "not_found" });
    assert.equal(row("SELECT state FROM vault_files WHERE id = ?", out.file.id)?.state, "active");
  });

  // ------------------------------------------------------------------ maintenance

  it("maintain: an unreferenced object is reclaimed after the grace period, then its tombstone retires after retention", async () => {
    const out = await must(upload(A, "orphan.txt", "orphan bytes here"));
    db.prepare("DELETE FROM vault_versions WHERE object_id = ?").run(out.file.objectId);
    db.prepare("DELETE FROM vault_files WHERE id = ?").run(out.file.id);
    const early = await svc.maintain(A);
    assert.equal(
      onDisk(vaultObjectKey(out.file.objectId)),
      true,
      `inside the grace period (${early.reclaimed} others reclaimed)`,
    );
    clock += baseConfig.reclaimGraceMs + 1;
    const report = await svc.maintain(A);
    assert.ok(report.reclaimed >= 1);
    assert.equal(report.errors.length, 0, report.errors.join("; "));
    assert.equal(onDisk(vaultObjectKey(out.file.objectId)), false);
    assert.equal(
      row("SELECT state FROM vault_objects WHERE id = ?", out.file.objectId)?.state,
      "deleted",
    );
    clock += baseConfig.tombstoneRetentionMs + 1;
    const later = await svc.maintain(A);
    assert.ok(later.tombstonesRetired >= 1);
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_objects WHERE id = ?", out.file.objectId),
      0,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });

  it("maintain: expired inbox entries are discarded and trashed entries past retention are purged", async () => {
    const inbox = await must(upload(A, "incoming.txt", "inbox bytes", { collection: "inbox" }));
    const trashed = await must(upload(A, "old-trash.txt", "trash bytes"));
    await store.vaultTrash({ principal: A, fileId: trashed.file.id, now: clock });
    clock += baseConfig.trashRetentionMs + baseConfig.inboxRetentionMs + 10;
    const report = await svc.maintain(A);
    assert.ok(report.inboxDiscarded >= 1);
    assert.ok(report.trashPurged >= 1);
    assert.equal(
      row("SELECT state FROM vault_files WHERE id = ?", inbox.file.id)?.state,
      "trashed",
    );
    assert.equal(count("SELECT COUNT(*) AS c FROM vault_files WHERE id = ?", trashed.file.id), 0);
    assert.equal(report.errors.length, 0, report.errors.join("; "));
  });

  it("maintain: a missing or wrong-sized object marks the entry damaged (never silently repaired)", async () => {
    const gone = await must(upload(A, "will-vanish.txt", "vanishing bytes"));
    const short = await must(upload(A, "will-shrink.txt", "shrinking bytes"));
    fs.rmSync(path.join(root, vaultObjectKey(gone.file.objectId)));
    fs.writeFileSync(path.join(root, vaultObjectKey(short.file.objectId)), "x");
    let damaged = 0;
    for (let round = 0; round < 10 && damaged < 2; round += 1) {
      damaged += (await svc.maintain(A)).damaged;
    }
    assert.equal(row("SELECT state FROM vault_files WHERE id = ?", gone.file.id)?.state, "damaged");
    assert.equal(
      row("SELECT state FROM vault_files WHERE id = ?", short.file.id)?.state,
      "damaged",
    );
    assert.ok(warnings.some((w) => w.includes(gone.file.id)));
    assert.ok(events.includes(`damaged:${gone.file.id}`));
  });

  it("owner isolation end to end: B sees nothing of A's files, bytes or objects", async () => {
    const mine = await must(upload(A, "iso.txt", "isolated bytes"));
    assert.deepEqual(await svc.read(B, { fileId: mine.file.id }), { outcome: "not_found" });
    assert.deepEqual(await store.vaultGet({ principal: B, fileId: mine.file.id }), {
      outcome: "not_found",
    });
    const bReport = await svc.maintain(B);
    assert.equal(bReport.damaged, 0);
    assert.equal(onDisk(vaultObjectKey(mine.file.objectId)), true);
  });
});
