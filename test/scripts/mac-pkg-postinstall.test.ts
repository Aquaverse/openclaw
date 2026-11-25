import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("scripts/mac-pkg-postinstall.sh", () => {
  it("uses the repository-pinned packer for the bundled installer CLI", () => {
    const script = readFileSync("scripts/build-mac-installer.sh", "utf8");
    const pack = script.indexOf("node scripts/package-openclaw-for-docker.mjs");
    const end = script.indexOf("--output-name", pack);

    expect(pack).toBeGreaterThanOrEqual(0);
    expect(script.slice(pack, end)).toContain("--pnpm-pack");
  });

  it("stamps only Nexus preset builds with the isolated app profile", () => {
    const script = readFileSync("scripts/build-mac-installer.sh", "utf8");
    const preset = script.indexOf('if [[ "$NEXUS_PRESET_FOR_BUNDLE" == "1" ]]');
    const nonPreset = script.indexOf("Nexus stays off in this build", preset);

    expect(preset).toBeGreaterThanOrEqual(0);
    expect(nonPreset).toBeGreaterThan(preset);
    expect(script.slice(preset, nonPreset)).toContain(
      'plist_set_or_add_string "$APP/Contents/Info.plist" OpenClawDefaultProfile nexus',
    );
    expect(script.slice(0, preset)).toContain("Delete :OpenClawDefaultProfile");
  });

  it("uses the app's bundled profile for state, service, defaults, and CLI children", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const profileRead = script.indexOf("Print :OpenClawDefaultProfile");
    const prefix = script.indexOf('PREFIX="$CONSOLE_HOME/.openclaw-${APP_PROFILE}"', profileRead);

    expect(profileRead).toBeGreaterThanOrEqual(0);
    expect(prefix).toBeGreaterThan(profileRead);
    expect(script).toContain('export OPENCLAW_PROFILE="$APP_PROFILE"');
    expect(script).toContain('GATEWAY_SERVICE_LABEL="ai.openclaw.${APP_PROFILE}"');
    expect(script).toContain('APP_DEFAULTS_DOMAIN="ai.openclaw.mac.profile.${APP_PROFILE}"');
    expect(script).toContain(
      'MIGRATION_SCRIPT="$APP_PATH/Contents/Resources/mac-nexus-profile-migrate.mjs"',
    );
    expect(script).toContain(
      'if [[ "$NEXUS_PROFILE_MIGRATION_REQUIRED" == "1" && "$NEXUS_PROFILE_MIGRATED" != "1" ]]',
    );
    expect(script).toContain("preserving the old state and leaving the new profile absent");
    expect(script).toContain("the Nexus profile migration resources are missing");
    expect(script).toContain("SOURCE_GATEWAY_INSTALLED=1");
    expect(script).toContain(
      'if [[ "$NEXUS_PROFILE_MIGRATED" != "1" && "$SOURCE_GATEWAY_WAS_LOADED" == "1"',
    );
    expect(script).toContain('"$SOURCE_OPENCLAW_BIN" gateway uninstall --json');
    expect(script).toContain('"$SOURCE_OPENCLAW_BIN" gateway install --json');
    expect(script).toContain("openclaw.connectionMode local");
    expect(script).not.toContain('defaults read "$BUNDLE_ID" "openclaw.connectionMode"');
  });

  it("only retires the default-profile LaunchAgent when its definition belongs to the prior Nexus state", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const ownershipFunction = script.indexOf("prior_nexus_gateway_service_owned() {");
    const migrationStart = script.indexOf("# Nexus builds moved from the shared default profile");
    const uninstall = script.indexOf('"$SOURCE_OPENCLAW_BIN" gateway uninstall --json');

    expect(ownershipFunction).toBeGreaterThanOrEqual(0);
    expect(ownershipFunction).toBeLessThan(migrationStart);
    expect(script.slice(ownershipFunction, migrationStart)).toContain("Print :WorkingDirectory");
    expect(script.slice(ownershipFunction, migrationStart)).toContain("Print :ProgramArguments");
    expect(script.slice(migrationStart, uninstall)).toContain(
      'prior_nexus_gateway_service_owned "$SOURCE_GATEWAY_PLIST" "$SOURCE_PREFIX"',
    );
    expect(script.slice(migrationStart, uninstall)).toContain(
      "belongs to another application; preserving it",
    );
  });

  it.runIf(process.platform === "darwin")(
    "classifies the prior Nexus LaunchAgent by its effective state root and command",
    () => {
      const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
      const functionStart = script.indexOf("prior_nexus_gateway_service_owned() {");
      const functionEnd = script.indexOf(
        "# Nexus builds moved from the shared default profile",
        functionStart,
      );
      const root = mkdtempSync(join(tmpdir(), "openclaw-nexus-launchagent-owner-"));
      const source = join(root, ".openclaw");
      const ownedPlist = join(root, "owned.plist");
      const foreignWorkingDirectoryPlist = join(root, "foreign-working-directory.plist");
      const foreignCommandPlist = join(root, "foreign-command.plist");
      const plist = (
        workingDirectory: string,
        commandRoot: string,
      ) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ai.openclaw.gateway</string>
<key>WorkingDirectory</key><string>${workingDirectory}</string>
<key>ProgramArguments</key><array>
<string>${commandRoot}/tools/node-v24.22.1/bin/node</string>
<string>${commandRoot}/tools/node-v24.22.1/lib/node_modules/openclaw/dist/index.js</string>
<string>gateway</string><string>--port</string><string>18789</string>
</array></dict></plist>
`;
      writeFileSync(ownedPlist, plist(source, source));
      writeFileSync(foreignWorkingDirectoryPlist, plist(join(root, ".telyclaw"), source));
      writeFileSync(foreignCommandPlist, plist(source, join(root, ".telyclaw")));

      const harness = join(root, "classify.sh");
      writeFileSync(
        harness,
        [
          "#!/bin/bash",
          "set -uo pipefail",
          script.slice(functionStart, functionEnd),
          `prior_nexus_gateway_service_owned ${JSON.stringify(ownedPlist)} ${JSON.stringify(source)} 'program = ${source}/tools/node-v24.22.1/bin/node'`,
          `! prior_nexus_gateway_service_owned ${JSON.stringify(foreignWorkingDirectoryPlist)} ${JSON.stringify(source)}`,
          `! prior_nexus_gateway_service_owned ${JSON.stringify(foreignCommandPlist)} ${JSON.stringify(source)}`,
          `! prior_nexus_gateway_service_owned ${JSON.stringify(ownedPlist)} ${JSON.stringify(source)} 'program = ${join(root, ".telyclaw")}/bin/gateway'`,
        ].join("\n"),
      );

      const result = spawnSync("/bin/bash", [harness], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("keeps bundled plugins visible during offline database migration", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const migrationStart = script.indexOf("# Upgrade over an existing install");
    const migrationEnd = script.indexOf("# Default AI provider (optional)", migrationStart);
    const migration = script.slice(migrationStart, migrationEnd);

    expect(migration).toContain("OPENCLAW_SERVICE_REPAIR_POLICY=external");
    expect(migration).toContain(
      '"$OPENCLAW_BIN" doctor --fix --non-interactive --no-workspace-suggestions',
    );
    expect(migration).not.toContain("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
  });

  it("backs up the canonical config before running installer migrations", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const migrationStart = script.indexOf("# Upgrade over an existing install");
    const migrationEnd = script.indexOf("# Default AI provider (optional)", migrationStart);
    const migration = script.slice(migrationStart, migrationEnd);
    const configBackup = migration.indexOf(
      'run_as_console_user /bin/cp -a "$PREFIX/openclaw.json" "$BACKUP_DIR/openclaw.json"',
    );
    const doctor = migration.indexOf(
      '"$OPENCLAW_BIN" doctor --fix --non-interactive --no-workspace-suggestions',
    );

    expect(configBackup).toBeGreaterThanOrEqual(0);
    expect(configBackup).toBeLessThan(doctor);
  });

  it("runs full Doctor only when the read-only migration preflight requires it", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const migrationStart = script.indexOf("# Upgrade over an existing install");
    const migrationEnd = script.indexOf("# Default AI provider (optional)", migrationStart);
    const migration = script.slice(migrationStart, migrationEnd);
    const preflight = migration.indexOf("doctor --lint --only core/doctor/state-schema --json");
    const doctor = migration.indexOf("doctor --fix --non-interactive", preflight);

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(doctor).toBeGreaterThan(preflight);
    expect(migration.slice(preflight, doctor)).toContain(
      '"requirement"[[:space:]]*:[[:space:]]*"state-schema-migration-pending"',
    );
    expect(migration.slice(preflight, doctor)).toContain(
      '"checkId"[[:space:]]*:[[:space:]]*"core/doctor/agent-deletion-journal"',
    );
    expect(migration.slice(preflight, doctor)).toContain("DOCTOR_REQUIRED=1");
    expect(migration.slice(preflight, doctor)).toContain(
      "Existing database state is current -- skipping full Doctor migration.",
    );
    expect(migration.slice(preflight, doctor)).toContain(
      "Doctor preflight could not inspect existing data",
    );
    expect(migration.slice(preflight, doctor)).not.toContain(
      "pending repair or could not prove current state",
    );
  });

  it("skips Doctor on a fresh runtime and lets onboarding install the Gateway once", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const migrationStart = script.indexOf("# Upgrade over an existing install");
    const migrationEnd = script.indexOf("# Default AI provider (optional)", migrationStart);
    const migration = script.slice(migrationStart, migrationEnd);
    const onboardingStart = script.indexOf("ONBOARD_ARGS=(onboard --non-interactive");
    const freshStart = script.indexOf("else\n  ONBOARD_RAN=1", onboardingStart);
    const freshEnd = script.indexOf('[[ -n "$ONBOARD_KEY_FILE" ]]', freshStart);
    const onboarding = script.slice(onboardingStart, freshEnd);
    const freshOnboarding = script.slice(freshStart, freshEnd);

    expect(migration).toContain(
      'if [[ "$REUSE_INSTALLED_RUNTIME" != "1" && ( -d "$PREFIX/agents" || -e "$PREFIX/state/openclaw.sqlite" ) ]]; then',
    );
    expect(migration).not.toContain('-d "$PREFIX/bin"');
    expect(migration).not.toContain('-d "$PREFIX/tools"');
    expect(onboarding).toContain("ONBOARD_ARGS=(onboard --non-interactive");
    expect(onboarding).toContain("--install-daemon");
    expect(onboarding).toContain("SETUP_ARGS=(");
    expect(onboarding).toContain("--install-daemon");
    expect(freshOnboarding).not.toContain("gateway start --json");
    expect(freshOnboarding).not.toContain("gateway install --json");
  });

  it("stops a loaded Gateway before replacing its CLI runtime", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const guard = script.indexOf('if [[ "$REUSE_INSTALLED_RUNTIME" != "1" ]]');
    const loaded = script.indexOf('launchctl print "$GATEWAY_SERVICE_TARGET"', guard);
    const stop = script.indexOf("gateway stop --force --json", loaded);
    const install = script.indexOf('"$INSTALL_CLI" --json --runtime-only', stop);

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(loaded).toBeGreaterThan(guard);
    expect(stop).toBeGreaterThan(loaded);
    expect(install).toBeGreaterThan(stop);
    expect(script.slice(guard, install)).toContain('REUSE_INSTALLED_RUNTIME" != "1"');
    expect(script.slice(stop, install)).toContain(
      "the running Gateway could not be stopped safely",
    );
  });

  it("restores the previous private runtime, wrapper, and markers after a failed replacement", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const functionsStart = script.indexOf("restore_previous_runtime() {");
    const functionsEnd = script.indexOf("# PackageKit termination", functionsStart);
    expect(functionsStart).toBeGreaterThanOrEqual(0);
    expect(functionsEnd).toBeGreaterThan(functionsStart);

    const root = mkdtempSync(join(tmpdir(), "openclaw-pkg-runtime-rollback-"));
    const prefix = join(root, "prefix");
    const runtime = join(prefix, "tools", "node-v24.22.1");
    const wrapper = join(prefix, "bin", "openclaw");
    mkdirSync(join(runtime, "bin"), { recursive: true });
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(join(prefix, "backups"), { recursive: true });
    writeFileSync(join(runtime, "old-runtime"), "old");
    writeFileSync(wrapper, "#!/bin/bash\necho old\n");
    chmodSync(wrapper, 0o755);
    writeFileSync(join(prefix, ".bundled-cli-package.sha256"), "old-package\n");
    writeFileSync(join(prefix, ".installer-runtime-applied"), "old-runtime-id\n");
    const nodeAlias = join(prefix, "tools", "node");
    const harness = join(root, "rollback.sh");
    writeFileSync(
      harness,
      [
        "#!/bin/bash",
        "set -uo pipefail",
        `PREFIX=${JSON.stringify(prefix)}`,
        `OPENCLAW_BIN=${JSON.stringify(wrapper)}`,
        `RUNTIME_MARKER=${JSON.stringify(join(prefix, ".installer-runtime-applied"))}`,
        "LOG_FILE=/dev/null",
        "GATEWAY_WAS_LOADED=0",
        "RUNTIME_ROLLBACK_DIR=",
        "PREVIOUS_RUNTIME_TARGET=",
        "log() { :; }",
        'run_as_console_user() { "$@"; }',
        script.slice(functionsStart, functionsEnd),
        `/bin/ln -sfn ${JSON.stringify(runtime)} ${JSON.stringify(nodeAlias)}`,
        "stage_previous_runtime",
        `test ! -e ${JSON.stringify(runtime)}`,
        `mkdir -p ${JSON.stringify(join(runtime, "bin"))}`,
        `printf partial > ${JSON.stringify(join(runtime, "partial"))}`,
        `printf '#!/bin/bash\\necho new\\n' > ${JSON.stringify(wrapper)}`,
        `printf new-package > ${JSON.stringify(join(prefix, ".bundled-cli-package.sha256"))}`,
        `printf new-runtime > ${JSON.stringify(join(prefix, ".installer-runtime-applied"))}`,
        "RUNTIME_ROLLBACK_DIR=",
        "PREVIOUS_RUNTIME_TARGET=",
        "RUNTIME_ROLLBACK_DIR=$(find \"$PREFIX/backups\" -maxdepth 1 -type d -name '.pkg-runtime-rollback-*' | head -n1)",
        'PREVIOUS_RUNTIME_TARGET=$(head -n1 "$RUNTIME_ROLLBACK_DIR/runtime-target")',
        "restore_previous_runtime",
        `test -f ${JSON.stringify(join(runtime, "old-runtime"))}`,
        `test ! -e ${JSON.stringify(join(runtime, "partial"))}`,
        `grep -q 'echo old' ${JSON.stringify(wrapper)}`,
        `grep -q old-package ${JSON.stringify(join(prefix, ".bundled-cli-package.sha256"))}`,
        `grep -q old-runtime-id ${JSON.stringify(join(prefix, ".installer-runtime-applied"))}`,
        `test "$(readlink ${JSON.stringify(nodeAlias)})" = ${JSON.stringify(runtime)}`,
      ].join("\n"),
    );
    const result = spawnSync("/bin/bash", [harness], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("reuses an identical successfully migrated bundled runtime", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const markerCheck = script.indexOf('APPLIED_RUNTIME_ID="$(/usr/bin/head -n1');
    const install = script.indexOf('"$INSTALL_CLI" --json --runtime-only');
    const migration = script.indexOf(
      'if [[ "$REUSE_INSTALLED_RUNTIME" != "1" && ( -d "$PREFIX/agents"',
    );
    const markerWrite = script.indexOf('"$RUNTIME_ID" "$RUNTIME_MARKER"', migration);

    expect(markerCheck).toBeGreaterThanOrEqual(0);
    expect(markerCheck).toBeLessThan(install);
    expect(script.slice(markerCheck, install)).toContain('APPLIED_RUNTIME_ID" == "$RUNTIME_ID"');
    expect(script).toContain('RUNTIME_ID="${CLI_PACKAGE_TGZ_SHA256}:${NODE_TARBALL_SHA256:-none}"');
    expect(migration).toBeGreaterThan(install);
    expect(markerWrite).toBeGreaterThan(migration);
    expect(script.slice(migration, markerWrite)).toContain("MIGRATION_OK=0");
  });

  it("does not copy historical startup-migration backups into each pkg backup", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const stateBackup = script.indexOf('if [[ -d "$PREFIX/state" ]]');
    const agentBackup = script.indexOf('if [[ -d "$PREFIX/agents" ]]', stateBackup);
    const block = script.slice(stateBackup, agentBackup);

    expect(block).toContain("! -name '*.pre-startup-migration-*.bak'");
    expect(block).not.toContain('/bin/cp -a "$PREFIX/state"');
  });

  it("still applies the Nexus preset when default-provider onboarding fails", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const failure = script.indexOf(
      'log "WARN: non-interactive onboarding failed (see $LOG_FILE above)',
    );
    const nexus = script.indexOf("NEXUS_PRESET_SCRIPT=", failure);
    const defaults = script.indexOf('if [[ "$ONBOARD_OK" == "1" ]]', nexus);

    expect(failure).toBeGreaterThanOrEqual(0);
    expect(nexus).toBeGreaterThan(failure);
    expect(script.slice(failure, nexus)).not.toContain("exit 0");
    expect(script.slice(nexus, defaults)).toContain("--repair-missing");
    expect(defaults).toBeGreaterThan(nexus);
  });

  it("refreshes changed bundled settings without coupling them to the user default", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const appliedCheck = script.indexOf('DEFAULT_PROVIDER_AUTH_ID="$(printf');
    const keyFile = script.indexOf('ONBOARD_KEY_FILE="$(/usr/bin/mktemp', appliedCheck);
    const setupArgs = script.indexOf("SETUP_ARGS=(", keyFile);

    expect(appliedCheck).toBeGreaterThanOrEqual(0);
    expect(script.slice(appliedCheck, keyFile)).toContain(
      "'provider=%s\\nbase_url=%s\\nmodel=%s\\napi_key=%s\\n'",
    );
    expect(script.slice(appliedCheck, keyFile)).toContain(
      '"$AI_PROVIDER" "$AI_BASE_URL" "$AI_MODEL" "$AI_API_KEY"',
    );
    expect(script.slice(appliedCheck, keyFile)).toContain(
      '"$PREFIX/.default-provider-auth-applied"',
    );
    expect(script.slice(appliedCheck, keyFile)).toContain(
      "APPLIED_PROVIDER_MODEL_REF=\"$(/usr/bin/sed -n '2p'",
    );
    expect(script.slice(appliedCheck, keyFile)).toContain(
      "DEFAULT_PROVIDER_SETUP_ALREADY_APPLIED=1",
    );
    expect(script.slice(keyFile - 160, keyFile)).toContain(
      '"$DEFAULT_PROVIDER_AUTH_ALREADY_APPLIED" != "1"',
    );
    expect(setupArgs).toBeGreaterThan(keyFile);
    expect(script.slice(setupArgs, setupArgs + 700)).toContain(
      '[[ -n "$ONBOARD_KEY_FILE" ]] && SETUP_ARGS+=(--api-key-file "$ONBOARD_KEY_FILE")',
    );
    expect(script.slice(setupArgs, setupArgs + 700)).toContain(
      "SETUP_ARGS+=(--resolved-model-file",
    );
    expect(script).toContain(
      '"$DEFAULT_PROVIDER_AUTH_ID" "$DEFAULT_PROVIDER_MODEL_REF" "$PREFIX/.default-provider-auth-applied"',
    );
    expect(script).toContain('"$DEFAULT_PROVIDER_SETUP_ALREADY_APPLIED" == "1"');
  });

  it("refreshes model capabilities when unchanged credentials skip onboarding", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const unchanged = script.indexOf(
      'log "Bundled default-provider settings are unchanged -- preserving the existing credential authorization."',
    );
    const capabilitySync = script.indexOf("--sync-pii-capability", unchanged);
    const onboardingSkip = script.indexOf(
      'log "Onboarding already completed -- skipping non-interactive onboarding."',
      unchanged,
    );

    expect(unchanged).toBeGreaterThanOrEqual(0);
    expect(capabilitySync).toBeGreaterThan(unchanged);
    expect(capabilitySync).toBeLessThan(onboardingSkip);
    expect(script.slice(unchanged, capabilitySync)).toContain(
      'DEFAULT_PROVIDER_SETUP_ALREADY_APPLIED" == "1"',
    );
    expect(script).toContain('DEFAULT_PROVIDER_CAPABILITY_VERSION="pii-replace-v1"');
    expect(script).toContain("DEFAULT_PROVIDER_CAPABILITIES_SYNCED=1");
  });

  it("refreshes model capabilities on a DMG upgrade without rerunning provider onboarding", () => {
    const source = readFileSync("apps/macos/Sources/OpenClaw/AutoOnboardBootstrap.swift", "utf8");
    const sync = source.indexOf("private static func syncDefaultProviderCapabilities");
    const command = source.indexOf('"--sync-pii-capability"', sync);

    expect(sync).toBeGreaterThanOrEqual(0);
    expect(command).toBeGreaterThan(sync);
    expect(source.match(/await Self[.]syncDefaultProviderCapabilities\(provider\)/g)).toHaveLength(
      2,
    );
    expect(source).toContain('defaultProviderCapabilityVersion = "pii-replace-v1"');
    expect(source).toContain("defaultProviderCapabilitiesNeedSync(provider)");
  });

  it("does not trust an applied marker after the provider credential binding disappears", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const functionStart = script.indexOf("default_provider_auth_binding_ready() {");
    const functionEnd = script.indexOf('\nif [[ "$APPLY_DEFAULT_PROVIDER" == "1"', functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    expect(script.slice(functionStart, functionEnd)).toContain(
      '"$DEFAULT_PROVIDER_SETUP" --openclaw-bin "$OPENCLAW_BIN" --check-auth-binding',
    );
    expect(script.slice(functionStart, functionEnd)).toContain('--expected-model-ref "$model_ref"');
    expect(script).toContain("The default-provider marker is stale");
    expect(script).toContain("The legacy default-provider marker is stale");
  });

  it("skips repeated onboarding and starts the selected local service without forcing a rewrite", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const seen = script.indexOf('"openclaw.onboardingSeen"');
    const skip = script.indexOf(
      'log "Onboarding already completed -- skipping non-interactive onboarding."',
      seen,
    );
    const start = script.indexOf("gateway start --json", skip);
    const installMissing = script.indexOf("gateway install --json", start);
    const onboard = script.indexOf('log "==> Running non-interactive onboarding', skip);

    expect(seen).toBeGreaterThanOrEqual(0);
    expect(skip).toBeGreaterThan(seen);
    expect(script.slice(seen, skip)).toContain('DEFAULT_PROVIDER_SETUP_ALREADY_APPLIED" == "1"');
    expect(start).toBeGreaterThan(skip);
    expect(installMissing).toBeGreaterThan(start);
    expect(onboard).toBeGreaterThan(installMissing);
    expect(script.slice(skip, start)).not.toContain('REUSE_INSTALLED_RUNTIME" != "1"');
    expect(script.slice(skip, onboard)).not.toContain("gateway install --force");
    expect(script.slice(skip, onboard)).toContain(
      'HOSTS_LOCAL_GATEWAY_WITH_REMOTE_PRIMARY" == "1"',
    );
    expect(script.slice(skip, onboard)).toContain('ONBOARDING_CONNECTION_MODE" != "remote"');
    expect(script.slice(skip, onboard)).toContain('-f "$GATEWAY_SERVICE_PLIST"');
    expect(script.slice(skip, onboard)).toContain(
      "Remote connection mode is configured without a local companion Gateway",
    );
  });

  it("preserves remote connection mode and does not apply the local default-provider preset", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const remoteGuard = script.indexOf('if [[ "$ONBOARDING_CONNECTION_MODE" == "remote" ]]; then');
    const providerSetup = script.indexOf(
      'if [[ "$APPLY_DEFAULT_PROVIDER" == "1" && -n "$AI_BASE_URL"',
      remoteGuard,
    );

    expect(remoteGuard).toBeGreaterThanOrEqual(0);
    expect(providerSetup).toBeGreaterThan(remoteGuard);
    expect(script.slice(remoteGuard, providerSetup)).toContain("APPLY_DEFAULT_PROVIDER=0");
    expect(script).toContain(
      '"$ONBOARDING_ALREADY_COMPLETED" == "1" || "$ONBOARDING_CONNECTION_MODE" == "remote"',
    );
    expect(script).not.toContain(
      'defaults write "$BUNDLE_ID" "openclaw.connectionMode" -string "local"',
    );
  });

  it("rolls back runtime and migration data before onboarding after a required Doctor failure", () => {
    const script = readFileSync("scripts/mac-pkg-postinstall.sh", "utf8");
    const doctorFailure = script.indexOf('rollback_failed_upgrade "Doctor migration failed"');
    const backupFailure = script.indexOf(
      'rollback_failed_upgrade "the pre-upgrade backup could not be completed"',
    );
    const onboarding = script.indexOf("# Default AI provider (optional)");

    expect(doctorFailure).toBeGreaterThanOrEqual(0);
    expect(backupFailure).toBeGreaterThan(doctorFailure);
    expect(backupFailure).toBeLessThan(onboarding);
    const restore = script.slice(
      script.indexOf("restore_migration_backup()"),
      script.indexOf("rollback_failed_upgrade()"),
    );
    expect(restore).toContain("CURRENT_DB_FILE");
    expect(restore.indexOf('/bin/rm -f "$CURRENT_DB_FILE"')).toBeLessThan(
      restore.indexOf('/bin/cp -a "$BACKUP_FILE"'),
    );
    expect(script.slice(doctorFailure, doctorFailure + 100)).toContain("exit 0");
    expect(script.slice(backupFailure, backupFailure + 140)).toContain(
      'rollback_failed_upgrade "the pre-upgrade backup could not be completed" 0',
    );
    expect(script.slice(backupFailure, backupFailure + 180)).toContain("exit 0");
  });
});
