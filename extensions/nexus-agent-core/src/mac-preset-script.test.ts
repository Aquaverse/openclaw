// Shell-level regression tests for the macOS installer pieces that touch user config. They run the real scripts
// (scripts/mac-nexus-preset.sh, and the default-ai-provider.env generator inside scripts/build-mac-installer.sh) under
// bash with a fake `openclaw` CLI that records every call, so "wrote nothing", "restarted once" and "left the file
// sourceable" are asserted, not assumed. Skipped where the repo-root scripts are absent or bash is not available.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

const scriptsDir =
  process.env.NEXUS_SCRIPTS_DIR ?? path.resolve(import.meta.dirname, "..", "..", "..", "scripts");
const presetScript = path.join(scriptsDir, "mac-nexus-preset.sh");
const buildScript = path.join(scriptsDir, "build-mac-installer.sh");
const runnable =
  process.platform !== "win32" && fs.existsSync(presetScript) && fs.existsSync(buildScript);

const PROVIDER = "plugins.entries.nexus-agent-core";
const SWITCHES = [
  "tasksEnabled",
  "decisionsEnabled",
  "claimsEnabled",
  "preferencesEnabled",
  "watchersEnabled",
];
// Version 3 so a stray marker from another test can never match by accident.
const PRESET_VERSION = "3";

// A stand-in for `openclaw`: config values live in files named after their path, every invocation is logged.
const FAKE_CLI = `#!/bin/bash
S="$FAKE_STATE"
echo "$*" >>"$S/calls.log"
case "$1 $2" in
  "config get") f="$S/cfg/$3"; if [[ -f "$f" ]]; then cat "$f"; else exit 1; fi ;;
  "config set") printf '%s' "$4" >"$S/cfg/$3" ;;
  "plugins enable") printf true >"$S/cfg/plugins.entries.$3.enabled" ;;
  "gateway restart") ;;
esac
exit 0
`;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-preset-test-"));
  temps.push(dir);
  return dir;
}

function nexusTools(): string[] {
  const line = /^NEXUS_TOOLS="([^"]+)"/mu.exec(fs.readFileSync(presetScript, "utf8"));
  assert.ok(line, "NEXUS_TOOLS not found");
  return (line[1] ?? "").split(" ");
}

type Sandbox = {
  state: string;
  prefix: string;
  app: string;
  log: string;
  set: (key: string, value: string) => void;
  get: (key: string) => string | undefined;
  calls: () => string[];
  marker: () => string | undefined;
  run: () => { status: number | null; stderr: string };
};

function sandbox(): Sandbox {
  const root = tmp();
  const state = path.join(root, "state");
  const prefix = path.join(root, "prefix");
  const app = path.join(root, "OpenClaw.app");
  const log = path.join(root, "preset.log");
  fs.mkdirSync(path.join(state, "cfg"), { recursive: true });
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  fs.writeFileSync(path.join(state, "calls.log"), "");
  const cli = path.join(prefix, "bin", "openclaw");
  fs.writeFileSync(cli, FAKE_CLI, { mode: 0o755 });
  fs.writeFileSync(
    path.join(app, "Contents", "Resources", "nexus-preset.env"),
    `NEXUS_PRESET=1\nNEXUS_PRESET_VERSION=${PRESET_VERSION}\nNEXUS_PRESET_SWITCHES=${SWITCHES.join(",")}\n`,
  );
  const cfgFile = (key: string) => path.join(state, "cfg", key);
  return {
    state,
    prefix,
    app,
    log,
    set: (key, value) => fs.writeFileSync(cfgFile(key), value),
    get: (key) => (fs.existsSync(cfgFile(key)) ? fs.readFileSync(cfgFile(key), "utf8") : undefined),
    calls: () =>
      fs
        .readFileSync(path.join(state, "calls.log"), "utf8")
        .split("\n")
        .filter((line) => line !== ""),
    marker: () => {
      const file = path.join(prefix, ".nexus-preset-applied");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    },
    run: () => {
      const result = spawnSync("bash", [presetScript, "--app-path", app, "--prefix", prefix], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: root,
          TMPDIR: root,
          FAKE_STATE: state,
          OPENCLAW_BIN_OVERRIDE: cli,
          NODE_BIN_OVERRIDE: process.execPath,
          OPENCLAW_NEXUS_PRESET_LOG: log,
        },
      });
      return { status: result.status, stderr: result.stderr };
    },
  };
}

function seedFullyConfigured(box: Sandbox, allow: string[]): void {
  box.set(`${PROVIDER}.enabled`, "true");
  for (const key of SWITCHES) {
    box.set(`${PROVIDER}.config.${key}`, "true");
  }
  box.set(`${PROVIDER}.config.fakeProviderMode`, '"ok"');
  box.set("tools.alsoAllow", JSON.stringify(allow));
}

const writes = (calls: string[]) =>
  calls.filter((c) => c.startsWith("config set") || c.startsWith("plugins enable"));
const restarts = (calls: string[]) => calls.filter((c) => c.startsWith("gateway restart"));

describe("scripts/mac-nexus-preset.sh", () => {
  it("first run appends the 22 tools once, keeps what was there, and restarts the gateway exactly once", () => {
    if (!runnable) {
      return;
    }
    const tools = nexusTools();
    assert.equal(tools.length, 22);
    const box = sandbox();
    // One user entry, plus one Nexus tool already present: it must not be added a second time.
    box.set("tools.alsoAllow", JSON.stringify(["web_search", "nexus_task_get"]));
    const result = box.run();
    assert.equal(result.status, 0);

    const allow = JSON.parse(box.get("tools.alsoAllow") ?? "null") as string[];
    assert.equal(allow[0], "web_search");
    assert.equal(allow[1], "nexus_task_get");
    assert.equal(new Set(allow).size, allow.length, "no duplicates");
    assert.deepEqual(allow.filter((t) => t.startsWith("nexus_")).toSorted(), tools.toSorted());
    assert.equal(allow.length, 1 + tools.length);

    assert.equal(box.get(`${PROVIDER}.enabled`), "true");
    for (const key of SWITCHES) {
      assert.equal(box.get(`${PROVIDER}.config.${key}`), "true", key);
    }
    assert.equal(box.get(`${PROVIDER}.config.fakeProviderMode`), '"ok"');
    assert.equal(restarts(box.calls()).length, 1);
    assert.equal(box.marker(), PRESET_VERSION);
  });

  it("when everything is already configured it writes nothing, restarts nothing, and still records the marker", () => {
    if (!runnable) {
      return;
    }
    const box = sandbox();
    seedFullyConfigured(box, ["web_search", ...nexusTools()]);
    const before = box.get("tools.alsoAllow");
    const result = box.run();
    assert.equal(result.status, 0);
    assert.deepEqual(writes(box.calls()), []);
    assert.deepEqual(restarts(box.calls()), []);
    assert.equal(box.get("tools.alsoAllow"), before);
    assert.equal(box.marker(), PRESET_VERSION);
  });

  it("does not overwrite tools.alsoAllow when it holds non-strings, and withholds the marker", () => {
    if (!runnable) {
      return;
    }
    const box = sandbox();
    seedFullyConfigured(box, []);
    const original = JSON.stringify(["web_search", 42, { group: "x" }]);
    box.set("tools.alsoAllow", original);
    const result = box.run();
    assert.equal(result.status, 0);
    assert.equal(box.get("tools.alsoAllow"), original);
    assert.equal(box.calls().filter((c) => c.startsWith("config set tools.alsoAllow")).length, 0);
    assert.equal(box.marker(), undefined);
  });

  it("is a no-op the second time it runs against the same version", () => {
    if (!runnable) {
      return;
    }
    const box = sandbox();
    box.set("tools.alsoAllow", JSON.stringify(["web_search"]));
    box.run();
    const callsAfterFirst = box.calls().length;
    const result = box.run();
    assert.equal(result.status, 0);
    assert.equal(box.calls().length, callsAfterFirst, "marker short-circuits before any CLI call");
  });
});

describe("scripts/build-mac-installer.sh default-ai-provider.env", () => {
  // Pull emit_default_ai_provider_env out of the build script and run it alone, with read_env_var stubbed.
  function generate(defaultModelSwitch: string): {
    env: string;
    stderr: string;
    status: number | null;
  } {
    const source = fs.readFileSync(buildScript, "utf8");
    const fn = /^emit_default_ai_provider_env\(\) \{\n[\s\S]*?\n\}\n/mu.exec(source);
    assert.ok(fn, "emit_default_ai_provider_env not found in build-mac-installer.sh");
    const root = tmp();
    const harness = path.join(root, "harness.sh");
    const out = path.join(root, "default-ai-provider.env");
    fs.writeFileSync(
      harness,
      [
        "set -uo pipefail",
        `DEFAULT_MODEL_SWITCH='${defaultModelSwitch}'`,
        'LLAMA_MODEL_FOR_BUNDLE=""',
        'LITELLM_ENABLED_FOR_BUNDLE=""',
        'read_env_var() { case "$1" in',
        "  OPENCLAW_INSTALLER_DEFAULT_AI_PROVIDER) echo custom ;;",
        "  OPENCLAW_INSTALLER_DEFAULT_AI_BASE_URL) echo https://example.test/v1 ;;",
        "  OPENCLAW_INSTALLER_DEFAULT_AI_MODEL) echo some-model ;;",
        "  OPENCLAW_INSTALLER_DEFAULT_AI_API_KEY) echo test-key ;;",
        "  *) echo '' ;;",
        "esac; }",
        fn[0],
        `emit_default_ai_provider_env > "${out}"`,
      ].join("\n"),
    );
    const result = spawnSync("bash", [harness], { encoding: "utf8" });
    return {
      env: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "",
      stderr: result.stderr,
      status: result.status,
    };
  }

  it("with DEFAULT_MODEL=0 emits only empty assignments and can be sourced with no output", () => {
    if (!runnable) {
      return;
    }
    const { env, status } = generate("0");
    assert.equal(status, 0);
    for (const line of env.split("\n").filter((l) => l !== "")) {
      assert.match(line, /^[A-Z][A-Z0-9_]*=.*$/u, `non-assignment line in env file: ${line}`);
    }
    assert.ok(!env.includes("==>"), "no build-log text in the env file");
    for (const key of ["PROVIDER", "BASE_URL", "MODEL", "API_KEY"]) {
      assert.match(env, new RegExp(`^DEFAULT_AI_${key}=$`, "mu"), key);
    }
    // What mac-pkg-postinstall.sh does: source it with errors visible. Nothing may be executed or printed.
    const root = tmp();
    const file = path.join(root, "default-ai-provider.env");
    fs.writeFileSync(file, env);
    const sourced = spawnSync(
      "bash",
      [
        "-c",
        'set -u; source "$1"; printf "[%s|%s]" "$DEFAULT_AI_PROVIDER" "$DEFAULT_AI_MODEL"',
        "x",
        file,
      ],
      { encoding: "utf8" },
    );
    assert.equal(sourced.status, 0);
    assert.equal(sourced.stderr, "");
    assert.equal(sourced.stdout, "[|]");
  });

  it("with the switch unset it bakes the configured provider values, again as plain assignments", () => {
    if (!runnable) {
      return;
    }
    const { env, status } = generate("");
    assert.equal(status, 0);
    assert.match(env, /^DEFAULT_AI_PROVIDER=custom$/mu);
    assert.match(env, /^DEFAULT_AI_MODEL=some-model$/mu);
    for (const line of env.split("\n").filter((l) => l !== "")) {
      assert.match(line, /^[A-Z][A-Z0-9_]*=.*$/u, line);
    }
  });

  it("keeps the DEFAULT_MODEL=0 notice out of the generator and prints it from the caller", () => {
    if (!runnable) {
      return;
    }
    const source = fs.readFileSync(buildScript, "utf8");
    const fn = /^emit_default_ai_provider_env\(\) \{\n[\s\S]*?\n\}\n/mu.exec(source);
    assert.ok(fn);
    assert.ok(!fn[0].includes("==>"), "the generator must not echo build-log lines");
    assert.match(
      source,
      /echo "==> OPENCLAW_INSTALLER_DEFAULT_MODEL=0 -- no default model baked"/u,
    );
  });
});
