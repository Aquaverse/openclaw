// Spike 3 items 1-3: observe the real openBlobStore runtime contract (DESIGN section 13, Stage 0).
// Everything here only OBSERVES; results land in the recorder and are copied into nexus-agent-core-design.md by a human.
import { randomBytes } from "node:crypto";
import type { OpenClawPluginApi } from "../../api.js";
import {
  MODULE_INSTANCE_ID,
  readBootIdCandidateA,
  readBootIdCandidateB,
  readBootIdCandidateD,
} from "./boot-id-candidates.js";
import { describeError, type SpikeRecorder } from "./recorder.js";

const MB = 1024 * 1024;
type BlobMeta = { probe: string };

function openStore(
  api: OpenClawPluginApi,
  options: {
    namespace: string;
    maxEntries?: number;
    maxBytesPerEntry?: number;
    maxBytesPerNamespace?: number;
    overflowPolicy?: "evict-oldest" | "reject-new";
  },
) {
  return api.runtime.state.openBlobStore<BlobMeta>({
    namespace: options.namespace,
    maxEntries: options.maxEntries ?? 16,
    maxBytesPerEntry: options.maxBytesPerEntry ?? MB,
    maxBytesPerNamespace: options.maxBytesPerNamespace ?? 8 * MB,
    ...(options.overflowPolicy ? { overflowPolicy: options.overflowPolicy } : {}),
  });
}

async function attempt<T>(
  recorder: SpikeRecorder,
  item: string,
  label: string,
  run: () => Promise<T> | T,
  extra?: (value: T) => Record<string, unknown>,
): Promise<T | undefined> {
  try {
    const value = await run();
    recorder.record(3, item, "ok", { label, ...(extra ? extra(value) : {}) });
    return value;
  } catch (error) {
    recorder.record(3, item, "fail", { label, error: describeError(error) });
    return undefined;
  }
}

/** 3.1: which limits are rejected at open time (2 GB per namespace, per-entry above 100 MB, ...). */
export async function runBlobOpenLimits(api: OpenClawPluginApi, recorder: SpikeRecorder) {
  const item = "blob.open-limits";
  const cases: Array<[string, number, number]> = [
    ["2GB namespace", 2048 * MB, MB],
    ["512MB namespace", 512 * MB, MB],
    ["513MB namespace", 513 * MB, MB],
    ["entry 101MB", 512 * MB, 101 * MB],
  ];
  for (const [label, namespaceBytes, entryBytes] of cases) {
    const name = `nexus-spike-limits-${label.replace(/\W+/g, "-").toLowerCase()}`;
    await attempt(recorder, item, label, () =>
      openStore(api, {
        namespace: name,
        maxBytesPerNamespace: namespaceBytes,
        maxBytesPerEntry: entryBytes,
      }),
    );
  }
}

/** 3.2: namespace naming, including the nexus-ev-<32 hex> shape and unsafe owner ids. */
export async function runBlobNaming(api: OpenClawPluginApi, recorder: SpikeRecorder) {
  const item = "blob.naming";
  const hex32 = randomBytes(16).toString("hex");
  for (const namespace of [
    `nexus-ev-${hex32}`,
    `nexus-ev-owner@example.com`,
    `nexus-ev-a/b`,
    `nexus-ev-${"x".repeat(200)}`,
  ]) {
    await attempt(
      recorder,
      item,
      namespace.length > 60 ? `${namespace.slice(0, 40)}…(${namespace.length})` : namespace,
      () => openStore(api, { namespace }),
    );
  }
}

/** 3.3: registerIfAbsent duplicate keys, reject-new and evict-oldest overflow, and cancel surface. */
export async function runBlobSemantics(api: OpenClawPluginApi, recorder: SpikeRecorder) {
  const item = "blob.semantics";
  const suffix = randomBytes(4).toString("hex");
  const bytes = (n: number) => new Uint8Array(n).fill(7);

  const plain = openStore(api, { namespace: `nexus-spike-sem-${suffix}` });
  await attempt(
    recorder,
    item,
    "registerIfAbsent first",
    () => plain.registerIfAbsent("k", bytes(8), { probe: "a" }),
    (returned) => ({ returned }),
  );
  await attempt(
    recorder,
    item,
    "registerIfAbsent duplicate",
    () => plain.registerIfAbsent("k", bytes(8), { probe: "b" }),
    (returned) => ({ returned }),
  );
  await attempt(
    recorder,
    item,
    "register overwrites",
    () => plain.register("k", bytes(9), { probe: "c" }),
    () => ({}),
  );
  await attempt(
    recorder,
    item,
    "lookup after overwrite",
    () => plain.lookup("k"),
    (entry) => ({
      sizeBytes: entry?.sizeBytes,
      metadata: entry?.metadata,
    }),
  );
  await attempt(
    recorder,
    item,
    "delete present",
    () => plain.delete("k"),
    (returned) => ({ returned }),
  );
  await attempt(
    recorder,
    item,
    "delete absent",
    () => plain.delete("k"),
    (returned) => ({ returned }),
  );
  recorder.record(3, item, "info", {
    label: "registerIfAbsent has no cancellation parameter (static)",
    declaredArity: plain.registerIfAbsent.length,
    note: "type signature is (key, bytes, metadata, opts?: { ttlMs }) - no AbortSignal",
  });

  const rejecting = openStore(api, {
    namespace: `nexus-spike-rej-${suffix}`,
    maxEntries: 2,
    overflowPolicy: "reject-new",
  });
  for (const key of ["a", "b", "c"]) {
    await attempt(recorder, item, `reject-new write ${key}`, () =>
      rejecting.register(key, bytes(4), { probe: key }),
    );
  }
  const evicting = openStore(api, {
    namespace: `nexus-spike-evict-${suffix}`,
    maxEntries: 2,
    overflowPolicy: "evict-oldest",
  });
  for (const key of ["a", "b", "c"]) {
    await attempt(recorder, item, `evict-oldest write ${key}`, () =>
      evicting.register(key, bytes(4), { probe: key }),
    );
  }
  await attempt(
    recorder,
    item,
    "evict-oldest survivors",
    () => evicting.entries(),
    (entries) => ({
      keys: entries.map((entry) => entry.key).toSorted(),
    }),
  );
  await Promise.allSettled([plain.clear(), rejecting.clear(), evicting.clear()]);
}

/**
 * 3.4 (heavy, opt-in): is the 512 MB cap per namespace or summed across namespaces?
 * Writes ~600 MB in 50 MB chunks across two namespaces, then clears.
 */
export async function runBlobCrossNamespaceCap(api: OpenClawPluginApi, recorder: SpikeRecorder) {
  const item = "blob.cross-namespace-cap";
  const suffix = randomBytes(4).toString("hex");
  const chunk = new Uint8Array(50 * MB).fill(1);
  // evict-oldest is the default policy and would hide the cap by silently deleting old rows (observed in v1 of this probe).
  const options = {
    maxEntries: 32,
    maxBytesPerEntry: 100 * MB,
    maxBytesPerNamespace: 400 * MB,
    overflowPolicy: "reject-new" as const,
  };
  const a = openStore(api, { ...options, namespace: `nexus-spike-capa-${suffix}` });
  const b = openStore(api, { ...options, namespace: `nexus-spike-capb-${suffix}` });
  let written = 0;
  try {
    for (let index = 0; index < 12; index += 1) {
      const store = index % 2 === 0 ? a : b;
      try {
        await store.register(`c${index}`, chunk, { probe: "cap" });
        written += chunk.byteLength;
      } catch (error) {
        const stored = [...(await a.entries()), ...(await b.entries())];
        recorder.record(3, item, "ok", {
          label: "first rejected write",
          storedBytes: stored.reduce((sum, entry) => sum + entry.sizeBytes, 0),
          chunkIndex: index,
          writtenBytesBefore: written,
          error: describeError(error),
          conclusion:
            written <= 512 * MB && written > 400 * MB
              ? "limit looks cross-namespace (sum)"
              : "see writtenBytesBefore against 400MB (per-namespace) and 512MB (per-plugin)",
        });
        return;
      }
    }
    const stored = [...(await a.entries()), ...(await b.entries())];
    recorder.record(3, item, "info", {
      label: "no rejection within 600MB under reject-new",
      writtenBytes: written,
      storedBytes: stored.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    });
  } finally {
    await Promise.allSettled([a.clear(), b.clear()]);
  }
}

/** 3.5: trust gate + boot id candidates, observed from the real plugin runtime. */
export async function runRuntimeIdentity(api: OpenClawPluginApi, recorder: SpikeRecorder) {
  recorder.record(3, "runtime.identity", "info", {
    pluginSource: api.source,
    runtimeSource: api.runtimeSource,
    registrationMode: api.registrationMode,
    bootIdA: readBootIdCandidateA(api.runtime),
    bootIdB: readBootIdCandidateB(),
    bootIdD: readBootIdCandidateD(),
    platform: process.platform,
    moduleInstance: MODULE_INSTANCE_ID,
    pid: process.pid,
    ppid: process.ppid,
  });
  await attempt(recorder, "runtime.trust", "openBlobStore passes assertTrustedPluginRuntime", () =>
    openStore(api, { namespace: "nexus-spike-trust" }),
  );
}
