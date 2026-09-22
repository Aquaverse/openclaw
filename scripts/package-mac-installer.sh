#!/bin/bash
set -euo pipefail

# Two-step pipeline: build OpenClaw.app from source (scripts/package-mac-app.sh),
# then re-sign and package it for distribution (scripts/build-mac-installer.sh).
# The app bundle itself is left completely alone -- Contents/MacOS/OpenClaw
# is still the real, Swift-compiled GUI binary, launched normally by a
# double-click through Launch Services, same as any other Mac app. First-run
# Node.js/CLI/Gateway provisioning is handled entirely by the app's own
# existing, native onboarding UI (see apps/macos/Sources/OpenClaw/CLIInstaller.swift),
# exactly like an official OpenClaw.app build.
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
# ...) both apply here -- see those two scripts' own header comments for
# the full list, including build-mac-installer.sh's signing/entitlements
# caveat.
#
# To re-run just the sign/package step against an already-built
# dist/OpenClaw.app without rebuilding it from source, call
# scripts/build-mac-installer.sh directly instead of this pipeline. To get
# a clean, unsigned-by-that-step dist/OpenClaw.app back (e.g. for
# scripts/restart-mac.sh dev iteration), just run scripts/package-mac-app.sh
# again -- it always rebuilds dist/OpenClaw.app fresh.
#
# Output:
#   dist/OpenClaw.app                     (re-signed, one bundle)
#   dist/OpenClaw-<version>-Install.dmg   (styled, unless SKIP_DMG=1)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=================================================="
echo "1/2  Building OpenClaw.app from source"
echo "=================================================="
"$ROOT_DIR/scripts/package-mac-app.sh"

echo ""
echo "=================================================="
echo "2/2  Signing and packaging for distribution"
echo "=================================================="
"$ROOT_DIR/scripts/build-mac-installer.sh" "$ROOT_DIR/dist/OpenClaw.app"

echo ""
echo "✅ Installer pipeline complete."
