import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { createSpikeRecorder } from "./recorder.js";
import { runSpike, SPIKE_ITEMS } from "./runner.js";

function createFakeApi(overrides: Record<string, unknown> = {}): OpenClawPluginApi {
  const stores = new Map<string, Map<string, Uint8Array>>();
  return {
    source: "/fake/index.ts",
    runtimeSource: undefined,
    registrationMode: "full",
    runtime: {
      state: {
        openBlobStore: (options: { namespace: string; maxBytesPerNamespace: number }) => {
          if (options.maxBytesPerNamespace > 512 * 1024 * 1024) {
            throw Object.assign(new Error("namespace limit too large"), {
              code: "PLUGIN_BLOB_INVALID_INPUT",
            });
          }
          if (!/^[a-z0-9][a-z0-9._-]*$/i.test(options.namespace)) {
            throw Object.assign(new Error("unsafe namespace"), {
              code: "PLUGIN_BLOB_INVALID_INPUT",
            });
          }
          const entries = stores.get(options.namespace) ?? new Map<string, Uint8Array>();
          stores.set(options.namespace, entries);
          return {
            register: async (key: string, bytes: Uint8Array) => void entries.set(key, bytes),
            registerIfAbsent: async (key: string, bytes: Uint8Array) => {
              if (entries.has(key)) {
                return false;
              }
              entries.set(key, bytes);
              return true;
            },
            lookup: async (key: string) => {
              const bytes = entries.get(key);
              return bytes
                ? { key, bytes, sizeBytes: bytes.byteLength, metadata: { probe: "x" } }
                : undefined;
            },
            entries: async () => [...entries.keys()].map((key) => ({ key })),
            delete: async (key: string) => entries.delete(key),
            clear: async () => entries.clear(),
          };
        },
      },
    },
    ...overrides,
  } as unknown as OpenClawPluginApi;
}

describe("runSpike", () => {
  it("rejects unknown spikes and items", async () => {
    const recorder = createSpikeRecorder();
    await expect(runSpike(createFakeApi(), recorder, { spike: 9 as 1 })).rejects.toThrow(
      /unknown spike/,
    );
    await expect(runSpike(createFakeApi(), recorder, { spike: 3, item: "nope" })).rejects.toThrow(
      /unknown item "nope"/,
    );
  });

  it("records open-limit failures as observations, not exceptions", async () => {
    const recorder = createSpikeRecorder();
    const result = await runSpike(createFakeApi(), recorder, { spike: 3, item: "open-limits" });
    const byLabel = Object.fromEntries(
      result.observations.map((row) => [String(row.data?.label), row.outcome]),
    );
    expect(byLabel["2GB namespace"]).toBe("fail");
    expect(byLabel["512MB namespace"]).toBe("ok");
  });

  it("observes registerIfAbsent duplicate behavior", async () => {
    const recorder = createSpikeRecorder();
    const result = await runSpike(createFakeApi(), recorder, { spike: 3, item: "semantics" });
    const first = result.observations.find((row) => row.data?.label === "registerIfAbsent first");
    const duplicate = result.observations.find(
      (row) => row.data?.label === "registerIfAbsent duplicate",
    );
    expect(first?.data).toMatchObject({ label: "registerIfAbsent first" });
    expect(duplicate?.outcome).toBe("ok");
    expect(
      result.observations.some((row) => String(row.data?.label).includes("no cancellation")),
    ).toBe(true);
  });

  it("flags unsafe blob namespaces", async () => {
    const recorder = createSpikeRecorder();
    const result = await runSpike(createFakeApi(), recorder, { spike: 3, item: "naming" });
    const failures = result.observations.filter((row) => row.outcome === "fail");
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });

  it("skips the heavy cap probe unless asked", async () => {
    const recorder = createSpikeRecorder();
    const result = await runSpike(createFakeApi(), recorder, {
      spike: 3,
      item: "cross-namespace-cap",
    });
    expect(result.observations[0]?.outcome).toBe("skipped");
  });

  it("skips the schedule probe without a sessionKey", async () => {
    const recorder = createSpikeRecorder();
    const result = await runSpike(createFakeApi(), recorder, { spike: 4 });
    expect(result.observations[0]).toMatchObject({ item: "schedule.handle", outcome: "skipped" });
  });

  it("returns only rows recorded by this run", async () => {
    const recorder = createSpikeRecorder();
    recorder.record(1, "earlier", "info");
    const result = await runSpike(createFakeApi(), recorder, { spike: 2 });
    expect(result.observations.map((row) => row.item)).toEqual(["guide"]);
  });

  it("covers every spike", () => {
    expect(Object.keys(SPIKE_ITEMS)).toEqual(["1", "2", "3", "4"]);
  });
});
