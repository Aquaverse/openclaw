#!/bin/bash
set -euo pipefail

# Registers the provider/model and credential baked into a macOS installer.
# It initializes an empty default model, but preserves any model the user
# already selected.
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
EXPECTED_MODEL_REF=""
RESOLVED_MODEL_FILE=""

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
    --expected-model-ref)
      EXPECTED_MODEL_REF="$2"
      shift 2
      ;;
    --resolved-model-file)
      RESOLVED_MODEL_FILE="$2"
      shift 2
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
  # The auth owner stores API-key profiles in the agent database; provider config
  # intentionally does not contain the key or a profile id. Use the one status
  # projection that exposes effective stored profiles for every provider.
  # This also avoids two extra CLI/config-worker startups during every pkg upgrade.
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
const modelRef = process.argv[1] || status.resolvedDefault;
const provider = typeof modelRef === "string" ? modelRef.split("/", 1)[0] : "";
const providerStatus = status.auth?.oauth?.providers?.find((entry) => entry.provider === provider);
const profiles = providerStatus?.effectiveProfiles ?? [];
const routeIssue = !process.argv[1] && status.auth?.modelRouteIssues?.some(
  (entry) => entry.provider === provider && `${entry.provider}/${entry.model}` === modelRef,
);
if (
  !provider ||
  routeIssue ||
  !profiles.some(
    (profile) =>
      profile?.provider === provider && profile?.type === "api_key" && profile?.status === "static",
  )
) {
  process.exit(1);
}
' "$EXPECTED_MODEL_REF" || exit 1
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

ORIGINAL_MODEL_REF="$("${CLI[@]}" config get agents.defaults.model.primary --json 2>/dev/null || true)"
ORIGINAL_MODEL_REF="${ORIGINAL_MODEL_REF#\"}"
ORIGINAL_MODEL_REF="${ORIGINAL_MODEL_REF%\"}"
[[ "$ORIGINAL_MODEL_REF" == "null" ]] && ORIGINAL_MODEL_REF=""

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

MODEL_REF="$("${CLI[@]}" config get agents.defaults.model.primary --json)"
MODEL_REF="${MODEL_REF#\"}"
MODEL_REF="${MODEL_REF%\"}"
EFFECTIVE_PROVIDER_ID="${MODEL_REF%%/*}"
if [[ -z "$EFFECTIVE_PROVIDER_ID" || "$EFFECTIVE_PROVIDER_ID" == "$MODEL_REF" || "${MODEL_REF#*/}" != "$MODEL_ID" ]]; then
  echo "ERROR: onboarding selected an unexpected bundled model" >&2
  exit 1
fi
if [[ -n "$RESOLVED_MODEL_FILE" ]]; then
  printf '%s\n' "$MODEL_REF" > "$RESOLVED_MODEL_FILE"
fi

# Advertise the request contract without exposing the installer endpoint to UI clients.
# At install or upgrade, the capability follows the endpoint, including matching
# models the user configured under another provider id.
PROVIDERS_JSON="$("${CLI[@]}" config get models.providers --json)"
CLI_PREFIX="$(cd "$(dirname "$OPENCLAW_BIN")/.." 2>/dev/null && /bin/pwd -P || true)"
NODE_BIN="$CLI_PREFIX/tools/node/bin/node"
if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "ERROR: Node is required to mark the bundled model capability" >&2
  exit 1
fi
CHANGED_PROVIDER_MODELS="$(printf '%s' "$PROVIDERS_JSON" | "$NODE_BIN" -e '
const fs = require("node:fs");
const providers = JSON.parse(fs.readFileSync(0, "utf8"));
const target = String(process.argv[1] || "").trim().replace(/\/+$/, "");
const changed = [];
for (const [providerId, provider] of Object.entries(providers || {})) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(providerId)) {
    throw new Error(`Invalid provider id: ${providerId}`);
  }
  const models = Array.isArray(provider.models) ? provider.models : [];
  const nextModels = models.map((model) => {
    const effective = String(model.baseUrl || provider.baseUrl || "").trim().replace(/\/+$/, "");
    const params = model.params && typeof model.params === "object" && !Array.isArray(model.params)
      ? { ...model.params }
      : {};
    if (effective === target) {
      params.supportsPiiReplace = true;
    } else {
      delete params.supportsPiiReplace;
    }
    const next = { ...model };
    if (Object.keys(params).length > 0) {
      next.params = params;
    } else {
      delete next.params;
    }
    return next;
  });
  if (JSON.stringify(nextModels) !== JSON.stringify(models)) {
    changed.push(`${providerId}\t${JSON.stringify(nextModels)}`);
  }
}
process.stdout.write(changed.join("\n"));
' "$BASE_URL")"
while IFS=$'\t' read -r CAPABILITY_PROVIDER_ID UPDATED_MODELS_JSON; do
  [[ -z "$CAPABILITY_PROVIDER_ID" ]] && continue
  "${CLI[@]}" config set "models.providers.${CAPABILITY_PROVIDER_ID}.models" \
    "$UPDATED_MODELS_JSON" --strict-json
done <<< "$CHANGED_PROVIDER_MODELS"

# Custom-provider onboarding selects the provider it just registered. An
# installer is allowed to initialize an empty primary, but an upgrade must not
# replace a model the user selected. Restore that choice before credential work
# so even a later auth-owner failure cannot leave the bundled model selected.
if [[ -n "$ORIGINAL_MODEL_REF" && "$ORIGINAL_MODEL_REF" != "$MODEL_REF" ]]; then
  "${CLI[@]}" models set "$ORIGINAL_MODEL_REF"
fi

if [[ -n "$API_KEY_FILE" ]]; then
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
