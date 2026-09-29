#!/bin/bash
# Local AI setup for the macOS app/pkg installs. Best-effort end to end (logs
# and exits 0 on any failure) and safe to re-run on every app launch. There
# is one local model: the small llama.cpp model of
# scripts/mac-llama-fallback-setup.sh (OPENCLAW_INSTALLER_DEFAULT_LLAMA_MODEL,
# a ~2B model that runs on 8-16 GB Macs). Two modes, from the build's
# installer.env settings (baked into Contents/Resources/default-ai-provider.env):
#
#   hybrid    DEFAULT_LITELLM_ENABLED=1 and a cloud model is registered: a
#             local LiteLLM proxy (scripts/mac-litellm-router-setup.sh) is the
#             primary model. The local model classifies each request; simple
#             ones it answers itself, the rest go to the models registered in
#             OpenClaw. The cloud model and the local model are fallbacks.
#   fallback  otherwise: the cloud model stays primary and the local model is
#             registered as its fallback (the original behavior).
#
# Model selection is only changed while it still is what the installer itself
# set up: once the user picks a different primary model, it is left alone.
#
# Usage:
#   mac-local-ai-setup.sh --app-path <OpenClaw.app> --prefix <~/.openclaw>
#
# Env overrides (testing/support):
#   OPENCLAW_LOCAL_AI_MODE   Force hybrid | fallback.

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

LOG_FILE="${OPENCLAW_LOCAL_AI_LOG:-$HOME/Library/Logs/OpenClaw/local-ai-setup.log}"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE" >/dev/null
}
finish() {
  log "local AI setup finished${1:+: $1}"
  exit 0
}

[[ -n "$APP_PATH" && -d "$APP_PATH" ]] || finish "no valid --app-path ($APP_PATH)"
[[ -n "$PREFIX" ]] || finish "no --prefix"

RESOURCES="$APP_PATH/Contents/Resources"
ENV_FILE="$RESOURCES/default-ai-provider.env"
LLAMA_SCRIPT="$RESOURCES/mac-llama-fallback-setup.sh"
LITELLM_SCRIPT="$RESOURCES/mac-litellm-router-setup.sh"
OPENCLAW_BIN="$PREFIX/bin/openclaw"
NODE_BIN="$PREFIX/tools/node/bin/node"
STATE_DIR="$PREFIX/local-ai"
ROUTER_MODEL_REF="litellm-router/adaptive"
ROUTER_SERVICE_TARGET="gui/$(/usr/bin/id -u)/ai.openclaw.litellm-router"

log "=================================================="
log "local AI setup starting (app: $APP_PATH, prefix: $PREFIX)"

[[ -f "$ENV_FILE" ]] || finish "no default-ai-provider.env in this build"
[[ -f "$LLAMA_SCRIPT" ]] || finish "no bundled mac-llama-fallback-setup.sh"
[[ -x "$OPENCLAW_BIN" ]] || finish "$OPENCLAW_BIN not found -- CLI install must finish first"
[[ -x "$NODE_BIN" ]] || finish "$NODE_BIN not found -- Node install must finish first"

# Reads one KEY=value line; the file is data, never sourced.
env_value() {
  /usr/bin/grep -E "^$1=" "$ENV_FILE" | /usr/bin/tail -n1 | /usr/bin/cut -d'=' -f2- | /usr/bin/tr -d '\r'
}
SMALL_MODEL="$(env_value DEFAULT_LLAMA_MODEL)"
LITELLM_ENABLED="$(env_value DEFAULT_LITELLM_ENABLED)"
CLOUD_PROVIDER="$(env_value DEFAULT_AI_PROVIDER)"
CLOUD_BASE_URL="$(env_value DEFAULT_AI_BASE_URL)"
CLOUD_MODEL="$(env_value DEFAULT_AI_MODEL)"

# The cloud model's ref as onboarding actually registered it. onboard derives
# the provider id from the base URL when DEFAULT_AI_PROVIDER is empty, and
# renames it when that id is taken by another endpoint, so the id is looked
# up by base URL + model id instead of being guessed.
resolve_cloud_model_ref() {
  [[ -n "$CLOUD_BASE_URL" && -n "$CLOUD_MODEL" ]] || return 1
  "$OPENCLAW_BIN" config get models.providers --json 2>/dev/null | "$NODE_BIN" -e '
    const [baseUrl, modelId, preferred] = process.argv.slice(1);
    const norm = (u) => String(u || "").trim().replace(/\/+$/, "").toLowerCase();
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let providers = {};
      try { providers = JSON.parse(raw) || {}; } catch {}
      const hits = Object.entries(providers).filter(([, p]) =>
        p && norm(p.baseUrl) === norm(baseUrl)
        && Array.isArray(p.models) && p.models.some((m) => m && m.id === modelId));
      if (!hits.length) process.exit(1);
      const hit = hits.find(([id]) => id === preferred) || hits[0];
      process.stdout.write(hit[0] + "/" + modelId);
    });
  ' "$CLOUD_BASE_URL" "$CLOUD_MODEL" "$CLOUD_PROVIDER" 2>/dev/null
}
CLOUD_MODEL_REF="$(resolve_cloud_model_ref || true)"
if [[ -n "$CLOUD_BASE_URL" && -n "$CLOUD_MODEL" && -z "$CLOUD_MODEL_REF" ]]; then
  log "WARN: the cloud model $CLOUD_MODEL ($CLOUD_BASE_URL) is not registered yet -- treating this run as having no cloud model"
fi

mkdir -p "$STATE_DIR" || finish "cannot create $STATE_DIR"
LOCK_DIR="$STATE_DIR/.setup.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log "Another setup run (pid $LOCK_PID) is in progress -- exiting."
    exit 0
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || finish "could not acquire $LOCK_DIR"
fi
echo "$$" > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

# ---------------------------------------------------------------------
# 1. Pick the mode from hardware + build settings.
# ---------------------------------------------------------------------
MEM_BYTES="$(/usr/sbin/sysctl -n hw.memsize 2>/dev/null || echo 0)"
MEM_GB=$((MEM_BYTES / 1024 / 1024 / 1024))
CPU_NAME="$(/usr/sbin/sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"
MODE="fallback"
if [[ "$LITELLM_ENABLED" == "1" && -n "$CLOUD_MODEL_REF" && -n "$SMALL_MODEL" && -f "$LITELLM_SCRIPT" ]]; then
  MODE="hybrid"
fi
case "${OPENCLAW_LOCAL_AI_MODE:-}" in
  hybrid | fallback) MODE="$OPENCLAW_LOCAL_AI_MODE" ;;
esac
log "Hardware: ${CPU_NAME}, ${MEM_GB} GB memory -> mode: $MODE"

# Runs the unchanged llama.cpp setup, then finds the local model it
# registered and checks that it answers: LOCAL_MODEL_REF, LOCAL_BASE_URL.
# That is our own llama-server (provider llama-local-fallback) or, when the
# user already runs one with the configured model, theirs (llama-existing).
LOCAL_MODEL_REF=""
LOCAL_BASE_URL=""
run_llama_setup() {
  OPENCLAW_LOCAL_AI_ORCHESTRATED=1 /bin/bash "$LLAMA_SCRIPT" --app-path "$APP_PATH" --prefix "$PREFIX"
  LOCAL_MODEL_REF="" LOCAL_BASE_URL=""
  local ref url
  while IFS=$'\t' read -r ref url; do
    [[ -n "$ref" && -n "$url" ]] || continue
    if /usr/bin/curl -fsS --max-time 3 "${url%/v1}/health" >/dev/null 2>&1; then
      LOCAL_MODEL_REF="$ref"
      LOCAL_BASE_URL="$url"
      return 0
    fi
  done < <("$OPENCLAW_BIN" config get models.providers --json 2>/dev/null | "$NODE_BIN" -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let providers = {};
      try { providers = JSON.parse(raw) || {}; } catch {}
      for (const id of ["llama-local-fallback", "llama-existing"]) {
        const p = providers[id];
        const model = p && Array.isArray(p.models) && p.models[0] && p.models[0].id;
        if (model && typeof p.baseUrl === "string") process.stdout.write(id + "/" + model + "\t" + p.baseUrl.replace(/\/+$/, "") + "\n");
      }
    });
  ' 2>/dev/null)
  return 1
}
local_server_healthy() {
  [[ -n "$LOCAL_BASE_URL" ]] \
    && /usr/bin/curl -fsS --max-time 3 "${LOCAL_BASE_URL%/v1}/health" >/dev/null 2>&1
}
# The router only belongs to the hybrid mode. Outside it, its process is
# stopped once the model selection no longer uses it (its files and
# registration stay, so switching back is quick).
stop_router_unless_selected() { # $1 = selection signature
  [[ "$MODE" != "hybrid" && "$1" != *"$ROUTER_MODEL_REF"* ]] || return 0
  if /bin/launchctl print "$ROUTER_SERVICE_TARGET" >/dev/null 2>&1; then
    log "Stopping the LiteLLM router (mode $MODE does not use it)"
    /bin/launchctl bootout "$ROUTER_SERVICE_TARGET" >>"$LOG_FILE" 2>&1 || true
  fi
}

# ---------------------------------------------------------------------
# 2. Bring up what the mode needs, and decide the model selection.
# ---------------------------------------------------------------------
DESIRED_PRIMARY=""
DESIRED_FALLBACKS=()
case "$MODE" in
  hybrid)
    [[ -n "$CLOUD_MODEL_REF" ]] || finish "hybrid mode needs a registered cloud model; model selection unchanged"
    run_llama_setup \
      || finish "small local model is not serving yet (see llama-fallback-setup.log); model selection unchanged"
    if ! /bin/bash "$LITELLM_SCRIPT" --app-path "$APP_PATH" --prefix "$PREFIX" \
      --local-base-url "$LOCAL_BASE_URL" --local-model "${LOCAL_MODEL_REF#*/}" \
      --local-ref "$LOCAL_MODEL_REF" \
      --default-model "$CLOUD_MODEL_REF"; then
      finish "LiteLLM router is not ready (see litellm-router-setup.log); model selection unchanged"
    fi
    DESIRED_PRIMARY="$ROUTER_MODEL_REF"
    DESIRED_FALLBACKS=("$CLOUD_MODEL_REF" "$LOCAL_MODEL_REF")
    ;;
  fallback)
    [[ -n "$SMALL_MODEL" ]] || finish "no small local model configured"
    run_llama_setup || true
    if [[ -n "$CLOUD_MODEL_REF" ]]; then
      DESIRED_PRIMARY="$CLOUD_MODEL_REF"
      local_server_healthy && DESIRED_FALLBACKS=("$LOCAL_MODEL_REF")
    fi
    ;;
esac
[[ -n "$DESIRED_PRIMARY" ]] || finish "nothing to select"

# ---------------------------------------------------------------------
# 3. Apply the model selection -- only while it is still the installer's.
# ---------------------------------------------------------------------
STATE_FILE="$STATE_DIR/applied-selection"
selection_signature() { # stdin: `openclaw config get agents.defaults.model --json`
  "$NODE_BIN" -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let value;
      try { value = JSON.parse(raw); } catch { value = undefined; }
      if (typeof value === "string") value = { primary: value };
      const primary = (value && typeof value.primary === "string") ? value.primary : "";
      const fallbacks = (value && Array.isArray(value.fallbacks)) ? value.fallbacks : [];
      process.stdout.write(primary + "|" + fallbacks.join(","));
    });
  '
}
CURRENT_SIG="$("$OPENCLAW_BIN" config get agents.defaults.model --json 2>/dev/null | selection_signature)"
DESIRED_SIG="${DESIRED_PRIMARY}|$(IFS=,; echo "${DESIRED_FALLBACKS[*]:-}")"
LAST_SIG="$(cat "$STATE_FILE" 2>/dev/null || true)"
CURRENT_PRIMARY="${CURRENT_SIG%%|*}"
LAST_PRIMARY="${LAST_SIG%%|*}"

if [[ "$CURRENT_SIG" == "$DESIRED_SIG" ]]; then
  echo "$DESIRED_SIG" > "$STATE_FILE"
  stop_router_unless_selected "$CURRENT_SIG"
  finish "model selection already $DESIRED_SIG (mode $MODE)"
fi
# Ours to change: nothing chosen yet, the installer's own cloud default (e.g.
# re-applied by a CLI refresh), or exactly what this script applied last time.
if [[ -n "$CURRENT_PRIMARY" && "$CURRENT_PRIMARY" != "$CLOUD_MODEL_REF" \
  && "$CURRENT_PRIMARY" != "$LAST_PRIMARY" && "$CURRENT_PRIMARY" != "$DESIRED_PRIMARY" ]]; then
  stop_router_unless_selected "$CURRENT_SIG"
  finish "primary model '$CURRENT_PRIMARY' was chosen by the user -- leaving model selection alone (mode $MODE would use $DESIRED_SIG)"
fi

log "Applying model selection for mode $MODE: primary $DESIRED_PRIMARY, fallbacks ${DESIRED_FALLBACKS[*]:-none} (was: ${CURRENT_SIG:-none})"
if ! "$OPENCLAW_BIN" models set "$DESIRED_PRIMARY" >>"$LOG_FILE" 2>&1; then
  finish "could not set primary model $DESIRED_PRIMARY (see above)"
fi
"$OPENCLAW_BIN" models fallbacks clear >>"$LOG_FILE" 2>&1 || true
for FALLBACK_REF in "${DESIRED_FALLBACKS[@]+"${DESIRED_FALLBACKS[@]}"}"; do
  "$OPENCLAW_BIN" models fallbacks add "$FALLBACK_REF" >>"$LOG_FILE" 2>&1 \
    || log "WARN: could not add fallback $FALLBACK_REF"
done
APPLIED_SIG="$("$OPENCLAW_BIN" config get agents.defaults.model --json 2>/dev/null | selection_signature)"
echo "$APPLIED_SIG" > "$STATE_FILE"
stop_router_unless_selected "$APPLIED_SIG"
finish "model selection now $APPLIED_SIG (mode $MODE)"
