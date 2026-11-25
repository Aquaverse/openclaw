import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("scripts/mac-nexus-profile-migrate.mjs", () => {
  it("copies eligible Nexus state atomically and rewrites profile-owned paths", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-nexus-profile-migrate-"));
    const source = join(root, ".openclaw");
    const target = join(root, ".openclaw-nexus");
    mkdirSync(join(source, "state"), { recursive: true });
    mkdirSync(join(source, "service-env"), { recursive: true });
    mkdirSync(join(source, "bin"), { recursive: true });
    mkdirSync(join(source, "tools", "node-v24.22.1"), { recursive: true });
    mkdirSync(join(source, "tools", "custom-helper"), { recursive: true });
    mkdirSync(join(source, "backups", "pre-upgrade-old"), { recursive: true });
    mkdirSync(join(source, "npm", "cache"), { recursive: true });
    mkdirSync(join(source, "cache"), { recursive: true });
    mkdirSync(join(source, "browser", "openclaw", "user-data"), { recursive: true });
    symlinkSync(join(source, "tools", "node-v24.22.1"), join(source, "tools", "node"));
    symlinkSync(
      "appleMacBookPro-23065",
      join(source, "browser", "openclaw", "user-data", "SingletonLock"),
    );
    symlinkSync(
      "1630168779362291540",
      join(source, "browser", "openclaw", "user-data", "SingletonCookie"),
    );
    symlinkSync(
      "/tmp/com.google.Chrome.fixture/SingletonSocket",
      join(source, "browser", "openclaw", "user-data", "SingletonSocket"),
    );
    writeFileSync(join(source, ".nexus-preset-applied"), "6\n");
    writeFileSync(join(source, ".installer-runtime-applied"), "old-runtime\n");
    writeFileSync(join(source, "bin", "openclaw"), "#!/bin/bash\n");
    writeFileSync(join(source, "service-env", "old.env"), "old\n");
    writeFileSync(join(source, "state", "nexus.sqlite"), "ledger\n");
    writeFileSync(join(source, "tools", "custom-helper", "keep"), "custom\n");
    writeFileSync(join(source, "backups", "pre-upgrade-old", "state.sqlite"), "backup\n");
    writeFileSync(join(source, "npm", "cache", "package.tgz"), "cache\n");
    writeFileSync(join(source, "cache", "derived"), "cache\n");
    writeFileSync(
      join(source, "openclaw.json"),
      JSON.stringify({
        gateway: { mode: "remote", port: 18789, remote: { token: "secret" } },
        agents: {
          defaults: { workspace: `${source}/workspace` },
          entries: {
            main: {
              workspace: `${source}/workspace`,
              agentDir: `${source}/agents/main/agent`,
            },
          },
        },
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        "scripts/mac-nexus-profile-migrate.mjs",
        "--source",
        source,
        "--target",
        target,
        "--profile",
        "nexus",
        "--port",
        "43384",
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "migrated", profile: "nexus" });
    const migrated = JSON.parse(readFileSync(join(target, "openclaw.json"), "utf8"));
    expect(migrated.gateway.port).toBe(43384);
    expect(migrated.gateway.mode).toBe("local");
    expect(migrated.gateway.remote).toBeUndefined();
    expect(migrated.agents.defaults.workspace).toBe(`${target}/workspace`);
    expect(migrated.agents.entries.main.agentDir).toBe(`${target}/agents/main/agent`);
    expect(readFileSync(join(target, "state", "nexus.sqlite"), "utf8")).toBe("ledger\n");
    expect(existsSync(join(target, ".installer-runtime-applied"))).toBe(false);
    expect(existsSync(join(target, "service-env"))).toBe(false);
    expect(existsSync(join(target, "tmp"))).toBe(false);
    expect(existsSync(join(target, "bin", "openclaw"))).toBe(false);
    expect(existsSync(join(target, "tools", "node"))).toBe(false);
    expect(existsSync(join(target, "tools", "node-v24.22.1"))).toBe(false);
    expect(readFileSync(join(target, "tools", "custom-helper", "keep"), "utf8")).toBe("custom\n");
    expect(existsSync(join(target, "backups"))).toBe(false);
    expect(existsSync(join(target, "npm"))).toBe(false);
    expect(existsSync(join(target, "cache"))).toBe(false);
    for (const basename of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      expect(() => lstatSync(join(target, "browser", "openclaw", "user-data", basename))).toThrow(
        /ENOENT/,
      );
    }

    expect(readFileSync(join(source, "openclaw.json"), "utf8")).toContain('"port":18789');
    expect(existsSync(join(source, ".installer-runtime-applied"))).toBe(true);
    expect(existsSync(join(source, "service-env", "old.env"))).toBe(true);
  });

  it("refuses to copy state while its Gateway writer is still alive", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-nexus-profile-active-writer-"));
    const source = join(root, ".openclaw");
    const target = join(root, ".openclaw-nexus");
    const locks = join(source, "tmp", `openclaw-${process.getuid?.() ?? 0}`);
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(source, ".nexus-preset-applied"), "6\n");
    writeFileSync(join(locks, "state.0123456789abcdef.lock"), JSON.stringify({ pid: process.pid }));

    const result = spawnSync(
      process.execPath,
      [
        "scripts/mac-nexus-profile-migrate.mjs",
        "--source",
        source,
        "--target",
        target,
        "--profile",
        "nexus",
        "--port",
        "43384",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Prior Gateway or maintenance owner");
    expect(existsSync(target)).toBe(false);
  });

  it("does not import an unrelated default profile or overwrite a target", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-nexus-profile-skip-"));
    const source = join(root, ".openclaw");
    const target = join(root, ".openclaw-nexus");
    mkdirSync(source, { recursive: true });
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "scripts/mac-nexus-profile-migrate.mjs",
          "--source",
          source,
          "--target",
          target,
          "--profile",
          "nexus",
          "--port",
          "43384",
        ],
        { encoding: "utf8" },
      );

    const unrelated = run();
    expect(unrelated.status, unrelated.stderr).toBe(0);
    expect(JSON.parse(unrelated.stdout).status).toBe("source_ineligible");

    writeFileSync(join(source, ".nexus-preset-applied"), "6\n");
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "target\n");
    const existing = run();
    expect(existing.status, existing.stderr).toBe(0);
    expect(JSON.parse(existing.stdout).status).toBe("target_exists");
    expect(readFileSync(join(target, "keep"), "utf8")).toBe("target\n");
  });

  it("repairs copied Chromium singleton locks in an existing migrated profile", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-nexus-profile-browser-repair-"));
    const source = join(root, ".openclaw");
    const target = join(root, ".openclaw-nexus");
    const userData = join(target, "browser", "openclaw", "user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(target, "keep"), "target\n");
    writeFileSync(
      join(target, ".nexus-profile-migration.json"),
      JSON.stringify({ version: 1, profile: "nexus", source, target }),
    );
    symlinkSync(
      join(source, "browser", "openclaw", "user-data", "appleMacBookPro-23065"),
      join(userData, "SingletonLock"),
    );
    symlinkSync(
      join(source, "browser", "openclaw", "user-data", "1630168779362291540"),
      join(userData, "SingletonCookie"),
    );
    symlinkSync(
      "/tmp/com.google.Chrome.fixture/SingletonSocket",
      join(userData, "SingletonSocket"),
    );

    const result = spawnSync(
      process.execPath,
      [
        "scripts/mac-nexus-profile-migrate.mjs",
        "--source",
        source,
        "--target",
        target,
        "--profile",
        "nexus",
        "--port",
        "43384",
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "target_repaired",
      removedBrowserSingletonArtifacts: 3,
      upgraded: true,
    });
    expect(
      JSON.parse(readFileSync(join(target, ".nexus-profile-migration.json"), "utf8")),
    ).toMatchObject({ version: 2, profile: "nexus", target });
    expect(readFileSync(join(target, "keep"), "utf8")).toBe("target\n");
    for (const basename of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      expect(() => lstatSync(join(userData, basename))).toThrow(/ENOENT/);
    }

    const repeated = spawnSync(
      process.execPath,
      [
        "scripts/mac-nexus-profile-migrate.mjs",
        "--source",
        source,
        "--target",
        target,
        "--profile",
        "nexus",
        "--port",
        "43384",
      ],
      { encoding: "utf8" },
    );
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout).status).toBe("target_exists");
  });
});
