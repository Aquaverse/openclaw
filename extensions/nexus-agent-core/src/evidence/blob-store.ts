// Byte store abstraction for evidence (DESIGN sections 9.4 / 9.5.1). The service talks to this small interface, never to
// the SDK directly, so the whole A0..B protocol is testable with an in-memory fake (VM tests cannot resolve
// `openclaw/plugin-sdk/*`) and the real `openBlobStore` is only exercised on the gateway, by the probe scripts.
import { sha256Hex } from "../canonical.js";

export type EvidenceBlobStore = {
  /** registerIfAbsent semantics: true when this call created the key, false when it already existed. */
  put(key: string, bytes: Uint8Array): Promise<boolean>;
  get(key: string): Promise<Uint8Array | undefined>;
  /** true when something was deleted. Deleting an absent key is not an error. */
  remove(key: string): Promise<boolean>;
  /** Every key with its size: used by the reconcile scan only. */
  list(): Promise<Array<{ key: string; sizeBytes: number }>>;
};

export type EvidenceBlobStores = {
  /** `nexus-ev-<sha256(ownerId)[:32]>`: authoritative bytes, overflow policy reject-new. */
  production(ownerId: string): Promise<EvidenceBlobStore>;
  /** `nexus-stg-<sha256(ownerId)[:32]>`: staging copies, evict-oldest, small quota. */
  staging(ownerId: string): Promise<EvidenceBlobStore>;
};

const MB = 1024 * 1024;
/** SDK ceilings (DESIGN 9.4): 512 MB per plugin across namespaces, 100 MB per entry, 50 000 entries. */
export const SDK_LIMITS = {
  pluginBytes: 512 * MB,
  entryBytes: 100 * MB,
  entries: 50_000,
} as const;
export const STAGING_LIMITS = { bytes: 128 * MB, entries: 64, ttlMs: 10 * 60_000 } as const;

export function namespaceFor(prefix: "nexus-ev" | "nexus-stg", ownerId: string): string {
  return `${prefix}-${sha256Hex(ownerId).slice(0, 32)}`;
}

/** The slice of `api.runtime.state.openBlobStore` this module uses (structural, so no SDK import is needed here). */
export type OpenBlobStoreLike = (options: {
  namespace: string;
  maxEntries: number;
  maxBytesPerEntry: number;
  maxBytesPerNamespace: number;
  overflowPolicy?: "evict-oldest" | "reject-new";
  defaultTtlMs?: number;
}) => PluginBlobStoreLike | Promise<PluginBlobStoreLike>;

export type PluginBlobStoreLike = {
  registerIfAbsent(
    key: string,
    bytes: Uint8Array,
    metadata: { owner: string },
    opts?: { ttlMs?: number },
  ): Promise<boolean>;
  lookup(key: string): Promise<{ bytes: Uint8Array } | undefined>;
  entries(): Promise<Array<{ key: string; sizeBytes: number }>>;
  delete(key: string): Promise<boolean>;
};

export function createRuntimeBlobStores(open: OpenBlobStoreLike): EvidenceBlobStores {
  const cache = new Map<string, Promise<EvidenceBlobStore>>();
  const adapt = (
    store: PluginBlobStoreLike,
    ownerHash: string,
    ttlMs: number | undefined,
  ): EvidenceBlobStore => ({
    put: (key, bytes) =>
      store.registerIfAbsent(key, bytes, { owner: ownerHash }, ttlMs ? { ttlMs } : undefined),
    get: async (key) => (await store.lookup(key))?.bytes,
    remove: (key) => store.delete(key),
    list: async () =>
      (await store.entries()).map((entry) => ({ key: entry.key, sizeBytes: entry.sizeBytes })),
  });
  const opened = (prefix: "nexus-ev" | "nexus-stg", ownerId: string) => {
    const namespace = namespaceFor(prefix, ownerId);
    let pending = cache.get(namespace);
    if (!pending) {
      const production = prefix === "nexus-ev";
      pending = (async () =>
        adapt(
          await open({
            namespace,
            maxEntries: production ? SDK_LIMITS.entries : STAGING_LIMITS.entries,
            maxBytesPerEntry: SDK_LIMITS.entryBytes,
            maxBytesPerNamespace: production ? SDK_LIMITS.pluginBytes : STAGING_LIMITS.bytes,
            overflowPolicy: production ? "reject-new" : "evict-oldest",
          }),
          namespace,
          production ? undefined : STAGING_LIMITS.ttlMs,
        ))();
      pending.catch(() => cache.delete(namespace));
      cache.set(namespace, pending);
    }
    return pending;
  };
  return {
    production: (ownerId) => opened("nexus-ev", ownerId),
    staging: (ownerId) => opened("nexus-stg", ownerId),
  };
}
