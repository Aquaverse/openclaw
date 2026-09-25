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
#   OPENCLAW_LLAMA_FALLBACK_CTX    Context size; overrides the build's installer.env value
#                                  (DEFAULT_LLAMA_CTX). Leave unset to select
#                                  32768 normally or model-native context when
#                                  more than 10 GiB of memory is available. Set
#                                  0 explicitly to always use model-native context.
#   OPENCLAW_LLAMA_FALLBACK_HEALTH_WAIT  Seconds to wait for the server to answer (default 600).
#   OPENCLAW_LLAMA_FALLBACK_REUSE_EXISTING  1 (default): register a llama-server the user
#                                  already runs instead of starting our own; 0: never.
#                                  A running server is reused only when its model
#                                  filename matches the configured App model.

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
MODELS_DIR="$LLAMA_DIR/models"
RESOLVED_MARKER="$MODELS_DIR/.resolved-file"
AUTO_CTX_MARKER="$LLAMA_DIR/.auto-context"

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
# OpenClaw's agent requests carry a long system prompt plus tool schemas.
# Explicit environment and baked settings take precedence. With neither set,
# context is selected after the model is resolved so the choice can be kept
# stable across subsequent app launches.
BAKED_CTX=""
if [[ -f "$DEFAULT_AI_ENV" ]]; then
  BAKED_CTX="$(/usr/bin/grep -E '^DEFAULT_LLAMA_CTX=' "$DEFAULT_AI_ENV" | /usr/bin/tail -n1 | /usr/bin/cut -d'=' -f2- | /usr/bin/tr -d '\r')"
fi
CTX_SETTING="${OPENCLAW_LLAMA_FALLBACK_CTX:-${BAKED_CTX:-}}"
AUTO_CTX=0
if [[ -z "$CTX_SETTING" ]]; then
  AUTO_CTX=1
  CTX=""
elif [[ "$CTX_SETTING" =~ ^[0-9]+$ ]] && (( CTX_SETTING == 0 || CTX_SETTING >= 4096 )); then
  CTX="$CTX_SETTING"
else
  log "WARN: invalid context size '$CTX_SETTING' -- selecting context from available memory"
  AUTO_CTX=1
  CTX=""
fi
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

available_memory_bytes() {
  /usr/bin/vm_stat 2>/dev/null | /usr/bin/awk '
    NR == 1 {
      if (match($0, /page size of [0-9]+ bytes/)) {
        value = substr($0, RSTART, RLENGTH)
        gsub(/[^0-9]/, "", value)
        page_size = value + 0
      }
      next
    }
    /^Pages free:|^Pages inactive:|^Pages speculative:/ {
      value = $0
      sub(/^[^:]+:[[:space:]]*/, "", value)
      gsub(/\./, "", value)
      pages += value + 0
    }
    END {
      if (page_size > 0) printf "%.0f\n", pages * page_size
    }
  '
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

# sync_context_window <provider id> <model id> <base url> [fallback n_ctx]
# Custom providers are registered with a 128k context window by default, so
# OpenClaw would keep sending prompts far beyond what llama-server was started
# with instead of compacting the session first. Record the server's real
# context size (from its /props, else the given fallback) on the model entry.
# Re-registration keeps an existing contextWindow, so this sticks.
sync_context_window() {
  local provider_id="$1" model_id="$2" base_url="$3" fallback_ctx="${4:-}"
  local server_root="${base_url%/v1}" n_ctx models_json model_index current_ctx
  n_ctx="$(/usr/bin/curl -fsS --max-time 5 "${server_root}/props" 2>/dev/null | "$NODE_BIN" -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const props = JSON.parse(raw);
        const value = props?.default_generation_settings?.n_ctx ?? props?.n_ctx;
        if (Number.isInteger(value) && value > 0) process.stdout.write(String(value));
      } catch {}
    });
  ' 2>/dev/null || true)"
  n_ctx="${n_ctx:-$fallback_ctx}"
  if [[ ! "$n_ctx" =~ ^[0-9]+$ ]]; then
    log "Could not determine the context size of ${base_url}; leaving ${provider_id}/${model_id} context window as registered"
    return 0
  fi
  models_json="$("$OPENCLAW_BIN" config get "models.providers.${provider_id}.models" --json 2>/dev/null || true)"
  read -r model_index current_ctx < <(printf '%s' "$models_json" | "$NODE_BIN" -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let models = [];
      try { models = JSON.parse(raw); } catch {}
      const index = Array.isArray(models) ? models.findIndex((m) => m && m.id === process.argv[1]) : -1;
      if (index >= 0) process.stdout.write(index + " " + (models[index].contextWindow ?? ""));
    });
  ' "$model_id" 2>/dev/null)
  if [[ -z "${model_index:-}" ]]; then
    log "WARN: ${provider_id}/${model_id} not found in config; cannot record its ${n_ctx}-token context window"
    return 0
  fi
  if [[ "${current_ctx:-}" == "$n_ctx" ]]; then
    return 0
  fi
  if "$OPENCLAW_BIN" config set "models.providers.${provider_id}.models[${model_index}].contextWindow" "$n_ctx" >>"$LOG_FILE" 2>&1; then
    log "Recorded ${provider_id}/${model_id} context window: ${n_ctx} tokens (was ${current_ctx:-unset})"
  else
    log "WARN: could not record the ${n_ctx}-token context window for ${provider_id}/${model_id} (see above)"
  fi
}

# ensure_local_service <provider id> <port> <launchd|external>
# Marks the provider as a local model server (models.providers.<id>.localService).
# OpenClaw then enables Tool Search automatically for that provider only: its
# requests carry a few search/describe/call tools instead of every tool schema
# (~34k tokens, more than the local context window), while the online primary
# model keeps its normal tool list. A global tools.toolSearch setting overrides
# this per-provider default, so this function never sets one.
# OpenClaw probes healthUrl before each request to this provider and runs the
# command only when the probe fails. The command is ensure-llama-server.sh,
# which defers to launchd and never starts llama-server itself, so OpenClaw
# can never end up running a second server on the same port.
ensure_local_service() {
  local provider_id="$1" port="$2" mode="$3"
  local helper="$LLAMA_DIR/ensure-llama-server.sh" helper_tmp desired current global_tool_search
  if ! helper_tmp="$(/usr/bin/mktemp "$LLAMA_DIR/.ensure-llama-server.XXXXXX")"; then
    log "WARN: could not write $helper; ${provider_id} stays without automatic Tool Search"
    return 0
  fi
  cat > "$helper_tmp" <<'HELPER_EOF'
#!/bin/bash
# Generated by mac-llama-fallback-setup.sh -- rewritten on every app launch.
#
# OpenClaw runs this (models.providers.<id>.localService.command) only when
# the local fallback model's health probe fails right before a request.
# llama-server is owned by launchd (LaunchAgent ai.openclaw.llama-fallback);
# this never starts it directly. It asks launchd to start the agent when it
# is not running, waits for /health, and exits 0 when healthy, 1 otherwise.
set -u
PORT="" TARGET="" PLIST="" LOCK_DIR="" WAIT=170
while (( $# >= 2 )); do
  case "$1" in
    --port) PORT="$2" ;;
    --launchd-target) TARGET="$2" ;;
    --plist) PLIST="$2" ;;
    --lock-dir) LOCK_DIR="$2" ;;
    --wait) WAIT="$2" ;;
  esac
  shift 2
done
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "ensure-llama-server: invalid --port '$PORT'" >&2; exit 2; }
[[ "$WAIT" =~ ^[0-9]+$ ]] || WAIT=170

healthy() {
  /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}
setup_running() {
  [[ -n "$LOCK_DIR" && -d "$LOCK_DIR" ]] || return 1
  local pid
  pid="$(/bin/cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

healthy && exit 0
if [[ -n "$TARGET" ]]; then
  if setup_running; then
    # The setup script is switching models or restarting the server; it
    # brings llama-server back (or restores the previous one) by itself.
    echo "llama fallback setup is running; waiting for it to bring llama-server up" >&2
  elif /bin/launchctl print "$TARGET" >/dev/null 2>&1; then
    # Loaded but not answering (crashed, throttled, or still loading the
    # model). Starts it only if it is not running; never restarts it.
    /bin/launchctl kickstart "$TARGET" >/dev/null 2>&1 || true
  elif [[ -n "$PLIST" && -f "$PLIST" ]]; then
    /bin/launchctl bootstrap "${TARGET%/*}" "$PLIST" >/dev/null 2>&1 || true
  else
    echo "LaunchAgent ${TARGET##*/} is not installed; reopen OpenClaw.app to set up the local model" >&2
    exit 1
  fi
fi
end=$((SECONDS + WAIT))
while (( SECONDS < end )); do
  healthy && exit 0
  sleep 1
done
echo "llama-server on 127.0.0.1:${PORT} did not become healthy within ${WAIT}s" >&2
exit 1
HELPER_EOF
  if /usr/bin/cmp -s "$helper_tmp" "$helper"; then
    rm -f "$helper_tmp"
  elif ! { chmod 755 "$helper_tmp" && mv -f "$helper_tmp" "$helper"; }; then
    rm -f "$helper_tmp"
    log "WARN: could not install $helper; ${provider_id} stays without automatic Tool Search"
    return 0
  fi
  [[ -x "$helper" ]] || chmod 755 "$helper"

  desired="$("$NODE_BIN" -e '
    const [helper, port, mode, target, plist, lockDir] = process.argv.slice(1);
    const args = ["--port", port];
    let readyTimeoutMs = 30000;
    if (mode === "launchd") {
      // First start after a reboot can include Metal shader compilation.
      args.push("--launchd-target", target, "--plist", plist, "--lock-dir", lockDir, "--wait", "170");
      readyTimeoutMs = 180000;
    } else {
      // Someone else runs this server; only wait briefly for it.
      args.push("--wait", "25");
    }
    process.stdout.write(JSON.stringify({
      command: helper,
      args,
      healthUrl: `http://127.0.0.1:${port}/health`,
      readyTimeoutMs,
    }));
  ' "$helper" "$port" "$mode" "$SERVICE_TARGET" "$LAUNCH_AGENT_PLIST" "$LOCK_DIR" 2>/dev/null || true)"
  if [[ -z "$desired" ]]; then
    log "WARN: could not build the localService entry for ${provider_id}"
    return 0
  fi
  # Unset -> non-zero exit (with a JSON error on stdout): treated as different.
  if current="$("$OPENCLAW_BIN" config get "models.providers.${provider_id}.localService" --json 2>/dev/null)" \
    && [[ -n "$current" ]] && "$NODE_BIN" -e '
    const canon = (v) => Array.isArray(v) ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
        : v;
    try {
      const same = JSON.stringify(canon(JSON.parse(process.argv[1]))) === JSON.stringify(canon(JSON.parse(process.argv[2])));
      process.exit(same ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' "$current" "$desired" 2>/dev/null; then
    :
  elif "$OPENCLAW_BIN" config set "models.providers.${provider_id}.localService" "$desired" --strict-json >>"$LOG_FILE" 2>&1; then
    log "Marked ${provider_id} as a local model server (OpenClaw enables Tool Search for it automatically)"
  else
    log "WARN: could not set models.providers.${provider_id}.localService (see above); requests to it may overflow its context window"
  fi

  # `config get --json` exits non-zero (printing a JSON error) when unset.
  if global_tool_search="$("$OPENCLAW_BIN" config get tools.toolSearch --json 2>/dev/null)" \
    && [[ -n "$global_tool_search" && "$global_tool_search" != "null" ]]; then
    global_tool_search="$(printf '%s' "$global_tool_search" | /usr/bin/tr -s ' \n' ' ')"
    log "NOTE: tools.toolSearch is set globally (${global_tool_search}); it overrides the automatic per-model Tool Search. Remove it with: openclaw config unset tools.toolSearch"
  fi
}

# llama_model_arg <command line>
# Prints the main model a llama-server command line loads: the value of its
# last -m / --model / --model= argument (llama.cpp uses the last one given).
# --model-draft, -md, --model-vocoder etc. are different options and never
# match. ps joins argv with spaces, so a path containing spaces is re-joined
# up to the next option token. Returns 1 when there is no such argument
# (e.g. a server started with -hf, which this never treats as a match).
llama_model_arg() {
  local token model="" state=""
  local -a tokens
  read -r -a tokens <<<"$1"
  for token in "${tokens[@]}"; do
    if [[ "$state" == "value" ]]; then
      model="$token"
      state="more"
      continue
    fi
    if [[ "$state" == "more" ]]; then
      if [[ "$token" != -* ]]; then
        model+=" $token"
        continue
      fi
      state=""
    fi
    case "$token" in
      -m|--model) model=""; state="value" ;;
      --model=*) model="${token#--model=}"; state="more" ;;
    esac
  done
  [[ -n "$model" ]] || return 1
  printf '%s\n' "$model"
}

# Prints "<pid>\t<port>\t<model id>" for the first llama-server this user is
# already running (not one started by this script) whose main model is the
# App's configured model file and that answers on 127.0.0.1 without an API
# key; returns 1 when there is none. The model is identified by the file the
# process was started with (its --model argument, compared by exact file
# name, and the file must exist) -- never by /v1/models, which only reports
# the server's --alias.
find_existing_llama_server() {
  local expected_file="$1" pid exe port models model_id command_line model_path cwd
  [[ -n "$expected_file" ]] || return 1
  for pid in $(/usr/bin/pgrep -x llama-server 2>/dev/null); do
    exe="$(/bin/ps -o comm= -p "$pid" 2>/dev/null)"
    [[ "$exe" == "$LLAMA_DIR/"* ]] && continue
    command_line="$(/bin/ps -ww -o command= -p "$pid" 2>/dev/null)"
    model_path="$(llama_model_arg "$command_line")" || continue
    if [[ "$model_path" != /* ]]; then
      # Relative to the directory that server was started from.
      cwd="$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p' | head -n1)"
      [[ -n "$cwd" ]] || continue
      model_path="$cwd/$model_path"
    fi
    [[ "${model_path##*/}" == "${expected_file##*/}" && -f "$model_path" ]] || continue
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
# Only a server running the App's configured model file is reused. Our own
# server (under $LLAMA_DIR) is never treated as external, so a server left by
# an older App build is handled by the LaunchAgent comparison in step 4.
CONFIGURED_MODEL_FILE=""
if [[ "$DEFAULT_LLAMA_MODEL" == *:* ]]; then
  CONFIGURED_MODEL_FILE="${DEFAULT_LLAMA_MODEL#*:}"
elif [[ -f "$RESOLVED_MARKER" ]]; then
  IFS=$'\t' read -r CACHED_REPO CACHED_FILE < "$RESOLVED_MARKER" || true
  if [[ "${CACHED_REPO:-}" == "$DEFAULT_LLAMA_MODEL" ]]; then
    CONFIGURED_MODEL_FILE="${CACHED_FILE:-}"
  fi
fi
if [[ "${OPENCLAW_LLAMA_FALLBACK_REUSE_EXISTING:-1}" == "1" ]] \
  && ! { [[ -f "$LAUNCH_AGENT_PLIST" ]] && /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; }; then
  if EXISTING_SERVER="$(find_existing_llama_server "$CONFIGURED_MODEL_FILE")"; then
    IFS=$'\t' read -r EXISTING_PID EXISTING_PORT EXISTING_MODEL <<<"$EXISTING_SERVER"
    log "Found a running llama-server (pid $EXISTING_PID) on 127.0.0.1:$EXISTING_PORT serving '$EXISTING_MODEL' -- using it instead of starting our own"
    register_fallback "llama-existing" "$EXISTING_MODEL" "http://127.0.0.1:${EXISTING_PORT}/v1"
    sync_context_window "llama-existing" "$EXISTING_MODEL" "http://127.0.0.1:${EXISTING_PORT}/v1"
    ensure_local_service "llama-existing" "$EXISTING_PORT" external
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

if (( AUTO_CTX == 1 )); then
  SAVED_CTX_MODE=""
  SAVED_CTX_MODEL=""
  SAVED_CTX=""
  if [[ -f "$AUTO_CTX_MARKER" ]]; then
    IFS=$'\t' read -r SAVED_CTX_MODE SAVED_CTX_MODEL SAVED_CTX < "$AUTO_CTX_MARKER" || true
  fi
  # Only an earlier automatic choice is reused; an old explicit setting that
  # has since been removed from installer.env must not stick.
  if [[ "$SAVED_CTX_MODE" == "auto" \
    && "$SAVED_CTX_MODEL" == "$DEFAULT_LLAMA_MODEL" \
    && "$SAVED_CTX" =~ ^[0-9]+$ && ( "$SAVED_CTX" == "0" || "$SAVED_CTX" -ge 4096 ) ]]; then
    CTX="$SAVED_CTX"
    log "Reusing the saved ${SAVED_CTX_MODE} context for this model: $CTX"
  else
    AVAILABLE_BYTES="$(available_memory_bytes)"
    TEN_GIB=$((10 * 1024 * 1024 * 1024))
    if [[ "$AVAILABLE_BYTES" =~ ^[0-9]+$ ]] && (( AVAILABLE_BYTES > TEN_GIB )); then
      CTX=0
      AVAILABLE_GIB="$(/usr/bin/awk -v bytes="$AVAILABLE_BYTES" 'BEGIN { printf "%.1f", bytes / 1073741824 }')"
      log "Available memory is ${AVAILABLE_GIB} GiB (> 10 GiB); using the model-native context"
    else
      CTX=32768
      if [[ "$AVAILABLE_BYTES" =~ ^[0-9]+$ ]]; then
        AVAILABLE_GIB="$(/usr/bin/awk -v bytes="$AVAILABLE_BYTES" 'BEGIN { printf "%.1f", bytes / 1073741824 }')"
        log "Available memory is ${AVAILABLE_GIB} GiB (not above 10 GiB); using a 32768-token context"
      else
        log "Could not determine available memory; using a 32768-token context"
      fi
    fi
  fi
fi

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

# Switch bookkeeping. The user must never be left without a working local
# model because of an upgrade (new model or context), including when a run
# is cut off halfway (App quit, crash, shutdown):
#   .launch-agent.plist.good  copy of the last definition verified running
#                             and healthy -- the rollback target. It is only
#                             replaced after a newer definition has been
#                             verified, never removed up front, so an
#                             interrupted switch still finds it next run.
#   .switch-pending           "<epoch>\t<candidate sha>" while a switch is in
#                             flight; left behind by an interrupted run.
#   .failed-launch            "<epoch>\t<candidate sha>" of a definition that
#                             failed to start; not retried for a day while a
#                             known-good definition exists.
GOOD_PLIST="$LLAMA_DIR/.launch-agent.plist.good"
SWITCH_PENDING="$LLAMA_DIR/.switch-pending"
FAILED_MARKER="$LLAMA_DIR/.failed-launch"
LEGACY_PREVIOUS_PLIST="$LLAMA_DIR/.launch-agent.plist.previous"
SERVER_LOG_HINT="see ${HOME}/Library/Logs/OpenClaw/llama-fallback-server.log"

# Prints a plist's ProgramArguments, one per line (the plists this script
# writes: one <string> per line, no XML entities).
plist_program_arguments() {
  /usr/bin/awk '
    /<key>ProgramArguments<\/key>/ { inside = 1; next }
    inside && /<\/array>/ { exit }
    inside && /<string>/ {
      sub(/^[[:space:]]*<string>/, ""); sub(/<\/string>[[:space:]]*$/, ""); print
    }
  ' "$1" 2>/dev/null
}

# plist_option_value <plist> <flag>: the argument following <flag>.
plist_option_value() {
  plist_program_arguments "$1" | /usr/bin/awk -v flag="$2" 'previous == flag { print; exit } { previous = $0 }'
}

# plist_usable <plist>: it exists and its server binary and model file are
# still on disk (a rollback target that points at deleted files is useless).
plist_usable() {
  local plist="$1" server model
  [[ -f "$plist" ]] || return 1
  server="$(plist_program_arguments "$plist" | head -n1)"
  model="$(plist_option_value "$plist" --model)"
  [[ -n "$server" && -x "$server" && -n "$model" && -s "$model" ]]
}

# agent_runs_plist <plist>: the LaunchAgent's live process was started from
# this definition. The plist on disk can differ from what launchd has loaded
# (a run interrupted after writing the file but before reloading the agent),
# so the process's actual arguments are compared. Returns 1 only on a
# definite mismatch; 0 when there is no process or its arguments cannot be
# read, since the health check covers those cases.
agent_runs_plist() {
  local plist="$1" pid actual expected
  pid="$(/bin/launchctl print "$SERVICE_TARGET" 2>/dev/null | /usr/bin/awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  actual="$(/bin/ps -ww -o command= -p "$pid" 2>/dev/null)"
  [[ -n "$actual" ]] || return 0
  expected="$(plist_program_arguments "$plist" | /usr/bin/paste -s -d ' ' -)"
  [[ "$actual" == "$expected" ]]
}

agent_loaded() {
  /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1
}

healthy_on_port() {
  /usr/bin/curl -fsS --max-time 2 "http://127.0.0.1:${1}/health" >/dev/null 2>&1
}

# wait_healthy_on_port <port> <seconds>
wait_healthy_on_port() {
  local port="$1" seconds="$2" waited=0
  while (( waited < seconds )); do
    healthy_on_port "$port" && return 0
    sleep 2
    waited=$((waited + 2))
  done
  healthy_on_port "$port"
}

# Copies a file into place atomically (never leaves a half-written plist).
install_file() {
  local source="$1" target="$2" tmp="$LLAMA_DIR/.install-file.tmp"
  cp -p "$source" "$tmp" && mv -f "$tmp" "$target"
}

# (Re)loads the LaunchAgent from $LAUNCH_AGENT_PLIST. Returns 1 when launchd
# refuses the definition.
reload_agent() {
  if agent_loaded; then
    /bin/launchctl bootout "$SERVICE_TARGET" >>"$LOG_FILE" 2>&1 || true
  fi
  # bootout returns before launchd has fully removed the label; bootstrapping
  # too early fails with "Bootstrap failed: 5". Wait for it to disappear.
  for _ in $(seq 1 20); do
    agent_loaded || break
    sleep 1
  done
  /bin/launchctl bootstrap "gui/${UID_NUM}" "$LAUNCH_AGENT_PLIST" >>"$LOG_FILE" 2>&1 || return 1
  # RunAtLoad already starts it; this only starts it if it is not running.
  /bin/launchctl kickstart "$SERVICE_TARGET" >>"$LOG_FILE" 2>&1 || true
}

# Puts the last known-good definition back and waits for it to answer.
restore_good() {
  local good_port
  install_file "$GOOD_PLIST" "$LAUNCH_AGENT_PLIST" || return 1
  reload_agent || return 1
  good_port="$(plist_option_value "$LAUNCH_AGENT_PLIST" --port)"
  wait_healthy_on_port "${good_port:-$PORT}" 180
}

# switch_failed <reason>: the candidate definition could not be started
# (launchd refused it, or it never became healthy). Records the failure and
# goes back to the last known-good definition when there is one.
switch_failed() {
  local reason="$1"
  printf '%s\t%s\n' "$(/bin/date +%s)" "$CANDIDATE_SHA" > "$FAILED_MARKER"
  if (( GOOD_AVAILABLE == 1 )); then
    log "$reason -- restoring the last known-good llama-server configuration"
    if restore_good; then
      rm -f "$SWITCH_PENDING"
      fail_soft "$reason; the previous llama-server is running again"
    fi
    rm -f "$SWITCH_PENDING"
    fail_soft "$reason, and the previous llama-server did not come back either ($SERVER_LOG_HINT)"
  fi
  rm -f "$SWITCH_PENDING"
  fail_soft "$reason ($SERVER_LOG_HINT)"
}

# Builds before this kept the rollback copy only during a switch, as
# .previous; a leftover one is an interrupted switch's only record of the
# last working definition.
if [[ -f "$LEGACY_PREVIOUS_PLIST" ]]; then
  if [[ ! -f "$GOOD_PLIST" ]]; then
    mv -f "$LEGACY_PREVIOUS_PLIST" "$GOOD_PLIST"
  else
    rm -f "$LEGACY_PREVIOUS_PLIST"
  fi
fi
GOOD_AVAILABLE=0
plist_usable "$GOOD_PLIST" && GOOD_AVAILABLE=1
CANDIDATE_SHA="$(/usr/bin/shasum -a 256 "$PLIST_CANDIDATE" | /usr/bin/awk '{print $1}')"
if [[ -f "$SWITCH_PENDING" ]]; then
  log "The previous run was interrupted while switching the llama-server configuration -- checking what is running now"
fi

SWITCHED=0
if /usr/bin/cmp -s "$PLIST_CANDIDATE" "$LAUNCH_AGENT_PLIST" \
  && agent_loaded && server_healthy && agent_runs_plist "$LAUNCH_AGENT_PLIST"; then
  # Unchanged definition, loaded, running it and answering: leave it running.
  # Reloading here would restart llama-server (and reload the model) on every
  # app launch.
  rm -f "$PLIST_CANDIDATE"
  log "llama-server LaunchAgent unchanged and healthy on port $PORT -- leaving it running"
else
  if /usr/bin/cmp -s "$PLIST_CANDIDATE" "$LAUNCH_AGENT_PLIST" && agent_loaded && server_healthy; then
    log "The running llama-server was not started from the LaunchAgent definition on disk (an earlier switch did not finish)"
  fi
  # First switch on an install that predates .good: the definition that is
  # loaded, running and healthy right now is the known-good one. Not when a
  # switch was interrupted -- the plist on disk may then be the unproven
  # candidate while the old process is still the one answering.
  if (( GOOD_AVAILABLE == 0 )) && [[ ! -f "$SWITCH_PENDING" ]] \
    && agent_loaded && server_healthy && agent_runs_plist "$LAUNCH_AGENT_PLIST" \
    && plist_usable "$LAUNCH_AGENT_PLIST" \
    && install_file "$LAUNCH_AGENT_PLIST" "$GOOD_PLIST"; then
    GOOD_AVAILABLE=1
  fi

  # A definition that failed within the last day is not retried on every app
  # launch while a working one exists; make sure that one is what runs.
  if (( GOOD_AVAILABLE == 1 )) && [[ -f "$FAILED_MARKER" ]]; then
    IFS=$'\t' read -r FAILED_AT FAILED_SHA < "$FAILED_MARKER" || true
    if [[ "${FAILED_SHA:-}" == "$CANDIDATE_SHA" && "${FAILED_AT:-0}" =~ ^[0-9]+$ ]] \
      && (( $(/bin/date +%s) - FAILED_AT < 86400 )); then
      rm -f "$PLIST_CANDIDATE"
      GOOD_PORT="$(plist_option_value "$GOOD_PLIST" --port)"
      if agent_loaded && healthy_on_port "${GOOD_PORT:-$PORT}" && agent_runs_plist "$GOOD_PLIST"; then
        /usr/bin/cmp -s "$GOOD_PLIST" "$LAUNCH_AGENT_PLIST" || install_file "$GOOD_PLIST" "$LAUNCH_AGENT_PLIST"
        rm -f "$SWITCH_PENDING"
        fail_soft "this llama-server configuration failed to start less than a day ago; keeping the currently running model"
      fi
      log "This llama-server configuration failed to start less than a day ago -- restoring the last known-good one"
      if restore_good; then
        rm -f "$SWITCH_PENDING"
        fail_soft "this llama-server configuration failed to start less than a day ago; the previous llama-server is running again"
      fi
      rm -f "$SWITCH_PENDING"
      fail_soft "the last known-good llama-server configuration did not come back ($SERVER_LOG_HINT)"
    fi
  fi

  printf '%s\t%s\n' "$(/bin/date +%s)" "$CANDIDATE_SHA" > "$SWITCH_PENDING"
  log "Writing LaunchAgent $LAUNCH_AGENT_PLIST (port $PORT)"
  mv -f "$PLIST_CANDIDATE" "$LAUNCH_AGENT_PLIST"
  SWITCHED=1
  reload_agent || switch_failed "launchctl bootstrap failed for $LAUNCH_AGENT_PLIST"
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
if [[ "$HEALTHY" != "1" ]]; then
  if (( SWITCHED == 1 )); then
    switch_failed "the new llama-server configuration did not become healthy within ${HEALTH_WAIT_SECONDS}s"
  fi
  fail_soft "llama-server did not become healthy within ${HEALTH_WAIT_SECONDS}s ($SERVER_LOG_HINT)"
fi
# Verified: this definition is the new rollback target.
if ! /usr/bin/cmp -s "$LAUNCH_AGENT_PLIST" "$GOOD_PLIST"; then
  install_file "$LAUNCH_AGENT_PLIST" "$GOOD_PLIST" || log "WARN: could not save $GOOD_PLIST"
fi
rm -f "$SWITCH_PENDING" "$FAILED_MARKER"
log "llama-server became healthy after ${WAITED}s"
register_fallback "llama-local-fallback" "$MODEL_ALIAS" "http://127.0.0.1:${PORT}/v1"
if (( CTX > 0 )); then
  sync_context_window "llama-local-fallback" "$MODEL_ALIAS" "http://127.0.0.1:${PORT}/v1" "$CTX"
else
  sync_context_window "llama-local-fallback" "$MODEL_ALIAS" "http://127.0.0.1:${PORT}/v1"
fi
ensure_local_service "llama-local-fallback" "$PORT" launchd

if (( AUTO_CTX == 1 )); then
  printf 'auto\t%s\t%s\n' "$DEFAULT_LLAMA_MODEL" "$CTX" > "$AUTO_CTX_MARKER"
else
  printf 'explicit\t%s\t%s\n' "$DEFAULT_LLAMA_MODEL" "$CTX" > "$AUTO_CTX_MARKER"
fi
log "llama fallback setup finished."
exit 0
