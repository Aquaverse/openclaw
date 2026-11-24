#!/bin/bash

PNPM_CMD=()

# Keep Corepack's package and pnpm's native executable across macOS package
# builds. Without an explicit owner, an isolated or changed HOME makes Corepack
# download the pinned pnpm binary again.
export COREPACK_HOME="${COREPACK_HOME:-$ROOT_DIR/.artifacts/mac-installer-corepack-cache}"
mkdir -p "$COREPACK_HOME"

resolve_pnpm_cmd() {
  if command -v corepack >/dev/null 2>&1 && (cd "$ROOT_DIR" && corepack pnpm --version >/dev/null 2>&1); then
    PNPM_CMD=(corepack pnpm)
    return 0
  fi

  if command -v pnpm >/dev/null 2>&1; then
    PNPM_CMD=(pnpm)
    return 0
  fi

  echo "ERROR: pnpm is not on PATH and corepack pnpm is unavailable. Install pnpm or run with Node/Corepack on PATH." >&2
  exit 1
}

run_pnpm() {
  if [[ "${#PNPM_CMD[@]}" -eq 0 ]]; then
    resolve_pnpm_cmd
  fi
  (cd "$ROOT_DIR" && "${PNPM_CMD[@]}" "$@")
}
