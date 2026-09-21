#!/bin/bash
#
# Fast-path launch dispatcher for the self-installing OpenClaw.app build
# produced by scripts/build-mac-installer.sh. Copied into the app bundle at
# Contents/Resources/OpenClawDispatch.sh, and called by the compiled
# AppleScript applet stub that build-mac-installer.sh installs as
# Contents/MacOS/OpenClaw (replacing the real, Swift-compiled GUI binary,
# which that same step moves to Contents/MacOS/OpenClaw-bin) on EVERY
# double-click.
#
# Job: decide, as fast as possible, whether the CLI/Node/Gateway/onboard
# provisioning done by scripts/mac-installer-runtime.sh has already run
# successfully on this Mac.
#
#   - If yes (every launch after the first, the overwhelming majority of
#     launches): launch Contents/MacOS/OpenClaw-bin directly and exit 0.
#     The calling AppleScript stub treats exit 0 as "handled" and does
#     nothing else -- no Terminal window, no visible delay, indistinguishable
#     from double-clicking a normal, already-installed app.
#   - If no: exit 1. The calling AppleScript stub treats a nonzero exit as
#     "first run" and falls through to opening Terminal and running the full
#     scripts/mac-installer-runtime.sh install flow instead.
set -uo pipefail

export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

APP_RESOURCES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$APP_RESOURCES/.." && cd .. && pwd)"
REAL_BIN="$APP_ROOT/Contents/MacOS/OpenClaw-bin"

# A GUI double-click launches this with a minimal environment (no ~/.zshrc,
# no ~/.zprofile PATH additions) -- same PATH scripts/mac-installer-runtime.sh
# exports, so `command -v openclaw` finds it wherever provisioning actually
# put it (the nodejs.org-download prefix specifically, if that's what ended
# up owning the npm global install).
export PATH="$HOME/.local/bin:$HOME/.openclaw/tools/node/bin:$HOME/Library/Application Support/OpenClawInstaller/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

fast_path_ready() {
  [[ -x "$REAL_BIN" ]] \
    && command -v openclaw >/dev/null 2>&1 \
    && [[ -f "$HOME/.openclaw/openclaw.json" ]] \
    && [[ -f "$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist" ]]
}

if fast_path_ready; then
  nohup "$REAL_BIN" "$@" >/dev/null 2>&1 &
  disown
  exit 0
fi

exit 1
