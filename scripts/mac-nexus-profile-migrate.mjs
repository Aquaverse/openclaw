#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

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
  if (!source || !target || !profile || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Usage: --source <dir> --target <dir> --profile <name> --port <port>");
  }
  return {
    source: path.resolve(source),
    target: path.resolve(target),
    profile,
    port,
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
  const ignoredRoots = new Set(["backups", "cache", "npm", "service-env", "tmp"]);
  return (candidate) => {
    const relative = path.relative(sourceRoot, candidate);
    if (relative) {
      const parts = relative.split(path.sep);
      if (ignoredRoots.has(parts[0])) {
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

function repairMigratedTarget(options) {
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
  if (
    receipt?.profile !== options.profile ||
    path.resolve(receipt?.target ?? "") !== options.target
  ) {
    return false;
  }
  const removedBrowserSingletonArtifacts = removeCopiedBrowserSingletonArtifacts(options.target);
  const upgraded = receipt.version !== 2;
  if (upgraded) {
    receipt.version = 2;
    receipt.repairedAt = new Date().toISOString();
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  }
  return { removedBrowserSingletonArtifacts, upgraded };
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
  const repair = repairMigratedTarget(options);
  const changed = repair && (repair.removedBrowserSingletonArtifacts > 0 || repair.upgraded);
  print(changed ? { status: "target_repaired", ...repair } : { status: "target_exists" });
  process.exit(0);
}
if (!fs.existsSync(path.join(options.source, ".nexus-preset-applied"))) {
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

  const configPath = path.join(staging, "openclaw.json");
  if (fs.existsSync(configPath)) {
    const config = rewriteOwnedPaths(
      JSON.parse(fs.readFileSync(configPath, "utf8")),
      options.source,
      options.target,
    );
    config.gateway ??= {};
    config.gateway.mode = "local";
    config.gateway.port = options.port;
    delete config.gateway.remote;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }

  fs.writeFileSync(
    path.join(staging, ".nexus-profile-migration.json"),
    `${JSON.stringify(
      {
        version: 2,
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
