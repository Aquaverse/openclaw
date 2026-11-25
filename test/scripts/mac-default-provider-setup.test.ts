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
  it("reports a stale credential marker unless the selected provider binding is usable", () => {
    const root = tempDirs.make("openclaw-default-provider-binding-");
    const cli = path.join(root, "openclaw");
    writeExecutable(
      cli,
      `#!/bin/bash
if [[ "$*" == *"models status --json --agent main"* ]]; then
  if [[ "\${AUTH_STATUS:-1}" == "0" ]]; then
    printf '%s\n' '{"defaultModel":"vllm/gpt-test","resolvedDefault":"vllm/gpt-test","auth":{"modelRouteIssues":[],"oauth":{"providers":[{"provider":"vllm","effectiveProfiles":[{"profileId":"vllm:manual","provider":"vllm","type":"api_key","status":"static"}]}]}}}'
  elif [[ "\${AUTH_STATUS:-1}" == "2" ]]; then
    printf '%s\n' '{"defaultModel":"vllm/gpt-test","resolvedDefault":"vllm/gpt-test","auth":{"modelRouteIssues":[{"kind":"incompatible","provider":"vllm","model":"gpt-test"}],"oauth":{"providers":[{"provider":"vllm","effectiveProfiles":[{"profileId":"vllm:manual","provider":"vllm","type":"api_key","status":"static"}]}]}}}'
  else
    printf '%s\n' '{"defaultModel":"vllm/gpt-test","resolvedDefault":"vllm/gpt-test","auth":{"modelRouteIssues":[{"kind":"missing-auth","provider":"vllm","model":"gpt-test"}],"oauth":{"providers":[{"provider":"vllm","effectiveProfiles":[]}]}}}'
  fi
  exit 0
fi
exit 9
`,
    );
    const run = (authStatus: number) =>
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
        {
          encoding: "utf8",
          env: {
            ...process.env,
            FIXTURE_ROOT: root,
            AUTH_STATUS: String(authStatus),
          },
        },
      );

    const inactive = run(1);
    const incompatible = run(2);
    const active = run(0);

    expect(inactive.status, inactive.stderr).toBe(1);
    expect(incompatible.status, incompatible.stderr).toBe(1);
    expect(active.status, active.stderr).toBe(0);
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

  it("waits for the installed Gateway before publishing a repaired credential", () => {
    const root = tempDirs.make("openclaw-default-provider-gateway-wait-");
    const cli = path.join(root, "openclaw");
    writeFileSync(path.join(root, "key"), "installer-secret");
    writeFileSync(path.join(root, "gateway-attempts"), "0");
    writeExecutable(
      cli,
      `#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$*" == *"onboard --non-interactive"* ]]; then exit 0; fi
if [[ "$*" == *"config get agents.defaults.model.primary --json"* ]]; then
  printf '%s\n' '"vllm/gpt-test"'
  exit 0
fi
if [[ "$*" == *"gateway call status --json"* ]]; then
  attempts="$(cat "$FIXTURE_ROOT/gateway-attempts")"
  attempts="$((attempts + 1))"
  printf '%s' "$attempts" > "$FIXTURE_ROOT/gateway-attempts"
  [[ "$attempts" -ge 3 ]]
  exit $?
fi
if [[ "$*" == *"models auth paste-api-key"* ]]; then
  [[ "$(cat "$FIXTURE_ROOT/gateway-attempts")" -ge 3 ]]
  cat > "$FIXTURE_ROOT/published-key"
  exit 0
fi
exit 9
`,
    );

    const result = runSetup(root, cli, ["--install-daemon"]);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(root, "gateway-attempts"), "utf8")).toBe("3");
    expect(readFileSync(path.join(root, "published-key"), "utf8")).toBe("installer-secret");
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
