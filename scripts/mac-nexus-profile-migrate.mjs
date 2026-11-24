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
if (!fs.existsSync(path.join(options.source, ".nexus-preset-applied"))) {
  print({ status: "source_ineligible" });
  process.exit(0);
}
if (fs.existsSync(options.target)) {
  print({ status: "target_exists" });
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
        version: 1,
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
