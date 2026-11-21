#!/bin/bash
set -euo pipefail

# Installs the credential and default model baked into a macOS installer.
# Onboarding first resolves the physical provider identity from provider id and
# base URL, without receiving an API key. The credential is then written through
# the live auth owner. That owner reuses the profile bound to the resolved
# provider connection, so a repeated install replaces the key in place. Handing
# an already-configured provider a key during onboarding
# instead creates an inactive setup-replacement profile, so every reinstall
# would add another unusable setup-<uuid> entry.

OPENCLAW_BIN=""
PROFILE=""
PROVIDER_ID=""
BASE_URL=""
MODEL_ID=""
API_KEY_FILE=""
DAEMON_MODE=""

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

CLI=("$OPENCLAW_BIN")
if [[ -n "$PROFILE" ]]; then
  CLI+=(--profile "$PROFILE")
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
  "${CLI[@]}" models auth paste-api-key \
    --provider "$EFFECTIVE_PROVIDER_ID" \
    --agent main < "$API_KEY_FILE"
fi
