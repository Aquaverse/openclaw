#!/usr/bin/env node

import fs from "node:fs";

const [expectedCommit, appCommit, appRuntimeBuildId, runtimeBuildInfoPath] = process.argv.slice(2);

if (!expectedCommit || !appCommit || !appRuntimeBuildId || !runtimeBuildInfoPath) {
  throw new Error(
    "usage: verify-mac-installer-source.mjs <expected-commit> <app-commit> <app-runtime-build-id> <runtime-build-info>",
  );
}

if (appCommit !== expectedCommit) {
  throw new Error(
    `Refusing to package a stale OpenClaw.app: the app was built from ${appCommit}, but the current source commit is ${expectedCommit}. Run the full \`pnpm mac:installer\` pipeline before packaging.`,
  );
}

let runtimeBuildInfo;
try {
  runtimeBuildInfo = JSON.parse(fs.readFileSync(runtimeBuildInfoPath, "utf8"));
} catch (error) {
  throw new Error(
    `Could not read the app's private runtime build identity: ${runtimeBuildInfoPath}`,
    {
      cause: error,
    },
  );
}

if (
  runtimeBuildInfo?.commit !== expectedCommit ||
  runtimeBuildInfo?.buildId !== appRuntimeBuildId
) {
  throw new Error(
    `Refusing to package a mismatched OpenClaw.app runtime: expected commit ${expectedCommit} and build ${appRuntimeBuildId}, got commit ${String(runtimeBuildInfo?.commit)} and build ${String(runtimeBuildInfo?.buildId)}. Run the full \`pnpm mac:installer\` pipeline before packaging.`,
  );
}
