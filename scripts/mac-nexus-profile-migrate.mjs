#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const STATE_DATABASE_PATH_COLUMNS = new Map([
  ["config_health_entries", ["config_path", "last_known_good_json", "last_promoted_good_json"]],
  ["config_machine_state", ["state_key", "value_json"]],
  ["cron_jobs", ["store_key", "job_json", "state_json"]],
  ["cron_run_receipts", ["store_key", "authority_json"]],
  ["plugin_state_entries", ["value_json"]],
  ["session_watch_cursors", ["watcher_store_path", "upstream_ref_json", "last_marker_json"]],
  ["skill_usage", ["skill_file"]],
  ["subagent_runs", ["controller_store_path", "requester_store_path", "payload_json"]],
  ["user_preferences", ["value_json"]],
  ["workspace_path_aliases", ["alias_path", "workspace_path"]],
  ["workspace_setup_state", ["workspace_path"]],
]);

const AGENT_DATABASE_PATH_COLUMNS = new Map([
  ["session_entry_snapshots", ["value_json"]],
  ["session_nodes", ["entry_json", "legacy_acp_migration_json"]],
]);

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${JSON.stringify(flag)}`);
    }
    values.set(flag.slice(2), value);
  }
  const source = values.get("source");
  const target = values.get("target");
  const profile = values.get("profile");
  const port = Number(values.get("port"));
  const sourcePolicy = values.get("source-policy") ?? "preset";
  if (!source || !target || !profile || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Usage: --source <dir> --target <dir> --profile <name> --port <port>");
  }
  if (sourcePolicy !== "preset" && sourcePolicy !== "explicit") {
    throw new Error("--source-policy must be preset or explicit");
  }
  return {
    source: path.resolve(source),
    target: path.resolve(target),
    profile,
    port,
    sourcePolicy,
  };
}

function rewriteOwnedPaths(value, source, target) {
  if (typeof value === "string") {
    return value === source || value.startsWith(`${source}${path.sep}`)
      ? `${target}${value.slice(source.length)}`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteOwnedPaths(item, source, target));
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      value[key] = rewriteOwnedPaths(item, source, target);
    }
  }
  return value;
}

function copyFilter(sourceRoot) {
  // The source profile remains intact after migration. Do not duplicate
  // installer-owned runtimes, recovery copies, or rebuildable caches into the
  // new profile; the pkg installs its own current runtime after this copy.
  const ignoredRoots = new Set(["backups", "cache", "npm", "plugin-skills", "service-env", "tmp"]);
  return (candidate) => {
    const relative = path.relative(sourceRoot, candidate);
    if (relative) {
      const parts = relative.split(path.sep);
      if (ignoredRoots.has(parts[0]) || parts.includes(".tmp") || parts.includes("tmp")) {
        return false;
      }
      if (
        relative === ".installer-runtime-applied" ||
        relative === ".bundled-cli-package.sha256" ||
        relative === ".nexus-profile-migration.json" ||
        relative === path.join("bin", "openclaw")
      ) {
        return false;
      }
      if (parts[0] === "tools" && (parts[1] === "node" || /^node-v\d/.test(parts[1] ?? ""))) {
        return false;
      }
    }
    const stat = fs.lstatSync(candidate);
    return !stat.isSocket();
  };
}

function removePathIfPresent(candidate) {
  try {
    fs.lstatSync(candidate);
  } catch {
    return false;
  }
  fs.rmSync(candidate, { recursive: true, force: true });
  return true;
}

function removeInstallerOwnedArtifacts(stateRoot) {
  let removed = false;
  for (const relative of [
    ".installer-runtime-applied",
    ".bundled-cli-package.sha256",
    path.join("bin", "openclaw"),
    "npm",
    "plugin-skills",
    "service-env",
  ]) {
    removed = removePathIfPresent(path.join(stateRoot, relative)) || removed;
  }
  const toolsRoot = path.join(stateRoot, "tools");
  if (fs.existsSync(toolsRoot)) {
    for (const entry of fs.readdirSync(toolsRoot, { withFileTypes: true })) {
      if (entry.name === "node" || /^node-v\d/.test(entry.name)) {
        removed = removePathIfPresent(path.join(toolsRoot, entry.name)) || removed;
      }
    }
  }
  return removed;
}

function removeLegacyCaches(stateRoot) {
  // Shell snapshots capture the source profile's PATH byte-for-byte. Keeping
  // them after a product-state move can send later commands back through the
  // retired OpenClaw runtime even when config and symlinks are already fixed.
  return removePathIfPresent(path.join(stateRoot, "cache", "shell-snapshots"));
}

function rewriteOwnedAbsoluteSymlinks(stateRoot, sourceRoot, targetRoot) {
  if (!fs.existsSync(stateRoot)) {
    return 0;
  }
  let rewritten = 0;
  const pending = [stateRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(candidate);
        if (
          path.isAbsolute(linkTarget) &&
          (linkTarget === sourceRoot || linkTarget.startsWith(`${sourceRoot}${path.sep}`))
        ) {
          const rewrittenTarget = `${targetRoot}${linkTarget.slice(sourceRoot.length)}`;
          fs.unlinkSync(candidate);
          fs.symlinkSync(rewrittenTarget, candidate);
          rewritten += 1;
        }
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(candidate);
      }
    }
  }
  return rewritten;
}

async function openSqliteDatabase(databasePath) {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    const database = new Database(databasePath);
    return {
      close: () => database.close(),
      exec: (sql) => database.exec(sql),
      all: (sql) => database.query(sql).all(),
      run: (sql) => database.query(sql).run(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath);
  return {
    close: () => database.close(),
    exec: (sql) => database.exec(sql),
    all: (sql) => database.prepare(sql).all(),
    run: (sql) => database.prepare(sql).run(),
  };
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function rewriteDatabasePathColumns(databasePath, columnsByTable, sourceRoot, targetRoot) {
  if (!fs.existsSync(databasePath)) {
    return 0;
  }
  const database = await openSqliteDatabase(databasePath);
  let rewritten = 0;
  try {
    const tables = new Set(
      database
        .all("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((row) => String(row.name)),
    );
    database.exec("BEGIN IMMEDIATE");
    for (const [table, candidateColumns] of columnsByTable) {
      if (!tables.has(table)) {
        continue;
      }
      const columns = new Set(
        database.all(`PRAGMA table_info(${sqlIdentifier(table)})`).map((row) => String(row.name)),
      );
      for (const column of candidateColumns) {
        if (!columns.has(column)) {
          continue;
        }
        const result = database.run(
          `UPDATE ${sqlIdentifier(table)} SET ${sqlIdentifier(column)} = replace(${sqlIdentifier(column)}, ${sqlString(sourceRoot)}, ${sqlString(targetRoot)}) WHERE instr(${sqlIdentifier(column)}, ${sqlString(sourceRoot)}) > 0`,
        );
        rewritten += Number(result.changes ?? 0);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original SQLite failure.
    }
    throw error;
  } finally {
    database.close();
  }
  return rewritten;
}

function findAgentDatabases(stateRoot) {
  const agentsRoot = path.join(stateRoot, "agents");
  if (!fs.existsSync(agentsRoot)) {
    return [];
  }
  const databases = [];
  const pending = [agentsRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && entry.name === "openclaw-agent.sqlite") {
        databases.push(candidate);
      }
    }
  }
  return databases;
}

async function rewriteOwnedDatabasePaths(stateRoot, sourceRoot, targetRoot) {
  let rewritten = await rewriteDatabasePathColumns(
    path.join(stateRoot, "state", "openclaw.sqlite"),
    STATE_DATABASE_PATH_COLUMNS,
    sourceRoot,
    targetRoot,
  );
  for (const databasePath of findAgentDatabases(stateRoot)) {
    rewritten += await rewriteDatabasePathColumns(
      databasePath,
      AGENT_DATABASE_PATH_COLUMNS,
      sourceRoot,
      targetRoot,
    );
  }
  return rewritten;
}

function rewriteTargetConfig(options, ownedRoot) {
  const configPath = path.join(options.target, "openclaw.json");
  if (!fs.existsSync(configPath)) {
    return false;
  }
  const before = fs.readFileSync(configPath, "utf8");
  const config = rewriteOwnedPaths(JSON.parse(before), ownedRoot, options.target);
  normalizeGatewayConfig(config, options);
  const after = `${JSON.stringify(config, null, 2)}\n`;
  if (after === before) {
    return false;
  }
  fs.writeFileSync(configPath, after, { mode: 0o600 });
  return true;
}

function normalizeGatewayConfig(config, options) {
  if (options.sourcePolicy === "explicit" && config.gateway?.mode === "remote") {
    return;
  }
  config.gateway ??= {};
  config.gateway.mode = "local";
  config.gateway.port = options.port;
  delete config.gateway.remote;
}

function print(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function removeCopiedBrowserSingletonArtifacts(stateRoot) {
  const browserRoot = path.join(stateRoot, "browser");
  if (!fs.existsSync(browserRoot)) {
    return 0;
  }
  let removed = 0;
  for (const profile of fs.readdirSync(browserRoot, { withFileTypes: true })) {
    if (!profile.isDirectory()) {
      continue;
    }
    const userDataDir = path.join(browserRoot, profile.name, "user-data");
    const lockPath = path.join(userDataDir, "SingletonLock");
    let lockTarget;
    try {
      lockTarget = fs.readlinkSync(lockPath);
    } catch {
      continue;
    }
    if (!path.isAbsolute(lockTarget)) {
      continue;
    }
    const relativeTarget = path.relative(userDataDir, lockTarget);
    if (relativeTarget && !relativeTarget.startsWith(`..${path.sep}`) && relativeTarget !== "..") {
      continue;
    }
    for (const basename of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      const artifactPath = path.join(userDataDir, basename);
      try {
        fs.lstatSync(artifactPath);
        fs.rmSync(artifactPath, { force: true });
        removed += 1;
      } catch {
        // A copied browser profile remains usable without these ephemeral locks.
      }
    }
  }
  return removed;
}

async function repairMigratedTarget(options) {
  const receiptPath = path.join(options.target, ".nexus-profile-migration.json");
  if (!fs.existsSync(receiptPath)) {
    return false;
  }
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  } catch {
    return false;
  }
  const receiptTarget = path.resolve(receipt?.target ?? "");
  const ownsCurrentTarget = receiptTarget === options.target;
  const continuesExplicitMigration =
    options.sourcePolicy === "explicit" && receiptTarget === options.source;
  if (receipt?.profile !== options.profile || (!ownsCurrentTarget && !continuesExplicitMigration)) {
    return false;
  }
  const removedBrowserSingletonArtifacts = removeCopiedBrowserSingletonArtifacts(options.target);
  const removedInstallerArtifacts = continuesExplicitMigration
    ? removeInstallerOwnedArtifacts(options.target)
    : false;
  const removedLegacyCaches = continuesExplicitMigration
    ? removeLegacyCaches(options.target)
    : false;
  const legacyRoots =
    options.sourcePolicy === "explicit"
      ? [...new Set([receiptTarget, path.resolve(receipt?.source ?? "")])].filter(
          (candidate) => candidate !== options.target && candidate !== path.parse(candidate).root,
        )
      : [];
  let rewrittenOwnedSymlinks = 0;
  let rewrittenConfig = false;
  let rewrittenDatabaseValues = 0;
  for (const legacyRoot of legacyRoots) {
    rewrittenOwnedSymlinks += rewriteOwnedAbsoluteSymlinks(
      options.target,
      legacyRoot,
      options.target,
    );
    rewrittenConfig = rewriteTargetConfig(options, legacyRoot) || rewrittenConfig;
    rewrittenDatabaseValues += await rewriteOwnedDatabasePaths(
      options.target,
      legacyRoot,
      options.target,
    );
  }
  const targetVersion = options.sourcePolicy === "explicit" ? 4 : 2;
  const upgraded = receipt.version !== targetVersion || continuesExplicitMigration;
  if (upgraded) {
    receipt.version = targetVersion;
    if (options.sourcePolicy === "explicit") {
      receipt.source = options.source;
      receipt.target = options.target;
    }
    receipt.repairedAt = new Date().toISOString();
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  }
  return {
    removedBrowserSingletonArtifacts,
    removedInstallerArtifacts,
    removedLegacyCaches,
    rewrittenOwnedSymlinks,
    rewrittenConfig,
    rewrittenDatabaseValues,
    upgraded,
  };
}

function assertNoGatewayStateOwner(source) {
  const lockRoot = path.join(source, "tmp");
  if (!fs.existsSync(lockRoot)) {
    return;
  }
  const pending = [lockRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (entry.name !== "gateway.state.lock" && !/^state\.[a-f0-9]+\.lock$/.test(entry.name)) {
        continue;
      }
      throw new Error(`Prior Gateway or maintenance owner has not released state: ${candidate}`);
    }
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.source === options.target) {
  throw new Error("Source and target must be different directories");
}
if (fs.existsSync(options.target)) {
  const repair = await repairMigratedTarget(options);
  const changed =
    repair &&
    (repair.removedBrowserSingletonArtifacts > 0 ||
      repair.removedInstallerArtifacts ||
      repair.removedLegacyCaches ||
      repair.rewrittenOwnedSymlinks > 0 ||
      repair.rewrittenConfig ||
      repair.rewrittenDatabaseValues > 0 ||
      repair.upgraded);
  print(changed ? { status: "target_repaired", ...repair } : { status: "target_exists" });
  process.exit(0);
}
if (
  options.sourcePolicy !== "explicit" &&
  !fs.existsSync(path.join(options.source, ".nexus-preset-applied"))
) {
  print({ status: "source_ineligible" });
  process.exit(0);
}
assertNoGatewayStateOwner(options.source);

const parent = path.dirname(options.target);
fs.mkdirSync(parent, { recursive: true });
const staging = path.join(
  parent,
  `.${path.basename(options.target)}.migrating-${process.pid}-${Date.now()}`,
);

try {
  fs.cpSync(options.source, staging, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    filter: copyFilter(options.source),
  });

  for (const relative of [
    ".installer-runtime-applied",
    ".bundled-cli-package.sha256",
    "bin/openclaw",
    "tools/node",
  ]) {
    fs.rmSync(path.join(staging, relative), { recursive: true, force: true });
  }
  removeCopiedBrowserSingletonArtifacts(staging);
  rewriteOwnedAbsoluteSymlinks(staging, options.source, options.target);
  await rewriteOwnedDatabasePaths(staging, options.source, options.target);

  const configPath = path.join(staging, "openclaw.json");
  if (fs.existsSync(configPath)) {
    const config = rewriteOwnedPaths(
      JSON.parse(fs.readFileSync(configPath, "utf8")),
      options.source,
      options.target,
    );
    normalizeGatewayConfig(config, options);
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }

  fs.writeFileSync(
    path.join(staging, ".nexus-profile-migration.json"),
    `${JSON.stringify(
      {
        version: options.sourcePolicy === "explicit" ? 4 : 2,
        profile: options.profile,
        source: options.source,
        target: options.target,
        migratedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(staging, options.target);
  print({ status: "migrated", profile: options.profile });
} catch (error) {
  fs.rmSync(staging, { recursive: true, force: true });
  throw error;
}
