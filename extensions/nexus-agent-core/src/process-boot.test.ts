// Section 9.5.1: the boot id has exactly one source. The SDK helper that reads a process start time may be imported by
// src/process-boot.ts and by nothing else in the plugin; spikes and the decision runtime go through it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { BOOT_ID_UNAVAILABLE, resolveProcessBootId, workerIdFor } from "./process-boot.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist") {
      return [];
    }
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return sources(full);
    }
    return /\.(ts|mts|mjs|js)$/.test(name) ? [full] : [];
  });
}

describe("process boot id", () => {
  it("is built from pid and start time, and is null (never invented) when the start time is unreadable", () => {
    assert.equal(
      resolveProcessBootId(() => 456, 123),
      "123:456",
    );
    assert.equal(
      resolveProcessBootId(() => 0, 123),
      "123:0",
    );
    assert.equal(
      resolveProcessBootId(() => null, 123),
      null,
    );
    assert.equal(
      resolveProcessBootId(() => Number.POSITIVE_INFINITY, 123),
      null,
    );
    assert.equal(
      resolveProcessBootId(() => {
        throw new Error("unreadable");
      }, 123),
      null,
    );
    assert.equal(workerIdFor(null, "x"), `nexus@${BOOT_ID_UNAVAILABLE}#x`);
  });

  it("only src/process-boot.ts references the SDK start-time helper", () => {
    const offenders = sources(pluginRoot)
      .filter((file) => !/[\\/]process-boot(\.test)?\.ts$/.test(file))
      .filter((file) => readFileSync(file, "utf8").includes("getFileLockProcessStartTime"))
      .map((file) => path.relative(pluginRoot, file));
    assert.deepEqual(offenders, []);
  });
});
