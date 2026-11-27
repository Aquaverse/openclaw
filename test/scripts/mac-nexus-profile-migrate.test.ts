import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  it("explicitly migrates product state without copying installer-owned runtime files", () => {
    const root = mkdtempSync(join(tmpdir(), "askpepio-explicit-profile-migrate-"));
    const source = join(root, ".openclaw-nexus");
    const target = join(root, ".askpepio");
    mkdirSync(join(source, "agents", "main", "agent", "codex-home", ".tmp", "plugins"), {
      recursive: true,
    });
    mkdirSync(join(source, "bin"), { recursive: true });
    mkdirSync(join(source, "service-env"), { recursive: true });
    mkdirSync(join(source, "tools", "node-v24.22.1", "bin"), { recursive: true });
    mkdirSync(join(source, "tools", "custom-helper"), { recursive: true });
    mkdirSync(join(source, "workspace"), { recursive: true });
    symlinkSync(join(source, "tools", "node-v24.22.1"), join(source, "tools", "node"));
    writeFileSync(
      join(source, "agents", "main", "agent", "codex-home", ".tmp", "plugins", "ignored"),
      "ephemeral\n",
    );
    writeFileSync(
      join(source, "bin", "openclaw"),
      `#!/bin/sh\nexec ${source}/tools/node/bin/node ${source}/runtime/entry.js\n`,
    );
    writeFileSync(join(source, "service-env", "ai.openclaw.nexus.env"), source);
    writeFileSync(join(source, "tools", "node-v24.22.1", "bin", "node"), "runtime\n");
    writeFileSync(join(source, "tools", "custom-helper", "keep"), "custom\n");
    writeFileSync(join(source, "workspace", "data"), "user data\n");
    symlinkSync(join(source, "workspace", "data"), join(source, "workspace", "data-link"));
    symlinkSync("/tmp/external-data", join(source, "workspace", "external-link"));
    writeFileSync(
      join(source, "openclaw.json"),
      JSON.stringify({
        gateway: { mode: "remote", port: 18789, remote: { url: "wss://gateway.example" } },
        agents: {
          defaults: { workspace: `${source}/workspace` },
          entries: { main: { agentDir: `${source}/agents/main/agent` } },
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
        "--source-policy",
        "explicit",
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "migrated", profile: "nexus" });
    const migrated = JSON.parse(readFileSync(join(target, "openclaw.json"), "utf8"));
    expect(migrated.agents.defaults.workspace).toBe(`${target}/workspace`);
    expect(migrated.agents.entries.main.agentDir).toBe(`${target}/agents/main/agent`);
    expect(migrated.gateway).toEqual({
      mode: "remote",
      port: 18789,
      remote: { url: "wss://gateway.example" },
    });
    expect(existsSync(join(target, "bin", "openclaw"))).toBe(false);
    expect(existsSync(join(target, "service-env"))).toBe(false);
    expect(existsSync(join(target, "tools", "node"))).toBe(false);
    expect(existsSync(join(target, "tools", "node-v24.22.1"))).toBe(false);
    expect(existsSync(join(target, "agents", "main", "agent", "codex-home", ".tmp"))).toBe(false);
    expect(readFileSync(join(target, "tools", "custom-helper", "keep"), "utf8")).toBe("custom\n");
    expect(readlinkSync(join(target, "workspace", "data-link"))).toBe(
      join(target, "workspace", "data"),
    );
    expect(readlinkSync(join(target, "workspace", "external-link"))).toBe("/tmp/external-data");
  });

  it("repairs a chained product migration after installer-owned runtime files were copied", () => {
    const root = mkdtempSync(join(tmpdir(), "askpepio-profile-repair-"));
    const original = join(root, ".openclaw");
    const source = join(root, ".openclaw-nexus");
    const target = join(root, ".askpepio");
    mkdirSync(join(target, "bin"), { recursive: true });
    mkdirSync(join(target, "service-env"), { recursive: true });
    mkdirSync(join(target, "tools", "node-v24.22.1", "bin"), { recursive: true });
    mkdirSync(join(target, "cache", "shell-snapshots"), { recursive: true });
    mkdirSync(join(target, "workspace"), { recursive: true });
    symlinkSync(source + "/tools/node-v24.22.1", join(target, "tools", "node"));
    writeFileSync(join(target, "bin", "openclaw"), `exec ${source}/tools/node/bin/node\n`);
    writeFileSync(join(target, "service-env", "ai.openclaw.nexus.env"), source);
    writeFileSync(join(target, "tools", "node-v24.22.1", "bin", "node"), "runtime\n");
    writeFileSync(
      join(target, "cache", "shell-snapshots", "legacy.sh"),
      `export PATH=${original}/bin:${source}/tools/node/bin\n`,
    );
    symlinkSync(join(source, "workspace", "data"), join(target, "workspace", "data-link"));
    writeFileSync(
      join(target, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { workspace: `${source}/workspace` } } }),
    );
    writeFileSync(
      join(target, ".nexus-profile-migration.json"),
      JSON.stringify({ version: 2, profile: "nexus", source: original, target: source }),
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
        "--source-policy",
        "explicit",
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "target_repaired",
      removedInstallerArtifacts: true,
      removedLegacyCaches: true,
      rewrittenConfig: true,
      rewrittenOwnedSymlinks: 1,
    });
    expect(
      JSON.parse(readFileSync(join(target, "openclaw.json"), "utf8")).agents.defaults.workspace,
    ).toBe(`${target}/workspace`);
    expect(existsSync(join(target, "bin", "openclaw"))).toBe(false);
    expect(existsSync(join(target, "service-env"))).toBe(false);
    expect(existsSync(join(target, "tools", "node"))).toBe(false);
    expect(existsSync(join(target, "tools", "node-v24.22.1"))).toBe(false);
    expect(existsSync(join(target, "cache", "shell-snapshots"))).toBe(false);
    expect(readlinkSync(join(target, "workspace", "data-link"))).toBe(
      join(target, "workspace", "data"),
    );
    expect(
      JSON.parse(readFileSync(join(target, ".nexus-profile-migration.json"), "utf8")),
    ).toMatchObject({ version: 4, profile: "nexus", source, target });

    mkdirSync(join(target, "tools", "node-v24.22.2", "bin"), { recursive: true });
    writeFileSync(join(target, "tools", "node-v24.22.2", "bin", "node"), "new runtime\n");
    symlinkSync(join(target, "tools", "node-v24.22.2"), join(target, "tools", "node"));
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
        "--source-policy",
        "explicit",
      ],
      { encoding: "utf8" },
    );
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout).status).toBe("target_exists");
    expect(readFileSync(join(target, "tools", "node-v24.22.2", "bin", "node"), "utf8")).toBe(
      "new runtime\n",
    );
  });

  it("repairs active SQLite paths without rewriting transcript history", () => {
    const root = mkdtempSync(join(tmpdir(), "askpepio-sqlite-path-repair-"));
    const source = join(root, ".openclaw-nexus");
    const target = join(root, ".askpepio");
    const stateDatabasePath = join(target, "state", "openclaw.sqlite");
    const agentDatabasePath = join(target, "agents", "main", "agent", "openclaw-agent.sqlite");
    mkdirSync(join(target, "state"), { recursive: true });
    mkdirSync(join(target, "agents", "main", "agent"), { recursive: true });
    writeFileSync(
      join(target, ".nexus-profile-migration.json"),
      JSON.stringify({ version: 3, profile: "nexus", source, target }),
    );

    using stateDatabase = new DatabaseSync(stateDatabasePath);
    stateDatabase.exec(`
      CREATE TABLE config_machine_state (
        state_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE plugin_state_entries (
        plugin_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (plugin_id, namespace, entry_key)
      );
      CREATE TABLE diagnostic_events (
        event_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      );
    `);
    stateDatabase
      .prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)")
      .run("plugins.installedIndex", JSON.stringify({ installPath: `${source}/npm/slack` }));
    stateDatabase
      .prepare("INSERT INTO plugin_state_entries VALUES (?, ?, ?, ?, 1, NULL)")
      .run(
        "memory-core",
        "short-term-recall",
        "fixture",
        JSON.stringify({ path: `${source}/workspace/memory.md` }),
      );
    stateDatabase
      .prepare("INSERT INTO diagnostic_events VALUES (?, ?)")
      .run("history", JSON.stringify({ observedPath: `${source}/legacy.log` }));

    using agentDatabase = new DatabaseSync(agentDatabasePath);
    agentDatabase.exec(`
      CREATE TABLE session_nodes (
        session_key TEXT PRIMARY KEY,
        entry_json TEXT NOT NULL
      );
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `);
    agentDatabase
      .prepare("INSERT INTO session_nodes VALUES (?, ?)")
      .run("main", JSON.stringify({ workspaceDir: `${source}/workspace` }));
    agentDatabase
      .prepare("INSERT INTO transcript_events VALUES (?, ?, ?)")
      .run("session", 1, JSON.stringify({ historicalPath: `${source}/workspace` }));

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
        "--source-policy",
        "explicit",
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "target_repaired",
      rewrittenDatabaseValues: 3,
    });
    expect(
      stateDatabase
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get("plugins.installedIndex"),
    ).toEqual({ value_json: JSON.stringify({ installPath: `${target}/npm/slack` }) });
    expect(
      stateDatabase
        .prepare("SELECT value_json FROM plugin_state_entries WHERE entry_key = ?")
        .get("fixture"),
    ).toEqual({ value_json: JSON.stringify({ path: `${target}/workspace/memory.md` }) });
    expect(
      agentDatabase
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get("main"),
    ).toEqual({ entry_json: JSON.stringify({ workspaceDir: `${target}/workspace` }) });
    expect(
      stateDatabase
        .prepare("SELECT payload_json FROM diagnostic_events WHERE event_id = ?")
        .get("history"),
    ).toEqual({ payload_json: JSON.stringify({ observedPath: `${source}/legacy.log` }) });
    expect(
      agentDatabase
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = ?")
        .get("session", 1),
    ).toEqual({ event_json: JSON.stringify({ historicalPath: `${source}/workspace` }) });
  });
});
