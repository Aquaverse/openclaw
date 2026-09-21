#!/bin/bash
set -euo pipefail

# One-click pipeline: build OpenClaw.app from source, then transform that
# SAME app bundle in place into a single, self-installing OpenClaw.app --
# double-click it on a Mac with no CLI/Gateway set up yet and it silently
# provisions a bundled Node.js runtime (no download) and the `openclaw`
# CLI, finishes non-interactive onboarding (optionally with a baked default
# AI provider -- see installer.env.example), and installs the local
# Gateway as a launchd daemon before launching into the app. There is no
# separate installer app and no nested OpenClaw.app copy: after this runs,
# dist/OpenClaw.app IS both the installer and the app, one bundle.
#
# This replaces what used to be two separate steps in two separate
# checkouts: build OpenClaw.app here, then hand a downloaded, already-signed
# OpenClaw-<version>.dmg release to a second "installer builder" project
# that wrapped it in a distinct outer app. Now it's one command, one bundle,
# built straight from source.
#
# Usage:
#   scripts/package-mac-installer.sh
#
# Every env var scripts/package-mac-app.sh accepts (ALLOW_ADHOC_SIGNING,
# SIGN_IDENTITY, OPENCLAW_SKIP_MLX_TTS, BUILD_CONFIG, ...) and every env var
# scripts/build-mac-installer.sh accepts (NOTARIZE, SKIP_DMG, BUILD_ZIP,
# OPENCLAW_NODE_VERSION, ...) both apply here -- see those two scripts' own
# header comments for the full list, including build-mac-installer.sh's
# signing/entitlements caveat.
#
# To re-transform an already-built dist/OpenClaw.app without rebuilding it
# from source (fast iteration on the installer logic itself), call
# scripts/build-mac-installer.sh directly instead of this pipeline. To get
# a plain, untransformed dist/OpenClaw.app back (e.g. for
# scripts/restart-mac.sh dev iteration), just run scripts/package-mac-app.sh
# again -- it always rebuilds dist/OpenClaw.app fresh.
#
# Output:
#   dist/OpenClaw.app                     (self-installing, one bundle)
#   dist/OpenClaw-<version>-Install.dmg   (styled, unless SKIP_DMG=1)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=================================================="
echo "1/2  Building OpenClaw.app from source"
echo "=================================================="
"$ROOT_DIR/scripts/package-mac-app.sh"

echo ""
echo "=================================================="
echo "2/2  Transforming it into a self-installing app (in place)"
echo "=================================================="
"$ROOT_DIR/scripts/build-mac-installer.sh" "$ROOT_DIR/dist/OpenClaw.app"

echo ""
echo "✅ One-click installer pipeline complete."
