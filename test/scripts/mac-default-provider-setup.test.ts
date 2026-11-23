import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const setupScript = path.resolve("scripts/mac-default-provider-setup.sh");

function writeExecutable(file: string, source: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function runSetup(root: string, cli: string, extraArgs: string[] = []) {
  return spawnSync(
    "/bin/bash",
    [
      setupScript,
      "--openclaw-bin",
      cli,
      "--provider-id",
      "vllm",
      "--base-url",
      "https://models.example.invalid/v1",
      "--model-id",
      "gpt-test",
      "--api-key-file",
      path.join(root, "key"),
      "--skip-daemon",
      ...extraArgs,
    ],
    { encoding: "utf8", env: { ...process.env, FIXTURE_ROOT: root } },
  );
}

describe.skipIf(process.platform === "win32")("mac default-provider setup", () => {
  it("reports a stale credential marker when the selected provider has no auth binding", () => {
    const root = tempDirs.make("openclaw-default-provider-binding-");
    const cli = path.join(root, "openclaw");
    writeExecutable(
      cli,
      `#!/bin/bash
printf '%s\n' "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$*" == *"config get agents.defaults.model.primary --json"* ]]; then
  printf '%s\n' '"vllm/gpt-test"'
  exit 0
fi
if [[ "$*" == *"config get models.providers.vllm.apiKey --json"* ]]; then
  printf '%s\n' "\${BINDING:-null}"
  exit 0
fi
exit 9
`,
    );
    const run = (binding: string) =>
      spawnSync(
        "/bin/bash",
        [
          setupScript,
          "--openclaw-bin",
          cli,
          "--profile",
          "installer-proof",
          "--check-auth-binding",
        ],
        { encoding: "utf8", env: { ...process.env, FIXTURE_ROOT: root, BINDING: binding } },
      );

    const missing = run("null");
    const present = run('"vllm:manual"');

    expect(missing.status, missing.stderr).toBe(1);
    expect(present.status, present.stderr).toBe(0);
    const calls = readFileSync(path.join(root, "calls"), "utf8").trim().split("\n");
    expect(calls).toEqual([
      "--profile installer-proof config get agents.defaults.model.primary --json",
      "--profile installer-proof config get models.providers.vllm.apiKey --json",
      "--profile installer-proof config get agents.defaults.model.primary --json",
      "--profile installer-proof config get models.providers.vllm.apiKey --json",
    ]);
  });

  it("overwrites one active profile from installer config across repeated installs", () => {
    const root = tempDirs.make("openclaw-default-provider-");
    const cli = path.join(root, "openclaw");
    writeFileSync(path.join(root, "key"), "installer-secret");
    writeExecutable(
      cli,
      `#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$*" == *"onboard --non-interactive"* ]]; then
  [[ "$*" == *"--auth-choice custom-api-key"* ]]
  [[ "$*" != *"--custom-api-key"* ]]
  [[ -z "\${CUSTOM_API_KEY:-}" ]]
  printf '%s' "vllm/gpt-test" > "$FIXTURE_ROOT/default-model"
  exit 0
fi
if [[ "$*" == *"config get agents.defaults.model.primary --json"* ]]; then
  printf '%s\n' '"vllm/gpt-test"'
  exit 0
fi
if [[ "$*" == *"models auth paste-api-key"* ]]; then
  key="$(cat)"
  [[ "$*" == *"--provider vllm --agent main"* ]]
  [[ "$*" != *"--profile-id"* ]]
  printf '%s' "$key" > "$FIXTURE_ROOT/profile-vllm-manual"
  exit 0
fi
exit 9
`,
    );

    const first = runSetup(root, cli, ["--profile", "installer-proof"]);
    writeFileSync(path.join(root, "key"), "replacement-installer-secret");
    const second = runSetup(root, cli, ["--profile", "installer-proof"]);

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(path.join(root, "default-model"), "utf8")).toBe("vllm/gpt-test");
    expect(readFileSync(path.join(root, "profile-vllm-manual"), "utf8")).toBe(
      "replacement-installer-secret",
    );
    expect(readdirSync(root).filter((name) => name.startsWith("profile-vllm"))).toEqual([
      "profile-vllm-manual",
    ]);
    const calls = readFileSync(path.join(root, "calls"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(6);
    expect(calls.filter((call) => call.includes("onboard --non-interactive"))).toHaveLength(2);
    expect(
      calls.filter((call) => call.includes("config get agents.defaults.model.primary --json")),
    ).toHaveLength(2);
    expect(calls.filter((call) => call.includes("models auth paste-api-key"))).toHaveLength(2);
    expect(calls.filter((call) => call.includes("models auth order set"))).toHaveLength(0);
    expect(calls.every((call) => call.startsWith("--profile installer-proof "))).toBe(true);
    expect(calls.join("\n")).not.toContain("installer-secret");
    expect(calls.join("\n")).not.toContain("replacement-installer-secret");
    expect(calls.join("\n")).not.toContain("setup-");
  });

  it("stops when the live auth owner cannot save the credential", () => {
    const root = tempDirs.make("openclaw-default-provider-failure-");
    const cli = path.join(root, "openclaw");
    writeFileSync(path.join(root, "key"), "installer-secret");
    writeExecutable(
      cli,
      `#!/bin/bash
printf '%s\n' "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$*" == *"onboard --non-interactive"* ]]; then exit 0; fi
if [[ "$*" == *"config get agents.defaults.model.primary --json"* ]]; then
  printf '%s\n' '"vllm/gpt-test"'
  exit 0
fi
if [[ "$*" == *"models auth paste-api-key"* ]]; then exit 17; fi
touch "$FIXTURE_ROOT/unexpected-command"
`,
    );

    const result = runSetup(root, cli);

    expect(result.status).toBe(17);
    expect(readFileSync(path.join(root, "calls"), "utf8")).toContain("models auth paste-api-key");
    expect(() => readFileSync(path.join(root, "unexpected-command"), "utf8")).toThrow();
  });

  it("stores the credential under the provider resolved from provider id and base URL", () => {
    const root = tempDirs.make("openclaw-default-provider-resolved-");
    const cli = path.join(root, "openclaw");
    writeFileSync(path.join(root, "key"), "installer-secret");
    writeExecutable(
      cli,
      `#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$*" == *"onboard --non-interactive"* ]]; then exit 0; fi
if [[ "$*" == *"config get agents.defaults.model.primary --json"* ]]; then
  printf '%s\n' '"vllm-2/gpt-test"'
  exit 0
fi
if [[ "$*" == *"models auth paste-api-key"* ]]; then
  [[ "$*" == *"--provider vllm-2 --agent main"* ]]
  [[ "$*" != *"--profile-id"* ]]
  cat > "$FIXTURE_ROOT/profile-vllm-2-manual"
  exit 0
fi
exit 9
`,
    );

    const result = runSetup(root, cli);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(root, "profile-vllm-2-manual"), "utf8")).toBe("installer-secret");
  });

  it("rejects a key without a provider id before invoking the CLI", () => {
    const root = tempDirs.make("openclaw-default-provider-invalid-");
    const cli = path.join(root, "openclaw");
    writeFileSync(path.join(root, "key"), "installer-secret");
    writeExecutable(cli, `#!/bin/bash\ntouch "$FIXTURE_ROOT/invoked"\n`);

    const result = spawnSync(
      "/bin/bash",
      [
        setupScript,
        "--openclaw-bin",
        cli,
        "--base-url",
        "https://models.example.invalid/v1",
        "--model-id",
        "gpt-test",
        "--api-key-file",
        path.join(root, "key"),
        "--skip-daemon",
      ],
      { encoding: "utf8", env: { ...process.env, FIXTURE_ROOT: root } },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--provider-id is required");
    expect(() => readFileSync(path.join(root, "invoked"), "utf8")).toThrow();
  });
});
