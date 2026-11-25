#!/bin/bash
# Runs once, as root, right after Installer.app copies OpenClaw.app into
# place -- before the app is ever launched for the first time. Node/CLI/
# Gateway provisioning happens here instead of inside the app itself, so
# the app bundle stays exactly what scripts/package-mac-app.sh produced
# (see scripts/build-mac-installer.sh's header comment for why an earlier
# approach that mutated the app bundle itself was removed).
#
# This script is deliberately best-effort: any failure here logs a
# warning and exits 0 rather than failing the whole installation. Worst
# case if something here doesn't work on a given machine, the app falls
# back to exactly its own normal, native first-run onboarding UI (Node/
# CLI/Gateway install, model picker) -- the same experience as before this
# script existed, never worse.
#
# Standard installer postinstall script arguments (Apple's convention):
#   $1 = path to this package
#   $2 = path to the install location (the argument to pkgbuild's
#        --install-location, typically /Applications)
#   $3 = path to the target volume's root (typically /)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/mac-installer-node-runtime.sh"

# Installer.app starts this script inside its own temporary sandbox directory, which is removed if the
# installer is cancelled or closed. A long step (the database migration below can take many minutes)
# would then fail with "ENOENT: process.cwd failed ... uv_cwd". Run from a directory that always exists.
cd / || true

LOG_FILE="/var/log/openclaw-installer-postinstall.log"
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE" >/dev/null
}

log "=================================================="
log "OpenClaw postinstall starting"

INSTALL_LOCATION="${2:-/Applications}"
APP_PATH="$INSTALL_LOCATION/OpenClaw.app"
if [[ ! -d "$APP_PATH" ]]; then
  APP_PATH="/Applications/OpenClaw.app"
fi
if [[ ! -d "$APP_PATH" ]]; then
  log "ERROR: OpenClaw.app not found at an expected location (checked $INSTALL_LOCATION and /Applications) -- skipping silent provisioning. The app install itself is unaffected."
  exit 0
fi
log "App: $APP_PATH"

# ---------------------------------------------------------------------
# Find the logged-in GUI user. A pkg can be installed with no one logged
# in (remote/MDM deployment, or the very first boot's setup screen) -- in
# that case there is no home directory to safely provision into, so skip
# cleanly rather than guessing.
# ---------------------------------------------------------------------
CONSOLE_USER="$(/usr/bin/stat -f%Su /dev/console 2>/dev/null || true)"
if [[ -z "$CONSOLE_USER" || "$CONSOLE_USER" == "root" || "$CONSOLE_USER" == "loginwindow" ]]; then
  log "No logged-in console user detected (got: '${CONSOLE_USER}') -- skipping silent provisioning; first launch will use the app's own onboarding."
  exit 0
fi
CONSOLE_UID="$(/usr/bin/id -u "$CONSOLE_USER" 2>/dev/null || true)"
if [[ -z "$CONSOLE_UID" ]]; then
  log "Could not resolve a uid for '$CONSOLE_USER' -- skipping silent provisioning."
  exit 0
fi
CONSOLE_HOME="$(/usr/bin/dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory 2>/dev/null | /usr/bin/awk '{print $2}')"
if [[ -z "$CONSOLE_HOME" || ! -d "$CONSOLE_HOME" ]]; then
  log "Could not resolve a usable home directory for '$CONSOLE_USER' -- skipping silent provisioning."
  exit 0
fi
log "Provisioning for console user: $CONSOLE_USER (uid $CONSOLE_UID, home $CONSOLE_HOME)"

# Installer.app writes the payload as root:wheel, so a pkg-installed app
# needs a password to move to the Trash until this is fixed -- chown it to
# the console user (their own primary group) right away, same ownership it
# would already have if they'd dragged it out of a dmg instead. Done
# unconditionally, before anything below that could fail, so this always
# lands even if the CLI/Gateway provisioning further down doesn't.
CONSOLE_GROUP="$(/usr/bin/id -gn "$CONSOLE_USER" 2>/dev/null || echo staff)"
log "Fixing ownership of $APP_PATH to $CONSOLE_USER:$CONSOLE_GROUP"
/usr/sbin/chown -R "$CONSOLE_USER:$CONSOLE_GROUP" "$APP_PATH" >>"$LOG_FILE" 2>&1 ||
  log "WARN: chown of $APP_PATH failed -- it may need a password to move to the Trash."

# launchctl asuser gives a root-run command the target user's GUI/Mach
# bootstrap context -- required for the CLI's LaunchAgent install
# (--install-daemon below) to land in that user's per-user launchd domain
# instead of root's. This is the standard, documented pattern for a pkg
# postinstall script that needs to act as the logged-in user.
run_as_console_user() {
  if [[ -n "${APP_PROFILE:-}" ]]; then
    /bin/launchctl asuser "$CONSOLE_UID" /usr/bin/sudo -u "$CONSOLE_USER" -H \
      /usr/bin/env OPENCLAW_PROFILE="$APP_PROFILE" "$@"
  else
    /bin/launchctl asuser "$CONSOLE_UID" /usr/bin/sudo -u "$CONSOLE_USER" -H "$@"
  fi
}

INSTALL_CLI="$APP_PATH/Contents/Resources/install-cli.sh"
if [[ ! -f "$INSTALL_CLI" ]]; then
  log "ERROR: $INSTALL_CLI missing from the app bundle -- skipping silent provisioning."
  exit 0
fi

# ---------------------------------------------------------------------
# Node: use the tarball scripts/build-mac-installer.sh bundled into
# Contents/Resources/node-runtime for this Mac's CPU architecture, if
# present, so install-cli.sh doesn't need its own network round trip.
# See scripts/install-cli.sh's OPENCLAW_NODE_TARBALL support.
# ---------------------------------------------------------------------
NODE_RUNTIME_DIR="$APP_PATH/Contents/Resources/node-runtime"
NODE_TARBALL=""
NODE_TARBALL_SHA256=""
if [[ -d "$NODE_RUNTIME_DIR" ]]; then
  PROCESS_ARCH="$(/usr/bin/uname -m)"
  TRANSLATED="$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null || echo 0)"
  ARCH="$(select_bundled_node_arch "$NODE_RUNTIME_DIR" "$PROCESS_ARCH" "$TRANSLATED" || true)"
  if [[ -n "$ARCH" ]]; then
    NODE_TARBALL="$(/usr/bin/find "$NODE_RUNTIME_DIR" -maxdepth 1 -iname "node-v*-darwin-${ARCH}.tar.gz" | /usr/bin/head -n1)"
  fi
  if [[ -n "$NODE_TARBALL" && -f "${NODE_TARBALL}.sha256" ]]; then
    NODE_TARBALL_SHA256="$(cat "${NODE_TARBALL}.sha256")"
  fi
fi
if [[ -n "$NODE_TARBALL" ]]; then
  log "Using bundled Node tarball: $NODE_TARBALL"
else
  log "No bundled Node tarball for process arch '${PROCESS_ARCH:-unknown}' (translated=${TRANSLATED:-unknown}) -- install-cli.sh will fetch Node from nodejs.org instead."
fi

# ---------------------------------------------------------------------
# Postinstall-script override: see scripts/build-mac-installer.sh's "2b"
# step for why this exists. Passed straight through to install-cli.sh's
# OPENCLAW_POSTINSTALL_SCRIPT_OVERRIDE support.
# ---------------------------------------------------------------------
POSTINSTALL_SCRIPT_OVERRIDE="$APP_PATH/Contents/Resources/postinstall-bundled-plugins-fixed.mjs"
if [[ -f "$POSTINSTALL_SCRIPT_OVERRIDE" ]]; then
  log "Using bundled postinstall-script fix: $POSTINSTALL_SCRIPT_OVERRIDE"
else
  POSTINSTALL_SCRIPT_OVERRIDE=""
fi

# ---------------------------------------------------------------------
# CLI package: this checkout's own CLI build, bundled by
# scripts/build-mac-installer.sh step 2d. Passed through to
# install-cli.sh's OPENCLAW_PACKAGE_TGZ support; empty (npm registry
# install, as before) when the build used SKIP_CLI_BUNDLE=1.
# ---------------------------------------------------------------------
CLI_PACKAGE_TGZ="$(/usr/bin/find "$APP_PATH/Contents/Resources/openclaw-cli" -maxdepth 1 -name 'openclaw-*.tgz' 2>/dev/null | /usr/bin/sort | /usr/bin/tail -n1)"
CLI_PACKAGE_TGZ_SHA256=""
if [[ -n "$CLI_PACKAGE_TGZ" ]]; then
  [[ -f "${CLI_PACKAGE_TGZ}.sha256" ]] && CLI_PACKAGE_TGZ_SHA256="$(cat "${CLI_PACKAGE_TGZ}.sha256")"
  log "Using bundled OpenClaw CLI package: $CLI_PACKAGE_TGZ"
else
  log "No bundled OpenClaw CLI package -- install-cli.sh will install openclaw from the npm registry."
fi

APP_PROFILE="$(/usr/libexec/PlistBuddy -c "Print :OpenClawDefaultProfile" "$APP_PATH/Contents/Info.plist" 2>/dev/null || true)"
if [[ -n "$APP_PROFILE" && ! "$APP_PROFILE" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]]; then
  log "WARN: ignoring invalid bundled app profile '$APP_PROFILE'."
  APP_PROFILE=""
fi
if [[ "$APP_PROFILE" == "default" ]]; then
  APP_PROFILE=""
fi

BUNDLE_ID="$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP_PATH/Contents/Info.plist" 2>/dev/null || true)"
APP_DEFAULTS_DOMAIN="$BUNDLE_ID"
if [[ -n "$APP_PROFILE" ]]; then
  export OPENCLAW_PROFILE="$APP_PROFILE"
  PREFIX="$CONSOLE_HOME/.openclaw-${APP_PROFILE}"
  GATEWAY_SERVICE_LABEL="ai.openclaw.${APP_PROFILE}"
  APP_DEFAULTS_DOMAIN="ai.openclaw.mac.profile.${APP_PROFILE}"
else
  unset OPENCLAW_PROFILE
  PREFIX="$CONSOLE_HOME/.openclaw"
  GATEWAY_SERVICE_LABEL="ai.openclaw.gateway"
fi

prior_nexus_gateway_service_owned() {
  local plist="$1"
  local source_prefix="$2"
  local loaded_definition="${3:-}"
  local label=""
  local working_directory=""
  local program_arguments=""

  [[ -f "$plist" ]] || return 1
  label="$(/usr/libexec/PlistBuddy -c "Print :Label" "$plist" 2>/dev/null || true)"
  working_directory="$(/usr/libexec/PlistBuddy -c "Print :WorkingDirectory" "$plist" 2>/dev/null || true)"
  program_arguments="$(/usr/libexec/PlistBuddy -c "Print :ProgramArguments" "$plist" 2>/dev/null || true)"

  [[ "$label" == "ai.openclaw.gateway" ]] || return 1
  [[ "$working_directory" == "$source_prefix" ]] || return 1
  [[ "$program_arguments" == *"$source_prefix/tools/node"* ]] || return 1
  [[ "$program_arguments" == *"/lib/node_modules/openclaw/dist/index.js"* ]] || return 1
  printf '%s\n' "$program_arguments" | /usr/bin/grep -Eq '^[[:space:]]*gateway[[:space:]]*$' || return 1

  # A loaded job can outlive or differ from the plist currently on disk. Require
  # its effective launchd definition to point at the same state root before the
  # installer is allowed to retire it.
  [[ -z "$loaded_definition" || "$loaded_definition" == *"$source_prefix/"* ]]
}

# Nexus builds moved from the shared default profile to a named profile so an
# installed OpenClaw-derived app cannot capture this app's Gateway connection.
# Import only a proven prior Nexus installation, never an unrelated default
# profile. The migration copies through a sibling staging directory, preserves
# the original, and rewrites only paths owned by the copied state.
MIGRATION_SCRIPT="$APP_PATH/Contents/Resources/mac-nexus-profile-migrate.mjs"
NEXUS_PROFILE_MIGRATED=0
NEXUS_PROFILE_MIGRATION_REQUIRED=0
if [[ "$APP_PROFILE" == "nexus" \
  && ! -e "$PREFIX" \
  && -f "$CONSOLE_HOME/.openclaw/.nexus-preset-applied" ]]; then
  NEXUS_PROFILE_MIGRATION_REQUIRED=1
  if [[ ! -f "$MIGRATION_SCRIPT" || ! -x "$APP_PATH/Contents/Resources/runtime/bin/bun" ]]; then
    log "ERROR: the Nexus profile migration resources are missing from this installer."
  else
    SOURCE_PREFIX="$CONSOLE_HOME/.openclaw"
    SOURCE_OPENCLAW_BIN="$SOURCE_PREFIX/bin/openclaw"
    SOURCE_GATEWAY_TARGET="gui/$CONSOLE_UID/ai.openclaw.gateway"
    SOURCE_GATEWAY_PLIST="$CONSOLE_HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
    SOURCE_GATEWAY_WAS_LOADED=0
    SOURCE_GATEWAY_INSTALLED=0
    SOURCE_GATEWAY_STOPPED=1
    SOURCE_GATEWAY_LAUNCHD_DEFINITION=""
    if SOURCE_GATEWAY_LAUNCHD_DEFINITION="$(/bin/launchctl print "$SOURCE_GATEWAY_TARGET" 2>/dev/null)"; then
      if prior_nexus_gateway_service_owned \
          "$SOURCE_GATEWAY_PLIST" "$SOURCE_PREFIX" "$SOURCE_GATEWAY_LAUNCHD_DEFINITION"; then
        SOURCE_GATEWAY_WAS_LOADED=1
        SOURCE_GATEWAY_INSTALLED=1
      else
        log "Existing $SOURCE_GATEWAY_TARGET belongs to another application; preserving it during the Nexus profile migration."
      fi
    elif [[ -f "$SOURCE_GATEWAY_PLIST" ]]; then
      if prior_nexus_gateway_service_owned "$SOURCE_GATEWAY_PLIST" "$SOURCE_PREFIX"; then
        SOURCE_GATEWAY_INSTALLED=1
      else
        log "Existing $SOURCE_GATEWAY_PLIST belongs to another application; preserving it during the Nexus profile migration."
      fi
    fi
    if [[ "$SOURCE_GATEWAY_INSTALLED" == "1" ]]; then
      SOURCE_GATEWAY_STOPPED=0
      log "==> Uninstalling the prior default-profile Gateway service for the Nexus profile cutover..."
      if [[ -x "$SOURCE_OPENCLAW_BIN" ]] \
        && run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" OPENCLAW_PREFIX="$SOURCE_PREFIX" OPENCLAW_PROFILE=default \
          "$SOURCE_OPENCLAW_BIN" gateway uninstall --json >>"$LOG_FILE" 2>&1; then
        SOURCE_GATEWAY_STOPPED=1
      fi
    fi
    if [[ "$SOURCE_GATEWAY_STOPPED" == "1" ]]; then
      log "==> Copying the prior Nexus state into the isolated '$APP_PROFILE' profile..."
      MIGRATION_OUTPUT="$(run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" \
        "$APP_PATH/Contents/Resources/runtime/bin/bun" "$MIGRATION_SCRIPT" \
        --source "$SOURCE_PREFIX" --target "$PREFIX" --profile "$APP_PROFILE" --port 43384 2>&1)"
      MIGRATION_STATUS=$?
      [[ -z "$MIGRATION_OUTPUT" ]] || log "$MIGRATION_OUTPUT"
      if [[ "$MIGRATION_STATUS" == "0" && "$MIGRATION_OUTPUT" == *'"status":"migrated"'* ]]; then
        NEXUS_PROFILE_MIGRATED=1
      elif [[ "$MIGRATION_STATUS" != "0" ]]; then
        log "WARN: Nexus profile migration failed; the original state remains at $SOURCE_PREFIX."
      fi
    else
      log "WARN: prior Nexus Gateway could not be stopped safely; skipping profile migration and preserving its state."
    fi
    if [[ "$NEXUS_PROFILE_MIGRATED" != "1" && "$SOURCE_GATEWAY_WAS_LOADED" == "1" && -x "$SOURCE_OPENCLAW_BIN" ]]; then
      run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" OPENCLAW_PREFIX="$SOURCE_PREFIX" OPENCLAW_PROFILE=default \
          "$SOURCE_OPENCLAW_BIN" gateway install --json >>"$LOG_FILE" 2>&1 \
        || log "WARN: could not reinstall the prior default-profile Gateway after the failed migration attempt."
    fi
  fi
fi

if [[ "$NEXUS_PROFILE_MIGRATION_REQUIRED" == "1" && "$NEXUS_PROFILE_MIGRATED" != "1" ]]; then
  log "ERROR: Nexus profile migration did not complete; preserving the old state and leaving the new profile absent so a later install can retry."
  exit 0
fi

if [[ "$NEXUS_PROFILE_MIGRATED" == "1" && -n "$APP_DEFAULTS_DOMAIN" ]]; then
  # This installer owns a local Nexus Gateway. Do not import the default
  # profile's remote route or Keychain binding; another OpenClaw-derived app
  # may own them. The copied Nexus data is served by the named local Gateway.
  run_as_console_user /usr/bin/defaults write "$APP_DEFAULTS_DOMAIN" openclaw.onboardingSeen -bool true >>"$LOG_FILE" 2>&1 \
    || log "WARN: could not mark the migrated Nexus profile as onboarded."
  run_as_console_user /usr/bin/defaults write "$APP_DEFAULTS_DOMAIN" openclaw.connectionMode local >>"$LOG_FILE" 2>&1 \
    || log "WARN: could not select the migrated Nexus profile's local Gateway."
fi

OPENCLAW_BIN="$PREFIX/bin/openclaw"
RUNTIME_MARKER="$PREFIX/.installer-runtime-applied"
REUSE_INSTALLED_RUNTIME=0
RUNTIME_ID=""
if [[ -n "$CLI_PACKAGE_TGZ_SHA256" ]]; then
  RUNTIME_ID="${CLI_PACKAGE_TGZ_SHA256}:${NODE_TARBALL_SHA256:-none}"
fi

GATEWAY_SERVICE_TARGET="gui/$CONSOLE_UID/$GATEWAY_SERVICE_LABEL"
GATEWAY_SERVICE_PLIST="$CONSOLE_HOME/Library/LaunchAgents/$GATEWAY_SERVICE_LABEL.plist"
GATEWAY_WAS_LOADED=0
GATEWAY_STOPPED_FOR_RUNTIME=0
RUNTIME_ROLLBACK_DIR=""
PREVIOUS_RUNTIME_TARGET=""

restore_previous_runtime() {
  [[ -n "$RUNTIME_ROLLBACK_DIR" && -n "$PREVIOUS_RUNTIME_TARGET" ]] || return 1
  [[ -d "$RUNTIME_ROLLBACK_DIR/node-runtime" ]] || return 1
  case "$PREVIOUS_RUNTIME_TARGET" in
    "$PREFIX/tools"/node-v*) ;;
    *)
      log "WARN: refusing to restore an unexpected runtime path: $PREVIOUS_RUNTIME_TARGET"
      return 1
      ;;
  esac

  # The failed install may have recreated the same versioned directory or
  # repointed the active alias to another version. Remove only the validated
  # installer-owned target, then put the previous runtime and wrapper back.
  /bin/rm -rf "$PREVIOUS_RUNTIME_TARGET"
  /bin/mv "$RUNTIME_ROLLBACK_DIR/node-runtime" "$PREVIOUS_RUNTIME_TARGET" || return 1
  /bin/ln -sfn "$PREVIOUS_RUNTIME_TARGET" "$PREFIX/tools/node" || return 1

  /bin/rm -f "$OPENCLAW_BIN"
  if [[ -f "$RUNTIME_ROLLBACK_DIR/openclaw-wrapper" ]]; then
    /bin/cp -a "$RUNTIME_ROLLBACK_DIR/openclaw-wrapper" "$OPENCLAW_BIN" || return 1
  fi
  for marker in .bundled-cli-package.sha256 .installer-runtime-applied; do
    /bin/rm -f "$PREFIX/$marker"
    if [[ -f "$RUNTIME_ROLLBACK_DIR/$marker" ]]; then
      /bin/cp -a "$RUNTIME_ROLLBACK_DIR/$marker" "$PREFIX/$marker" || return 1
    fi
  done
  /bin/rm -rf "$RUNTIME_ROLLBACK_DIR"
  RUNTIME_ROLLBACK_DIR=""
  PREVIOUS_RUNTIME_TARGET=""
  return 0
}

restart_previous_gateway() {
  [[ "$GATEWAY_WAS_LOADED" == "1" && -x "$OPENCLAW_BIN" ]] || return 0
  log "Restarting the Gateway on the restored CLI runtime."
  run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" OPENCLAW_PREFIX="$PREFIX" \
      "$OPENCLAW_BIN" gateway start --json >>"$LOG_FILE" 2>&1 \
    || log "WARN: Gateway recovery start failed; open OpenClaw.app to retry recovery."
}

stage_previous_runtime() {
  [[ -x "$OPENCLAW_BIN" ]] || return 0
  if [[ ! -d "$PREFIX/tools/node" ]]; then
    log "WARN: the existing CLI has no active private Node runtime; refusing to replace it without a rollback source."
    return 1
  fi
  PREVIOUS_RUNTIME_TARGET="$(cd "$PREFIX/tools/node" 2>/dev/null && /bin/pwd -P || true)"
  case "$PREVIOUS_RUNTIME_TARGET" in
    "$PREFIX/tools"/node-v*) ;;
    *)
      log "WARN: the existing CLI runtime is outside the installer-owned tools directory: $PREVIOUS_RUNTIME_TARGET"
      PREVIOUS_RUNTIME_TARGET=""
      return 1
      ;;
  esac

  RUNTIME_ROLLBACK_DIR="$PREFIX/backups/.pkg-runtime-rollback-$(/bin/date '+%Y%m%d-%H%M%S')-$$"
  /bin/mkdir -p "$RUNTIME_ROLLBACK_DIR" || return 1
  [[ ! -f "$OPENCLAW_BIN" ]] || /bin/cp -a "$OPENCLAW_BIN" "$RUNTIME_ROLLBACK_DIR/openclaw-wrapper" || return 1
  for marker in .bundled-cli-package.sha256 .installer-runtime-applied; do
    [[ ! -f "$PREFIX/$marker" ]] || /bin/cp -a "$PREFIX/$marker" "$RUNTIME_ROLLBACK_DIR/$marker" || return 1
  done
  printf '%s\n' "$PREVIOUS_RUNTIME_TARGET" >"$RUNTIME_ROLLBACK_DIR/runtime-target" || return 1
  /bin/mv "$PREVIOUS_RUNTIME_TARGET" "$RUNTIME_ROLLBACK_DIR/node-runtime" || return 1
  log "Previous CLI runtime staged for rollback in $RUNTIME_ROLLBACK_DIR"
  return 0
}

commit_runtime_upgrade() {
  [[ -n "$RUNTIME_ROLLBACK_DIR" ]] || return 0
  /bin/rm -rf "$RUNTIME_ROLLBACK_DIR"
  RUNTIME_ROLLBACK_DIR=""
  PREVIOUS_RUNTIME_TARGET=""
}

rollback_uncommitted_runtime_on_exit() {
  [[ -n "$RUNTIME_ROLLBACK_DIR" && -d "$RUNTIME_ROLLBACK_DIR/node-runtime" ]] || return 0
  log "Package installation ended before the runtime upgrade committed; restoring the previous CLI runtime."
  if restore_previous_runtime; then
    restart_previous_gateway
  else
    log "WARN: automatic runtime rollback failed; retained rollback files are available under $RUNTIME_ROLLBACK_DIR."
  fi
}
trap rollback_uncommitted_runtime_on_exit EXIT
trap 'exit 1' HUP INT TERM

# PackageKit termination or a machine restart can interrupt the small window
# between staging the old runtime and committing the new one. Reconcile that
# durable rollback record before trusting the installed-runtime marker.
PENDING_RUNTIME_ROLLBACK="$(/usr/bin/find "$PREFIX/backups" -maxdepth 1 -type d -name '.pkg-runtime-rollback-*' 2>/dev/null | /usr/bin/sort | /usr/bin/tail -n1)"
if [[ -n "$PENDING_RUNTIME_ROLLBACK" ]]; then
  RUNTIME_ROLLBACK_DIR="$PENDING_RUNTIME_ROLLBACK"
  PREVIOUS_RUNTIME_TARGET="$(/usr/bin/head -n1 "$RUNTIME_ROLLBACK_DIR/runtime-target" 2>/dev/null || true)"
  if restore_previous_runtime; then
    log "Recovered the previous CLI runtime from an interrupted package installation."
  else
    log "WARN: an interrupted package installation left an unusable rollback record at $RUNTIME_ROLLBACK_DIR; refusing to replace the runtime automatically."
    exit 0
  fi
fi

# A successful install records the exact bundled CLI archive. Reinstalling the
# same pkg does not need to unpack Node/npm dependencies or rerun the migration
# preflight. A user who manually restores older database files must still run
# Doctor; that visible recovery case does not justify making every ordinary
# reinstall repeat migration discovery.
if [[ -n "$RUNTIME_ID" && -x "$OPENCLAW_BIN" && -f "$RUNTIME_MARKER" ]]; then
  APPLIED_RUNTIME_ID="$(/usr/bin/head -n1 "$RUNTIME_MARKER" 2>/dev/null || true)"
  if [[ "$APPLIED_RUNTIME_ID" == "$RUNTIME_ID" ]]; then
    REUSE_INSTALLED_RUNTIME=1
  fi
fi

if [[ "$REUSE_INSTALLED_RUNTIME" != "1" ]] \
  && /bin/launchctl print "$GATEWAY_SERVICE_TARGET" >/dev/null 2>&1; then
  GATEWAY_WAS_LOADED=1
  log "==> Stopping the running Gateway before replacing its CLI runtime..."
  if [[ -x "$OPENCLAW_BIN" ]] \
    && run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" OPENCLAW_PREFIX="$PREFIX" \
      "$OPENCLAW_BIN" gateway stop --force --json >>"$LOG_FILE" 2>&1; then
    GATEWAY_STOPPED_FOR_RUNTIME=1
  else
    log "Gateway CLI stop failed; asking launchd to stop the existing service directly."
    /bin/launchctl bootout "$GATEWAY_SERVICE_TARGET" >>"$LOG_FILE" 2>&1 \
      && GATEWAY_STOPPED_FOR_RUNTIME=1
  fi
  if [[ "$GATEWAY_STOPPED_FOR_RUNTIME" != "1" ]] \
    || /bin/launchctl print "$GATEWAY_SERVICE_TARGET" >/dev/null 2>&1; then
    log "WARN: the running Gateway could not be stopped safely -- leaving its CLI runtime unchanged; first launch can retry the upgrade."
    exit 0
  fi
fi

if [[ "$REUSE_INSTALLED_RUNTIME" != "1" ]] && ! stage_previous_runtime; then
  if [[ -n "$RUNTIME_ROLLBACK_DIR" && ! -d "$RUNTIME_ROLLBACK_DIR/node-runtime" ]]; then
    /bin/rm -rf "$RUNTIME_ROLLBACK_DIR"
    RUNTIME_ROLLBACK_DIR=""
    PREVIOUS_RUNTIME_TARGET=""
  fi
  log "WARN: the existing runtime could not be staged safely -- leaving it unchanged; first launch can retry the upgrade."
  restart_previous_gateway
  exit 0
fi

if [[ "$REUSE_INSTALLED_RUNTIME" == "1" ]]; then
  log "Bundled CLI package is already installed and migrated -- reusing $OPENCLAW_BIN."
else
  log "==> Installing OpenClaw CLI into $PREFIX (this can take a minute)..."
  # This script owns Gateway stop/migration and daemon installation below. Keep
  # install-cli in runtime-only mode so it does not first refresh the loaded
  # Gateway service; that duplicate refresh consumed most of PackageKit's fixed
  # 600-second script allowance during an upgrade and caused error 112.
  if ! run_as_console_user /usr/bin/env \
      HOME="$CONSOLE_HOME" \
      OPENCLAW_PREFIX="$PREFIX" \
      OPENCLAW_NODE_TARBALL="$NODE_TARBALL" \
      OPENCLAW_NODE_TARBALL_SHA256="$NODE_TARBALL_SHA256" \
      OPENCLAW_POSTINSTALL_SCRIPT_OVERRIDE="$POSTINSTALL_SCRIPT_OVERRIDE" \
      OPENCLAW_PACKAGE_TGZ="$CLI_PACKAGE_TGZ" \
      OPENCLAW_PACKAGE_TGZ_SHA256="$CLI_PACKAGE_TGZ_SHA256" \
      /bin/bash "$INSTALL_CLI" --json --runtime-only >>"$LOG_FILE" 2>&1; then
    log "WARN: CLI install failed (see $LOG_FILE for install-cli.sh's own output above)."
    if restore_previous_runtime; then
      log "Restored the previous CLI runtime after the failed install."
      restart_previous_gateway
    else
      log "WARN: no previous CLI runtime was available to restore; first launch will use the app's onboarding recovery."
    fi
    exit 0
  fi
  log "CLI install finished."
fi

if [[ ! -x "$OPENCLAW_BIN" ]]; then
  log "WARN: $OPENCLAW_BIN not found after install-cli.sh reported success."
  if restore_previous_runtime; then
    log "Restored the previous CLI runtime after the incomplete install."
    restart_previous_gateway
  fi
  exit 0
fi

# ---------------------------------------------------------------------
# Upgrade over an existing install: run Doctor only for a structured migration
# or recovery finding. Gateway startup owns ordinary shared and agent database
# copy-and-swap upgrades; this preflight additionally catches held deletion
# journals that need Doctor's wider repair path. A preflight execution failure
# is only a warning and does not turn an unknown result into mutation authority.
# A fresh machine has no state yet, so nothing runs there. Best-effort like
# everything else here: a failure is logged and the install continues. When a
# structured finding does require Doctor, order matters:
#   1. stop the Gateway (it holds the databases; doctor refuses otherwise),
#   2. back up the config and databases (a migrated database cannot be opened
#      by the older CLI, and Doctor may migrate configured plugin entries),
#   3. doctor --fix --non-interactive (safe migrations only, no prompts).
# ---------------------------------------------------------------------
MIGRATION_OK=1
BACKUP_DIR=""
restore_migration_backup() {
  [[ -n "$BACKUP_DIR" && -d "$BACKUP_DIR" ]] || return 1
  if [[ -f "$BACKUP_DIR/openclaw.json" ]]; then
    run_as_console_user /bin/cp -a "$BACKUP_DIR/openclaw.json" "$PREFIX/openclaw.json" >>"$LOG_FILE" 2>&1 || return 1
  elif [[ -f "$BACKUP_DIR/.openclaw-json-absent" ]]; then
    run_as_console_user /bin/rm -f "$PREFIX/openclaw.json" >>"$LOG_FILE" 2>&1 || return 1
  fi
  # Remove the failed migration's database files and sidecars before copying
  # the stopped-Gateway snapshot back. Overlaying only the old main file could
  # leave a new WAL behind and replay pages written by the failed upgrade.
  for scope in state agents; do
    [[ -d "$PREFIX/$scope" ]] || continue
    while IFS= read -r CURRENT_DB_FILE; do
      run_as_console_user /bin/rm -f "$CURRENT_DB_FILE" >>"$LOG_FILE" 2>&1 </dev/null || return 1
    done < <(/usr/bin/find "$PREFIX/$scope" \( -name '*.sqlite' -o -name '*.sqlite-wal' -o -name '*.sqlite-shm' \) -type f 2>/dev/null)
  done
  for scope in state agents; do
    [[ -d "$BACKUP_DIR/$scope" ]] || continue
    while IFS= read -r BACKUP_FILE; do
      REL="${BACKUP_FILE#"$BACKUP_DIR"/}"
      run_as_console_user /bin/mkdir -p "$PREFIX/$(/usr/bin/dirname "$REL")" </dev/null || return 1
      run_as_console_user /bin/cp -a "$BACKUP_FILE" "$PREFIX/$REL" >>"$LOG_FILE" 2>&1 </dev/null || return 1
    done < <(/usr/bin/find "$BACKUP_DIR/$scope" -type f 2>/dev/null)
  done
  return 0
}

rollback_failed_upgrade() {
  local reason="$1"
  local restore_data="${2:-1}"
  log "Rolling back the failed upgrade: $reason"
  if [[ "$restore_data" == "1" && -n "$BACKUP_DIR" ]]; then
    restore_migration_backup \
      && log "Restored the pre-upgrade config and database files from $BACKUP_DIR." \
      || log "WARN: the pre-upgrade config/database restore was incomplete; backup remains in $BACKUP_DIR."
  fi
  if restore_previous_runtime; then
    log "Restored the previous CLI runtime."
    restart_previous_gateway
  else
    log "WARN: no previous CLI runtime was available to restore."
  fi
}

if [[ "$REUSE_INSTALLED_RUNTIME" != "1" && ( -d "$PREFIX/agents" || -e "$PREFIX/state/openclaw.sqlite" ) ]]; then
  DOCTOR_REQUIRED=0
  log "==> Checking whether existing OpenClaw data needs Doctor migration..."
  DOCTOR_PREFLIGHT_FILE="$(run_as_console_user /usr/bin/mktemp /tmp/openclaw-doctor-preflight.XXXXXX 2>/dev/null || true)"
  if [[ -z "$DOCTOR_PREFLIGHT_FILE" ]]; then
    log "WARN: Doctor preflight could not create its result file -- skipping automatic Doctor; Gateway startup will perform supported database upgrades."
  else
    run_as_console_user /usr/bin/env \
        HOME="$CONSOLE_HOME" \
        OPENCLAW_PREFIX="$PREFIX" \
        "$OPENCLAW_BIN" doctor --lint --only core/doctor/state-schema --json >"$DOCTOR_PREFLIGHT_FILE" 2>&1
    DOCTOR_PREFLIGHT_STATUS=$?
    /bin/cat "$DOCTOR_PREFLIGHT_FILE" >>"$LOG_FILE" 2>/dev/null || true
    if /usr/bin/grep -Eq \
        '"requirement"[[:space:]]*:[[:space:]]*"state-schema-migration-pending"|"checkId"[[:space:]]*:[[:space:]]*"core/doctor/agent-deletion-journal"' \
        "$DOCTOR_PREFLIGHT_FILE"; then
      DOCTOR_REQUIRED=1
      log "Doctor preflight found a database migration or deletion-journal recovery requirement -- running the guarded migration path."
    elif [[ "$DOCTOR_PREFLIGHT_STATUS" == "0" ]]; then
      log "Existing database state is current -- skipping full Doctor migration."
    else
      log "WARN: Doctor preflight could not inspect existing data (exit $DOCTOR_PREFLIGHT_STATUS) -- skipping automatic Doctor; Gateway startup will perform supported database upgrades."
    fi
    /bin/rm -f "$DOCTOR_PREFLIGHT_FILE"
  fi

  if [[ "$DOCTOR_REQUIRED" == "1" ]]; then
    log "==> Existing OpenClaw data found in $PREFIX -- migrating databases before the Gateway starts..."
    if /bin/launchctl print "$GATEWAY_SERVICE_TARGET" >/dev/null 2>&1; then
      run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" OPENCLAW_PREFIX="$PREFIX" \
          "$OPENCLAW_BIN" gateway stop --force >>"$LOG_FILE" 2>&1 \
        || log "Gateway stop returned non-zero; Doctor will report if a live owner still holds the databases."
      # Give a launchd-managed Gateway a moment to release its database locks.
      /bin/sleep 3
    fi

    BACKUP_DIR="$PREFIX/backups/pre-upgrade-$(/bin/date '+%Y%m%d-%H%M%S')"
    BACKUP_OK=1
    run_as_console_user /bin/mkdir -p "$BACKUP_DIR" || BACKUP_OK=0
    if [[ -f "$PREFIX/openclaw.json" ]]; then
      run_as_console_user /bin/cp -a "$PREFIX/openclaw.json" "$BACKUP_DIR/openclaw.json" >>"$LOG_FILE" 2>&1 || BACKUP_OK=0
    else
      run_as_console_user /usr/bin/touch "$BACKUP_DIR/.openclaw-json-absent" >>"$LOG_FILE" 2>&1 || BACKUP_OK=0
    fi
    if [[ -d "$PREFIX/state" ]]; then
      # Preserve active state databases and their journals, but not historical
      # pre-startup migration backups. Those are already rollback artifacts and
      # copying them into every pkg backup made repeat installs progressively slower.
      while IFS= read -r STATE_FILE; do
        REL="${STATE_FILE#"$PREFIX"/}"
        run_as_console_user /bin/mkdir -p "$BACKUP_DIR/$(/usr/bin/dirname "$REL")" </dev/null || BACKUP_OK=0
        run_as_console_user /bin/cp -a "$STATE_FILE" "$BACKUP_DIR/$REL" >>"$LOG_FILE" 2>&1 </dev/null || BACKUP_OK=0
      done < <(/usr/bin/find "$PREFIX/state" -type f ! -name '*.pre-startup-migration-*.bak' 2>/dev/null)
    fi
    if [[ -d "$PREFIX/agents" ]]; then
      # Only the databases (and their WAL/SHM files), not session transcripts or media.
      while IFS= read -r DB_FILE; do
        REL="${DB_FILE#"$PREFIX"/}"
        # </dev/null: keep launchctl/sudo from swallowing the loop's file list.
        run_as_console_user /bin/mkdir -p "$BACKUP_DIR/$(/usr/bin/dirname "$REL")" </dev/null || BACKUP_OK=0
        run_as_console_user /bin/cp -a "$DB_FILE" "$BACKUP_DIR/$REL" >>"$LOG_FILE" 2>&1 </dev/null || BACKUP_OK=0
      done < <(/usr/bin/find "$PREFIX/agents" \( -name '*.sqlite' -o -name '*.sqlite-wal' -o -name '*.sqlite-shm' \) -type f 2>/dev/null)
    fi

    if [[ "$BACKUP_OK" == "1" ]]; then
      log "Pre-upgrade backup written to $BACKUP_DIR"
      # This script, not Doctor, owns the stopped Gateway until onboarding below
      # installs/restarts it. Keep Doctor out of native service reconciliation so
      # it cannot spend PackageKit's script budget waiting for a Gateway that the
      # installer is about to replace. Keep bundled plugin discovery enabled: Doctor
      # needs the installed manifests and migration contracts to converge configured
      # plugins. Disabling discovery here records those plugins as missing and the
      # next Gateway then suppresses their tools.
      if run_as_console_user /usr/bin/env \
          HOME="$CONSOLE_HOME" \
          OPENCLAW_PREFIX="$PREFIX" \
          OPENCLAW_SERVICE_REPAIR_POLICY=external \
          "$OPENCLAW_BIN" doctor --fix --non-interactive --no-workspace-suggestions >>"$LOG_FILE" 2>&1; then
        log "Database migration (doctor --fix --non-interactive) finished."
      else
        MIGRATION_OK=0
        log "WARN: doctor --fix --non-interactive failed (see $LOG_FILE above). Backup is in $BACKUP_DIR. The Gateway may not start until 'openclaw doctor --fix' succeeds."
        rollback_failed_upgrade "Doctor migration failed"
        exit 0
      fi
    else
      MIGRATION_OK=0
      log "WARN: could not back up the existing config and databases to $BACKUP_DIR -- skipping the automatic migration so nothing is changed without a backup. Run 'openclaw doctor --fix' manually after backing up ~/.openclaw."
      rollback_failed_upgrade "the pre-upgrade backup could not be completed" 0
      exit 0
    fi
  fi
fi

if [[ "$REUSE_INSTALLED_RUNTIME" != "1" && "$MIGRATION_OK" == "1" && -n "$RUNTIME_ID" ]]; then
  run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" \
      /bin/bash -c 'printf "%s\n" "$1" > "$2"' _ "$RUNTIME_ID" "$RUNTIME_MARKER" >>"$LOG_FILE" 2>&1 \
    || log "WARN: could not record the installed runtime marker; a repeat install may redo CLI setup and Doctor."
fi
if [[ "$REUSE_INSTALLED_RUNTIME" != "1" && "$MIGRATION_OK" == "1" ]]; then
  commit_runtime_upgrade
fi

# ---------------------------------------------------------------------
# Default AI provider (optional): read the plain installer.env values
# scripts/build-mac-installer.sh baked into Contents/Resources/
# default-ai-provider.env, if any -- see installer.env.example. No file,
# or an empty base URL/model -- onboard still installs the Gateway/daemon
# below, it just leaves the model picker for the app's own onboarding UI.
# ---------------------------------------------------------------------
AI_PROVIDER=""
AI_BASE_URL=""
AI_MODEL=""
AI_API_KEY=""
ONBOARD_KEY_FILE=""
RESOLVED_MODEL_FILE=""
DEFAULT_PROVIDER_MODEL_REF=""
DEFAULT_PROVIDER_AUTH_ALREADY_APPLIED=0
DEFAULT_PROVIDER_SETUP_ALREADY_APPLIED=0
DEFAULT_PROVIDER_AUTH_ID=""
APPLY_DEFAULT_PROVIDER=1
ENV_FILE="$APP_PATH/Contents/Resources/default-ai-provider.env"
if [[ -f "$ENV_FILE" ]]; then
  DEFAULT_AI_PROVIDER=""
  DEFAULT_AI_BASE_URL=""
  DEFAULT_AI_MODEL=""
  DEFAULT_AI_API_KEY=""
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  AI_PROVIDER="$DEFAULT_AI_PROVIDER"
  AI_BASE_URL="$DEFAULT_AI_BASE_URL"
  AI_MODEL="$DEFAULT_AI_MODEL"
  AI_API_KEY="$DEFAULT_AI_API_KEY"
fi

ONBOARD_ARGS=(onboard --non-interactive --accept-risk --mode local --install-daemon
  --skip-health --skip-ui --skip-hooks --skip-channels --skip-search --skip-skills --skip-bootstrap)
DEFAULT_PROVIDER_SETUP="$APP_PATH/Contents/Resources/mac-default-provider-setup.sh"
ONBOARDING_ALREADY_COMPLETED=0
ONBOARDING_CONNECTION_MODE=""
HOSTS_LOCAL_GATEWAY_WITH_REMOTE_PRIMARY=0
if [[ -n "$APP_DEFAULTS_DOMAIN" ]]; then
  ONBOARDING_SEEN="$(run_as_console_user /usr/bin/defaults read "$APP_DEFAULTS_DOMAIN" "openclaw.onboardingSeen" 2>/dev/null || true)"
  ONBOARDING_CONNECTION_MODE="$(run_as_console_user /usr/bin/defaults read "$APP_DEFAULTS_DOMAIN" "openclaw.connectionMode" 2>/dev/null || true)"
  HOSTS_LOCAL_GATEWAY_RAW="$(run_as_console_user /usr/bin/defaults read "$APP_DEFAULTS_DOMAIN" "openclaw.localGateway.hostWithRemotePrimary" 2>/dev/null || true)"
  if [[ "$ONBOARDING_SEEN" == "1" || "$ONBOARDING_SEEN" == "true" || "$ONBOARDING_SEEN" == "YES" ]]; then
    ONBOARDING_ALREADY_COMPLETED=1
  fi
  if [[ "$HOSTS_LOCAL_GATEWAY_RAW" == "1" || "$HOSTS_LOCAL_GATEWAY_RAW" == "true" || "$HOSTS_LOCAL_GATEWAY_RAW" == "YES" ]]; then
    HOSTS_LOCAL_GATEWAY_WITH_REMOTE_PRIMARY=1
  fi
fi

# A remote app is only a client of the external Gateway. Its provider/model and
# credential owners live on that Gateway, so applying this Mac package's local
# preset would both target the wrong state and switch the app back to local.
if [[ "$ONBOARDING_CONNECTION_MODE" == "remote" ]]; then
  APPLY_DEFAULT_PROVIDER=0
  if [[ -n "$AI_BASE_URL" && -n "$AI_MODEL" ]]; then
    log "Remote connection mode is configured -- preserving it and leaving the bundled default model to the remote Gateway owner."
  fi
fi

default_provider_auth_binding_ready() {
  local model_ref="$1"
  [[ -n "$model_ref" ]] || return 1
  [[ -x "$DEFAULT_PROVIDER_SETUP" ]] || return 1
  run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" OPENCLAW_PREFIX="$PREFIX" \
    "$DEFAULT_PROVIDER_SETUP" --openclaw-bin "$OPENCLAW_BIN" --check-auth-binding \
      --expected-model-ref "$model_ref" \
    >/dev/null 2>&1
}

if [[ "$APPLY_DEFAULT_PROVIDER" == "1" && -n "$AI_BASE_URL" && -n "$AI_MODEL" ]]; then
  log "Configuring default AI provider from the bundled installer.env (base URL: $AI_BASE_URL, model: $AI_MODEL)"
  ENV_SHA256="$(/usr/bin/shasum -a 256 "$ENV_FILE" | /usr/bin/awk '{print $1}')"
  DEFAULT_PROVIDER_AUTH_ID="$(printf 'provider=%s\nbase_url=%s\nmodel=%s\napi_key=%s\n' \
    "$AI_PROVIDER" "$AI_BASE_URL" "$AI_MODEL" "$AI_API_KEY" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')"
  APPLIED_PROVIDER_AUTH_ID="$(/usr/bin/head -n1 "$PREFIX/.default-provider-auth-applied" 2>/dev/null || true)"
  APPLIED_PROVIDER_MODEL_REF="$(/usr/bin/sed -n '2p' "$PREFIX/.default-provider-auth-applied" 2>/dev/null || true)"
  if [[ -z "$APPLIED_PROVIDER_MODEL_REF" ]]; then
    APPLIED_PROVIDER_MODEL_REF="$(/usr/bin/sed -n '2p' "$PREFIX/.default-provider-applied" 2>/dev/null || true)"
  fi
  if [[ -n "$APPLIED_PROVIDER_AUTH_ID" && "$APPLIED_PROVIDER_AUTH_ID" == "$DEFAULT_PROVIDER_AUTH_ID" ]]; then
    if [[ -z "$AI_API_KEY" ]] || default_provider_auth_binding_ready "$APPLIED_PROVIDER_MODEL_REF"; then
      DEFAULT_PROVIDER_AUTH_ALREADY_APPLIED=1
      DEFAULT_PROVIDER_SETUP_ALREADY_APPLIED=1
      DEFAULT_PROVIDER_MODEL_REF="$APPLIED_PROVIDER_MODEL_REF"
    else
      log "The default-provider marker is stale because its credential binding is missing -- repairing it from this installer."
    fi
  elif [[ -f "$PREFIX/.default-provider-applied" ]]; then
    # Migrate installations made before the auth-only marker existed. The old
    # marker proves this exact bundled file completed onboarding once.
    APPLIED_DEFAULT_PROVIDER="$(/usr/bin/head -n1 "$PREFIX/.default-provider-applied" 2>/dev/null || true)"
    case "$APPLIED_DEFAULT_PROVIDER" in
      "$ENV_SHA256":*)
        LEGACY_PROVIDER_MODEL_REF="$(/usr/bin/sed -n '2p' "$PREFIX/.default-provider-applied" 2>/dev/null || true)"
        if [[ -z "$AI_API_KEY" ]] || default_provider_auth_binding_ready "$LEGACY_PROVIDER_MODEL_REF"; then
          DEFAULT_PROVIDER_AUTH_ALREADY_APPLIED=1
          DEFAULT_PROVIDER_SETUP_ALREADY_APPLIED=1
          DEFAULT_PROVIDER_MODEL_REF="$LEGACY_PROVIDER_MODEL_REF"
        else
          log "The legacy default-provider marker is stale because its credential binding is missing -- repairing it from this installer."
        fi
        ;;
    esac
  fi
  # The API key is handed to the default-provider setup owner through a
  # console-user-only file, never a process argument. After onboarding creates
  # or resolves the provider connection without a key, the live auth owner
  # updates the profile bound to that connection. Repeated installs therefore
  # update the same profile instead of accumulating inactive
  # <provider>:setup-<uuid> replacement credentials.
  # Saving even identical key bytes is an intentional account replacement and
  # retires persisted automation authorization. Avoid that on an ordinary CLI
  # upgrade. A changed provider, base URL, model or key fingerprint refreshes
  # the bundled registration and credential without replacing the user's
  # selected default model.
  if [[ -n "$AI_API_KEY" && "$DEFAULT_PROVIDER_AUTH_ALREADY_APPLIED" != "1" ]]; then
    ONBOARD_KEY_FILE="$(/usr/bin/mktemp /tmp/openclaw-onboard-key.XXXXXX)"
    /bin/chmod 600 "$ONBOARD_KEY_FILE"
    printf '%s' "$AI_API_KEY" > "$ONBOARD_KEY_FILE"
    /usr/sbin/chown "$CONSOLE_USER" "$ONBOARD_KEY_FILE"
  elif [[ -n "$AI_API_KEY" ]]; then
    log "Bundled default-provider settings are unchanged -- preserving the existing credential authorization."
  fi
else
  log "No default AI provider baked into this build -- setting up the Gateway/daemon only; the app will still ask for a model on first launch."
fi

ONBOARD_OK=0
ONBOARD_RAN=0
if [[ ( "$ONBOARDING_ALREADY_COMPLETED" == "1" || "$ONBOARDING_CONNECTION_MODE" == "remote" ) \
  && ( "$APPLY_DEFAULT_PROVIDER" != "1" || -z "$AI_BASE_URL" || -z "$AI_MODEL" || "$DEFAULT_PROVIDER_SETUP_ALREADY_APPLIED" == "1" ) ]]; then
  ONBOARD_OK=1
  log "Onboarding already completed -- skipping non-interactive onboarding."
  if [[ "$ONBOARDING_CONNECTION_MODE" != "remote" || "$HOSTS_LOCAL_GATEWAY_WITH_REMOTE_PRIMARY" == "1" ]]; then
    if [[ "$GATEWAY_WAS_LOADED" == "1" || -f "$GATEWAY_SERVICE_PLIST" ]]; then
      # `gateway start` preserves a matching service definition and repairs it
      # only when the new runtime or Gateway target actually changed. The old
      # `install --force` path rewrote and restarted an already-correct service.
      log "==> Starting the Gateway on the newly installed CLI (repairing its service definition only if needed)..."
      run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" OPENCLAW_PREFIX="$PREFIX" \
          "$OPENCLAW_BIN" gateway start --json >>"$LOG_FILE" 2>&1 \
        || log "WARN: Gateway service start failed (see $LOG_FILE above); onboarding remains completed and the app can retry service recovery."
    else
      log "==> No Gateway service definition exists; installing it once..."
      run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" OPENCLAW_PREFIX="$PREFIX" \
          "$OPENCLAW_BIN" gateway install --json >>"$LOG_FILE" 2>&1 \
        || log "WARN: Gateway service install failed (see $LOG_FILE above); onboarding remains completed and the app can retry service recovery."
    fi
  elif [[ "$ONBOARDING_CONNECTION_MODE" == "remote" ]]; then
    log "Remote connection mode is configured without a local companion Gateway -- leaving the local Gateway stopped."
  fi
else
  ONBOARD_RAN=1
  log "==> Running non-interactive onboarding (installs the Gateway LaunchAgent)..."
  if [[ "$APPLY_DEFAULT_PROVIDER" == "1" && -n "$AI_BASE_URL" && -n "$AI_MODEL" ]]; then
    SETUP_ARGS=(
      --openclaw-bin "$OPENCLAW_BIN"
      --base-url "$AI_BASE_URL"
      --model-id "$AI_MODEL"
      --install-daemon
    )
    RESOLVED_MODEL_FILE="$(/usr/bin/mktemp /tmp/openclaw-bundled-model.XXXXXX)"
    /bin/chmod 600 "$RESOLVED_MODEL_FILE"
    /usr/sbin/chown "$CONSOLE_USER" "$RESOLVED_MODEL_FILE"
    SETUP_ARGS+=(--resolved-model-file "$RESOLVED_MODEL_FILE")
    [[ -n "$AI_PROVIDER" ]] && SETUP_ARGS+=(--provider-id "$AI_PROVIDER")
    [[ -n "$ONBOARD_KEY_FILE" ]] && SETUP_ARGS+=(--api-key-file "$ONBOARD_KEY_FILE")
    if [[ -x "$DEFAULT_PROVIDER_SETUP" ]]; then
      run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" OPENCLAW_PREFIX="$PREFIX" \
          "$DEFAULT_PROVIDER_SETUP" "${SETUP_ARGS[@]}" >>"$LOG_FILE" 2>&1 && ONBOARD_OK=1
    else
      log "WARN: $DEFAULT_PROVIDER_SETUP is missing or not executable."
    fi
  else
    run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" OPENCLAW_PREFIX="$PREFIX" \
        "$OPENCLAW_BIN" "${ONBOARD_ARGS[@]}" >>"$LOG_FILE" 2>&1 && ONBOARD_OK=1
  fi
fi
[[ -n "$ONBOARD_KEY_FILE" ]] && /bin/rm -f "$ONBOARD_KEY_FILE"
if [[ "$ONBOARD_OK" == "1" ]]; then
  if [[ -n "$RESOLVED_MODEL_FILE" ]]; then
    DEFAULT_PROVIDER_MODEL_REF="$(/usr/bin/head -n1 "$RESOLVED_MODEL_FILE" 2>/dev/null || true)"
  fi
  [[ -n "$RESOLVED_MODEL_FILE" ]] && /bin/rm -f "$RESOLVED_MODEL_FILE"
  if [[ "$ONBOARD_RAN" == "1" ]]; then
    log "Onboarding finished."
  fi
  # The bundled default provider was just written (install and upgrade alike;
  # other providers/models and an existing user-selected default are kept).
  # Record the physical bundled model reference on line two, so the app can
  # verify this provider's auth without treating the user's current default as
  # the bundled model. This both skips repeated setup on later launches and
  # prevents a later install from switching Codex (or any other user choice)
  # back to the installer model. Must match AutoOnboardBootstrap's
  # defaultProviderMarkerValue(): "<sha256 of default-ai-provider.env>:<bundled
  # CLI package sha256, or 'none'>".
  if [[ "$APPLY_DEFAULT_PROVIDER" == "1" && -n "$AI_BASE_URL" && -n "$AI_MODEL" ]]; then
    DEFAULT_PROVIDER_MARKER="${ENV_SHA256}:${CLI_PACKAGE_TGZ_SHA256:-none}"
    run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" \
        /bin/bash -c 'printf "%s\n%s\n" "$1" "$2" > "$3"' _ "$DEFAULT_PROVIDER_MARKER" "$DEFAULT_PROVIDER_MODEL_REF" "$PREFIX/.default-provider-applied" >>"$LOG_FILE" 2>&1 \
      || log "WARN: could not record the default provider marker (non-fatal; the app may apply it once more on first launch)."
    run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" \
        /bin/bash -c 'printf "%s\n%s\n" "$1" "$2" > "$3"' _ "$DEFAULT_PROVIDER_AUTH_ID" "$DEFAULT_PROVIDER_MODEL_REF" "$PREFIX/.default-provider-auth-applied" >>"$LOG_FILE" 2>&1 \
      || log "WARN: could not record the default-provider auth marker; a later upgrade may ask the auth owner to save the same key again."
  fi
else
  [[ -n "$RESOLVED_MODEL_FILE" ]] && /bin/rm -f "$RESOLVED_MODEL_FILE"
  log "WARN: non-interactive onboarding failed (see $LOG_FILE above) -- first launch will fall back to the app's own onboarding UI."
fi

# Nexus preset (best-effort, no-op unless this build baked nexus-preset.env): enable the bundled Nexus plugin so
# the first launch already has it. The app runs the same script on every launch (once per preset version).
NEXUS_PRESET_SCRIPT="$APP_PATH/Contents/Resources/mac-nexus-preset.sh"
if [[ -f "$NEXUS_PRESET_SCRIPT" ]]; then
  run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" \
      /bin/bash "$NEXUS_PRESET_SCRIPT" --app-path "$APP_PATH" --prefix "$PREFIX" --repair-missing >>"$LOG_FILE" 2>&1 \
    || log "WARN: Nexus preset script failed (non-fatal)"
fi

# ---------------------------------------------------------------------
# Prime the app's own saved state so it skips straight to chat on first
# launch instead of showing its onboarding windows again. The connection
# mode itself (local/remote) is actually read live from the CLI config
# onboarding just wrote (see ConnectionModeResolver.swift), so it doesn't
# need spoofing here -- only onboardingSeen is read from this
# UserDefaults domain at launch (see AppState.swift's init).
# ---------------------------------------------------------------------
if [[ "$ONBOARD_OK" == "1" ]]; then
  if [[ -n "$APP_DEFAULTS_DOMAIN" ]]; then
    log "Marking onboarding as seen for $APP_DEFAULTS_DOMAIN"
    run_as_console_user /usr/bin/defaults write "$APP_DEFAULTS_DOMAIN" "openclaw.onboardingSeen" -bool true >>"$LOG_FILE" 2>&1
  else
    log "WARN: could not read CFBundleIdentifier from $APP_PATH/Contents/Info.plist -- app defaults not primed; first launch will show its own onboarding."
  fi
fi


# ---------------------------------------------------------------------
# llama.cpp local-model fallback (best-effort, backgrounded): if this
# build bundled a llama-server release for this Mac's arch (see
# scripts/build-mac-installer.sh step 3 / OPENCLAW_INSTALLER_DEFAULT_LLAMA_MODEL
# in installer.env), download its GGUF weights, start it, and register it
# as a *backup* model -- never touching the online default model
# configured above. Backgrounded because the GGUF download can take
# minutes and must not hold up Installer.app's own postinstall wait.
# ---------------------------------------------------------------------
# The local model (download of a ~2 GB GGUF, llama-server start) is NOT run
# from here: with it backgrounded from this script, Installer.app was observed
# to keep showing "Running package scripts" while the download ran, even
# with nohup/&. OpenClaw.app starts the same setup in the
# background on every launch (AutoOnboardBootstrap / MenuBar), so it simply
# happens on first launch instead, without holding up the installer.
log "Local model setup is deferred to OpenClaw.app's first launch."

log "OpenClaw postinstall finished."
exit 0
