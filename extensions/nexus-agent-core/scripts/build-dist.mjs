#!/usr/bin/env node
// Builds the publishable runtime for this plugin: dist/index.js, the SQLite worker
// entries and dist/control-ui/<hash>. It reuses the repository's shared plugin runtime
// build (tsdown; `openclaw` and `openclaw/*` stay external) and only adds guards.
// Run from anywhere inside the OpenClaw checkout:
//   node extensions/nexus-agent-core/scripts/build-dist.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const buildScript = path.join(repoRoot, "scripts", "lib", "plugin-npm-runtime-build.mjs");

if (!fs.existsSync(buildScript)) {
  console.error(`[nexus build-dist] ${buildScript} not found; run inside an OpenClaw checkout`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [buildScript, path.relative(repoRoot, packageDir)], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// package.json deliberately has no openclaw.runtimeExtensions: the npm pack step derives it from
// openclaw.extensions (./index.ts -> ./dist/index.js), and a hand-written ./dist/index.js would point at the wrong
// file inside the bundled App, where the built entry sits at the plugin root (index.js). See manifest.test.ts.
const required = ["./dist/index.js", "./dist/src/store/sqlite-store.worker.js"];
const missing = required.filter((file) => !fs.existsSync(path.join(packageDir, file)));
const controlUiRoot = path.join(packageDir, "dist", "control-ui");
const controlUiHashes = fs.existsSync(controlUiRoot) ? fs.readdirSync(controlUiRoot) : [];
if (controlUiHashes.length !== 1) {
  missing.push(`dist/control-ui/<single hash> (found ${controlUiHashes.length})`);
}
if (missing.length > 0) {
  console.error(`[nexus build-dist] missing build output: ${missing.join(", ")}`);
  process.exit(1);
}
console.error(`[nexus build-dist] ok: ${required.join(", ")}, control-ui ${controlUiHashes[0]}`);
