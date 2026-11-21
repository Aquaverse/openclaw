import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scripts/mac-pkg-postinstall.sh", () => {
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
    expect(defaults).toBeGreaterThan(nexus);
  });

  it("does not replace unchanged default-provider credentials during an upgrade", () => {
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
    expect(script.slice(keyFile - 160, keyFile)).toContain(
      '"$DEFAULT_PROVIDER_AUTH_ALREADY_APPLIED" != "1"',
    );
    expect(setupArgs).toBeGreaterThan(keyFile);
    expect(script.slice(setupArgs, setupArgs + 700)).toContain(
      '[[ -n "$ONBOARD_KEY_FILE" ]] && SETUP_ARGS+=(--api-key-file "$ONBOARD_KEY_FILE")',
    );
    expect(script).toContain(
      '"$DEFAULT_PROVIDER_AUTH_ID" "$PREFIX/.default-provider-auth-applied"',
    );
  });
});
