import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const verifier = path.resolve("scripts/verify-mac-installer-source.mjs");

function verify(options: {
  expectedCommit: string;
  appCommit?: string;
  appRuntimeBuildId?: string;
  runtimeCommit?: string;
  runtimeBuildId?: string;
}) {
  const root = tempDirs.make("openclaw-mac-installer-source-");
  const buildInfo = path.join(root, "dist", "build-info.json");
  mkdirSync(path.dirname(buildInfo), { recursive: true });
  writeFileSync(
    buildInfo,
    JSON.stringify({
      commit: options.runtimeCommit ?? options.expectedCommit,
      buildId: options.runtimeBuildId ?? "build-current",
    }),
  );
  return spawnSync(
    process.execPath,
    [
      verifier,
      options.expectedCommit,
      options.appCommit ?? options.expectedCommit,
      options.appRuntimeBuildId ?? "build-current",
      buildInfo,
    ],
    { encoding: "utf8" },
  );
}

describe("mac installer source verification", () => {
  const currentCommit = "a".repeat(40);
  const staleCommit = "b".repeat(40);

  it("accepts an app and private runtime from the current source generation", () => {
    const result = verify({ expectedCommit: currentCommit });

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects an app built from an older source generation", () => {
    const result = verify({ expectedCommit: currentCommit, appCommit: staleCommit });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to package a stale OpenClaw.app");
    expect(result.stderr).toContain("pnpm mac:installer");
  });

  it("rejects a private runtime that does not match the app", () => {
    const result = verify({
      expectedCommit: currentCommit,
      runtimeCommit: staleCommit,
      runtimeBuildId: "build-stale",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to package a mismatched OpenClaw.app runtime");
  });
});
