// Chat attachment intake (Vault design 4, `source: "chat"`): the hook filter, the library placement in both directions, and
// the hard link that keeps a chat file from being stored twice. Runs against a real directory tree and real SQL in memory,
// like the service tests, so the inode assertion means what it says.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "vitest";
import { applyMigrations } from "../store/kernel.js";
import { createNexusKernel } from "../store/nexus-kernel.js";
import type { Principal } from "../store/types.js";
import { vaultObjectKey } from "../store/vault-types.js";
import { createChatIntake, createReplyIntake } from "./vault-chat.js";
import { createFsVaultFileStore } from "./vault-file-store.js";
import { createVaultService, type VaultConfig, type VaultStore } from "./vault-service.js";

const A: Principal = { ownerId: "owner-a" };
const MIB = 1024 * 1024;

const tile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-chat-"));
  const root = path.join(dir, "vault");
  const media = path.join(dir, "media");
  fs.mkdirSync(media, { recursive: true });
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
    import: { roots: [media], forbidden: [], maxBytes: MIB },
    chatMediaRoot: media,
  };
  const warnings: string[] = [];
  let clock = 1_000;
  const service = createVaultService({
    getStore: async () => store,
    files: createFsVaultFileStore(root),
    incarnationId: () => "inc-1",
    incarnationGoneEnabled: false,
    config: () => config,
    now: () => (clock += 1),
    logger: { warn: (message) => warnings.push(message) },
  });
  kernel.registerIncarnation({
    principal: A,
    incarnationId: "inc-1",
    bootId: "boot-1",
    now: clock,
  });
  return { dir, root, media, service, warnings };
};

const write = (dir: string, name: string, body: string) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
};

const flush = async (rounds = 8) => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

describe("chat media intake: ingestChatMedia", () => {
  it("puts an attachment in the library, records the message it came from, and links instead of copying", async () => {
    const world = tile();
    const file = write(world.media, "invoice.pdf", "pdf bytes here");
    const out = await world.service.ingestChatMedia(A, {
      path: file,
      displayName: "invoice.pdf",
      sessionKey: "agent:main:main",
      messageId: "m-1",
      importedBy: "operator:console",
    });
    assert.equal(out.outcome, "ok");
    assert.equal(out.outcome === "ok" && out.file.source, "chat");
    // A file that came with a message is kept, not queued for review: it goes straight into the library.
    assert.equal(out.outcome === "ok" && out.file.collection, "vault");
    assert.equal(out.outcome === "ok" && out.file.expiresAt, null);
    assert.equal(out.outcome === "ok" && out.file.sourceRef, "agent:main:main#m-1");
    if (out.outcome !== "ok") {
      throw new Error("expected an ingested file");
    }
    const objectPath = path.join(world.root, vaultObjectKey(out.file.objectId));
    assert.equal(fs.readFileSync(objectPath, "utf8"), "pdf bytes here");
    if (process.platform !== "win32") {
      // Same inode: the vault holds its own name for the file without a second copy of the bytes.
      assert.equal(fs.statSync(objectPath).ino, fs.statSync(file).ino);
    }
    // The media side going away cannot take the vault's copy with it.
    fs.rmSync(file);
    assert.equal(fs.readFileSync(objectPath, "utf8"), "pdf bytes here");
  });

  it("refuses a path outside the media directory and a relative one", async () => {
    const world = tile();
    const elsewhere = path.join(world.dir, "Downloads");
    fs.mkdirSync(elsewhere, { recursive: true });
    const outside = write(elsewhere, "secret.txt", "not media");
    const refused = await world.service.ingestChatMedia(A, {
      path: outside,
      displayName: "secret.txt",
      sessionKey: "s",
      messageId: "m",
      importedBy: "operator:console",
    });
    assert.deepEqual(refused, { outcome: "refused", reason: "outside_roots" });
    const relative = await world.service.ingestChatMedia(A, {
      path: "media/relative.txt",
      displayName: "relative.txt",
      sessionKey: "s",
      messageId: "m",
      importedBy: "operator:console",
    });
    assert.deepEqual(relative, { outcome: "refused", reason: "not_absolute" });
  });

  it("refuses a file over the per-file limit before writing anything", async () => {
    const world = tile();
    const big = path.join(world.media, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(MIB + 1));
    const out = await world.service.ingestChatMedia(A, {
      path: big,
      displayName: "big.bin",
      sessionKey: "s",
      messageId: "m",
      importedBy: "operator:console",
    });
    assert.deepEqual(out, { outcome: "refused", reason: "too_large" });
  });
});

describe("chat media intake: the message hook", () => {
  const event = (over: Record<string, unknown>) => ({
    sessionKey: "agent:main:main",
    messageId: "m-1",
    channel: "control-ui",
    ...over,
  });

  it("takes the facts that already have a local file and skips the rest", async () => {
    const taken: Array<Record<string, unknown>> = [];
    const intake = createChatIntake({
      vault: {
        ingestChatMedia: async (_who, input) => {
          taken.push(input);
          return { outcome: "ok", file: {}, deduplicated: false } as never;
        },
      },
      resolvePrincipal: () => A,
      importedBy: "operator:console",
    });
    intake(
      event({
        media: [
          { path: "/tmp/media/one.png", fileName: "one.png" },
          { url: "https://example.com/remote.png" },
          { path: "relative/two.png" },
          { path: "/tmp/media/three.pdf" },
        ],
      }),
    );
    await flush();
    assert.equal(taken.length, 2);
    assert.equal(taken[0]?.displayName, "one.png");
    // No fileName in the fact: the file's own base name is shown.
    assert.equal(taken[1]?.displayName, "three.pdf");
    assert.equal(taken[0]?.sessionKey, "agent:main:main");
    assert.equal(taken[0]?.messageId, "m-1");
  });

  it("ignores a message whose media is still staging, and one with no attachments", async () => {
    const taken: unknown[] = [];
    const intake = createChatIntake({
      vault: {
        ingestChatMedia: async () => {
          taken.push(1);
          return { outcome: "ok", file: {}, deduplicated: false } as never;
        },
      },
      resolvePrincipal: () => A,
      importedBy: "operator:console",
    });
    intake(event({ mediaStagingPending: true, media: [{ path: "/tmp/media/a.png" }] }));
    intake(event({ media: [] }));
    intake(event({}));
    await flush();
    assert.equal(taken.length, 0);
  });

  it("ingests the same (session, message, index) once, and caps how much one message queues", async () => {
    const taken: Array<Record<string, unknown>> = [];
    const intake = createChatIntake({
      vault: {
        ingestChatMedia: async (_who, input) => {
          taken.push(input);
          return { outcome: "ok", file: {}, deduplicated: false } as never;
        },
      },
      resolvePrincipal: () => A,
      importedBy: "operator:console",
      maxPerMessage: 2,
    });
    const media = [
      { path: "/tmp/media/a.png" },
      { path: "/tmp/media/b.png" },
      { path: "/tmp/media/c.png" },
    ];
    intake(event({ media }));
    await flush();
    assert.equal(taken.length, 2);
    intake(event({ media }));
    await flush();
    assert.equal(taken.length, 2);
  });

  it("never throws when the vault refuses or fails", async () => {
    const intake = createChatIntake({
      vault: {
        ingestChatMedia: async () => {
          throw new Error("disk on fire");
        },
      } as never,
      resolvePrincipal: () => A,
      importedBy: "operator:console",
    });
    assert.doesNotThrow(() => intake(event({ media: [{ path: "/tmp/media/a.png" }] })));
    await flush();
  });
});

describe("chat media intake: the reply hook", () => {
  const reply = (over: Record<string, unknown> = {}) => ({
    kind: "final",
    sessionKey: "agent:main:main",
    runId: "r-1",
    payload: {
      text: "here it is",
      mediaUrls: [
        "/tmp/media/report.pdf",
        "https://example.com/remote.png",
        "file:///tmp/media/chart.png",
      ],
    },
    ...over,
  });
  const collect = () => {
    const taken: Array<Record<string, unknown>> = [];
    const intake = createReplyIntake({
      vault: {
        ingestChatMedia: async (_who, input) => {
          taken.push(input);
          return { outcome: "ok", file: {}, deduplicated: false } as never;
        },
      },
      resolvePrincipal: () => A,
      importedBy: "operator:console",
    });
    return { taken, intake };
  };

  it("files the local files a final reply sends, and leaves URLs alone", async () => {
    const { taken, intake } = collect();
    intake(reply());
    await flush();
    // The remote URL is not the vault's to fetch; the `file:` URL names a local file and is taken.
    assert.deepEqual(
      taken.map((input) => input.path),
      ["/tmp/media/report.pdf", "/tmp/media/chart.png"],
    );
    assert.equal(taken[0]?.messageId, "sent:r-1");
    assert.equal(taken[0]?.displayName, "report.pdf");
  });

  it("ignores tool and block payloads: they are the same reply in pieces", async () => {
    const { taken, intake } = collect();
    intake(reply({ kind: "block" }));
    intake(reply({ kind: "tool" }));
    intake(reply({ payload: { text: "no files" } }));
    await flush();
    assert.equal(taken.length, 0);
  });

  it("takes one reply once, so a repeated announcement cannot add a second copy", async () => {
    const { taken, intake } = collect();
    intake(reply());
    await flush();
    intake(reply());
    await flush();
    assert.equal(taken.length, 2);
  });

  it("never throws when the vault fails", async () => {
    const intake = createReplyIntake({
      vault: {
        ingestChatMedia: async () => {
          throw new Error("disk on fire");
        },
      },
      resolvePrincipal: () => A,
      importedBy: "operator:console",
    });
    assert.doesNotThrow(() => intake(reply()));
    await flush();
  });
});
