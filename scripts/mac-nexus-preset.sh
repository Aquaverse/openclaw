#!/bin/bash
# Nexus Agent Core preset (best-effort, idempotent): turns the bundled Nexus plugin on for this user, so a fresh
# install of OpenClaw.app has Nexus working in the UI without the user touching `openclaw config`.
#
# It does exactly four things, all through the `openclaw` CLI the installer put in <prefix>/bin:
#   1. `plugins enable nexus-agent-core`
#   2. turns on the feature switches named by the build (default: tasks, decisions, claims, preferences, watchers, vault, evidence bytes)
#   3. makes sure the demo provider is the fake one (`fakeProviderMode` = "ok": no real external effect, ever)
#   4. appends Nexus' tools to `tools.alsoAllow`, keeping every entry already there and never duplicating
# then restarts the gateway once, only when it actually wrote something: every value is read first and left alone when
# it already is the target, so a second run (or a machine configured by hand) changes nothing and restarts nothing.
#
# It runs only when the build baked Contents/Resources/nexus-preset.env with NEXUS_PRESET=1 (installer.env key
# OPENCLAW_INSTALLER_NEXUS_PRESET=1, or the same variable in the build environment); otherwise it is a silent no-op.
# It is applied ONCE per preset version (marker <prefix>/.nexus-preset-applied), so a user who later turns a switch
# off, or removes a tool from the allow list, is not overridden on the next launch. Bump NEXUS_PRESET_VERSION in
# scripts/build-mac-installer.sh to re-apply.
#
# Called from scripts/mac-pkg-postinstall.sh (after onboarding) and from scripts/mac-llama-fallback-setup.sh, which
# OpenClaw.app starts on every launch; both already run as the logged-in user. Never exits non-zero.
#
# Usage: mac-nexus-preset.sh --app-path <OpenClaw.app> --prefix <~/.openclaw>

set -uo pipefail

APP_PATH=""
PREFIX=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-path) APP_PATH="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    *) shift ;;
  esac
done

LOG_FILE="${OPENCLAW_NEXUS_PRESET_LOG:-$HOME/Library/Logs/OpenClaw/nexus-preset.log}"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG_FILE" 2>/dev/null || true
}
soft_exit() {
  log "WARN: $* -- Nexus preset not (fully) applied; will retry on the next launch."
  exit 0
}

[[ -n "$APP_PATH" && -d "$APP_PATH" ]] || exit 0
[[ -n "$PREFIX" ]] || exit 0

ENV_FILE="$APP_PATH/Contents/Resources/nexus-preset.env"
[[ -f "$ENV_FILE" ]] || exit 0

# Data, not code: read single keys, never `source` it.
read_key() {
  /usr/bin/grep -E "^$1=" "$ENV_FILE" | /usr/bin/tail -n1 | /usr/bin/cut -d'=' -f2- | /usr/bin/tr -d '\r'
}
[[ "$(read_key NEXUS_PRESET)" == "1" ]] || exit 0
PRESET_VERSION="$(read_key NEXUS_PRESET_VERSION)"
PRESET_VERSION="${PRESET_VERSION:-1}"
SWITCHES="$(read_key NEXUS_PRESET_SWITCHES)"
SWITCHES="${SWITCHES:-tasksEnabled,decisionsEnabled,claimsEnabled,preferencesEnabled,watchersEnabled,vaultEnabled,evidenceBlobsEnabled}"

MARKER="$PREFIX/.nexus-preset-applied"
if [[ -f "$MARKER" && "$(/bin/cat "$MARKER" 2>/dev/null)" == "$PRESET_VERSION" ]]; then
  exit 0
fi

OPENCLAW_BIN="${OPENCLAW_BIN_OVERRIDE:-$PREFIX/bin/openclaw}"
NODE_BIN="${NODE_BIN_OVERRIDE:-$PREFIX/tools/node/bin/node}"
[[ -x "$OPENCLAW_BIN" ]] || soft_exit "$OPENCLAW_BIN not found (CLI install must finish first)"
[[ -x "$NODE_BIN" ]] || soft_exit "$NODE_BIN not found (Node install must finish first)"

# The tools Nexus registers (extensions/nexus-agent-core: *_TOOL_NAMES). The extension's manifest test keeps this
# list in step with the plugin; `nexus_spike_probe` is a Stage 0 probe and is deliberately not listed.
NEXUS_TOOLS="nexus_task_reserve nexus_task_create nexus_task_get nexus_task_update nexus_task_note nexus_task_search nexus_action_prepare nexus_action_authorize nexus_decision_request nexus_action_commit nexus_claim_add nexus_evidence_add nexus_claim_verify nexus_preference_get nexus_preference_set nexus_preference_confirm nexus_watch_create nexus_watch_cancel nexus_watch_report nexus_file_search nexus_file_get nexus_file_attach"

log "=================================================="
log "Nexus preset v$PRESET_VERSION starting (switches: $SWITCHES)"

oc() { "$OPENCLAW_BIN" "$@" >>"$LOG_FILE" 2>&1; }

CHANGED=0

# Current value of a config path as a bare scalar ("true", "ok"), or empty when unset/unreadable. The CLI prints the
# value as JSON; surrounding quotes and blank lines are dropped.
cfg_get() {
  local out
  out="$("$OPENCLAW_BIN" config get "$1" 2>/dev/null | /usr/bin/sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | /usr/bin/grep -v '^$' | /usr/bin/tail -n1)" || true
  out="${out#\"}"
  out="${out%\"}"
  printf '%s' "$out"
}

# Write only when the stored value differs. $1 path, $2 expected bare value, $3 value to write, $4 extra flag (optional).
ensure() {
  if [[ "$(cfg_get "$1")" == "$2" ]]; then
    log "already set: $1 = $2"
    return 0
  fi
  if [[ -n "${4:-}" ]]; then
    oc config set "$1" "$3" "$4" || return 1
  else
    oc config set "$1" "$3" || return 1
  fi
  CHANGED=1
  log "set: $1 = $2"
}

P="plugins.entries.nexus-agent-core"

# 1. Enable the plugin.
if [[ "$(cfg_get "$P.enabled")" == "true" ]]; then
  log "already enabled: nexus-agent-core"
else
  oc plugins enable nexus-agent-core || soft_exit "plugins enable nexus-agent-core failed"
  CHANGED=1
  log "enabled: nexus-agent-core"
fi

# 2. Feature switches (names are validated: letters only).
IFS=',' read -r -a SWITCH_LIST <<<"$SWITCHES"
for key in "${SWITCH_LIST[@]}"; do
  key="${key//[[:space:]]/}"
  [[ -n "$key" ]] || continue
  [[ "$key" =~ ^[A-Za-z]+$ ]] || soft_exit "refusing odd switch name '$key'"
  ensure "$P.config.$key" true true || soft_exit "config set $key failed"
done

# 3. The only provider that exists in this build is the fake one.
ensure "$P.config.fakeProviderMode" ok '"ok"' --strict-json || soft_exit "config set fakeProviderMode failed"

# 4. Append to tools.alsoAllow without losing or duplicating anything. `config get` prints the JSON array (or fails
# when the key is unset); node does the merge. Anything that is not a plain array of strings is left exactly as it is:
# this script only ever adds, it never rewrites what the user has.
CURRENT_FILE="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/nexus-preset-current.XXXXXX")" || soft_exit "mktemp failed"
MERGED_FILE="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/nexus-preset-merged.XXXXXX")" || soft_exit "mktemp failed"
trap '/bin/rm -f "$CURRENT_FILE" "$MERGED_FILE"' EXIT
"$OPENCLAW_BIN" config get tools.alsoAllow >"$CURRENT_FILE" 2>/dev/null || : >"$CURRENT_FILE"

"$NODE_BIN" -e '
const fs = require("node:fs");
const [currentFile, mergedFile, tools] = process.argv.slice(1);
const raw = fs.readFileSync(currentFile, "utf8");
let current = [];
const start = raw.indexOf("[");
const end = raw.lastIndexOf("]");
if (start !== -1 && end > start) {
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    process.exit(2); // present but unreadable: do not overwrite what the user has
  }
  // Fail closed on anything but a plain array of strings: dropping entries would silently delete user config.
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) process.exit(3);
  current = parsed;
} else if (raw.trim() !== "" && raw.trim() !== "null" && raw.trim() !== "undefined") {
  process.exit(2);
}
const merged = [...current];
for (const tool of tools.split(" ")) {
  if (tool && !merged.includes(tool)) merged.push(tool);
}
fs.writeFileSync(mergedFile, JSON.stringify(merged));
process.exit(merged.length === current.length ? 10 : 0);
' "$CURRENT_FILE" "$MERGED_FILE" "$NEXUS_TOOLS"
MERGE_STATUS=$?
case "$MERGE_STATUS" in
  0)
    oc config set tools.alsoAllow "$(/bin/cat "$MERGED_FILE")" --strict-json || soft_exit "config set tools.alsoAllow failed"
    CHANGED=1
    log "Appended Nexus tools to tools.alsoAllow"
    ;;
  10) log "tools.alsoAllow already contains every Nexus tool" ;;
  *)
    # Keep going: the switches written above still need the restart below. Only the marker is withheld.
    log "WARN: tools.alsoAllow is not a plain array of strings (status $MERGE_STATUS); left it untouched"
    ALLOW_FAILED=1
    ;;
esac

# One restart so the plugin loads with its switches, only if something was written. Best-effort: the gateway may not
# be installed yet (pkg postinstall) or the app may be about to start it, in which case it reads the new config anyway.
if [[ "$CHANGED" == "1" ]]; then
  if oc gateway restart; then
    log "Gateway restarted"
  else
    log "Gateway restart skipped or failed (not running yet?); the new config applies at its next start"
  fi
else
  log "Nothing to change; gateway left running"
fi

if [[ "${ALLOW_FAILED:-0}" == "1" ]]; then
  soft_exit "tools.alsoAllow could not be extended, so Nexus' tools stay hidden from agents until it is fixed"
fi

printf '%s' "$PRESET_VERSION" >"$MARKER" 2>/dev/null || log "WARN: could not write $MARKER (preset will re-run next launch)"
log "Nexus preset finished (config changed: $CHANGED)"
exit 0
