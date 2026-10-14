// In-memory EvidenceBlobStores with failure and timing injection, for tests only. It models the two properties the
// protocol is built around: registerIfAbsent cannot be cancelled once issued, and a delete can return late.
import {
  namespaceFor,
  type EvidenceBlobStore,
  type EvidenceBlobStores,
} from "../evidence/blob-store.js";

type Gate = { release: () => void; promise: Promise<void> };
const gate = (): Gate => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
};

export type FakeBlobWorld = EvidenceBlobStores & {
  /** Raw view of one namespace, for assertions. */
  peek(prefix: "nexus-ev" | "nexus-stg", ownerId: string): Map<string, Uint8Array>;
  /** Make the next `put` on this production key throw (after `after` ms is not modelled: it throws immediately). */
  failNextPut(key?: string): void;
  /** Hold every `put` to this key until `release()` (the write lands only after release: a late A2 write). */
  holdPut(key: string): { release: () => void; started: Promise<void> };
  /** Hold every `remove` of this key until `release()`; the delete happens after release (a late GC delete). */
  holdRemove(key: string): { release: () => void; started: Promise<void> };
  failNextRemove(): void;
  /** Reject puts once the production namespace holds this many bytes (reject-new). */
  setCapacity(bytes: number): void;
  calls: { put: string[]; remove: string[]; get: string[] };
};

export function createFakeBlobWorld(): FakeBlobWorld {
  const spaces = new Map<string, Map<string, Uint8Array>>();
  const putGates = new Map<string, { gate: Gate; started: Gate }>();
  const removeGates = new Map<string, { gate: Gate; started: Gate }>();
  const failPuts = new Set<string>();
  let failAnyPut = false;
  let failRemove = false;
  let capacity = Number.POSITIVE_INFINITY;
  const calls = { put: [] as string[], remove: [] as string[], get: [] as string[] };
  const space = (name: string) => {
    let found = spaces.get(name);
    if (!found) {
      found = new Map();
      spaces.set(name, found);
    }
    return found;
  };
  const storeFor = (name: string, production: boolean): EvidenceBlobStore => ({
    async put(key, bytes) {
      calls.put.push(`${production ? "ev" : "stg"}:${key}`);
      const held = putGates.get(key);
      if (held && production) {
        held.started.release();
        await held.gate.promise;
      }
      if (production && (failAnyPut || failPuts.delete(key))) {
        failAnyPut = false;
        throw new Error("fake blob store: put failed");
      }
      const target = space(name);
      if (target.has(key)) {
        return false;
      }
      if (production) {
        const used = [...target.values()].reduce((sum, value) => sum + value.byteLength, 0);
        if (used + bytes.byteLength > capacity) {
          throw new Error("fake blob store: PLUGIN_BLOB_LIMIT_EXCEEDED");
        }
      }
      target.set(key, bytes.slice());
      return true;
    },
    async get(key) {
      calls.get.push(key);
      return space(name).get(key)?.slice();
    },
    async remove(key) {
      calls.remove.push(`${production ? "ev" : "stg"}:${key}`);
      const held = removeGates.get(key);
      if (held && production) {
        held.started.release();
        await held.gate.promise;
      }
      if (production && failRemove) {
        failRemove = false;
        throw new Error("fake blob store: remove failed");
      }
      return space(name).delete(key);
    },
    async list() {
      return [...space(name).entries()].map(([key, value]) => ({
        key,
        sizeBytes: value.byteLength,
      }));
    },
  });
  return {
    production: async (ownerId) => storeFor(namespaceFor("nexus-ev", ownerId), true),
    staging: async (ownerId) => storeFor(namespaceFor("nexus-stg", ownerId), false),
    peek: (prefix, ownerId) => space(namespaceFor(prefix, ownerId)),
    failNextPut(key) {
      if (key) {
        failPuts.add(key);
      } else {
        failAnyPut = true;
      }
    },
    holdPut(key) {
      const held = { gate: gate(), started: gate() };
      putGates.set(key, held);
      return {
        release: () => {
          putGates.delete(key);
          held.gate.release();
        },
        started: held.started.promise,
      };
    },
    holdRemove(key) {
      const held = { gate: gate(), started: gate() };
      removeGates.set(key, held);
      return {
        release: () => {
          removeGates.delete(key);
          held.gate.release();
        },
        started: held.started.promise,
      };
    },
    failNextRemove() {
      failRemove = true;
    },
    setCapacity(bytes) {
      capacity = bytes;
    },
    calls,
  };
}
