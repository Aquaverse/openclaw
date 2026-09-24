#!/bin/bash
# Best-effort local-model fallback setup: unpacks the bundled llama-server
# release archive (see scripts/build-mac-installer.sh step 3), downloads the
# GGUF weights named by OPENCLAW_INSTALLER_DEFAULT_LLAMA_MODEL from
# HuggingFace, starts llama-server as a per-user LaunchAgent, and -- only
# once it actually answers health checks -- registers it with the CLI as a
# *backup* model (--custom-as-backup; see src/wizard/setup.model-auth.ts /
# src/commands/onboard-non-interactive/local/auth-choice.ts). The already
# -configured online default model, if any, is left untouched and stays
# primary the whole time.
#
# This script is deliberately best-effort end to end: on any failure it
# logs and exits 0 rather than aborting -- the app/pkg's own primary
# onboarding has already finished by the time this runs, so there is
# never a working setup for this to break, only an optional extra to skip.
# It is designed to be safely re-run (the dmg app runs it on every launch):
# each step first checks whether its result already exists and is valid
# before doing any work -- an already-healthy server is left running, an
# already-registered model is not re-registered, and a partial download
# resumes where it stopped. Concurrent runs are serialized by a lock.
#
# Invoked already running AS the logged-in console user (the pkg
# postinstall script wraps it with launchctl asuser/sudo -u, same as it
# wraps install-cli.sh and `openclaw onboard`; the dmg's
# AutoOnboardBootstrap.swift already runs as that user itself, being a
# GUI app) -- this script never elevates or re-execs as anyone else.
#
# Usage:
#   mac-llama-fallback-setup.sh --app-path <OpenClaw.app> --prefix <~/.openclaw>
#
# Env overrides:
#   OPENCLAW_LLAMA_FALLBACK_PORT   Port llama-server listens on (default 8687).
#   OPENCLAW_LLAMA_FALLBACK_CTX    Context size (default 4096).
#   OPENCLAW_LLAMA_FALLBACK_HEALTH_WAIT  Seconds to wait for the server to answer (default 600).
#   OPENCLAW_LLAMA_FALLBACK_REUSE_EXISTING  1 (default): register a llama-server the user
#                                  already runs instead of starting our own; 0: never.

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

LOG_FILE="${OPENCLAW_LLAMA_FALLBACK_LOG:-$HOME/Library/Logs/OpenClaw/llama-fallback-setup.log}"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE" >/dev/null
}

fail_soft() {
  log "WARN: $* -- leaving the local-model fallback unconfigured (online model, if any, is unaffected)."
  exit 0
}

[[ -n "$APP_PATH" && -d "$APP_PATH" ]] || fail_soft "no valid --app-path given ($APP_PATH)"
[[ -n "$PREFIX" ]] || fail_soft "no --prefix given"

log "=================================================="
log "llama fallback setup starting (app: $APP_PATH, prefix: $PREFIX)"

DEFAULT_AI_ENV="$APP_PATH/Contents/Resources/default-ai-provider.env"
DEFAULT_LLAMA_MODEL=""
if [[ -f "$DEFAULT_AI_ENV" ]]; then
  # Read just the one key this script needs. Never `source` this file: it is
  # data, not code, and it also carries the online provider's API key, which
  # has no business in this script's environment.
  DEFAULT_LLAMA_MODEL="$(/usr/bin/grep -E '^DEFAULT_LLAMA_MODEL=' "$DEFAULT_AI_ENV" | /usr/bin/tail -n1 | /usr/bin/cut -d'=' -f2- | /usr/bin/tr -d '\r')"
fi
[[ -n "${DEFAULT_LLAMA_MODEL:-}" ]] || fail_soft "no OPENCLAW_INSTALLER_DEFAULT_LLAMA_MODEL baked into this build"
log "Configured fallback model: $DEFAULT_LLAMA_MODEL"

OPENCLAW_BIN="$PREFIX/bin/openclaw"
[[ -x "$OPENCLAW_BIN" ]] || fail_soft "$OPENCLAW_BIN not found -- CLI install must finish first"

NODE_BIN="$PREFIX/tools/node/bin/node"
[[ -x "$NODE_BIN" ]] || fail_soft "$NODE_BIN not found -- Node install must finish first"

LLAMA_DIR="$PREFIX/llama"
mkdir -p "$LLAMA_DIR" || fail_soft "cannot create $LLAMA_DIR"

# ---------------------------------------------------------------------
# 0. Serialize runs. The app starts this script on every launch without
# waiting for it; quitting and reopening during a long model download would
# otherwise start a second copy writing the same files. A lock left behind
# by a run that died is reclaimed when its PID is gone.
# ---------------------------------------------------------------------
LOCK_DIR="$LLAMA_DIR/.setup.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log "Another setup run (pid $LOCK_PID) is in progress -- exiting."
    exit 0
  fi
  log "Reclaiming stale setup lock (pid ${LOCK_PID:-unknown} is gone)"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || fail_soft "could not acquire $LOCK_DIR"
fi
echo "$$" > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

# ---------------------------------------------------------------------
# Shared settings and helpers.
# ---------------------------------------------------------------------
PORT="${OPENCLAW_LLAMA_FALLBACK_PORT:-8687}"
CTX="${OPENCLAW_LLAMA_FALLBACK_CTX:-4096}"
MODEL_ALIAS="openclaw-local-fallback"
LAUNCH_AGENT_LABEL="ai.openclaw.llama-fallback"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT_PLIST="$LAUNCH_AGENT_DIR/${LAUNCH_AGENT_LABEL}.plist"
UID_NUM="$(/usr/bin/id -u)"
SERVICE_TARGET="gui/${UID_NUM}/${LAUNCH_AGENT_LABEL}"
CONFIG_FILE="$PREFIX/openclaw.json"

server_healthy() {
  /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

# register_fallback <provider id> <model id> <base url>
# Registers an OpenAI-compatible llama-server as an automatic fallback model
# (primary model untouched). No-op when that exact model/endpoint is already
# registered.
register_fallback() {
  local provider_id="$1" model_id="$2" base_url="$3"
  local model_ref="${provider_id}/${model_id}"
  local endpoint="${base_url#http://}"
  endpoint="${endpoint%/v1}"
  if [[ -f "$CONFIG_FILE" ]] && /usr/bin/grep -Fq "\"${model_ref}\"" "$CONFIG_FILE" \
    && /usr/bin/grep -Fq "$endpoint" "$CONFIG_FILE"; then
    log "$model_ref ($base_url) is already registered -- nothing to do."
    return 0
  fi

  # --custom-as-backup only exists in this repo's CLI build, which the app
  # installs from its bundled package (scripts/build-mac-installer.sh step 2d).
  # A CLI installed from the public npm registry instead rejects the flag.
  # Capture first, then search: piping straight into `grep -q` lets grep exit
  # at the first match and close the pipe, the CLI dies of SIGPIPE while still
  # writing the rest of the help text, and under `set -o pipefail` that failure
  # made a supporting CLI look unsupported.
  local onboard_help
  onboard_help="$("$OPENCLAW_BIN" onboard --help 2>/dev/null || true)"
  if ! /usr/bin/grep -q -- '--custom-as-backup' <<<"$onboard_help"; then
    fail_soft "the installed CLI ($("$OPENCLAW_BIN" --version 2>/dev/null | head -n1)) has no 'onboard --custom-as-backup'; reinstall with the app's bundled CLI package"
  fi

  log "Registering $model_ref ($base_url) as a fallback model"
  # A local llama-server needs no key; never let an inherited CUSTOM_API_KEY
  # be attached to it.
  if env -u CUSTOM_API_KEY "$OPENCLAW_BIN" onboard --non-interactive --accept-risk --mode local --skip-daemon \
      --skip-health --skip-ui --skip-hooks --skip-channels --skip-search --skip-skills --skip-bootstrap \
      --auth-choice custom-api-key \
      --custom-base-url "$base_url" \
      --custom-model-id "$model_id" \
      --custom-provider-id "$provider_id" \
      --custom-compatibility openai \
      --custom-as-backup >>"$LOG_FILE" 2>&1; then
    log "Registered $model_ref ($base_url) as an automatic fallback."
  else
    fail_soft "registering $model_ref with the CLI failed (see $LOG_FILE)"
  fi
}

# Prints "<pid>\t<port>\t<model id>" for the first llama-server this user is
# already running (not one started by this script) that answers on
# 127.0.0.1 without an API key; returns 1 when there is none.
find_existing_llama_server() {
  local pid exe port models model_id
  for pid in $(/usr/bin/pgrep -x llama-server 2>/dev/null); do
    exe="$(/bin/ps -o comm= -p "$pid" 2>/dev/null)"
    [[ "$exe" == "$LLAMA_DIR/"* ]] && continue
    while IFS= read -r port; do
      [[ -n "$port" ]] || continue
      /usr/bin/curl -fsS --max-time 3 "http://127.0.0.1:${port}/health" >/dev/null 2>&1 || continue
      models="$(/usr/bin/curl -fsS --max-time 3 "http://127.0.0.1:${port}/v1/models" 2>/dev/null)" || continue
      model_id="$(printf '%s' "$models" | "$NODE_BIN" -e '
        let raw = "";
        process.stdin.on("data", (chunk) => { raw += chunk; });
        process.stdin.on("end", () => {
          const first = (JSON.parse(raw).data || [])[0];
          if (!first || typeof first.id !== "string" || !first.id.trim()) process.exit(1);
          process.stdout.write(first.id.trim());
        });
      ' 2>/dev/null)" || continue
      [[ -n "$model_id" ]] || continue
      printf '%s\t%s\t%s\n' "$pid" "$port" "$model_id"
      return 0
    done < <(/usr/sbin/lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN -Fn 2>/dev/null \
      | /usr/bin/sed -n 's/^n.*:\([0-9][0-9]*\)$/\1/p' | /usr/bin/sort -u)
  done
  return 1
}

# ---------------------------------------------------------------------
# 0b. Reuse a llama-server the user already runs. Unless this script's own
# server is already set up (then keep using it), an existing llama-server
# that answers on 127.0.0.1 without an API key is registered as the fallback
# as-is -- no bundled runtime unpacked, no model downloaded, no second
# server started. Set OPENCLAW_LLAMA_FALLBACK_REUSE_EXISTING=0 to disable.
# ---------------------------------------------------------------------
if [[ "${OPENCLAW_LLAMA_FALLBACK_REUSE_EXISTING:-1}" == "1" ]] \
  && ! { [[ -f "$LAUNCH_AGENT_PLIST" ]] && /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; }; then
  if EXISTING_SERVER="$(find_existing_llama_server)"; then
    IFS=$'\t' read -r EXISTING_PID EXISTING_PORT EXISTING_MODEL <<<"$EXISTING_SERVER"
    log "Found a running llama-server (pid $EXISTING_PID) on 127.0.0.1:$EXISTING_PORT serving '$EXISTING_MODEL' -- using it instead of starting our own"
    register_fallback "llama-existing" "$EXISTING_MODEL" "http://127.0.0.1:${EXISTING_PORT}/v1"
    log "llama fallback setup finished."
    exit 0
  fi
fi

# ---------------------------------------------------------------------
# 1. Unpack the bundled llama-server release archive for this Mac's arch.
# ---------------------------------------------------------------------
ARCH="$(/usr/bin/uname -m)"
case "$ARCH" in
  arm64) MAC_ASSET_ARCH="arm64" ;;
  x86_64) MAC_ASSET_ARCH="x64" ;;
  *) fail_soft "unsupported arch '$ARCH'" ;;
esac

LLAMA_RUNTIME_DIR="$APP_PATH/Contents/Resources/llama-runtime"
# llama.cpp ships its macOS builds as .tar.gz now (older releases: .zip);
# scripts/build-mac-installer.sh bundles whichever the chosen release had.
BUNDLED_ARCHIVE=""
ARCHIVE_EXT=""
for CANDIDATE_EXT in tar.gz zip; do
  if [[ -f "$LLAMA_RUNTIME_DIR/llama-macos-${MAC_ASSET_ARCH}.${CANDIDATE_EXT}" ]]; then
    BUNDLED_ARCHIVE="$LLAMA_RUNTIME_DIR/llama-macos-${MAC_ASSET_ARCH}.${CANDIDATE_EXT}"
    ARCHIVE_EXT="$CANDIDATE_EXT"
    break
  fi
done
[[ -n "$BUNDLED_ARCHIVE" ]] || fail_soft "no bundled llama-server for arch '$MAC_ASSET_ARCH' in $LLAMA_RUNTIME_DIR -- SKIP_LLAMA_BUNDLE may have been set at build time"

if [[ -f "$BUNDLED_ARCHIVE.sha256" ]]; then
  EXPECTED_SHA="$(cat "$BUNDLED_ARCHIVE.sha256")"
  ACTUAL_SHA="$(/usr/bin/shasum -a 256 "$BUNDLED_ARCHIVE" | /usr/bin/awk '{print $1}')"
  [[ "$ACTUAL_SHA" == "$EXPECTED_SHA" ]] || fail_soft "bundled llama-server archive sha256 mismatch"
fi

RELEASE_TAG="$(cat "$LLAMA_RUNTIME_DIR/release-tag.txt" 2>/dev/null || echo unknown)"
# The release is unpacked as-is into one directory: llama-server finds its
# dylibs through @rpath relative to its own location, which differs between
# release layouts (same directory vs. a sibling lib/), so the tree is kept
# intact rather than copying selected files out of it.
LLAMA_RUNTIME_ROOT="$LLAMA_DIR/runtime"
INSTALLED_TAG_MARKER="$LLAMA_DIR/.installed-release-tag"
SERVER_PATH_MARKER="$LLAMA_DIR/.server-path"

SERVER_BIN="$(cat "$SERVER_PATH_MARKER" 2>/dev/null || true)"
if [[ -n "$SERVER_BIN" && -x "$SERVER_BIN" && "$(cat "$INSTALLED_TAG_MARKER" 2>/dev/null || true)" == "$RELEASE_TAG" ]]; then
  log "llama-server already unpacked at release $RELEASE_TAG -- reusing $SERVER_BIN"
else
  log "Unpacking $BUNDLED_ARCHIVE (release $RELEASE_TAG)"
  # "$LLAMA_DIR/bin" is the layout an earlier version of this script used.
  rm -rf "$LLAMA_RUNTIME_ROOT" "$LLAMA_DIR/bin" "$SERVER_PATH_MARKER" "$INSTALLED_TAG_MARKER"
  mkdir -p "$LLAMA_RUNTIME_ROOT"
  if [[ "$ARCHIVE_EXT" == "zip" ]]; then
    /usr/bin/ditto -x -k "$BUNDLED_ARCHIVE" "$LLAMA_RUNTIME_ROOT" >>"$LOG_FILE" 2>&1 \
      || fail_soft "failed to unzip $BUNDLED_ARCHIVE"
  else
    /usr/bin/tar -xzf "$BUNDLED_ARCHIVE" -C "$LLAMA_RUNTIME_ROOT" >>"$LOG_FILE" 2>&1 \
      || fail_soft "failed to extract $BUNDLED_ARCHIVE"
  fi
  SERVER_BIN="$(/usr/bin/find "$LLAMA_RUNTIME_ROOT" -type f -name 'llama-server' | head -n1)"
  [[ -n "$SERVER_BIN" ]] || fail_soft "llama-server binary not found inside $BUNDLED_ARCHIVE"
  chmod 0755 "$SERVER_BIN"
  # Files unpacked from inside a downloaded (dmg) app inherit its
  # com.apple.quarantine flag, which can make Gatekeeper refuse to run the
  # server when launchd starts it. This is our own bundled payload
  # (sha256-checked above), so clear the flag, then ad-hoc sign the dylibs
  # and the server in place.
  /usr/bin/xattr -dr com.apple.quarantine "$LLAMA_RUNTIME_ROOT" >>"$LOG_FILE" 2>&1 || true
  # Keep the release's own signature when it is still valid; only (re)sign
  # ad hoc what fails verification.
  while IFS= read -r -d '' MACHO_FILE; do
    /usr/bin/codesign --verify "$MACHO_FILE" >/dev/null 2>&1 \
      || /usr/bin/codesign --force --sign - "$MACHO_FILE" >>"$LOG_FILE" 2>&1 || true
  done < <(/usr/bin/find "$LLAMA_RUNTIME_ROOT" -type f \( -name '*.dylib' -o -path "$SERVER_BIN" \) -print0)
  echo "$SERVER_BIN" > "$SERVER_PATH_MARKER"
  echo "$RELEASE_TAG" > "$INSTALLED_TAG_MARKER"
fi

# ---------------------------------------------------------------------
# 2. Resolve which GGUF file to download. DEFAULT_LLAMA_MODEL is a
# HuggingFace repo id, optionally with ":<filename>" to pin an exact file
# (e.g. "Qwen/Qwen2.5-1.5B-Instruct-GGUF:qwen2.5-1.5b-instruct-q4_k_m.gguf").
# Without a pinned filename, query the HF API and pick the first .gguf
# matching a preferred quantization, falling back to the first .gguf found.
# ---------------------------------------------------------------------
HF_REPO="${DEFAULT_LLAMA_MODEL%%:*}"
if [[ "$DEFAULT_LLAMA_MODEL" == *:* ]]; then
  HF_FILE="${DEFAULT_LLAMA_MODEL#*:}"
else
  HF_FILE=""
fi

# Remember which file an unpinned repo resolved to, so later runs (every app
# launch) find the already-downloaded model without asking HuggingFace
# again -- and still work offline.
RESOLVED_MARKER="$LLAMA_DIR/models/.resolved-file"
if [[ -z "$HF_FILE" && -f "$RESOLVED_MARKER" ]]; then
  IFS=$'\t' read -r CACHED_REPO CACHED_FILE < "$RESOLVED_MARKER" || true
  if [[ "${CACHED_REPO:-}" == "$HF_REPO" && -n "${CACHED_FILE:-}" && -s "$LLAMA_DIR/models/$CACHED_FILE" ]]; then
    HF_FILE="$CACHED_FILE"
    log "Using previously resolved model file: $HF_REPO / $HF_FILE"
  fi
fi

if [[ -z "$HF_FILE" ]]; then
  log "Resolving a GGUF file from HuggingFace repo $HF_REPO"
  HF_FILE="$("$NODE_BIN" -e '
    const repo = process.argv[1];
    const prefs = ["q4_k_m", "q4_0", "q5_k_m", "q6_k", "q8_0"];
    // Encode each path segment, not the whole id: the API rejects an encoded
    // "/" between owner and name ("Qwen%2F...") with HTTP 400.
    fetch("https://huggingface.co/api/models/" + repo.split("/").map(encodeURIComponent).join("/"))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((data) => {
        const files = (data.siblings || [])
          .map((s) => s.rfilename)
          .filter((f) => typeof f === "string" && f.toLowerCase().endsWith(".gguf"));
        let chosen = null;
        for (const p of prefs) {
          chosen = files.find((f) => f.toLowerCase().includes(p));
          if (chosen) break;
        }
        if (!chosen) chosen = files[0];
        if (!chosen) throw new Error("no .gguf files found");
        process.stdout.write(chosen);
      })
      .catch((err) => {
        process.stderr.write(String(err) + "\n");
        process.exit(1);
      });
  ' "$HF_REPO" 2>>"$LOG_FILE")"
  [[ -n "$HF_FILE" ]] || fail_soft "could not resolve a GGUF file for repo $HF_REPO (see $LOG_FILE)"
fi
log "Resolved model file: $HF_REPO / $HF_FILE"

# ---------------------------------------------------------------------
# 3. Download the GGUF weights (idempotent: skipped if already present).
# ---------------------------------------------------------------------
MODELS_DIR="$LLAMA_DIR/models"
mkdir -p "$MODELS_DIR"
MODEL_PATH="$MODELS_DIR/$HF_FILE"
if [[ -s "$MODEL_PATH" ]]; then
  log "Model already downloaded at $MODEL_PATH -- reusing"
else
  MODEL_URL="https://huggingface.co/${HF_REPO}/resolve/main/${HF_FILE}"
  log "Downloading $MODEL_URL to $MODEL_PATH (this can take a while for larger models)"
  # -C - resumes a .part left by an interrupted run (app quit, the app's
  # own timeout, network drop) instead of starting a multi-GB file over.
  # The .part is deliberately kept on failure for the next run to resume.
  if ! /usr/bin/curl -fL --proto '=https' --tlsv1.2 --retry 3 -C - -o "$MODEL_PATH.part" "$MODEL_URL" >>"$LOG_FILE" 2>&1; then
    fail_soft "download of $MODEL_URL failed; will resume on the next run (see $LOG_FILE)"
  fi
  mv "$MODEL_PATH.part" "$MODEL_PATH"
  log "Download finished: $MODEL_PATH"
fi
printf '%s\t%s\n' "$HF_REPO" "$HF_FILE" > "$RESOLVED_MARKER"

# ---------------------------------------------------------------------
# 4. Start llama-server as a per-user LaunchAgent, pointed at the model.
# ---------------------------------------------------------------------
mkdir -p "$LAUNCH_AGENT_DIR"

# ProcessType is Interactive, not Background: on first start llama-server's
# Metal backend compiles its shader library from source through macOS's
# MTLCompilerService, and a Background-class process gets its compile
# requests deprioritized so far that startup was observed stalling for many
# minutes (llama-server stuck in ggml_metal_library_init / MTLCompilerScheduler).
PLIST_CANDIDATE="$LLAMA_DIR/.launch-agent.plist.new"
cat > "$PLIST_CANDIDATE" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${SERVER_BIN}</string>
    <string>--model</string>
    <string>${MODEL_PATH}</string>
    <string>--alias</string>
    <string>${MODEL_ALIAS}</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>${PORT}</string>
    <string>-c</string>
    <string>${CTX}</string>
    <string>--no-webui</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${HOME}/Library/Logs/OpenClaw/llama-fallback-server.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/Library/Logs/OpenClaw/llama-fallback-server.log</string>
</dict>
</plist>
PLIST_EOF

if /usr/bin/cmp -s "$PLIST_CANDIDATE" "$LAUNCH_AGENT_PLIST" \
  && /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1 \
  && server_healthy; then
  # Unchanged definition, loaded and answering: leave it running. Reloading
  # here would restart llama-server (and reload the model) on every app launch.
  rm -f "$PLIST_CANDIDATE"
  log "llama-server LaunchAgent unchanged and healthy on port $PORT -- leaving it running"
else
  log "Writing LaunchAgent $LAUNCH_AGENT_PLIST (port $PORT)"
  mv -f "$PLIST_CANDIDATE" "$LAUNCH_AGENT_PLIST"
  if /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
    /bin/launchctl bootout "$SERVICE_TARGET" >>"$LOG_FILE" 2>&1 || true
  fi
  # bootout returns before launchd has fully removed the label; bootstrapping
  # too early fails with "Bootstrap failed: 5". Wait for it to disappear.
  for _ in $(seq 1 20); do
    /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1 || break
    sleep 1
  done
  if ! /bin/launchctl bootstrap "gui/${UID_NUM}" "$LAUNCH_AGENT_PLIST" >>"$LOG_FILE" 2>&1; then
    fail_soft "launchctl bootstrap failed for $LAUNCH_AGENT_PLIST (see $LOG_FILE)"
  fi
  /bin/launchctl kickstart -k "$SERVICE_TARGET" >>"$LOG_FILE" 2>&1 || true
fi

# ---------------------------------------------------------------------
# 5. Wait for the server to actually answer, then register it with the
# CLI as a backup (non-primary) model -- never as a replacement for
# whatever online default model is already configured.
# ---------------------------------------------------------------------
# The very first start compiles the Metal shaders (can take minutes on older
# Apple Silicon); later starts reuse macOS's shader cache and take seconds.
HEALTH_WAIT_SECONDS="${OPENCLAW_LLAMA_FALLBACK_HEALTH_WAIT:-600}"
log "Waiting up to ${HEALTH_WAIT_SECONDS}s for llama-server to become healthy on 127.0.0.1:$PORT (first start compiles Metal shaders)"
HEALTHY=0
WAITED=0
while (( WAITED < HEALTH_WAIT_SECONDS )); do
  if server_healthy; then
    HEALTHY=1
    break
  fi
  sleep 2
  WAITED=$((WAITED + 2))
  if (( WAITED % 60 == 0 )); then
    log "  still waiting for llama-server (${WAITED}s)"
  fi
done
[[ "$HEALTHY" == "1" ]] || fail_soft "llama-server did not become healthy within ${HEALTH_WAIT_SECONDS}s (see ${HOME}/Library/Logs/OpenClaw/llama-fallback-server.log)"
log "llama-server became healthy after ${WAITED}s"
register_fallback "llama-local-fallback" "$MODEL_ALIAS" "http://127.0.0.1:${PORT}/v1"

log "llama fallback setup finished."
exit 0
