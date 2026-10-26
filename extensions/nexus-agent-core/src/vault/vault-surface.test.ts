// The two surfaces over the vault service: what an Agent may do (vault-agent-ops) and what the console may do (vault-rpc).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { applyMigrations } from "../store/kernel.js";
import { createNexusKernel } from "../store/nexus-kernel.js";
import type { Principal } from "../store/types.js";
import { createVaultRpcHandlers, decodeVaultBase64 } from "../vault-rpc.js";
import { agentAttachFile, agentGetFile, agentSearchFiles } from "./vault-agent-ops.js";
import { VAULT_EXTRACT_DEFAULTS } from "./vault-extract.js";
import { createFsVaultFileStore } from "./vault-file-store.js";
import { createVaultService, type VaultConfig, type VaultStore } from "./vault-service.js";

const A: Principal = { ownerId: "owner-a" };
const B: Principal = { ownerId: "owner-b" };
const MIB = 1024 * 1024;
const text = (value: string) => new TextEncoder().encode(value);

describe("vault surfaces", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-surface-"));
  const importRoot = path.join(dir, "Downloads");
  fs.mkdirSync(importRoot, { recursive: true });
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
      get: (_t, name: string) =>
        name === "then"
          ? undefined
          : async (input: unknown) => (Reflect.get(kernel, name) as (v: unknown) => unknown)(input),
    },
  ) as VaultStore;
  let clock = 9_000_000;
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
    import: { roots: [importRoot], forbidden: [], maxBytes: MIB },
  };
  const changes: string[] = [];
  kernel.registerIncarnation({
    principal: A,
    incarnationId: "inc-1",
    bootId: "boot-1",
    now: clock,
  });
  kernel.registerIncarnation({
    principal: B,
    incarnationId: "inc-1",
    bootId: "boot-1",
    now: clock,
  });
  const service = createVaultService({
    getStore: async () => store,
    files: createFsVaultFileStore(path.join(dir, "vault")),
    incarnationId: () => "inc-1",
    incarnationGoneEnabled: false,
    config: () => config,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  let principal: Principal | undefined = A;
  const handlers = new Map<string, { run: (o: never) => unknown; scope: string }>();
  for (const [method, run, scope] of createVaultRpcHandlers({
    getStore: async () => store,
    service,
    events: { vaultChanged: (p) => changes.push(`${p.action}:${p.fileId}`) },
    resolvePrincipal: () => principal,
    maxFileBytes: () => config.limits.maxFileBytes,
    now: () => clock,
  })) {
    handlers.set(method, { run: run as never, scope });
  }
  type Answer = {
    ok: boolean;
    payload?: Record<string, any>;
    error?: { code: string; message: string; details?: any };
  };
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<Answer> => {
    let answer: Answer | undefined;
    await handlers.get(method)!.run({
      params,
      respond: (ok: boolean, payload?: Record<string, any>, error?: any) => {
        answer = { ok, payload, error };
      },
    } as never);
    assert.ok(answer, `${method} did not respond`);
    return answer;
  };
  const b64 = (value: string) => Buffer.from(value).toString("base64");
  const put = async (name: string, body: string, extra: Record<string, unknown> = {}) => {
    const out = await call("nexus.vault.upload", { name, dataBase64: b64(body), ...extra });
    assert.equal(out.ok, true, JSON.stringify(out));
    return out.payload!.file as { id: string };
  };

  it("rpc: scopes - reads are read, edits are write, purge alone is admin", () => {
    const scope = (method: string) => handlers.get(method)!.scope;
    for (const m of [
      "list",
      "get",
      "stats",
      "read",
      "versions",
      "links",
      "purgeStatus",
      "purgeReceipts",
      "search",
      "text",
      "jobs",
    ]) {
      assert.equal(scope(`nexus.vault.${m}`), "operator.read", m);
    }
    for (const m of [
      "upload",
      "importPath",
      "keep",
      "discard",
      "trash",
      "restore",
      "rename",
      "move",
      "pin",
      "setSensitivity",
      "maintain",
      "retryExtract",
      "extract",
    ]) {
      assert.equal(scope(`nexus.vault.${m}`), "operator.write", m);
    }
    assert.equal(scope("nexus.vault.purge"), "operator.admin");
  });

  it("rpc: base64 is strict and its size is checked before decoding", () => {
    assert.equal(decodeVaultBase64("", 10), "invalid");
    assert.equal(decodeVaultBase64("abc", 10), "invalid");
    assert.equal(decodeVaultBase64("ab*=", 10), "invalid");
    assert.equal(decodeVaultBase64(5, 10), "invalid");
    assert.equal(decodeVaultBase64(b64("0123456789ab"), 10), "too_large");
    assert.deepEqual([...(decodeVaultBase64(b64("hi"), 10) as Uint8Array)], [104, 105]);
  });

  it("rpc: no principal means no service", async () => {
    principal = undefined;
    const out = await call("nexus.vault.list");
    principal = A;
    assert.equal(out.error?.code, "nexus_no_principal");
  });

  it("rpc: upload, list, get, read round trip, then dedup is reported", async () => {
    const first = await put("notes.txt", "hello vault", { collection: "vault", folder: "Docs" });
    const again = await call("nexus.vault.upload", {
      name: "notes-copy.txt",
      dataBase64: b64("hello vault"),
      collection: "vault",
    });
    assert.equal(again.payload?.deduplicated, true);
    const list = await call("nexus.vault.list", { collection: "vault", nameContains: "notes" });
    assert.equal(list.payload?.total, 2);
    const got = await call("nexus.vault.get", { fileId: first.id });
    assert.equal(got.payload?.file.displayName, "notes.txt");
    const read = await call("nexus.vault.read", { fileId: first.id });
    assert.equal(Buffer.from(read.payload!.dataBase64, "base64").toString(), "hello vault");
    assert.equal(read.payload?.eof, true);
  });

  it("rpc: versions lists newest first and read can fetch an older one", async () => {
    const file = await put("versioned.txt", "version one body", { collection: "vault" });
    const second = await put("versioned-next.txt", "version two body!", { collection: "vault" });
    const one = (await call("nexus.vault.versions", { fileId: file.id })).payload!;
    assert.equal(one.versions.length, 1);
    assert.equal(one.versions[0].seq, 1);
    assert.equal(one.versions[0].current, true);
    assert.equal(one.versions[0].size, "version one body".length);
    // No operation creates a second version yet; add one the way a future "replace" would.
    const next = db
      .prepare("SELECT object_id FROM vault_versions WHERE owner_id = ? AND file_id = ?")
      .get("owner-a", second.id) as { object_id: string };
    db.prepare(
      "INSERT INTO vault_versions (owner_id, file_id, seq, object_id, created_at) VALUES (?, ?, 2, ?, ?)",
    ).run("owner-a", file.id, next.object_id, clock + 5);
    const two = (await call("nexus.vault.versions", { fileId: file.id })).payload!;
    assert.deepEqual(
      two.versions.map((v: { seq: number; current: boolean }) => [v.seq, v.current]),
      [
        [2, true],
        [1, false],
      ],
    );
    assert.equal(two.versions[0].size, "version two body!".length);
    assert.match(two.versions[1].contentHash, /^[0-9a-f]{64}$/);
    const old = await call("nexus.vault.read", { fileId: file.id, version: 1 });
    assert.equal(Buffer.from(old.payload!.dataBase64, "base64").toString(), "version one body");
    assert.equal(old.payload!.contentHash, two.versions[1].contentHash);
    assert.equal(old.payload!.name, "versioned.txt");
    const newer = await call("nexus.vault.read", { fileId: file.id, version: 2 });
    assert.equal(Buffer.from(newer.payload!.dataBase64, "base64").toString(), "version two body!");
    assert.equal(
      (await call("nexus.vault.read", { fileId: file.id, version: 9 })).error?.code,
      "nexus_not_found",
    );
    for (const bad of [0, -1, 1.5, "1", null]) {
      assert.equal(
        (await call("nexus.vault.read", { fileId: file.id, version: bad })).error?.code,
        "nexus_invalid_params",
        String(bad),
      );
    }
    assert.equal(
      (await call("nexus.vault.versions", { fileId: "VF_NOPE" })).error?.code,
      "nexus_not_found",
    );
    principal = B;
    const other = await call("nexus.vault.versions", { fileId: file.id });
    principal = A;
    assert.equal(other.error?.code, "nexus_not_found");
  });

  it("rpc: links lists the tasks that hold the file as evidence", async () => {
    const file = await put("linked.txt", "linked body", { collection: "vault" });
    const none = (await call("nexus.vault.links", { fileId: file.id })).payload!;
    assert.deepEqual([none.total, none.links], [0, []]);
    // Minimal rows by hand: the evidence flow itself is covered elsewhere; here only the derived view matters.
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      const task = db.prepare(
        "INSERT INTO nexus_tasks (id, owner_id, kind, title, status, goal_json, origin_session_key, revision, created_at, updated_at) " +
          "VALUES (?, 'owner-a', 'general', ?, 'executing', '{}', 'sess', 1, 1, 1)",
      );
      task.run("TASK_L1", "Claim the refund");
      task.run("TASK_L2", "Older task");
      const ev = db.prepare(
        "INSERT INTO evidence (id, owner_id, task_id, kind, blob_key, content_hash, byte_size, source_ref_kind, source_ref_id, " +
          "source_locator_canonical, source_version, source_identity_hash, source_group, source_group_rule_version, retention_policy, captured_at) " +
          "VALUES (?, 'owner-a', ?, 'document', NULL, ?, NULL, 'blob', 'k', ?, 'v', ?, 'user_file', 1, 'default', ?)",
      );
      ev.run("EV_L1", "TASK_L1", "a".repeat(64), `vault:${file.id}`, "h1", 2_000);
      ev.run("EV_L2", "TASK_L2", "a".repeat(64), `vault:${file.id}`, "h2", 1_000);
      ev.run("EV_X", "TASK_L2", "b".repeat(64), "vault:VF_OTHER", "h3", 3_000);
      db.prepare(
        "INSERT INTO claim_evidence_links (owner_id, task_id, claim_id, evidence_id, relation, effective, head_link_event_id, updated_at) " +
          "VALUES ('owner-a', 'TASK_L1', ?, 'EV_L1', 'supports', ?, 'E1', 1)",
      ).run("CL_ON", 1);
      db.prepare(
        "INSERT INTO claim_evidence_links (owner_id, task_id, claim_id, evidence_id, relation, effective, head_link_event_id, updated_at) " +
          "VALUES ('owner-a', 'TASK_L1', ?, 'EV_L1', 'supports', ?, 'E1', 1)",
      ).run("CL_OFF", 0);
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
    const out = (await call("nexus.vault.links", { fileId: file.id })).payload!;
    assert.equal(out.total, 2);
    assert.deepEqual(
      out.links.map((l: any) => [
        l.evidenceId,
        l.taskId,
        l.taskTitle,
        l.taskStatus,
        l.claimIds,
        l.bytesKept,
      ]),
      [
        ["EV_L1", "TASK_L1", "Claim the refund", "executing", ["CL_ON"], false],
        ["EV_L2", "TASK_L2", "Older task", "executing", [], false],
      ],
    );
    principal = B;
    const other = await call("nexus.vault.links", { fileId: file.id });
    principal = A;
    assert.equal(other.error?.code, "nexus_not_found");
    assert.equal((await call("nexus.vault.links", {})).error?.code, "nexus_invalid_params");
  });

  it("rpc: list filters by kind, favorite and sensitivity", async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];
    const image = await call("nexus.vault.upload", {
      name: "filter-pic.png",
      dataBase64: Buffer.from(png).toString("base64"),
      collection: "vault",
    });
    assert.equal(image.ok, true, JSON.stringify(image));
    const picId = image.payload!.file.id as string;
    const note = await put("filter-note.txt", "filter note body", { collection: "vault" });
    const names = async (params: Record<string, unknown>) =>
      (
        (await call("nexus.vault.list", { nameContains: "filter-", ...params })).payload!
          .items as Array<{
          displayName: string;
        }>
      )
        .map((item) => item.displayName)
        .toSorted();
    assert.deepEqual(await names({}), ["filter-note.txt", "filter-pic.png"]);
    assert.deepEqual(await names({ kind: "image" }), ["filter-pic.png"]);
    assert.deepEqual(await names({ kind: "text" }), ["filter-note.txt"]);
    assert.deepEqual(await names({ favorite: true }), []);
    await call("nexus.vault.pin", { fileId: note.id, favorite: true });
    assert.deepEqual(await names({ favorite: true }), ["filter-note.txt"]);
    assert.deepEqual(await names({ favorite: false }), ["filter-note.txt", "filter-pic.png"]);
    await call("nexus.vault.setSensitivity", { fileId: picId, sensitivity: "sensitive" });
    assert.deepEqual(await names({ sensitivity: "sensitive" }), ["filter-pic.png"]);
    assert.deepEqual(await names({ sensitivity: "normal" }), ["filter-note.txt"]);
    const counted = await call("nexus.vault.list", { nameContains: "filter-", kind: "image" });
    assert.equal(counted.payload?.total, 1);
  });

  it("rpc: bad input is rejected with a code, not a store error", async () => {
    assert.equal(
      (await call("nexus.vault.get", { fileId: "../x" })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.vault.get", { fileId: "VF_NOPE" })).error?.code,
      "nexus_not_found",
    );
    assert.equal(
      (await call("nexus.vault.upload", { name: "a", dataBase64: "!!!" })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.vault.upload", { name: "a/b", dataBase64: b64("x") })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.vault.list", { collection: "nope" })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.vault.list", { state: "gone" })).error?.code,
      "nexus_invalid_params",
    );
    for (const bad of [{ kind: "exe" }, { favorite: "yes" }, { sensitivity: "secret" }]) {
      assert.equal(
        (await call("nexus.vault.list", bad)).error?.code,
        "nexus_invalid_params",
        JSON.stringify(bad),
      );
    }
    assert.equal(
      (await call("nexus.vault.pin", { fileId: "VF_X" })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.vault.setSensitivity", { fileId: "VF_X", sensitivity: "x" })).error?.code,
      "nexus_invalid_params",
    );
    const big = await call("nexus.vault.upload", {
      name: "big",
      dataBase64: Buffer.alloc(2 * MIB).toString("base64"),
    });
    assert.equal(big.error?.code, "nexus_quota_exceeded");
    assert.equal(big.error?.details?.scope, "file");
  });

  it("rpc: quota is reported with numbers", async () => {
    const saved = config.limits.ownerQuotaBytes;
    config.limits = { ...config.limits, ownerQuotaBytes: 16 };
    const out = await call("nexus.vault.upload", {
      name: "q.txt",
      dataBase64: b64("a long enough body for the tiny quota"),
    });
    config.limits = { ...config.limits, ownerQuotaBytes: saved };
    assert.equal(out.error?.code, "nexus_quota_exceeded");
    assert.equal(out.error?.details?.scope, "owner");
  });

  it("rpc: lifecycle edits report conflicts and publish vault_changed", async () => {
    const inbox = await put("arrival.txt", "just arrived", { collection: "inbox" });
    changes.length = 0;
    const kept = await call("nexus.vault.keep", { fileId: inbox.id, folder: "Inbox kept" });
    assert.equal(kept.payload?.file.collection, "vault");
    assert.deepEqual(changes, [`kept:${inbox.id}`]);
    assert.equal(
      (await call("nexus.vault.discard", { fileId: inbox.id })).error?.code,
      "nexus_conflict",
    );
    assert.equal(
      (await call("nexus.vault.rename", { fileId: inbox.id, displayName: "x/y" })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.vault.rename", { fileId: inbox.id, displayName: "renamed.txt" })).payload
        ?.file.displayName,
      "renamed.txt",
    );
    assert.equal(
      (await call("nexus.vault.move", { fileId: inbox.id, folder: "A/B" })).payload?.file.folder,
      "A/B",
    );
    assert.equal(
      (await call("nexus.vault.pin", { fileId: inbox.id, pinned: true, favorite: true })).payload
        ?.file.favorite,
      true,
    );
    assert.equal(
      (await call("nexus.vault.trash", { fileId: inbox.id })).payload?.file.state,
      "trashed",
    );
    assert.equal(
      (await call("nexus.vault.rename", { fileId: inbox.id, displayName: "z.txt" })).error?.code,
      "nexus_conflict",
    );
    assert.equal(
      (await call("nexus.vault.restore", { fileId: inbox.id })).payload?.file.state,
      "active",
    );
    const stats = await call("nexus.vault.stats");
    assert.ok(Number(stats.payload?.objects) > 0);
  });

  it("rpc: purge needs the id repeated, then leaves a receipt and no file", async () => {
    const file = await put("purge-me.txt", "purge me please", { collection: "vault" });
    assert.equal(
      (await call("nexus.vault.purge", { fileId: file.id })).error?.code,
      "nexus_invalid_params",
    );
    assert.equal(
      (await call("nexus.vault.purge", { fileId: file.id, confirmFileId: "other" })).error?.code,
      "nexus_invalid_params",
    );
    await call("nexus.vault.trash", { fileId: file.id });
    changes.length = 0;
    const done = await call("nexus.vault.purge", { fileId: file.id, confirmFileId: file.id });
    assert.equal(done.payload?.outcome, "purged", JSON.stringify(done));
    assert.equal(
      (await call("nexus.vault.get", { fileId: file.id })).error?.code,
      "nexus_not_found",
    );
    const receipts = await call("nexus.vault.purgeReceipts", {});
    assert.ok(((receipts.payload?.receipts ?? []) as unknown[]).length >= 1);
    assert.equal(
      (await call("nexus.vault.purgeStatus", { fileId: file.id })).payload?.status.outcome,
      "completed",
    );
  });

  it("rpc: import refuses a path outside the roots with a reason", async () => {
    const out = await call("nexus.vault.importPath", { path: path.join(dir, "nothing-here.txt") });
    assert.equal(out.error?.code, "nexus_import_refused");
    assert.ok(out.error?.details?.reason);
    fs.writeFileSync(path.join(importRoot, "imp.txt"), "imported text");
    const ok = await call("nexus.vault.importPath", { path: path.join(importRoot, "imp.txt") });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.payload?.file.source, "local_import");
  });

  it("rpc: another owner sees nothing", async () => {
    const mine = await put("private-a.txt", "owner a only");
    principal = B;
    const got = await call("nexus.vault.get", { fileId: mine.id });
    const read = await call("nexus.vault.read", { fileId: mine.id });
    const trash = await call("nexus.vault.trash", { fileId: mine.id });
    principal = A;
    assert.equal(got.error?.code, "nexus_not_found");
    assert.equal(read.error?.code, "nexus_not_found");
    assert.equal(trash.error?.code, "nexus_not_found");
  });

  // ------------------------------------------------------------------ Agent surface

  it("agent: search never returns sensitive, inbox or trashed files, and reports completeness", async () => {
    const visible = await put("agent-visible-report.txt", "quarterly numbers", {
      collection: "vault",
    });
    const secret = await put("agent-visible-secret.txt", "secret body", { collection: "vault" });
    await call("nexus.vault.setSensitivity", { fileId: secret.id, sensitivity: "sensitive" });
    const inboxFile = await put("agent-visible-inbox.txt", "inbox body", { collection: "inbox" });
    const trashed = await put("agent-visible-trashed.txt", "trashed body", { collection: "vault" });
    await call("nexus.vault.trash", { fileId: trashed.id });

    const found = (await agentSearchFiles(store, A, { name: "agent-visible" })) as any;
    assert.equal(found.ok, true);
    assert.deepEqual(
      found.files.map((f: any) => f.fileId),
      [visible.id],
    );
    assert.equal(found.complete, true);
    assert.deepEqual(found.searched, ["vault", "deliverable"]);
    assert.match(found.note, /sensitive/);
    const inbox = (await agentSearchFiles(store, A, {
      name: "agent-visible",
      collection: "inbox",
    })) as any;
    assert.deepEqual(
      inbox.files.map((f: any) => f.fileId),
      [inboxFile.id],
    );
    // a name query is matched as text, not as a pattern
    const wild = (await agentSearchFiles(store, A, { name: "%" })) as any;
    assert.equal(wild.total, 0);
  });

  it("agent: search validates its parameters and caps the page", async () => {
    for (const params of [
      { collection: "x" },
      { name: 5 },
      { folder: "../x" },
      { limit: 0 },
      { limit: 1.5 },
      { name: "x".repeat(200) },
    ]) {
      const out = (await agentSearchFiles(store, A, params as never)) as any;
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.match(out.notice, /FAILED/);
    }
    for (let i = 0; i < 30; i += 1) {
      await put(`bulk-${i}.txt`, `bulk body ${i}`, { collection: "vault" });
    }
    const page = (await agentSearchFiles(store, A, { name: "bulk-", limit: 100 })) as any;
    assert.equal(page.returned, 25);
    assert.equal(page.total, 30);
    assert.equal(page.complete, false);
  });

  it("agent: search is owner-scoped", async () => {
    const out = (await agentSearchFiles(store, B, { name: "agent-visible" })) as any;
    assert.equal(out.total, 0);
  });

  it("agent: get returns metadata only and refuses sensitive, missing and trashed files", async () => {
    const file = await put("agent-get.txt", "get me", { collection: "vault" });
    const got = (await agentGetFile(store, A, file.id)) as any;
    assert.equal(got.ok, true);
    assert.equal(got.contentSearchable, false);
    assert.equal(got.textState, "none");
    assert.equal("contentHash" in got, false);
    await call("nexus.vault.setSensitivity", { fileId: file.id, sensitivity: "sensitive" });
    assert.equal(((await agentGetFile(store, A, file.id)) as any).code, "file_sensitive");
    await call("nexus.vault.setSensitivity", { fileId: file.id, sensitivity: "normal" });
    await call("nexus.vault.trash", { fileId: file.id });
    assert.equal(((await agentGetFile(store, A, file.id)) as any).code, "file_not_available");
    assert.equal(((await agentGetFile(store, A, "VF_MISSING")) as any).code, "not_found");
    assert.equal(((await agentGetFile(store, A, "a b")) as any).code, "invalid_file_id");
    assert.equal(((await agentGetFile(store, B, file.id)) as any).code, "not_found");
  });

  // evidence fake: records what the attach flow sends and answers like the real service
  const makeEvidence = (answers: { upload?: any; attach?: any; throwOnUpload?: Error } = {}) => {
    const calls: { kind: string; input: any }[] = [];
    return {
      calls,
      evidence: {
        maxEntryBytes: 64,
        async upload(input: any) {
          calls.push({ kind: "upload", input });
          if (answers.throwOnUpload) {
            throw answers.throwOnUpload;
          }
          return (
            answers.upload ?? {
              outcome: "registered",
              evidenceId: "EV1",
              blobKey: `${"a".repeat(64)}.1`,
            }
          );
        },
        async attachBlob(input: any) {
          calls.push({ kind: "attach", input });
          return answers.attach ?? { outcome: "linked", evidenceId: "EV1", stateAfter: "ASSERTED" };
        },
      },
    };
  };
  const mapEvidence = (r: { outcome: string }) =>
    r.outcome === "linked" || r.outcome === "registered"
      ? { ok: true, outcome: r.outcome }
      : { ok: false, code: r.outcome, message: r.outcome };
  const isBytesUnavailable = (error: unknown) =>
    error instanceof Error && error.message === "no-bytes" ? { reason: "unsupported" } : undefined;
  const attach = (
    fake: ReturnType<typeof makeEvidence>,
    principalArg: Principal,
    fileId: unknown,
    extra: object = {},
  ) =>
    agentAttachFile(
      {
        store,
        read: (p, i) => service.read(p, i),
        evidence: fake.evidence,
        mapEvidence,
        isBytesUnavailable,
      },
      principalArg,
      { taskId: "T0ABC123", claimId: "CL1", fileId, actor: "agent:main:s1", ...extra },
    );

  it("agent: attach registers the bytes, then links by blobKey, as personal material", async () => {
    const file = await put("agent-attach.txt", "attach body", { collection: "vault" });
    const fake = makeEvidence();
    const out = (await attach(fake, A, file.id, { expectedHeadEventId: "E9" })) as any;
    assert.equal(out.ok, true);
    assert.deepEqual(out.source, { fileId: file.id, name: "agent-attach.txt" });
    assert.deepEqual(
      fake.calls.map((c) => c.kind),
      ["upload", "attach"],
    );
    const up = fake.calls[0]!.input;
    assert.equal(up.classification, "personal");
    assert.equal(Buffer.from(up.bytes).toString(), "attach body");
    assert.equal(up.locator, `vault:${file.id}`);
    assert.equal(up.claimId, undefined);
    const link = fake.calls[1]!.input;
    assert.equal(link.blobKey, `${"a".repeat(64)}.1`);
    assert.equal(link.eventSource, "store");
    assert.equal(link.expectedHeadEventId, "E9");
    assert.equal(link.operatorRelation, undefined);
  });

  it("agent: attach refuses sensitive, trashed, oversize, foreign and malformed input before touching evidence", async () => {
    const file = await put("agent-attach-2.txt", "x".repeat(100), { collection: "vault" });
    const fake = makeEvidence();
    assert.equal(((await attach(fake, A, file.id)) as any).code, "file_too_large");
    const small = await put("agent-attach-3.txt", "tiny", { collection: "vault" });
    await call("nexus.vault.setSensitivity", { fileId: small.id, sensitivity: "sensitive" });
    assert.equal(((await attach(fake, A, small.id)) as any).code, "file_sensitive");
    await call("nexus.vault.setSensitivity", { fileId: small.id, sensitivity: "normal" });
    assert.equal(((await attach(fake, B, small.id)) as any).code, "not_found");
    assert.equal(((await attach(fake, A, "a b")) as any).code, "invalid_file_id");
    assert.equal(
      ((await attach(fake, A, small.id, { claimId: "bad id" })) as any).code,
      "invalid_claim_id",
    );
    assert.equal(
      ((await attach(fake, A, small.id, { expectedHeadEventId: 5 })) as any).code,
      "invalid_expected_head",
    );
    await call("nexus.vault.trash", { fileId: small.id });
    assert.equal(((await attach(fake, A, small.id)) as any).code, "file_not_available");
    assert.equal(fake.calls.length, 0);
  });

  it("agent: attach stops on corrupted or missing bytes", async () => {
    const file = await put("agent-attach-4.txt", "will be damaged", { collection: "vault" });
    const row = db.prepare("SELECT object_id FROM vault_files WHERE id = ?").get(file.id) as {
      object_id: string;
    };
    const key = path.join(dir, "vault", "objects", row.object_id.slice(0, 2), row.object_id);
    const fake = makeEvidence();
    fs.writeFileSync(key, "will be damagXX");
    assert.equal(((await attach(fake, A, file.id)) as any).code, "file_bytes_mismatch");
    fs.rmSync(key);
    assert.equal(((await attach(fake, A, file.id)) as any).code, "file_bytes_missing");
    assert.equal(fake.calls.length, 0);
  });

  it("agent: attach passes the evidence verdict through and names the missing byte store", async () => {
    const file = await put("agent-attach-5.txt", "verdicts", { collection: "vault" });
    const stale = makeEvidence({ attach: { outcome: "stale_head" } });
    assert.equal(((await attach(stale, A, file.id)) as any).code, "stale_head");
    const rejected = makeEvidence({ upload: { outcome: "quota_exceeded" } });
    assert.equal(((await attach(rejected, A, file.id)) as any).code, "quota_exceeded");
    assert.deepEqual(
      rejected.calls.map((c) => c.kind),
      ["upload"],
    );
    const noBytes = makeEvidence({ throwOnUpload: new Error("no-bytes") });
    const out = (await attach(noBytes, A, file.id)) as any;
    assert.equal(out.code, "evidence_bytes_unavailable");
    assert.equal(out.reason, "unsupported");
    const boom = makeEvidence({ throwOnUpload: new Error("disk exploded") });
    await assert.rejects(() => attach(boom, A, file.id), /disk exploded/);
  });

  it("content search: the console gets files and text, the Agent gets only which files match", async () => {
    // This suite shares one store, so earlier tests' files are queued too. The fake clock gives every job the same
    // timestamp, which leaves the claim order to the job ids: a batch of 20 may not reach the files made here.
    config.extract = { ...VAULT_EXTRACT_DEFAULTS, batch: 500 };
    try {
      await put("report-q3.md", "Quarterly revenue grew because of the harbor contract.", {
        collection: "vault",
      });
      await call("nexus.vault.upload", {
        name: "holiday.png",
        dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString(
          "base64",
        ),
        collection: "vault",
      });
      await call("nexus.vault.extract");

      const found = await call("nexus.vault.search", { query: "harbor contract" });
      assert.equal(found.ok, true, JSON.stringify(found));
      assert.deepEqual(
        found.payload!.items.map((item: { displayName: string }) => item.displayName),
        ["report-q3.md"],
      );
      const fileId = found.payload!.items[0].id as string;
      assert.equal(found.payload!.extraction[fileId].state, "ready");
      assert.equal(
        (await call("nexus.vault.search", { query: "" })).error?.code,
        "nexus_invalid_params",
      );

      const body = await call("nexus.vault.text", { fileId });
      assert.equal(body.payload!.available, true);
      assert.ok(String(body.payload!.text).includes("harbor contract"));

      const agent = (await agentSearchFiles(store, A, {
        contentContains: "harbor contract",
      })) as any;
      assert.equal(agent.ok, true);
      assert.deepEqual(
        agent.files.map((file: { name: string }) => file.name),
        ["report-q3.md"],
      );
      assert.equal(agent.contentSearch.textAvailableToYou, false);
      assert.ok(!JSON.stringify(agent).includes("revenue"), "no text or snippet reaches the Agent");
      assert.equal(((await agentGetFile(store, A, fileId)) as any).contentSearchable, true);

      const none = (await agentSearchFiles(store, A, {
        contentContains: "zzz-nothing-like-this",
      })) as any;
      assert.equal(none.returned, 0);
      assert.match(
        String(none.note),
        /does NOT prove the content is absent|Every file in this scope was searched/,
      );

      await call("nexus.vault.setSensitivity", { fileId, sensitivity: "sensitive" });
      assert.equal(
        ((await agentSearchFiles(store, A, { contentContains: "harbor contract" })) as any)
          .returned,
        0,
      );
      assert.equal(
        (await call("nexus.vault.search", { query: "harbor contract" })).payload!.total,
        0,
      );
      assert.equal((await call("nexus.vault.text", { fileId })).payload!.available, false);
      assert.equal(
        (await call("nexus.vault.get", { fileId })).payload!.extraction.state,
        "skipped",
      );
      await call("nexus.vault.setSensitivity", { fileId, sensitivity: "normal" });
      // The cancelled job may be queued again by hand (the sweep would do it too); a finished one may not.
      assert.equal((await call("nexus.vault.retryExtract", { fileId })).ok, true);
      await call("nexus.vault.extract");
      assert.equal((await call("nexus.vault.get", { fileId })).payload!.extraction.state, "ready");
      assert.equal(
        (await call("nexus.vault.retryExtract", { fileId })).error?.code,
        "nexus_conflict",
      );

      const stats = await call("nexus.vault.stats");
      assert.equal(stats.payload!.text.fts, true);
      const jobs = await call("nexus.vault.jobs", { state: "rejected" });
      assert.ok(
        jobs.payload!.items.some(
          (job: { displayName: string }) => job.displayName === "holiday.png",
        ),
      );
    } finally {
      delete config.extract;
    }
  });
});

describe("vault service drain", () => {
  it("drain waits for a running write and reports a timeout when one never ends", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-drain-"));
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
    kernel.registerIncarnation({ principal: A, incarnationId: "inc-d", bootId: "b", now: 1 });
    const store = new Proxy(
      {},
      {
        get: (_t, name: string) =>
          name === "then"
            ? undefined
            : async (input: unknown) =>
                (Reflect.get(kernel, name) as (v: unknown) => unknown)(input),
      },
    ) as VaultStore;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* slow() {
      yield text("part one ");
      await gate;
      yield text("part two");
    }
    const svc = createVaultService({
      getStore: async () => store,
      files: createFsVaultFileStore(path.join(dir, "vault")),
      incarnationId: () => "inc-d",
      incarnationGoneEnabled: false,
      config: () => ({
        limits: { maxFileBytes: MIB, ownerQuotaBytes: 8 * MIB },
        inboxRetentionMs: 1000,
        trashRetentionMs: 1000,
        reservationTtlMs: 60_000,
        minFreeBytes: 0,
        reservationRetentionMs: 1000,
        tombstoneRetentionMs: 1000,
        receiptHashRetentionMs: 1000,
        reclaimGraceMs: 0,
        import: { roots: [], forbidden: [], maxBytes: MIB },
      }),
      now: () => 10,
    });
    assert.equal(await svc.drain(50), true, "idle service drains at once");
    const pending = svc.ingest(A, {
      displayName: "slow.txt",
      bytes: slow(),
      source: "upload",
      importedBy: "t",
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    assert.equal(await svc.drain(60), false, "a stuck write times the drain out");
    release();
    assert.equal((await pending).outcome, "ok");
    assert.equal(await svc.drain(500), true);
  });
});
