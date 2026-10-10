// Spike 1: bundled-install facts and a minimal SQLite worker round trip (DESIGN section 13, Stage 0).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { OpenClawPluginApi } from "../../api.js";
import { describeError, type SpikeRecorder } from "./recorder.js";
import type { Spike1Operations } from "./spike1-sqlite.worker.js";

export function resolveSpikeStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "plugins", "nexus-agent-core", "spikes");
}

export function resolveSpike1WorkerUrl(runtimeSource: string | undefined): URL | undefined {
  if (!runtimeSource) {
    return undefined;
  }
  return new URL(
    `./src/spikes/spike1-sqlite.worker${path.extname(runtimeSource)}`,
    pathToFileURL(runtimeSource),
  );
}

export async function runPackagingFacts(api: OpenClawPluginApi, recorder: SpikeRecorder) {
  const worker = resolveSpike1WorkerUrl(api.runtimeSource);
  const rootDir = api.rootDir;
  recorder.record(1, "packaging.facts", "info", {
    source: api.source,
    runtimeSource: api.runtimeSource,
    rootDir,
    registrationMode: api.registrationMode,
    workerUrl: worker?.href,
    workerExists: worker ? fs.existsSync(worker) : false,
    manifestExists: rootDir ? fs.existsSync(path.join(rootDir, "openclaw.plugin.json")) : undefined,
    packageJsonExists: rootDir ? fs.existsSync(path.join(rootDir, "package.json")) : undefined,
    execPath: process.execPath,
    node: process.version,
    nodeSqlite: await import("node:sqlite").then(
      () => true,
      () => false,
    ),
    // .app/.pkg bundles have a path under *.app/Contents; record it so the artifact can be matched to the run.
    insideAppBundle: (api.runtimeSource ?? "").includes(".app/Contents"),
  });
}

export async function runSqliteWorkerRoundTrip(api: OpenClawPluginApi, recorder: SpikeRecorder) {
  const worker = resolveSpike1WorkerUrl(api.runtimeSource);
  if (!worker) {
    recorder.record(1, "sqlite.worker", "fail", {
      reason: "no runtimeSource; cannot locate worker module",
    });
    return;
  }
  const databasePath = path.join(resolveSpikeStateDir(), "spike1.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  let store: SqliteWorkerStore<Spike1Operations> | undefined;
  try {
    store = await openSqliteWorkerStore<Spike1Operations>({
      moduleUrl: worker,
      databasePath,
      input: undefined,
    });
    const info = await store.execute({ type: "probe.info", input: undefined });
    recorder.record(1, "sqlite.worker.info", "ok", { databasePath, ...info });
    for (const mode of ["commit", "throw", "async-callback"] as const) {
      const result = await store.execute({ type: "probe.tx", input: { mode } });
      recorder.record(1, "sqlite.sync-transaction", "info", { ...result });
    }
  } catch (error) {
    recorder.record(1, "sqlite.worker", "fail", { databasePath, error: describeError(error) });
  } finally {
    await store?.close().catch((error: unknown) => {
      recorder.record(1, "sqlite.worker.close", "fail", { error: describeError(error) });
    });
  }
}
