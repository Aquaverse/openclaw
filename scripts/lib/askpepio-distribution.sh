#!/bin/bash

# Ask Pepio is a branded Nexus distribution. Keep the upstream OpenClaw
# executable and CLI names intact; only product-facing artifacts and persistent
# namespaces change. Sourcing this file is intentionally a no-op for ordinary
# OpenClaw builds.
if [[ "${OPENCLAW_INSTALLER_NEXUS_PRESET:-0}" == "1" ]]; then
  export OPENCLAW_PRODUCT_DISPLAY_NAME="Ask Pepio"
  export OPENCLAW_PRODUCT_FILE_NAME="AskPepio"
  export OPENCLAW_PRODUCT_BUNDLE_ID="ai.pepio.mac"
  export OPENCLAW_PRODUCT_IDENTITY_PREFIX="ai.pepio"
  export OPENCLAW_PRODUCT_STATE_DIRECTORY_NAME=".askpepio"
  export OPENCLAW_PRODUCT_APPLICATION_SUPPORT_NAME="askpepio"
  export OPENCLAW_PRODUCT_LOG_DIRECTORY_NAME="AskPepio"
  export OPENCLAW_PRODUCT_CACHE_DIRECTORY_NAME="askpepio"
  export OPENCLAW_PRODUCT_DOMAIN="pepio.ai"
  export VITE_OPENCLAW_PRODUCT_NAME="Ask Pepio"
fi
