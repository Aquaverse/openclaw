// Byte store of the personal file vault (Vault design 5.1 / 5.6). The vault service talks to this small interface, never to
// the filesystem directly, so the whole R / W / P / C protocol is testable with fault injection (a wrapper below) and the
// real `createFsVaultFileStore` only touches a directory tree it owns:
//
//   <root>/objects/<id[0..2]>/<id>   immutable bytes; the id is a server-issued random id, never a hash or a user string
//   <root>/staging/<reservation id>  bytes in flight; the path is fully determined by the reservation row
//   <root>/derived/<id[0..2]>/<id>/  rebuildable derivatives (thumbnails, page images); may be deleted at any time
//
// Keys are validated against a strict pattern before any path is built, so a display name, a folder or any user text can
// never reach the filesystem (names live in metadata only). Directories are 0700 and files 0600.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ID = "[A-Za-z0-9_-]{8,256}";
const STAGING_KEY = new RegExp(`^staging/(${ID})$`);
const OBJECT_KEY = new RegExp(`^objects/([A-Za-z0-9_-]{2})/(${ID})$`);

export type VaultStagingWriter = {
  write(chunk: Uint8Array): Promise<void>;
  /** Flush to disk and close. After this the staging file is complete. */
  finish(): Promise<void>;
  /** Close and delete the partial file. Safe after a failed write; never throws. */
  abort(): Promise<void>;
};

export type VaultFileStore = {
  /** Exclusive create: fails if the key exists, so two writers can never share a staging file. */
  createStaging(stagingKey: string): Promise<VaultStagingWriter>;
  /** Atomic rename `staging/<id>` -> `objects/<aa>/<id>`. Never overwrites an existing object. */
  promote(stagingKey: string, objectKey: string): Promise<void>;
  stat(key: string): Promise<{ size: number } | undefined>;
  /** SHA-256 and size of the bytes currently stored under the key, or undefined when absent. */
  hash(key: string): Promise<{ hash: string; size: number } | undefined>;
  readRange(key: string, offset: number, length: number): Promise<Uint8Array>;
  /** true when something was deleted. Deleting an absent key is not an error (all callers are idempotent). */
  remove(key: string): Promise<boolean>;
  /** Remove the derivatives directory of one object (no receipt, no proof: derivatives are rebuildable). */
  removeDerived(objectId: string): Promise<void>;
  /** Free bytes on the volume that holds the vault, or undefined when the platform cannot say. */
  freeBytes(): Promise<number | undefined>;
  /** Object keys currently on disk (reconcile warns about the ones no row owns; it never deletes them). */
  listObjectKeys(): Promise<string[]>;
};

export class VaultKeyError extends Error {
  readonly code = "vault_bad_key";
  constructor(key: string) {
    super(`not a vault key: ${JSON.stringify(key.slice(0, 80))}`);
    this.name = "VaultKeyError";
  }
}

export { vaultObjectKey, vaultStagingKey } from "../store/vault-types.js";

/** Resolve a key to an absolute path under `root`; anything that is not exactly a staging or object key is refused. */
function resolveKey(root: string, key: string): string {
  const staging = STAGING_KEY.exec(key);
  const stagingId = staging?.[1];
  if (stagingId !== undefined) {
    return path.join(root, "staging", stagingId);
  }
  const object = OBJECT_KEY.exec(key);
  const prefix = object?.[1];
  const objectId = object?.[2];
  if (prefix !== undefined && objectId !== undefined && objectId.startsWith(prefix)) {
    return path.join(root, "objects", prefix, objectId);
  }
  throw new VaultKeyError(key);
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function createFsVaultFileStore(root: string): VaultFileStore {
  const absoluteRoot = path.resolve(root);
  let prepared: Promise<void> | undefined;
  const prepare = (): Promise<void> => {
    prepared ??= (async () => {
      for (const part of ["", "objects", "staging", "derived"]) {
        await fs.promises.mkdir(path.join(absoluteRoot, part), { recursive: true, mode: DIR_MODE });
      }
    })();
    prepared.catch(() => {
      prepared = undefined;
    });
    return prepared;
  };

  const statOrUndefined = async (file: string): Promise<fs.Stats | undefined> => {
    try {
      return await fs.promises.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };

  return {
    async createStaging(stagingKey) {
      await prepare();
      const file = resolveKey(absoluteRoot, stagingKey);
      if (!STAGING_KEY.test(stagingKey)) {
        throw new VaultKeyError(stagingKey);
      }
      const handle = await fs.promises.open(file, "wx", FILE_MODE);
      let closed = false;
      const close = async () => {
        if (!closed) {
          closed = true;
          await handle.close().catch(() => undefined);
        }
      };
      return {
        async write(chunk) {
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
            offset += bytesWritten;
          }
        },
        async finish() {
          await handle.sync();
          await close();
        },
        async abort() {
          await close();
          await fs.promises.rm(file, { force: true }).catch(() => undefined);
        },
      };
    },

    async promote(stagingKey, objectKey) {
      await prepare();
      if (!STAGING_KEY.test(stagingKey) || !OBJECT_KEY.test(objectKey)) {
        throw new VaultKeyError(`${stagingKey} -> ${objectKey}`);
      }
      const from = resolveKey(absoluteRoot, stagingKey);
      const to = resolveKey(absoluteRoot, objectKey);
      await fs.promises.mkdir(path.dirname(to), { recursive: true, mode: DIR_MODE });
      if (await statOrUndefined(to)) {
        // Object ids are random and never reused, so an existing target means a previous promote already landed
        // (crash after rename). The staging file is then gone; treat "target exists, source missing" as done.
        if (!(await statOrUndefined(from))) {
          return;
        }
        throw new Error(`vault promote refused: ${objectKey} already exists`);
      }
      await fs.promises.rename(from, to);
    },

    async stat(key) {
      const found = await statOrUndefined(resolveKey(absoluteRoot, key));
      return found && found.isFile() ? { size: found.size } : undefined;
    },

    async hash(key) {
      const file = resolveKey(absoluteRoot, key);
      const found = await statOrUndefined(file);
      if (!found || !found.isFile()) {
        return undefined;
      }
      const digest = createHash("sha256");
      let size = 0;
      const handle = await fs.promises.open(file, "r");
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) {
            break;
          }
          digest.update(buffer.subarray(0, bytesRead));
          size += bytesRead;
        }
      } finally {
        await handle.close();
      }
      return { hash: digest.digest("hex"), size };
    },

    async readRange(key, offset, length) {
      const file = resolveKey(absoluteRoot, key);
      const handle = await fs.promises.open(file, "r");
      try {
        const buffer = Buffer.alloc(Math.max(0, length));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, offset));
        return new Uint8Array(buffer.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    },

    async remove(key) {
      const file = resolveKey(absoluteRoot, key);
      const found = await statOrUndefined(file);
      if (!found) {
        return false;
      }
      await fs.promises.rm(file, { force: true });
      return true;
    },

    async removeDerived(objectId) {
      if (!new RegExp(`^${ID}$`).test(objectId)) {
        throw new VaultKeyError(objectId);
      }
      await fs.promises.rm(path.join(absoluteRoot, "derived", objectId.slice(0, 2), objectId), {
        recursive: true,
        force: true,
      });
    },

    async freeBytes() {
      try {
        await prepare();
        const stats = await fs.promises.statfs(absoluteRoot);
        return stats.bavail * stats.bsize;
      } catch {
        return undefined;
      }
    },

    async listObjectKeys() {
      await prepare();
      const keys: string[] = [];
      const top = path.join(absoluteRoot, "objects");
      for (const shard of await fs.promises.readdir(top)) {
        const dir = path.join(top, shard);
        const dirStat = await statOrUndefined(dir);
        if (!dirStat?.isDirectory()) {
          continue;
        }
        for (const name of await fs.promises.readdir(dir)) {
          keys.push(`objects/${shard}/${name}`);
        }
      }
      return keys;
    },
  };
}

// ---------------------------------------------------------------- fault injection (tests)

export type VaultStoreFaults = {
  /** Throw on the next call of this method (once). */
  failNext(
    method: "createStaging" | "write" | "finish" | "promote" | "remove" | "hash" | "readRange",
  ): void;
  /** Hold the next call of this method until `release()`; `started` resolves when the call arrived. */
  holdNext(method: "promote" | "remove" | "write"): { release(): void; started: Promise<void> };
  /** Pretend the volume has this many free bytes (undefined: restore the real value). */
  setFreeBytes(bytes: number | undefined): void;
  calls: string[];
};

/** Wraps a store with per-method failure and hold hooks. Production code never imports this. */
export function withVaultStoreFaults(inner: VaultFileStore): VaultFileStore & VaultStoreFaults {
  const failures = new Set<string>();
  const holds = new Map<
    string,
    { promise: Promise<void>; release: () => void; started: () => void }
  >();
  let free: number | undefined;
  let freeSet = false;
  const calls: string[] = [];
  const gate = async (method: string, detail: string): Promise<void> => {
    calls.push(`${method}:${detail}`);
    const hold = holds.get(method);
    if (hold) {
      holds.delete(method);
      hold.started();
      await hold.promise;
    }
    if (failures.delete(method)) {
      throw new Error(`injected vault store failure: ${method}`);
    }
  };
  return {
    calls,
    failNext: (method) => {
      failures.add(method);
    },
    holdNext: (method) => {
      let release = () => {};
      let started = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      holds.set(method, { promise, release, started });
      return { release, started: startedPromise };
    },
    setFreeBytes: (bytes) => {
      freeSet = bytes !== undefined;
      free = bytes;
    },
    async createStaging(key) {
      await gate("createStaging", key);
      const writer = await inner.createStaging(key);
      return {
        async write(chunk) {
          await gate("write", key);
          return writer.write(chunk);
        },
        async finish() {
          await gate("finish", key);
          return writer.finish();
        },
        abort: () => writer.abort(),
      };
    },
    async promote(from, to) {
      await gate("promote", `${from}->${to}`);
      return inner.promote(from, to);
    },
    stat: (key) => inner.stat(key),
    async hash(key) {
      await gate("hash", key);
      return inner.hash(key);
    },
    async readRange(key, offset, length) {
      await gate("readRange", key);
      return inner.readRange(key, offset, length);
    },
    async remove(key) {
      await gate("remove", key);
      return inner.remove(key);
    },
    removeDerived: (id) => inner.removeDerived(id),
    freeBytes: async () => (freeSet ? free : inner.freeBytes()),
    listObjectKeys: () => inner.listObjectKeys(),
  };
}
