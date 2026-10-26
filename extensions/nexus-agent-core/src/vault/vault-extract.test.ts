// Text extraction and content search (Vault design 9, F2): the queue, the built-in text extractor, the FTS5 trigram index with its
// substring fallback, and the sensitivity rules (sensitive files get no text, and lose it the moment they turn sensitive).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { applyMigrations } from "../store/kernel.js";
import { createNexusKernel } from "../store/nexus-kernel.js";
import type { Principal } from "../store/types.js";
import { VAULT_EXTRACT_DEFAULTS } from "./vault-extract.js";
import {
  cleanText,
  decodeTextBytes,
  htmlToText,
  paginateText,
  TEXT_EXTRACTOR,
} from "./vault-extractors.js";
import { createFsVaultFileStore, withVaultStoreFaults } from "./vault-file-store.js";
import { createVaultService, type VaultConfig, type VaultStore } from "./vault-service.js";

const A: Principal = { ownerId: "owner-a" };
const B: Principal = { ownerId: "owner-b" };
const MIB = 1024 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value);

describe("vault text extractors", () => {
  it("decodes UTF-8, a BOM, UTF-16 and GB18030, and refuses binary data", () => {
    assert.equal(decodeTextBytes(bytes("你好 hello")), "你好 hello");
    assert.equal(decodeTextBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])), "hi");
    assert.equal(decodeTextBytes(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])), "hi");
    // "发票" in GB18030
    assert.equal(decodeTextBytes(new Uint8Array([0xb7, 0xa2, 0xc6, 0xb1])), "发票");
    assert.throws(() => decodeTextBytes(new Uint8Array([0x61, 0x00, 0x62])), /binary/);
  });

  it("cleans control characters and line endings", () => {
    assert.equal(cleanText("a\r\nb\rc\u0007d\te\u007f"), "a\nb\ncd\te");
  });

  it("extracts visible text from html and ignores scripts, styles and comments", () => {
    const html =
      "<html><head><style>p{color:red}</style><script>alert('x')</script></head><body><!-- hidden --><h1>Title</h1><p>A &amp; B&nbsp;C</p></body></html>";
    const text = htmlToText(html);
    assert.ok(text.includes("Title"));
    assert.ok(text.includes("A & B C"));
    assert.ok(!text.includes("alert"));
    assert.ok(!text.includes("color"));
    assert.ok(!text.includes("hidden"));
  });

  it("accepts text types and legacy-encoded text with a text extension, not images", () => {
    assert.equal(TEXT_EXTRACTOR.accepts({ mime: "text/markdown", name: "a.md" }), true);
    assert.equal(TEXT_EXTRACTOR.accepts({ mime: "application/json", name: "a.json" }), true);
    assert.equal(
      TEXT_EXTRACTOR.accepts({ mime: "application/octet-stream", name: "旧.txt" }),
      true,
    );
    assert.equal(
      TEXT_EXTRACTOR.accepts({ mime: "application/octet-stream", name: "a.bin" }),
      false,
    );
    assert.equal(TEXT_EXTRACTOR.accepts({ mime: "image/png", name: "a.txt" }), false);
    assert.equal(TEXT_EXTRACTOR.accepts({ mime: "application/pdf", name: "a.pdf" }), false);
  });

  it("pages on line breaks, caps the total and never splits a surrogate pair", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `line ${index} ${"x".repeat(20)}`).join(
      "\n",
    );
    const paged = paginateText(lines, 200, 1_000_000);
    assert.ok(paged.pages.length > 3);
    assert.equal(paged.pages.join(""), lines);
    assert.equal(paged.truncated, false);
    const capped = paginateText(lines, 200, 300);
    assert.equal(capped.truncated, true);
    assert.equal(capped.pages.join("").length, 300);
    const emoji = "😀".repeat(50);
    for (const page of paginateText(emoji, 11, 1000).pages) {
      assert.equal(page.length % 2, 0);
    }
    assert.deepEqual(paginateText("", 10, 100).pages, []);
  });
});

describe("vault text queue and content search", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-extract-"));
  const root = path.join(dir, "vault");
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
        name === "then"
          ? undefined
          : async (input: unknown) =>
              (Reflect.get(kernel, name) as (value: unknown) => unknown)(input),
    },
  ) as VaultStore;
  const count = (sql: string, ...params: (string | number)[]): number =>
    (db.prepare(sql).get(...params) as { c: number }).c;

  let clock = 9_000_000;
  const faults = withVaultStoreFaults(createFsVaultFileStore(root));
  const config: VaultConfig = {
    limits: { maxFileBytes: MIB, ownerQuotaBytes: 8 * MIB },
    inboxRetentionMs: 60_000,
    trashRetentionMs: 600_000,
    reservationTtlMs: 60_000,
    minFreeBytes: 0,
    reservationRetentionMs: 3_600_000,
    tombstoneRetentionMs: 3_600_000,
    receiptHashRetentionMs: 86_400_000,
    reclaimGraceMs: 5_000,
    import: { roots: [dir], forbidden: [], maxBytes: MIB },
    extract: { ...VAULT_EXTRACT_DEFAULTS, maxBytes: 4096, pageChars: 80 },
  };
  const warnings: string[] = [];
  const svc = createVaultService({
    getStore: async () => store,
    files: faults,
    incarnationId: () => "inc-1",
    incarnationGoneEnabled: false,
    config: () => config,
    now: () => clock,
    logger: { warn: (message) => warnings.push(message) },
  });
  kernel.registerIncarnation({
    principal: A,
    incarnationId: "inc-1",
    bootId: "boot-1",
    now: clock,
  });

  const upload = async (principal: Principal, name: string, body: string | Uint8Array) => {
    const out = await svc.ingest(principal, {
      displayName: name,
      bytes: typeof body === "string" ? bytes(body) : body,
      source: "upload",
      importedBy: "operator",
    });
    assert.equal(out.outcome, "ok", JSON.stringify(out));
    if (out.outcome !== "ok") {
      throw new Error("unreachable");
    }
    await svc.extract(principal);
    return out.file;
  };
  const search = (principal: Principal, query: string, forceLike = false) =>
    kernel.vaultTextSearch({ principal, query, ...(forceLike ? { forceLike } : {}) });
  const names = (result: { items: { displayName: string }[] }) =>
    result.items.map((item) => item.displayName).toSorted();
  const statusOf = (principal: Principal, objectId: string) =>
    kernel.vaultExtractionStatus({ principal, objectIds: [objectId] }).byObject[objectId];

  it("starts with an FTS5 trigram index and secure delete", () => {
    const stats = kernel.vaultTextStats({ principal: A });
    assert.equal(stats.fts, true);
    assert.equal(stats.secureDelete, true);
  });

  it("extracts an uploaded text file and finds it by content, never returning the text", async () => {
    const file = await upload(A, "meeting.md", "# Q3 planning\nThe budget review is on Thursday.");
    assert.equal(statusOf(A, file.objectId)?.state, "ready");
    const hit = search(A, "budget review");
    assert.equal(hit.mode, "fts");
    assert.deepEqual(names(hit), ["meeting.md"]);
    assert.ok(!JSON.stringify(hit).includes("Thursday"));
    assert.deepEqual(names(search(A, "BUDGET")), ["meeting.md"]);
    assert.deepEqual(names(search(A, "no such phrase")), []);
  });

  it("matches every term (AND), across the file, and does not leak between owners", async () => {
    await upload(A, "a.txt", "alpha bravo charlie");
    await upload(A, "b.txt", "alpha delta echo");
    await upload(B, "other.txt", "alpha bravo secret-b-word");
    assert.deepEqual(
      names(search(A, "alpha")),
      ["a.txt", "b.txt", "meeting.md"].filter((n) => n !== "meeting.md"),
    );
    assert.deepEqual(names(search(A, "alpha bravo")), ["a.txt"]);
    assert.deepEqual(names(search(A, "secret-b-word")), []);
    assert.deepEqual(names(search(B, "secret-b-word")), ["other.txt"]);
  });

  it("finds Chinese text, and short queries fall back to a substring scan", async () => {
    await upload(A, "发票.txt", "本月发票已报销，金额共计三百元。");
    const long = search(A, "已报销");
    assert.equal(long.mode, "fts");
    assert.deepEqual(names(long), ["发票.txt"]);
    const short = search(A, "报销");
    assert.equal(short.mode, "like");
    assert.deepEqual(names(short), ["发票.txt"]);
    assert.deepEqual(names(search(A, "已报销", true)), ["发票.txt"]);
  });

  it("indexes a legacy GB18030 file and html", async () => {
    const gbk = new Uint8Array([0xb7, 0xa2, 0xc6, 0xb1, 0xca, 0xd5, 0xbe, 0xdd]); // 发票收据
    await upload(A, "旧文件.txt", gbk);
    assert.deepEqual(names(search(A, "发票收据")), ["旧文件.txt"]);
    await upload(
      A,
      "page.html",
      "<html><body><script>var hidden=1</script><p>visible words</p></body></html>",
    );
    assert.deepEqual(names(search(A, "visible words")), ["page.html"]);
    assert.deepEqual(names(search(A, "var hidden")), []);
  });

  it("rejects what it cannot read and says so instead of claiming there is no match", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const image = await upload(A, "photo.png", png);
    assert.equal(statusOf(A, image.objectId)?.state, "rejected");
    assert.equal(statusOf(A, image.objectId)?.failureCode, "unsupported_type");
    const big = await upload(A, "big.txt", `big ${"y".repeat(5000)}`);
    assert.equal(statusOf(A, big.objectId)?.failureCode, "too_large");
    const result = search(A, "anything");
    assert.ok(result.unindexed.unsupported >= 2);
    assert.equal(result.unindexed.pending, 0);
  });

  it("never extracts a sensitive file, and removes text when a file turns sensitive", async () => {
    const passport = await upload(A, "passport scan.txt", "document number X1234567");
    assert.equal(passport.sensitivity, "sensitive");
    assert.equal(statusOf(A, passport.objectId)?.state, "skipped");
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_jobs WHERE object_id = ?", passport.objectId),
      0,
    );
    assert.deepEqual(names(search(A, "X1234567")), []);

    const plain = await upload(A, "notes.txt", "my wifi password is hunter2hunter2");
    assert.deepEqual(names(search(A, "hunter2hunter2")), ["notes.txt"]);
    const before = count("SELECT COUNT(*) AS c FROM vault_text_fts");
    kernel.vaultSetSensitivity({
      principal: A,
      fileId: plain.id,
      now: ++clock,
      sensitivity: "sensitive",
      by: "user",
    });
    assert.deepEqual(names(search(A, "hunter2hunter2")), []);
    assert.equal(statusOf(A, plain.objectId)?.state, "skipped");
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_text WHERE object_id = ?", plain.objectId),
      0,
    );
    assert.ok(count("SELECT COUNT(*) AS c FROM vault_text_fts") < before);
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM vault_text_fts WHERE vault_text_fts MATCH ?",
        '"hunter2hunter2"',
      ),
      0,
    );
    await svc.extract(A);
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_text WHERE object_id = ?", plain.objectId),
      0,
    );

    // back to normal: the sweep queues it again and the text returns
    kernel.vaultSetSensitivity({
      principal: A,
      fileId: plain.id,
      now: ++clock,
      sensitivity: "normal",
      by: "user",
    });
    await svc.extract(A);
    assert.deepEqual(names(search(A, "hunter2hunter2")), ["notes.txt"]);
  });

  it("hides the text of an object while ANY file that references it is sensitive", async () => {
    const first = await upload(A, "shared one.txt", "shared bytes zebra-quartz");
    assert.deepEqual(names(search(A, "zebra-quartz")), ["shared one.txt"]);
    const second = await upload(A, "shared two.txt", "shared bytes zebra-quartz");
    assert.equal(second.objectId, first.objectId);
    kernel.vaultSetSensitivity({
      principal: A,
      fileId: second.id,
      now: ++clock,
      sensitivity: "sensitive",
      by: "user",
    });
    assert.deepEqual(names(search(A, "zebra-quartz")), []);
    kernel.vaultSetSensitivity({
      principal: A,
      fileId: second.id,
      now: ++clock,
      sensitivity: "normal",
      by: "user",
    });
    await svc.extract(A);
    assert.deepEqual(names(search(A, "zebra-quartz")), ["shared one.txt", "shared two.txt"]);
  });

  it("retries a failed read with backoff, gives up after the attempt limit, and retries on request", async () => {
    // A service with extraction off, so ingest does not start a pass by itself and the first attempt is ours.
    const quiet = createVaultService({
      getStore: async () => store,
      files: faults,
      incarnationId: () => "inc-1",
      incarnationGoneEnabled: false,
      config: () => ({ ...config, extract: undefined }),
      now: () => clock,
    });
    const made = await quiet.ingest(A, {
      displayName: "flaky.txt",
      bytes: bytes("flaky content marker-flaky"),
      source: "upload",
      importedBy: "operator",
    });
    assert.equal(made.outcome, "ok");
    if (made.outcome !== "ok") {
      return;
    }
    const { objectId, id: fileId } = made.file;
    assert.equal(statusOf(A, objectId)?.state, "none");

    faults.failNext("readRange");
    await svc.extract(A);
    assert.equal(statusOf(A, objectId)?.state, "pending");
    assert.equal(statusOf(A, objectId)?.attempts, 1);
    assert.equal(statusOf(A, objectId)?.failureCode, "extract_error");

    await svc.extract(A); // the backoff (1 minute) has not elapsed: the job is not touched
    assert.equal(statusOf(A, objectId)?.attempts, 1);

    clock += 61_000;
    faults.failNext("readRange");
    await svc.extract(A);
    assert.equal(statusOf(A, objectId)?.attempts, 2);
    assert.equal(statusOf(A, objectId)?.state, "pending");

    clock += 6 * 60_000;
    faults.failNext("readRange");
    await svc.extract(A);
    assert.equal(statusOf(A, objectId)?.state, "failed");
    assert.equal(statusOf(A, objectId)?.attempts, 3);
    assert.deepEqual(names(search(A, "marker-flaky")), []);
    assert.ok(search(A, "marker-flaky").unindexed.failed >= 1);

    assert.equal(kernel.vaultJobRetry({ principal: A, fileId, now: ++clock }).outcome, "queued");
    await svc.extract(A);
    assert.equal(statusOf(A, objectId)?.state, "ready");
    assert.deepEqual(names(search(A, "marker-flaky")), ["flaky.txt"]);
    assert.equal(
      kernel.vaultJobRetry({ principal: A, fileId, now: ++clock }).outcome,
      "not_retryable",
    );
  });

  it("keeps the index in step with vault_text and survives a rebuild", () => {
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_text_fts"),
      count("SELECT COUNT(*) AS c FROM vault_text"),
    );
    const rebuilt = createNexusKernel(db, tx); // reopening the kernel is a no-op for a consistent index
    assert.equal(rebuilt.vaultTextStats({ principal: A }).fts, true);
    db.exec("DELETE FROM vault_text_fts");
    const repaired = createNexusKernel(db, tx);
    assert.equal(repaired.vaultTextStats({ principal: A }).fts, true);
    assert.equal(
      count("SELECT COUNT(*) AS c FROM vault_text_fts"),
      count("SELECT COUNT(*) AS c FROM vault_text"),
    );
  });

  it("reads one page of text for the console, only for a visible file", async () => {
    const long = await upload(
      A,
      "long.txt",
      Array.from({ length: 12 }, (_, i) => `row ${i} ${"z".repeat(30)}`).join("\n"),
    );
    const first = kernel.vaultTextRead({ principal: A, fileId: long.id });
    assert.equal(first.outcome, "ok");
    if (first.outcome === "ok") {
      assert.ok(first.pageCount > 1);
      assert.equal(first.page, 0);
      assert.ok(first.text.startsWith("row 0"));
    }
    assert.equal(kernel.vaultTextRead({ principal: B, fileId: long.id }).outcome, "not_found");
    kernel.vaultSetSensitivity({
      principal: A,
      fileId: long.id,
      now: ++clock,
      sensitivity: "sensitive",
      by: "user",
    });
    assert.equal(kernel.vaultTextRead({ principal: A, fileId: long.id }).outcome, "no_text");
  });

  it("deletes index rows together with the text when the object is reclaimed", async () => {
    const gone = await upload(A, "to-trash.txt", "unique-gone-marker text");
    assert.deepEqual(names(search(A, "unique-gone-marker")), ["to-trash.txt"]);
    db.prepare("DELETE FROM vault_text WHERE object_id = ?").run(gone.objectId);
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM vault_text_fts WHERE vault_text_fts MATCH ?",
        '"unique-gone-marker"',
      ),
      0,
    );
  });
});
