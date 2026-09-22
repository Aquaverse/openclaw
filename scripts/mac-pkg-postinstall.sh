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
  /bin/launchctl asuser "$CONSOLE_UID" /usr/bin/sudo -u "$CONSOLE_USER" -H "$@"
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
ARCH="$(/usr/bin/uname -m)"
NODE_RUNTIME_DIR="$APP_PATH/Contents/Resources/node-runtime"
NODE_TARBALL=""
NODE_TARBALL_SHA256=""
if [[ -d "$NODE_RUNTIME_DIR" ]]; then
  NODE_TARBALL="$(/usr/bin/find "$NODE_RUNTIME_DIR" -maxdepth 1 -iname "node-v*-darwin-${ARCH}.tar.gz" | /usr/bin/head -n1)"
  if [[ -n "$NODE_TARBALL" && -f "${NODE_TARBALL}.sha256" ]]; then
    NODE_TARBALL_SHA256="$(cat "${NODE_TARBALL}.sha256")"
  fi
fi
if [[ -n "$NODE_TARBALL" ]]; then
  log "Using bundled Node tarball: $NODE_TARBALL"
else
  log "No bundled Node tarball for arch '$ARCH' -- install-cli.sh will fetch Node from nodejs.org instead."
fi

PREFIX="$CONSOLE_HOME/.openclaw"

log "==> Installing OpenClaw CLI into $PREFIX (this can take a minute)..."
if ! run_as_console_user /usr/bin/env \
    HOME="$CONSOLE_HOME" \
    OPENCLAW_PREFIX="$PREFIX" \
    OPENCLAW_NODE_TARBALL="$NODE_TARBALL" \
    OPENCLAW_NODE_TARBALL_SHA256="$NODE_TARBALL_SHA256" \
    /bin/bash "$INSTALL_CLI" --json >>"$LOG_FILE" 2>&1; then
  log "WARN: CLI install failed (see $LOG_FILE for install-cli.sh's own output above) -- leaving first-run setup to the app's own onboarding UI."
  exit 0
fi
log "CLI install finished."

OPENCLAW_BIN="$PREFIX/bin/openclaw"
if [[ ! -x "$OPENCLAW_BIN" ]]; then
  log "WARN: $OPENCLAW_BIN not found after install-cli.sh reported success -- leaving first-run setup to the app's own onboarding UI."
  exit 0
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

if [[ -n "$AI_BASE_URL" && -n "$AI_MODEL" ]]; then
  log "Configuring default AI provider from the bundled installer.env (base URL: $AI_BASE_URL, model: $AI_MODEL)"
  ONBOARD_ARGS+=(--auth-choice custom-api-key --custom-base-url "$AI_BASE_URL" --custom-model-id "$AI_MODEL" --custom-compatibility openai)
  [[ -n "$AI_PROVIDER" ]] && ONBOARD_ARGS+=(--custom-provider-id "$AI_PROVIDER")
  [[ -n "$AI_API_KEY" ]] && ONBOARD_ARGS+=(--custom-api-key "$AI_API_KEY")
else
  log "No default AI provider baked into this build -- setting up the Gateway/daemon only; the app will still ask for a model on first launch."
fi

log "==> Running non-interactive onboarding (installs the Gateway LaunchAgent)..."
if run_as_console_user /usr/bin/env HOME="$CONSOLE_HOME" OPENCLAW_PREFIX="$PREFIX" \
    "$OPENCLAW_BIN" "${ONBOARD_ARGS[@]}" >>"$LOG_FILE" 2>&1; then
  log "Onboarding finished."
else
  log "WARN: non-interactive onboarding failed (see $LOG_FILE above) -- first launch will fall back to the app's own onboarding UI."
  exit 0
fi

# ---------------------------------------------------------------------
# Prime the app's own saved state so it skips straight to chat on first
# launch instead of showing its onboarding windows again. The connection
# mode itself (local/remote) is actually read live from the CLI config
# onboarding just wrote (see ConnectionModeResolver.swift), so it doesn't
# need spoofing here -- only onboardingSeen is read from this
# UserDefaults domain at launch (see AppState.swift's init).
# ---------------------------------------------------------------------
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP_PATH/Contents/Info.plist" 2>/dev/null || true)"
if [[ -n "$BUNDLE_ID" ]]; then
  log "Marking onboarding as seen for $BUNDLE_ID"
  run_as_console_user /usr/bin/defaults write "$BUNDLE_ID" "openclaw.onboardingSeen" -bool true >>"$LOG_FILE" 2>&1
  run_as_console_user /usr/bin/defaults write "$BUNDLE_ID" "openclaw.connectionMode" -string "local" >>"$LOG_FILE" 2>&1
else
  log "WARN: could not read CFBundleIdentifier from $APP_PATH/Contents/Info.plist -- app defaults not primed; first launch will show its own onboarding."
fi

log "OpenClaw postinstall finished."
exit 0
