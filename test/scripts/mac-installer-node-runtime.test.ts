import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const selector = "scripts/lib/mac-installer-node-runtime.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function selectArch(params: { archives: string[]; processArch: string; translated: "0" | "1" }) {
  const root = tempDirs.make("openclaw-mac-installer-node-");
  const runtimeDir = join(root, "node-runtime");
  mkdirSync(runtimeDir);
  for (const archive of params.archives) {
    writeFileSync(join(runtimeDir, archive), "fixture");
  }
  return spawnSync(
    "/bin/bash",
    [
      "-c",
      'source "$1"; select_bundled_node_arch "$2" "$3" "$4"',
      "node-selector",
      selector,
      runtimeDir,
      params.processArch,
      params.translated,
    ],
    { encoding: "utf8" },
  );
}

describe("macOS installer bundled Node selection", () => {
  it("uses the arm64 archive when Installer runs through Rosetta", () => {
    const result = selectArch({
      archives: ["node-v24.22.1-darwin-arm64.tar.gz"],
      processArch: "x86_64",
      translated: "1",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("arm64\n");
  });

  it("keeps the native process architecture when it is available", () => {
    const result = selectArch({
      archives: ["node-v24.22.1-darwin-arm64.tar.gz", "node-v24.22.1-darwin-x86_64.tar.gz"],
      processArch: "x86_64",
      translated: "0",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("x86_64\n");
  });

  it("fails closed when the required archive is not bundled", () => {
    const result = selectArch({
      archives: ["node-v24.22.1-darwin-arm64.tar.gz"],
      processArch: "x86_64",
      translated: "0",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});
