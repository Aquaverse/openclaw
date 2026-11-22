import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const script = path.resolve("scripts/mac-local-ai-setup.sh");

function executable(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "#!/bin/bash\nexit 0\n");
  chmodSync(file, 0o755);
}

describe.skipIf(process.platform === "win32")("mac local AI setup", () => {
  it("does not consume retirement attempts on a clean install", () => {
    const root = tempDirs.make("openclaw-local-ai-clean-install-");
    const home = path.join(root, "home");
    const prefix = path.join(root, "prefix");
    const app = path.join(root, "OpenClaw.app");
    const resources = path.join(app, "Contents", "Resources");
    mkdirSync(resources, { recursive: true });
    writeFileSync(
      path.join(resources, "default-ai-provider.env"),
      [
        "DEFAULT_AI_PROVIDER=",
        "DEFAULT_AI_BASE_URL=",
        "DEFAULT_AI_MODEL=",
        "DEFAULT_LLAMA_MODEL=",
        "DEFAULT_LLAMA_DISABLED=1",
        "DEFAULT_LITELLM_ENABLED=",
        "DEFAULT_LITELLM_DISABLED=1",
      ].join("\n"),
    );
    writeFileSync(path.join(resources, "mac-llama-fallback-setup.sh"), "");
    executable(path.join(prefix, "bin", "openclaw"));
    executable(path.join(prefix, "tools", "node", "bin", "node"));

    const result = spawnSync("/bin/bash", [script, "--app-path", app, "--prefix", prefix], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, OPENCLAW_LOCAL_AI_LOG: path.join(root, "log") },
    });

    expect(result.status).toBe(0);
    expect(existsSync(path.join(prefix, "local-ai", ".retire-llama-service-attempted-v1"))).toBe(
      false,
    );
    expect(existsSync(path.join(prefix, "local-ai", ".retire-litellm-service-attempted-v1"))).toBe(
      false,
    );
  });

  it("attempts disabled historical service retirement once without deleting runtime files", () => {
    const root = tempDirs.make("openclaw-local-ai-retirement-");
    const home = path.join(root, "home");
    const prefix = path.join(root, "prefix");
    const app = path.join(root, "OpenClaw.app");
    const resources = path.join(app, "Contents", "Resources");
    const log = path.join(root, "local-ai.log");
    const model = path.join(prefix, "llama", "models", "keep.gguf");
    const virtualenv = path.join(prefix, "litellm", "venv", "keep");
    mkdirSync(resources, { recursive: true });
    mkdirSync(path.dirname(model), { recursive: true });
    mkdirSync(path.dirname(virtualenv), { recursive: true });
    mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(
      path.join(home, "Library", "LaunchAgents", "ai.openclaw.llama-fallback.plist"),
      "llama-service",
    );
    writeFileSync(
      path.join(home, "Library", "LaunchAgents", "ai.openclaw.litellm-router.plist"),
      "litellm-service",
    );
    writeFileSync(model, "model-bytes");
    writeFileSync(virtualenv, "venv-bytes");
    writeFileSync(
      path.join(resources, "default-ai-provider.env"),
      [
        "DEFAULT_AI_PROVIDER=",
        "DEFAULT_AI_BASE_URL=",
        "DEFAULT_AI_MODEL=",
        "DEFAULT_LLAMA_MODEL=",
        "DEFAULT_LLAMA_DISABLED=1",
        "DEFAULT_LITELLM_ENABLED=",
        "DEFAULT_LITELLM_DISABLED=1",
      ].join("\n"),
    );
    writeFileSync(path.join(resources, "mac-llama-fallback-setup.sh"), "");
    executable(path.join(prefix, "bin", "openclaw"));
    executable(path.join(prefix, "tools", "node", "bin", "node"));

    const run = () =>
      spawnSync("/bin/bash", [script, "--app-path", app, "--prefix", prefix], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, OPENCLAW_LOCAL_AI_LOG: log },
      });
    expect(run().status).toBe(0);
    expect(run().status).toBe(0);

    const output = readFileSync(log, "utf8");
    expect(
      output.match(/Retiring disabled historical service ai\.openclaw\.llama-fallback/gu),
    ).toHaveLength(1);
    expect(
      output.match(/Retiring disabled historical service ai\.openclaw\.litellm-router/gu),
    ).toHaveLength(1);
    expect(readFileSync(model, "utf8")).toBe("model-bytes");
    expect(readFileSync(virtualenv, "utf8")).toBe("venv-bytes");

    writeFileSync(
      path.join(resources, "default-ai-provider.env"),
      [
        "DEFAULT_AI_PROVIDER=",
        "DEFAULT_AI_BASE_URL=",
        "DEFAULT_AI_MODEL=",
        "DEFAULT_LLAMA_MODEL=",
        "DEFAULT_LLAMA_DISABLED=",
        "DEFAULT_LITELLM_ENABLED=",
        "DEFAULT_LITELLM_DISABLED=",
      ].join("\n"),
    );
    expect(run().status).toBe(0);
    expect(existsSync(path.join(prefix, "local-ai", ".retire-llama-service-attempted-v1"))).toBe(
      false,
    );
    expect(existsSync(path.join(prefix, "local-ai", ".retire-litellm-service-attempted-v1"))).toBe(
      false,
    );
  });
});
