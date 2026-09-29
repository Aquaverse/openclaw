#!/bin/bash
# LiteLLM smart router for the hybrid local+cloud mode (driven by
# scripts/mac-local-ai-setup.sh). Installs the pinned, hash-locked
# litellm[proxy] into ~/.openclaw/litellm with the uv bundled by
# scripts/build-mac-installer.sh (step 3b), runs it as a per-user LaunchAgent
# on 127.0.0.1 only, and registers it with OpenClaw as provider
# `litellm-router`, model `adaptive` -- shown as "Adaptive".
#
# The adaptive model is an ordinary, selectable OpenClaw model: choosing it
# lets the router pick a model per request; choosing any other model in a
# conversation's settings uses exactly that model, bypassing the router.
#
# Routing. Normally the bundled adaptive-model plugin (extensions/
# adaptive-model) decides inside OpenClaw: it asks the small local llama.cpp
# model -- through this router's `local-classifier` model, with a compact
# prompt -- how demanding each user message is, and OpenClaw runs the turn on
# the matching configured model itself. Requests reach this router's
# `adaptive` model only when the plugin cannot decide; LiteLLM's
# auto_router/complexity_router then routes with its heuristic scorer (no
# extra model call -- its LLM classifier would re-read OpenClaw's whole system
# prompt, ~8k tokens, and time out on a small local model). SIMPLE requests go
# to the local model, the other tiers to configured models LiteLLM can reach
# directly (see step 2). Every tier falls back to the default cloud model,
# which falls back to the local model.
#
# Every model call through the router is logged to litellm-router.log as one
# "[route]" line: requested model, the model that answered, tokens, duration.
#
# Idempotent: an unchanged, healthy setup is left running. Exits 0 when the
# router is installed, healthy and registered; 1 otherwise (the orchestrator
# then leaves model selection alone).
#
# Usage:
#   mac-litellm-router-setup.sh --app-path <OpenClaw.app> --prefix <~/.openclaw> \
#     [--local-base-url http://127.0.0.1:8687/v1] [--local-model openclaw-local-fallback] \
#     [--local-ref llama-local-fallback/openclaw-local-fallback] \
#     [--default-model <provider/model>]
#
# --default-model is the OpenClaw ref of the installer's cloud model (the
# COMPLEX tier and every fallback); mac-local-ai-setup.sh resolves it.
#
# The local tier is the llama.cpp model mac-llama-fallback-setup.sh
# registered (mac-local-ai-setup.sh passes its URL and name): normally our
# own llama-server, or a llama-server the user already runs. It appears in
# the router under its OpenClaw ref (--local-ref), like every other model,
# so the router's tiers and "[route]" log lines use OpenClaw's model names.
# It is the same llama-server process OpenClaw calls: no second model is
# loaded. `local-classifier` points at it too, with the settings for the
# adaptive-model plugin's short labelling calls.
#
# Env overrides:
#   OPENCLAW_LITELLM_PORT           Router port (default 18791).
#   OPENCLAW_LITELLM_HEALTH_WAIT    Seconds to wait for the router (default 180).

set -uo pipefail

APP_PATH=""
PREFIX=""
LOCAL_PORT="8687"
LOCAL_BASE_URL=""
LOCAL_MODEL="openclaw-local-fallback"
LOCAL_REF=""
DEFAULT_MODEL_REF=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-path) APP_PATH="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --local-port) LOCAL_PORT="$2"; shift 2 ;;
    --local-base-url) LOCAL_BASE_URL="$2"; shift 2 ;;
    --local-model) LOCAL_MODEL="$2"; shift 2 ;;
    --local-ref) LOCAL_REF="$2"; shift 2 ;;
    --default-model) DEFAULT_MODEL_REF="$2"; shift 2 ;;
    *) shift ;;
  esac
done
LOCAL_BASE_URL="${LOCAL_BASE_URL:-http://127.0.0.1:${LOCAL_PORT}/v1}"
LOCAL_REF="${LOCAL_REF:-llama-local-fallback/${LOCAL_MODEL}}"

LOG_FILE="${OPENCLAW_LITELLM_LOG:-$HOME/Library/Logs/OpenClaw/litellm-router-setup.log}"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE" >/dev/null
}
fail() {
  log "WARN: $* -- LiteLLM router not (re)configured."
  exit 1
}

[[ -n "$APP_PATH" && -d "$APP_PATH" ]] || fail "no valid --app-path ($APP_PATH)"
[[ -n "$PREFIX" ]] || fail "no --prefix"

log "=================================================="
log "LiteLLM router setup starting (app: $APP_PATH, prefix: $PREFIX)"

RESOURCES="$APP_PATH/Contents/Resources"
RUNTIME_DIR="$RESOURCES/litellm-runtime"
ENV_FILE="$RESOURCES/default-ai-provider.env"
OPENCLAW_BIN="$PREFIX/bin/openclaw"
NODE_BIN="$PREFIX/tools/node/bin/node"
[[ -x "$OPENCLAW_BIN" ]] || fail "$OPENCLAW_BIN not found"
[[ -x "$NODE_BIN" ]] || fail "$NODE_BIN not found"
[[ -d "$RUNTIME_DIR" ]] || fail "this build has no LiteLLM runtime (OPENCLAW_INSTALLER_ENABLE_LITELLM was not set)"

env_value() { # the file is data, never sourced
  /usr/bin/grep -E "^$1=" "$ENV_FILE" | /usr/bin/tail -n1 | /usr/bin/cut -d'=' -f2- | /usr/bin/tr -d '\r'
}
CLOUD_BASE_URL="$(env_value DEFAULT_AI_BASE_URL)"
CLOUD_MODEL="$(env_value DEFAULT_AI_MODEL)"
CLOUD_API_KEY="$(env_value DEFAULT_AI_API_KEY)"
# Optional per-tier overrides from installer.env (OpenClaw model refs).
TIER_MEDIUM_OVERRIDE="$(env_value DEFAULT_ROUTER_TIER_MEDIUM)"
TIER_COMPLEX_OVERRIDE="$(env_value DEFAULT_ROUTER_TIER_COMPLEX)"
TIER_REASONING_OVERRIDE="$(env_value DEFAULT_ROUTER_TIER_REASONING)"

case "$(/usr/bin/uname -m)" in
  arm64) MAC_ARCH="arm64" ;;
  x86_64) MAC_ARCH="x64" ;;
  *) fail "unsupported arch $(/usr/bin/uname -m)" ;;
esac
UV_ARCHIVE="$RUNTIME_DIR/uv-macos-${MAC_ARCH}.tar.gz"
LOCK_FILE="$RUNTIME_DIR/requirements-macos-${MAC_ARCH}.lock"
[[ -f "$UV_ARCHIVE" && -f "$LOCK_FILE" ]] || fail "no bundled uv/lock for $MAC_ARCH"
PYTHON_VERSION="$(cat "$RUNTIME_DIR/python-version.txt" 2>/dev/null || echo 3.12)"
LITELLM_VERSION="$(cat "$RUNTIME_DIR/litellm-version.txt" 2>/dev/null || echo unknown)"

LITELLM_DIR="$PREFIX/litellm"
mkdir -p "$LITELLM_DIR" || fail "cannot create $LITELLM_DIR"
chmod 700 "$LITELLM_DIR" 2>/dev/null || true

LOCK_DIR="$LITELLM_DIR/.setup.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    fail "another router setup run (pid $LOCK_PID) is in progress"
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || fail "could not acquire $LOCK_DIR"
fi
echo "$$" > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

# ---------------------------------------------------------------------
# 1. uv (bundled archive, sha256-checked) -> managed Python -> venv with the
# hash-locked packages. The venv directory is keyed by the lock's sha256, so
# a new lock builds a new venv beside the running one; older ones are removed
# only after the LaunchAgent points at the new one.
# ---------------------------------------------------------------------
if [[ -f "$UV_ARCHIVE.sha256" ]]; then
  [[ "$(/usr/bin/shasum -a 256 "$UV_ARCHIVE" | /usr/bin/awk '{print $1}')" == "$(cat "$UV_ARCHIVE.sha256")" ]] \
    || fail "bundled uv archive sha256 mismatch"
fi
UV_SHA="$(/usr/bin/shasum -a 256 "$UV_ARCHIVE" | /usr/bin/awk '{print substr($1,1,12)}')"
UV_DIR="$LITELLM_DIR/uv-$UV_SHA"
UV_BIN="$UV_DIR/uv"
if [[ ! -x "$UV_BIN" ]]; then
  rm -rf "$UV_DIR" && mkdir -p "$UV_DIR"
  /usr/bin/tar -xzf "$UV_ARCHIVE" -C "$UV_DIR" --strip-components=1 >>"$LOG_FILE" 2>&1 || fail "could not extract $UV_ARCHIVE"
  /usr/bin/xattr -dr com.apple.quarantine "$UV_DIR" >/dev/null 2>&1 || true
  [[ -x "$UV_BIN" ]] || fail "uv binary missing in $UV_ARCHIVE"
fi

LOCK_SHA="$(/usr/bin/shasum -a 256 "$LOCK_FILE" | /usr/bin/awk '{print substr($1,1,12)}')"
VENV_DIR="$LITELLM_DIR/venv-$LOCK_SHA"
LITELLM_BIN="$VENV_DIR/bin/litellm"
export UV_PYTHON_INSTALL_DIR="$LITELLM_DIR/python"
export UV_CACHE_DIR="$LITELLM_DIR/uv-cache"
if [[ -x "$LITELLM_BIN" && -f "$VENV_DIR/.install-complete" ]]; then
  log "LiteLLM $LITELLM_VERSION already installed at $VENV_DIR -- reusing"
else
  log "Installing LiteLLM $LITELLM_VERSION (Python $PYTHON_VERSION) into $VENV_DIR -- downloads Python and packages, can take a few minutes"
  rm -rf "$VENV_DIR"
  "$UV_BIN" --no-config venv --python "$PYTHON_VERSION" --python-preference only-managed "$VENV_DIR" >>"$LOG_FILE" 2>&1 \
    || fail "could not create the Python environment (see $LOG_FILE)"
  # --require-hashes: every package must match the hash locked at build time.
  "$UV_BIN" --no-config pip install --python "$VENV_DIR/bin/python" --require-hashes --no-deps -r "$LOCK_FILE" >>"$LOG_FILE" 2>&1 \
    || { rm -rf "$VENV_DIR"; fail "could not install the locked LiteLLM packages (see $LOG_FILE)"; }
  [[ -x "$LITELLM_BIN" ]] || { rm -rf "$VENV_DIR"; fail "litellm entry point missing after install"; }
  touch "$VENV_DIR/.install-complete"
  log "LiteLLM installed"
fi

# ---------------------------------------------------------------------
# 2. Router config (0600: it holds the cloud API key and the router key).
# ---------------------------------------------------------------------
PORT="${OPENCLAW_LITELLM_PORT:-18791}"
MASTER_KEY_FILE="$LITELLM_DIR/master.key"
if [[ ! -s "$MASTER_KEY_FILE" ]]; then
  (umask 077 && printf 'sk-openclaw-%s\n' "$(/usr/bin/openssl rand -hex 24)" > "$MASTER_KEY_FILE") \
    || fail "could not create the router key"
fi
MASTER_KEY="$(tr -d '\r\n' < "$MASTER_KEY_FILE")"

CONFIG_FILE="$LITELLM_DIR/config.yaml"
CONFIG_CANDIDATE="$LITELLM_DIR/.config.yaml.new"
# Written as JSON, which LiteLLM's YAML loader reads as-is (JSON is a subset
# of YAML) -- no hand-quoting of keys, URLs or model ids. Secrets reach node
# through the environment, never argv. Prints the tier plan (no secrets).
# LiteLLM callback that logs one line per model call (loaded from the config
# directory via litellm_settings.callbacks). Its hash goes into config.yaml,
# so a changed logger restarts the router like any other config change.
ROUTE_LOGGER="$LITELLM_DIR/route_logger.py"
ROUTE_LOGGER_CANDIDATE="$LITELLM_DIR/.route_logger.py.new"
cat > "$ROUTE_LOGGER_CANDIDATE" <<'LOGGER_EOF'
# Generated by mac-litellm-router-setup.sh -- rewritten on every app launch.
# One "[route]" line per model call made by the router, so litellm-router.log
# shows which model actually answered: the requested model group (e.g.
# "adaptive" resolved to the local model or a cloud model, or the adaptive-model
# plugin's "local-classifier" calls), the upstream model, tokens and duration.
# Never logs message content.
import datetime

try:
    from litellm.integrations.custom_logger import CustomLogger
except Exception:  # pragma: no cover - keep the router starting regardless
    CustomLogger = object


def _route_line(kwargs, response_obj, start_time, end_time, status):
    try:
        params = kwargs.get("litellm_params") or {}
        metadata = params.get("metadata") or {}
        group = metadata.get("model_group") or kwargs.get("model") or "?"
        upstream = kwargs.get("model") or "?"
        seconds = (end_time - start_time).total_seconds() if start_time and end_time else -1
        usage = getattr(response_obj, "usage", None)
        prompt_tokens = getattr(usage, "prompt_tokens", None) if usage is not None else None
        completion_tokens = getattr(usage, "completion_tokens", None) if usage is not None else None
        role = "classifier" if group == "local-classifier" else "request"
        stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = (
            f"[route] {stamp} {status} {role} group={group} model={upstream} "
            f"prompt_tokens={prompt_tokens} completion_tokens={completion_tokens} seconds={seconds:.2f}"
        )
        if status != "ok":
            exception = kwargs.get("exception")
            line += f" error={type(exception).__name__ if exception is not None else '?'}"
        print(line, flush=True)
    except Exception as error:  # pragma: no cover
        print(f"[route] could not log a call: {error!r}", flush=True)


class RouteLogger(CustomLogger):
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        _route_line(kwargs, response_obj, start_time, end_time, "ok")

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        _route_line(kwargs, response_obj, start_time, end_time, "error")


proxy_handler_instance = RouteLogger()
LOGGER_EOF
if /usr/bin/cmp -s "$ROUTE_LOGGER_CANDIDATE" "$ROUTE_LOGGER"; then
  rm -f "$ROUTE_LOGGER_CANDIDATE"
else
  mv -f "$ROUTE_LOGGER_CANDIDATE" "$ROUTE_LOGGER" || fail "could not write $ROUTE_LOGGER"
fi
ROUTE_LOGGER_SHA="$(/usr/bin/shasum -a 256 "$ROUTE_LOGGER" | /usr/bin/awk '{print substr($1,1,12)}')"

# OpenClaw's own view of the configured models (what its model picker shows).
OPENCLAW_MODELS_JSON="$("$OPENCLAW_BIN" models list --json 2>/dev/null || true)"
ROUTER_PLAN="$(
  umask 077
  ROUTER_CONFIG_OUT="$CONFIG_CANDIDATE" \
  ROUTER_OPENCLAW_MODELS="$OPENCLAW_MODELS_JSON" \
  ROUTER_STATE_DIR="$PREFIX" \
  ROUTER_LOGGER_SHA="$ROUTE_LOGGER_SHA" \
  ROUTER_OPENCLAW_CONFIG="$PREFIX/openclaw.json" \
  ROUTER_LOCAL_BASE_URL="$LOCAL_BASE_URL" \
  ROUTER_LOCAL_MODEL="$LOCAL_MODEL" \
  ROUTER_LOCAL_REF="$LOCAL_REF" \
  ROUTER_SELF_URL="http://127.0.0.1:${PORT}" \
  ROUTER_DEFAULT_REF="$DEFAULT_MODEL_REF" \
  ROUTER_CLOUD_BASE_URL="$CLOUD_BASE_URL" \
  ROUTER_CLOUD_MODEL="$CLOUD_MODEL" \
  ROUTER_CLOUD_API_KEY="$CLOUD_API_KEY" \
  ROUTER_MASTER_KEY="$MASTER_KEY" \
  ROUTER_TIER_MEDIUM="$TIER_MEDIUM_OVERRIDE" \
  ROUTER_TIER_COMPLEX="$TIER_COMPLEX_OVERRIDE" \
  ROUTER_TIER_REASONING="$TIER_REASONING_OVERRIDE" \
  "$NODE_BIN" -e '
const fs = require("fs");
const env = process.env;
const notes = [];
const norm = (u) => String(u || "").trim().replace(/\/+$/, "").toLowerCase();
const isLoopback = (u) => /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(u || "").trim());

// 1. Candidates. The list is the one OpenClaw itself shows: `openclaw models list --json`
// (configured models, with the OpenClaw availability check). LiteLLM then has
// to call each model itself, so a model is used when its connection can be
// taken from models.providers in openclaw.json:
//  - API: OpenAI chat/responses, Anthropic messages, Gemini, Ollama;
//  - key: a plain string, "${VAR}" or an env SecretRef -- resolved like
//    OpenClaw does, from the environment, config env and ~/.openclaw/.env --
//    or none for a loopback server.
// Models whose credentials live only inside OpenClaw (auth profiles in its
// credential store, OAuth logins, file/exec SecretRefs) are left to OpenClaw:
// they stay selectable directly, just not through the adaptive model.
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(env.ROUTER_OPENCLAW_CONFIG, "utf8")) || {};
} catch (err) {
  notes.push("could not read openclaw.json (" + String(err.message).split("\n")[0] + "); using the installer cloud model only");
}
const providers = (cfg.models && cfg.models.providers) || {};

const parseDotenv = (file) => {
  const out = {};
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$/.test(v) || /^\x27.*\x27$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
};
const configEnv = {};
if (cfg.env && typeof cfg.env === "object") {
  for (const [k, v] of Object.entries(cfg.env.vars || {})) if (typeof v === "string") configEnv[k] = v;
  for (const [k, v] of Object.entries(cfg.env)) if (typeof v === "string" && k !== "shellEnv" && k !== "vars") configEnv[k] = v;
}
const home = env.HOME || "";
// Process environment wins, as for OpenClaw; dotenv files never override it.
const envMap = Object.assign({},
  parseDotenv(home + "/.config/openclaw/gateway.env"),
  parseDotenv(env.ROUTER_STATE_DIR + "/.env"),
  configEnv,
  process.env);
const resolveSecret = (value) => {
  if (value === undefined || value === null || value === "") return { key: "" };
  if (typeof value === "string") {
    let missing = null;
    const out = value.replace(/\$\$\{/g, "\u0000").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      if (typeof envMap[name] === "string" && envMap[name] !== "") return envMap[name];
      missing = name;
      return "";
    }).replace(/\u0000/g, "${");
    return missing ? { error: "environment variable " + missing + " is not set" } : { key: out };
  }
  if (value && typeof value === "object" && value.source === "env" && typeof value.id === "string") {
    const v = envMap[value.id];
    return typeof v === "string" && v ? { key: v } : { error: "environment variable " + value.id + " is not set" };
  }
  const source = value && typeof value === "object" && value.source ? value.source : "unknown";
  return { error: "its API key is a " + source + " secret reference, resolved only inside OpenClaw" };
};
const LITELLM_PREFIX = {
  "openai-completions": "openai",
  "openai-responses": "openai",
  "anthropic-messages": "anthropic",
  "google-generative-ai": "gemini",
  "ollama": "ollama_chat",
};
const OFFICIAL_HOSTS = {
  anthropic: /^https:\/\/api\.anthropic\.com(\/v1)?\/?$/i,
  gemini: /^https:\/\/generativelanguage\.googleapis\.com(\/v1(beta)?)?\/?$/i,
};

const ownProviders = new Set(["llama-local-fallback", "llama-existing", "litellm-router"]);
const ownUrls = new Set([norm(env.ROUTER_LOCAL_BASE_URL), norm(env.ROUTER_SELF_URL), norm(env.ROUTER_SELF_URL + "/v1")]);
const connectionFor = (pid, modelId) => {
  const p = providers[pid];
  if (!p || typeof p !== "object") return { error: "no models.providers entry (credentials managed by OpenClaw)" };
  const base = typeof p.baseUrl === "string" ? p.baseUrl.trim() : "";
  if (!base) return { error: "no baseUrl (built-in provider; credentials managed by OpenClaw)" };
  if (ownUrls.has(norm(base))) return { skip: true };
  const api = p.api || "openai-completions";
  const llm = LITELLM_PREFIX[api];
  if (!llm) return { error: "API " + api + " is not supported by the router" };
  const secret = resolveSecret(p.apiKey);
  if (secret.error) return { error: secret.error };
  let key = secret.key;
  if (!key) {
    if (!isLoopback(base) && llm !== "ollama_chat") return { error: "no API key in the config (credentials managed by OpenClaw)" };
    key = "none";
  }
  const headers = {};
  for (const [h, v] of Object.entries(p.headers || {})) {
    const r = resolveSecret(v);
    if (r.error) return { error: "header " + h + ": " + r.error };
    if (r.key) headers[h] = r.key;
  }
  let apiBase = base;
  if (llm === "ollama_chat") apiBase = base.replace(/\/v1\/?$/, "");
  if (OFFICIAL_HOSTS[llm] && OFFICIAL_HOSTS[llm].test(base)) apiBase = "";
  const m = (Array.isArray(p.models) ? p.models : []).find((x) => x && x.id === modelId) || {};
  const cost = m.cost && typeof m.cost === "object" ? (Number(m.cost.input) || 0) + (Number(m.cost.output) || 0) : 0;
  return { llm, apiBase, key, headers, reasoning: m.reasoning === true, cost: cost > 0 ? cost : null, input: m.input };
};

// Configured models, as OpenClaw itself lists them.
let rows = null;
try {
  const listed = JSON.parse(env.ROUTER_OPENCLAW_MODELS || "");
  if (listed && Array.isArray(listed.models)) rows = listed.models;
} catch {}
const refs = [];
if (rows) {
  for (const r of rows) {
    if (!r || typeof r.key !== "string" || !r.key.includes("/")) continue;
    if (r.available === false) { notes.push("skipped " + r.key + ": not available (no credentials)"); continue; }
    if (typeof r.input === "string" && r.input && !/text/i.test(r.input)) continue;
    refs.push(r.key);
  }
} else {
  notes.push("`openclaw models list` failed; using models.providers only");
  for (const [pid, p] of Object.entries(providers)) {
    for (const m of (p && Array.isArray(p.models)) ? p.models : []) if (m && typeof m.id === "string") refs.push(pid + "/" + m.id);
  }
}
const cloud = new Map();
const managedOnly = [];
for (const ref of refs) {
  const slash = ref.indexOf("/");
  const pid = ref.slice(0, slash);
  const id = ref.slice(slash + 1);
  if (ownProviders.has(pid)) continue;
  const c = connectionFor(pid, id);
  if (c.skip) continue;
  if (c.error) { managedOnly.push(ref + " (" + c.error + ")"); continue; }
  if (Array.isArray(c.input) && !c.input.includes("text")) continue;
  cloud.set(ref, Object.assign({ ref, id }, c));
}
if (managedOnly.length) notes.push("not reachable by the router, selectable directly in OpenClaw: " + managedOnly.join(", "));
// The installer cloud model is always available (its key ships in the app),
// and the config copy of its key wins when present (the user may have
// rotated it in OpenClaw).
let defaultRef = env.ROUTER_DEFAULT_REF || "";
if (env.ROUTER_CLOUD_BASE_URL && env.ROUTER_CLOUD_MODEL) {
  const match = [...cloud.values()].find((c) => norm(c.apiBase) === norm(env.ROUTER_CLOUD_BASE_URL) && c.id === env.ROUTER_CLOUD_MODEL);
  if (match) {
    defaultRef = defaultRef && cloud.has(defaultRef) ? defaultRef : match.ref;
  } else {
    const ref = defaultRef || "installer-cloud/" + env.ROUTER_CLOUD_MODEL;
    cloud.set(ref, { ref, id: env.ROUTER_CLOUD_MODEL, llm: "openai", apiBase: env.ROUTER_CLOUD_BASE_URL, key: env.ROUTER_CLOUD_API_KEY || "none", headers: {}, reasoning: false, cost: null });
    defaultRef = ref;
  }
}
if (!cloud.size) { process.stderr.write("no model the router can reach: " + (notes.join("; ") || "none configured") + "\n"); process.exit(2); }
if (!cloud.has(defaultRef)) defaultRef = cloud.keys().next().value;
const dflt = cloud.get(defaultRef);

// 2. Tier plan. SIMPLE is always the local model. COMPLEX is the default
// cloud model. MEDIUM takes a cheaper model when one is identifiable (a
// known lower price, else a "light" model name); REASONING takes a model
// marked reasoning-capable (or named like one). Anything unidentifiable
// stays on the default model. installer.env can pin each tier.
const others = [...cloud.values()].filter((c) => c.ref !== defaultRef);
const LIGHT = /(mini|flash|haiku|lite|small|nano|tiny|turbo|air|(^|[^0-9])[1-9](\.\d)?b\b)/i;
const REASONING = /(reason|thinking|(^|[^a-z])r1([^0-9]|$)|(^|[^a-z])o[134](-|$)|qwq|opus)/i;
let medium = defaultRef;
const cheaper = others.filter((c) => c.cost !== null && (dflt.cost === null || c.cost < dflt.cost)).sort((a, b) => a.cost - b.cost);
if (cheaper.length) medium = cheaper[0].ref;
else { const light = others.find((c) => LIGHT.test(c.id)); if (light) medium = light.ref; }
let reasoning = defaultRef;
if (!(dflt.reasoning || REASONING.test(dflt.id))) {
  const r = others.filter((c) => c.reasoning || REASONING.test(c.id)).sort((a, b) => (b.cost || 0) - (a.cost || 0));
  if (r.length) reasoning = r[0].ref;
}
const localRef = env.ROUTER_LOCAL_REF;
const tiers = { SIMPLE: localRef, MEDIUM: medium, COMPLEX: defaultRef, REASONING: reasoning };
for (const [tier, ref] of [["MEDIUM", env.ROUTER_TIER_MEDIUM], ["COMPLEX", env.ROUTER_TIER_COMPLEX], ["REASONING", env.ROUTER_TIER_REASONING]]) {
  if (!ref) continue;
  if (cloud.has(ref)) tiers[tier] = ref;
  else notes.push("installer.env pins " + tier + " to " + ref + ", which is not a usable registered model -- ignored");
}

// 3. LiteLLM config.
const localParams = (extra) => Object.assign({
  model: "openai/" + env.ROUTER_LOCAL_MODEL,
  api_base: env.ROUTER_LOCAL_BASE_URL,
  api_key: "local-no-key",
  // Qwen3-style templates otherwise "think" first; neither a routing
  // decision nor a SIMPLE answer needs that.
  extra_body: { chat_template_kwargs: { enable_thinking: false } },
}, extra || {});
const modelList = [
  { model_name: localRef, litellm_params: localParams() },
  { model_name: "local-classifier", litellm_params: localParams({ temperature: 0, max_tokens: 64 }),
    model_info: { supports_response_schema: true } },
  ...[...cloud.values()].sort((a, b) => a.ref.localeCompare(b.ref)).map((c) => ({
    model_name: c.ref,
    litellm_params: Object.assign(
      { model: c.llm + "/" + c.id, api_key: c.key },
      c.apiBase ? { api_base: c.apiBase } : {},
      Object.keys(c.headers || {}).length ? { extra_headers: c.headers } : {},
    ),
  })),
  {
    model_name: "adaptive",
    litellm_params: {
      model: "auto_router/complexity_router",
      // Heuristic scorer: no extra model call. The LLM classifier would
      // prefill the caller system prompt (~8k tokens) on the local model and
      // time out; the adaptive-model plugin classifies with a compact prompt.
      complexity_router_config: { tiers },
      complexity_router_default_model: defaultRef,
    },
  },
];
const fallbacks = [{ [localRef]: [defaultRef] }, { [defaultRef]: [localRef] }];
for (const c of others) fallbacks.push({ [c.ref]: [defaultRef] });
const config = {
  model_list: modelList,
  router_settings: {
    num_retries: 1,
    fallbacks,
    // The local context is much smaller than the cloud models: a
    // conversation that outgrew it continues on the default model.
    context_window_fallbacks: [{ [localRef]: [defaultRef] }],
  },
  litellm_settings: { drop_params: true, callbacks: "route_logger.proxy_handler_instance" },
  general_settings: { master_key: env.ROUTER_MASTER_KEY },
};
fs.writeFileSync(env.ROUTER_CONFIG_OUT, "# Generated by mac-litellm-router-setup.sh -- rewritten on every app launch.\n"
  + "# route_logger.py " + (env.ROUTER_LOGGER_SHA || "") + "\n" + JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
process.stdout.write(Object.entries(tiers).map(([t, m]) => t + "=" + m).join(" ") + " | default=" + defaultRef + " | cloud models: " + cloud.size
  + (notes.length ? " | " + notes.join("; ") : ""));
' 2>>"$LOG_FILE"
)" || fail "could not generate the router config (see $LOG_FILE)"
log "Router plan: $ROUTER_PLAN"

# ---------------------------------------------------------------------
# 3. LaunchAgent, loopback only. Reloaded only when something changed.
# ---------------------------------------------------------------------
LAUNCH_AGENT_LABEL="ai.openclaw.litellm-router"
LAUNCH_AGENT_PLIST="$HOME/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
SERVICE_TARGET="gui/$(/usr/bin/id -u)/${LAUNCH_AGENT_LABEL}"
PLIST_CANDIDATE="$LITELLM_DIR/.launch-agent.plist.new"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_CANDIDATE" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${LITELLM_BIN}</string>
    <string>--config</string>
    <string>${CONFIG_FILE}</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>${PORT}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LITELLM_TELEMETRY</key>
    <string>False</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${LITELLM_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${HOME}/Library/Logs/OpenClaw/litellm-router.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/Library/Logs/OpenClaw/litellm-router.log</string>
</dict>
</plist>
PLIST_EOF

router_healthy() {
  /usr/bin/curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health/liveliness" >/dev/null 2>&1
}
CONFIG_CHANGED=1
ROUTER_UNCHANGED=0
/usr/bin/cmp -s "$CONFIG_CANDIDATE" "$CONFIG_FILE" && CONFIG_CHANGED=0
mv -f "$CONFIG_CANDIDATE" "$CONFIG_FILE"
if [[ "$CONFIG_CHANGED" == "0" ]] && /usr/bin/cmp -s "$PLIST_CANDIDATE" "$LAUNCH_AGENT_PLIST" \
  && /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1 && router_healthy; then
  rm -f "$PLIST_CANDIDATE"
  ROUTER_UNCHANGED=1
  log "LiteLLM router unchanged and healthy on 127.0.0.1:$PORT -- leaving it running"
else
  log "Starting LiteLLM router LaunchAgent on 127.0.0.1:$PORT"
  mv -f "$PLIST_CANDIDATE" "$LAUNCH_AGENT_PLIST"
  if /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
    /bin/launchctl bootout "$SERVICE_TARGET" >>"$LOG_FILE" 2>&1 || true
    for _ in $(seq 1 20); do
      /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1 || break
      sleep 1
    done
  fi
  /bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$LAUNCH_AGENT_PLIST" >>"$LOG_FILE" 2>&1 \
    || fail "launchctl bootstrap failed for $LAUNCH_AGENT_PLIST"
fi

HEALTH_WAIT="${OPENCLAW_LITELLM_HEALTH_WAIT:-180}"
WAITED=0
until router_healthy; do
  (( WAITED >= HEALTH_WAIT )) && fail "router did not answer within ${HEALTH_WAIT}s (see ~/Library/Logs/OpenClaw/litellm-router.log)"
  sleep 2
  WAITED=$((WAITED + 2))
done
log "LiteLLM router is up (after ${WAITED}s)"

# Remove venvs/uv from older locks now that the agent uses the current one.
for OLD in "$LITELLM_DIR"/venv-* "$LITELLM_DIR"/uv-*; do
  [[ -d "$OLD" && "$OLD" != "$VENV_DIR" && "$OLD" != "$UV_DIR" && "$OLD" != "$LITELLM_DIR/uv-cache" ]] && rm -rf "$OLD"
done

# ---------------------------------------------------------------------
# 4. Smoke test: a trivially simple ask must be answered through the router.
# ---------------------------------------------------------------------
# Skipped only when the router was left running unchanged AND this exact
# configuration already passed it (a failed test is repeated every run).
SMOKE_OK_MARKER="$LITELLM_DIR/.smoke-ok"
ROUTER_CONFIG_SHA="$(/bin/cat "$CONFIG_FILE" "$LAUNCH_AGENT_PLIST" 2>/dev/null | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')"
if [[ "$ROUTER_UNCHANGED" == "1" && "$(/bin/cat "$SMOKE_OK_MARKER" 2>/dev/null)" == "$ROUTER_CONFIG_SHA" ]]; then
  log "Router unchanged -- skipping the smoke test"
else
  rm -f "$SMOKE_OK_MARKER"
  SMOKE_OUT="$LITELLM_DIR/.smoke-response.json"
  # The key goes in a 0600 header file (curl -H @file), never in argv.
  SMOKE_HEADERS="$LITELLM_DIR/.smoke-headers"
  (umask 077 && printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$MASTER_KEY" > "$SMOKE_HEADERS") \
    || fail "could not write $SMOKE_HEADERS"
  SMOKE_CODE="$(/usr/bin/curl -sS --max-time 120 -o "$SMOKE_OUT" -w '%{http_code}' \
    -H @"$SMOKE_HEADERS" \
    -d '{"model":"adaptive","max_tokens":16,"messages":[{"role":"user","content":"Say hi."}]}' \
    "http://127.0.0.1:${PORT}/v1/chat/completions" 2>>"$LOG_FILE" || true)"
  rm -f "$SMOKE_HEADERS"
  if [[ "$SMOKE_CODE" != "200" ]]; then
    log "Router smoke test response (HTTP ${SMOKE_CODE:-none}): $(head -c 600 "$SMOKE_OUT" 2>/dev/null)"
    fail "router smoke test failed"
  fi
  SERVED_BY="$(/usr/bin/grep -o '"model" *: *"[^"]*"' "$SMOKE_OUT" | head -n1)"
  log "Router smoke test OK (${SERVED_BY:-model not reported})"
  rm -f "$SMOKE_OUT"
  printf '%s' "$ROUTER_CONFIG_SHA" > "$SMOKE_OK_MARKER"
fi

# ---------------------------------------------------------------------
# 5. Register the router with OpenClaw (as a fallback entry; the
# orchestrator decides what is primary). The key goes through the
# environment, never argv.
# ---------------------------------------------------------------------
# ensure_router_local_service: marks litellm-router as a local model server
# (models.providers.litellm-router.localService), exactly like
# mac-llama-fallback-setup.sh does for llama-local-fallback. OpenClaw then
# enables Tool Search for requests through the router: they carry a few
# search/describe/call tools instead of every tool schema (~34k tokens) --
# without it every SIMPLE request routed to the small local model would
# overflow its context window. OpenClaw runs the command only when the
# router's health probe fails; it is ensure-litellm-router.sh (written
# below), which only asks launchd to (re)start this LaunchAgent and waits for
# it -- it never starts a second router itself.
ensure_router_local_service() {
  local helper="$LITELLM_DIR/ensure-litellm-router.sh" helper_tmp desired current
  helper_tmp="$LITELLM_DIR/.ensure-litellm-router.sh.new"
  cat > "$helper_tmp" <<'HELPER_EOF'
#!/bin/bash
# Generated by mac-litellm-router-setup.sh -- rewritten on every app launch.
# Run by OpenClaw (models.providers.litellm-router.localService.command) only
# when the router's health probe fails right before a request. launchd owns
# the router (LaunchAgent ai.openclaw.litellm-router); this asks launchd to
# start it if it is not running, waits for the health URL, and exits 0 when
# healthy, 1 otherwise. It never starts a router process itself.
set -u
HEALTH_URL="" TARGET="" PLIST="" LOCK_DIR="" WAIT=110
while (( $# >= 2 )); do
  case "$1" in
    --health-url) HEALTH_URL="$2" ;;
    --launchd-target) TARGET="$2" ;;
    --plist) PLIST="$2" ;;
    --lock-dir) LOCK_DIR="$2" ;;
    --wait) WAIT="$2" ;;
  esac
  shift 2
done
[[ -n "$HEALTH_URL" && -n "$TARGET" ]] || { echo "ensure-litellm-router: --health-url and --launchd-target are required" >&2; exit 2; }
[[ "$WAIT" =~ ^[0-9]+$ ]] || WAIT=110
healthy() {
  /usr/bin/curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}
setup_running() {
  [[ -n "$LOCK_DIR" && -d "$LOCK_DIR" ]] || return 1
  local pid
  pid="$(/bin/cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}
healthy && exit 0
if setup_running; then
  echo "router setup is running; waiting for it to bring the router up" >&2
elif /bin/launchctl print "$TARGET" >/dev/null 2>&1; then
  /bin/launchctl kickstart "$TARGET" >/dev/null 2>&1 || true
elif [[ -n "$PLIST" && -f "$PLIST" ]]; then
  /bin/launchctl bootstrap "${TARGET%/*}" "$PLIST" >/dev/null 2>&1 || true
else
  echo "LaunchAgent ${TARGET##*/} is not installed; reopen OpenClaw.app to set it up" >&2
  exit 1
fi
end=$((SECONDS + WAIT))
while (( SECONDS < end )); do
  healthy && exit 0
  sleep 1
done
echo "${HEALTH_URL} did not become healthy within ${WAIT}s" >&2
exit 1
HELPER_EOF
  if /usr/bin/cmp -s "$helper_tmp" "$helper"; then
    rm -f "$helper_tmp"
  elif ! { chmod 755 "$helper_tmp" && mv -f "$helper_tmp" "$helper"; }; then
    rm -f "$helper_tmp"
    log "WARN: could not install $helper -- requests through the router will not use Tool Search"
    return 0
  fi
  desired="$("$NODE_BIN" -e '
    const [helper, port, target, plist, lockDir] = process.argv.slice(1);
    const healthUrl = `http://127.0.0.1:${port}/health/liveliness`;
    process.stdout.write(JSON.stringify({
      command: helper,
      args: ["--health-url", healthUrl, "--launchd-target", target,
        "--plist", plist, "--lock-dir", lockDir, "--wait", "110"],
      healthUrl,
      readyTimeoutMs: 120000,
    }));
  ' "$helper" "$PORT" "$SERVICE_TARGET" "$LAUNCH_AGENT_PLIST" "$LOCK_DIR" 2>/dev/null || true)"
  [[ -n "$desired" ]] || { log "WARN: could not build the router's localService entry"; return 0; }
  # Unset -> non-zero exit (with a JSON error on stdout): treated as different.
  if current="$("$OPENCLAW_BIN" config get models.providers.litellm-router.localService --json 2>/dev/null)" \
    && "$NODE_BIN" -e '
      const canon = (v) => Array.isArray(v) ? v.map(canon)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
          : v;
      try {
        process.exit(JSON.stringify(canon(JSON.parse(process.argv[1]))) === JSON.stringify(canon(JSON.parse(process.argv[2]))) ? 0 : 1);
      } catch {
        process.exit(1);
      }
    ' "$current" "$desired" 2>/dev/null; then
    return 0
  fi
  if "$OPENCLAW_BIN" config set models.providers.litellm-router.localService "$desired" --strict-json >>"$LOG_FILE" 2>&1; then
    log "Marked litellm-router as a local model server (OpenClaw enables Tool Search for it automatically)"
  else
    log "WARN: could not set models.providers.litellm-router.localService (see above); requests routed to the small local model may overflow its context window"
  fi
}

# finalize_registration: the display name, no stale entry from builds that
# called the model smart-router, and Tool Search (see above).
ADAPTIVE_NAME="Adaptive"
finalize_registration() {
  local models_json updated
  models_json="$("$OPENCLAW_BIN" config get models.providers.litellm-router.models --json 2>/dev/null || true)"
  updated="$(printf '%s' "$models_json" | ADAPTIVE_NAME="$ADAPTIVE_NAME" "$NODE_BIN" -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      let models;
      try { models = JSON.parse(raw); } catch { process.exit(1); }
      if (!Array.isArray(models)) process.exit(1);
      const next = models.filter((m) => m && m.id !== "smart-router")
        .map((m) => (m.id === "adaptive" ? Object.assign({}, m, { name: process.env.ADAPTIVE_NAME }) : m));
      if (JSON.stringify(next) === JSON.stringify(models)) process.exit(3);
      process.stdout.write(JSON.stringify(next));
    });
  ' 2>/dev/null)"
  if [[ -n "$updated" ]]; then
    "$OPENCLAW_BIN" config set models.providers.litellm-router.models "$updated" --strict-json >>"$LOG_FILE" 2>&1 \
      && log "Named litellm-router/adaptive \"$ADAPTIVE_NAME\"" \
      || log "WARN: could not update the litellm-router model entry (see above)"
  fi
  ensure_router_local_service
  enable_adaptive_plugin
}

# enable_adaptive_plugin: the bundled adaptive-model plugin (extensions/
# adaptive-model) completes the adaptive model. When the adaptive model is
# selected, it asks the local classifier -- through this router -- how
# demanding each user message is and runs that turn on the matching configured
# model, called by OpenClaw itself: models whose credentials only OpenClaw has
# (auth profiles, OAuth logins, secret references) are routed to as well. When
# it cannot decide, the turn goes to this router as before. A user who
# disabled the plugin (enabled: false) is left alone; installer settings are
# only filled in where the user has not set anything.
enable_adaptive_plugin() {
  local tier override path package_dir output
  # Look for the plugin in the installed CLI package itself: `plugins inspect`
  # reads the plugin index cache, which can miss a bundled plugin that is new
  # in this CLI build until the index is refreshed.
  # The CLI wrapper execs <package>/dist/entry.js; fall back to the default
  # install-cli.sh layout.
  package_dir=""
  for package_dir in \
    "$(/usr/bin/grep -o '[^" ]*/dist/entry\.js' "$OPENCLAW_BIN" 2>/dev/null | /usr/bin/head -n1 | /usr/bin/sed 's#/dist/entry\.js$##')" \
    "$PREFIX"/tools/node-v*/lib/node_modules/openclaw; do
    [[ -n "$package_dir" && -f "$package_dir/dist/extensions/adaptive-model/openclaw.plugin.json" ]] && break
    package_dir=""
  done
  if [[ -z "$package_dir" ]]; then
    log "The installed CLI has no adaptive-model plugin -- the adaptive model routes through the router alone"
    return 0
  fi
  if ! "$OPENCLAW_BIN" config get plugins.entries.adaptive-model.enabled --json >/dev/null 2>&1; then
    if ! output="$("$OPENCLAW_BIN" plugins enable adaptive-model 2>&1)"; then
      printf '%s\n' "$output" >>"$LOG_FILE"
      log "Refreshing the plugin index and retrying (plugins enable failed, see above)"
      "$OPENCLAW_BIN" plugins registry --refresh >>"$LOG_FILE" 2>&1 || true
      if ! output="$("$OPENCLAW_BIN" plugins enable adaptive-model 2>&1)"; then
        printf '%s\n' "$output" >>"$LOG_FILE"
        log "WARN: could not enable the adaptive-model plugin (see above)"
        return 0
      fi
    fi
    printf '%s\n' "$output" >>"$LOG_FILE"
    log "Enabled the adaptive-model plugin"
  elif [[ "$("$OPENCLAW_BIN" config get plugins.entries.adaptive-model.enabled --json 2>/dev/null)" == "false" ]]; then
    log "The adaptive-model plugin is disabled in the config -- leaving it off"
    return 0
  fi
  set_plugin_default() { # <config path> <JSON value>
    "$OPENCLAW_BIN" config get "$1" --json >/dev/null 2>&1 && return 0
    "$OPENCLAW_BIN" config set "$1" "$2" --strict-json >>"$LOG_FILE" 2>&1 \
      || log "WARN: could not set $1 (see above)"
  }
  path="plugins.entries.adaptive-model.config"
  if [[ -n "$DEFAULT_MODEL_REF" ]]; then
    set_plugin_default "$path.defaultModel" "$(json_string "$DEFAULT_MODEL_REF")"
  fi
  set_plugin_default "$path.routerBaseUrl" "$(json_string "http://127.0.0.1:${PORT}/v1")"
  for tier in MEDIUM COMPLEX REASONING; do
    case "$tier" in
      MEDIUM) override="$TIER_MEDIUM_OVERRIDE" ;;
      COMPLEX) override="$TIER_COMPLEX_OVERRIDE" ;;
      REASONING) override="$TIER_REASONING_OVERRIDE" ;;
    esac
    [[ -n "$override" ]] && set_plugin_default "$path.tiers.$tier" "$(json_string "$override")"
  done
  return 0
}

json_string() {
  "$NODE_BIN" -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

OPENCLAW_CONFIG="$PREFIX/openclaw.json"
if [[ -f "$OPENCLAW_CONFIG" ]] && /usr/bin/grep -Fq '"litellm-router/adaptive"' "$OPENCLAW_CONFIG" \
  && /usr/bin/grep -Fq "127.0.0.1:${PORT}" "$OPENCLAW_CONFIG"; then
  log "litellm-router/adaptive already registered"
  finalize_registration
  exit 0
fi
ONBOARD_HELP="$("$OPENCLAW_BIN" onboard --help 2>/dev/null || true)"
/usr/bin/grep -q -- '--custom-as-backup' <<<"$ONBOARD_HELP" \
  || fail "the installed CLI has no 'onboard --custom-as-backup'"
if CUSTOM_API_KEY="$MASTER_KEY" "$OPENCLAW_BIN" onboard --non-interactive --accept-risk --mode local --skip-daemon \
    --skip-health --skip-ui --skip-hooks --skip-channels --skip-search --skip-skills --skip-bootstrap \
    --auth-choice custom-api-key \
    --custom-base-url "http://127.0.0.1:${PORT}/v1" \
    --custom-model-id "adaptive" \
    --custom-provider-id "litellm-router" \
    --custom-compatibility openai \
    --custom-as-backup >>"$LOG_FILE" 2>&1; then
  log "Registered litellm-router/adaptive (127.0.0.1:$PORT)"
  finalize_registration
  exit 0
fi
fail "registering litellm-router/adaptive with the CLI failed (see $LOG_FILE)"
