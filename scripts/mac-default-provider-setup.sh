#!/bin/bash
set -euo pipefail

# Installs the credential and default model baked into a macOS installer.
# Onboarding first resolves the physical provider identity from provider id and
# base URL, without receiving an API key. The credential is then written through
# the live auth owner. That owner reuses an ordinary profile bound to the
# resolved provider connection, so a repeated install replaces the key in place.
# An inactive setup-replacement binding is switched to the ordinary manual
# profile instead; preserving its setup marker would leave the new key unusable.
# `--check-auth-binding` is the shared read-only readiness probe used by both
# the pkg postinstall and the dmg first-launch bootstrap; it never writes state.

OPENCLAW_BIN=""
PROFILE=""
PROVIDER_ID=""
BASE_URL=""
MODEL_ID=""
API_KEY_FILE=""
DAEMON_MODE=""
CHECK_AUTH_BINDING=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --openclaw-bin)
      OPENCLAW_BIN="$2"
      shift 2
      ;;
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --provider-id)
      PROVIDER_ID="$2"
      shift 2
      ;;
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --model-id)
      MODEL_ID="$2"
      shift 2
      ;;
    --api-key-file)
      API_KEY_FILE="$2"
      shift 2
      ;;
    --install-daemon | --skip-daemon)
      DAEMON_MODE="$1"
      shift
      ;;
    --check-auth-binding)
      CHECK_AUTH_BINDING=1
      shift
      ;;
    *)
      echo "ERROR: unknown default-provider setup option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$OPENCLAW_BIN" || ! -x "$OPENCLAW_BIN" ]]; then
  echo "ERROR: --openclaw-bin must name an executable OpenClaw CLI" >&2
  exit 2
fi
CLI=("$OPENCLAW_BIN")
if [[ -n "$PROFILE" ]]; then
  CLI+=(--profile "$PROFILE")
fi

if [[ "$CHECK_AUTH_BINDING" == "1" ]]; then
  MODEL_REF="$("${CLI[@]}" config get agents.defaults.model.primary --json)" || exit 1
  MODEL_REF="${MODEL_REF#\"}"
  MODEL_REF="${MODEL_REF%\"}"
  EFFECTIVE_PROVIDER_ID="${MODEL_REF%%/*}"
  [[ -n "$EFFECTIVE_PROVIDER_ID" && "$EFFECTIVE_PROVIDER_ID" != "$MODEL_REF" ]] || exit 1
  BINDING="$("${CLI[@]}" config get "models.providers.$EFFECTIVE_PROVIDER_ID.apiKey" --json)" || exit 1
  [[ -n "$BINDING" && "$BINDING" != "null" && "$BINDING" != '""' ]] || exit 1
  # `models status --check` covers every fallback and utility route. Inspect the
  # selected binding only, so an unrelated user model cannot trigger key replacement.
  STATUS_JSON="$("${CLI[@]}" models status --json --agent main)" || exit 1
  CLI_PREFIX="$(cd "$(dirname "$OPENCLAW_BIN")/.." 2>/dev/null && /bin/pwd -P || true)"
  NODE_BIN="$CLI_PREFIX/tools/node/bin/node"
  if [[ ! -x "$NODE_BIN" ]]; then
    NODE_BIN="$(command -v node || true)"
  fi
  [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || exit 1
  printf '%s' "$STATUS_JSON" | "$NODE_BIN" -e '
const fs = require("node:fs");
const status = JSON.parse(fs.readFileSync(0, "utf8"));
const binding = JSON.parse(process.argv[1]);
const provider = process.argv[2];
const modelRef = process.argv[3];
const profile = status.auth?.oauth?.profiles?.find((entry) => entry.profileId === binding);
const routeIssue = status.auth?.modelRouteIssues?.some(
  (entry) => entry.provider === provider && `${entry.provider}/${entry.model}` === modelRef,
);
if (
  typeof binding !== "string" ||
  status.resolvedDefault !== modelRef ||
  routeIssue ||
  profile?.provider !== provider ||
  profile?.type !== "api_key" ||
  profile?.status !== "static"
) {
  process.exit(1);
}
' "$BINDING" "$EFFECTIVE_PROVIDER_ID" "$MODEL_REF" || exit 1
  exit 0
fi

if [[ -z "$BASE_URL" || -z "$MODEL_ID" || -z "$DAEMON_MODE" ]]; then
  echo "ERROR: --base-url, --model-id and one daemon mode are required" >&2
  exit 2
fi
if [[ -n "$API_KEY_FILE" && ! -r "$API_KEY_FILE" ]]; then
  echo "ERROR: --api-key-file must name a readable file" >&2
  exit 2
fi
if [[ -n "$API_KEY_FILE" && -z "$PROVIDER_ID" ]]; then
  echo "ERROR: --provider-id is required when installing an API key" >&2
  exit 2
fi

ONBOARD_ARGS=(
  onboard --non-interactive --accept-risk --mode local "$DAEMON_MODE"
  --skip-health --skip-ui --skip-hooks --skip-channels --skip-search --skip-skills --skip-bootstrap
  --auth-choice custom-api-key
  --custom-base-url "$BASE_URL"
  --custom-model-id "$MODEL_ID"
  --custom-compatibility openai
)
if [[ -n "$PROVIDER_ID" ]]; then
  ONBOARD_ARGS+=(--custom-provider-id "$PROVIDER_ID")
fi

"${CLI[@]}" "${ONBOARD_ARGS[@]}"

if [[ -n "$API_KEY_FILE" ]]; then
  MODEL_REF="$("${CLI[@]}" config get agents.defaults.model.primary --json)"
  MODEL_REF="${MODEL_REF#\"}"
  MODEL_REF="${MODEL_REF%\"}"
  EFFECTIVE_PROVIDER_ID="${MODEL_REF%%/*}"
  if [[ -z "$EFFECTIVE_PROVIDER_ID" || "$EFFECTIVE_PROVIDER_ID" == "$MODEL_REF" || "${MODEL_REF#*/}" != "$MODEL_ID" ]]; then
    echo "ERROR: onboarding selected an unexpected default model" >&2
    exit 1
  fi
  if [[ "$DAEMON_MODE" == "--install-daemon" ]]; then
    GATEWAY_READY=0
    for ((ATTEMPT = 1; ATTEMPT <= 60; ATTEMPT++)); do
      if "${CLI[@]}" gateway call status --json >/dev/null 2>&1; then
        GATEWAY_READY=1
        break
      fi
      /bin/sleep 1
    done
    if [[ "$GATEWAY_READY" != "1" ]]; then
      echo "ERROR: Gateway did not become ready for default-provider credential setup" >&2
      exit 1
    fi
  fi
  "${CLI[@]}" models auth paste-api-key \
    --provider "$EFFECTIVE_PROVIDER_ID" \
    --agent main < "$API_KEY_FILE"
fi
