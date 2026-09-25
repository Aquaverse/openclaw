#!/bin/bash
set -euo pipefail

# Turn a plain OpenClaw.app (scripts/package-mac-app.sh's own output) into
# the distributable build: optionally bakes a default AI provider and a
# bundled Node.js runtime into it (see installer.env.example), re-signs,
# and produces both a plain dmg and a self-provisioning .pkg installer.
#
# The app bundle itself is left completely alone -- Contents/MacOS/OpenClaw
# is still the real, Swift-compiled GUI binary, exactly what
# package-mac-app.sh produced, launched normally by a double-click through
# Launch Services like any other Mac app. That part never changes.
#
# An earlier version of this script instead moved the real GUI binary aside
# and spliced in a compiled AppleScript applet as a new
# Contents/MacOS/OpenClaw, so that every double-click ran a dispatcher
# script first and, on a genuine first run, opened a visible Terminal
# window to run a whole separate shell-script installer before ever
# launching the real app. That fought macOS's own conventions badly enough
# to cause real, repeatable bugs: Gatekeeper's dedicated "Press Run to run
# this script or Quit to quit" prompt for script-based (AppleScript-applet)
# app bundles kept reappearing because quarantine on a manually-installed
# copy never got a chance to clear; the window's miniaturize button, the
# red close button's quit behavior, and the Dock icon's right-click "Quit"
# were all broken because a process forked directly from that script was
# never registered with Launch Services as a real running application; and
# the fast-path re-dispatch could itself fail and silently fall back to
# opening a full Terminal window on every single launch, not just the
# first. None of that exists anymore -- see the removed
# scripts/mac-installer-runtime.sh and scripts/mac-app-installer-dispatch.sh
# in git history if any of it is ever needed again.
#
# Silent Node/CLI/Gateway provisioning is back, but on a completely
# different, much better-trodden mechanism: this script now also builds a
# .pkg installer (scripts/mac-pkg-postinstall.sh) whose postinstall script
# runs once, as root, right after Installer.app copies OpenClaw.app into
# /Applications and before it is ever launched -- using the standard
# `launchctl asuser <uid> sudo -u <user>` pattern to act as the logged-in
# user. It installs the CLI (offline, from the Node tarball bundled below,
# when present), runs `openclaw onboard --non-interactive --install-daemon
# --mode local` (optionally pre-filling a default AI provider from
# installer.env), and marks the app's own onboarding as seen -- so a pkg
# install lands straight in chat with a working local Gateway, same as
# the old architecture intended, without ever touching the app bundle
# itself or Launch Services. Every step in there is independently
# best-effort: any failure just falls back to the app's own normal
# onboarding UI (see that script's own header comment). The dmg is still
# built too, unchanged, with no silent provisioning, for a plain manual
# drag-to-Applications install with no admin-password prompt.
#
# Usage:
#   scripts/build-mac-installer.sh [path/to/OpenClaw.app | path/to/OpenClaw-*.dmg]
#   (defaults to dist/OpenClaw.app, i.e. package-mac-app.sh's own output --
#   mutated in place; re-run package-mac-app.sh first for a clean, plain
#   build again)
#
# Env:
#   SIGN_IDENTITY          Explicit codesigning identity for the re-sign
#                          pass. Auto-detects (Developer ID Application >
#                          Apple Distribution > Apple Development) when
#                          unset -- same resolution order as
#                          scripts/codesign-mac-app.sh.
#   ALLOW_ADHOC_SIGNING=1  Fall back to ad-hoc ("-") signing when no real
#                          identity is found/configured. Required if this
#                          machine has no signing identity at all.
#   NOTARIZE=1              Submit the signed app for notarization and
#                          staple the ticket (needs a real, non-ad-hoc
#                          SIGN_IDENTITY). See scripts/notarize-mac-artifact.sh
#                          for its NOTARYTOOL_* credential env vars. Given
#                          the entitlements caveat above, don't reach for
#                          this without first working through that.
#   SKIP_DMG=1             Skip the styled dmg (the pkg is still built).
#   SKIP_PKG=1             Skip the .pkg installer (the dmg is still built).
#   SKIP_NODE_BUNDLE=1     Don't bundle a Node tarball into the app --
#                          scripts/mac-pkg-postinstall.sh (and manual
#                          install-cli.sh runs) fall back to downloading
#                          Node from nodejs.org at install time instead.
#   OPENCLAW_NODE_VERSION   Node version to bundle/install (default: the
#                          same 24.19.0 default scripts/install-cli.sh uses).
#   SKIP_CLI_BUNDLE=1      Don't bundle this checkout's OpenClaw CLI package --
#                          installs then fetch openclaw from the npm registry
#                          (install-cli.sh --version latest) as before, and
#                          CLI-side changes made in this repo (e.g. onboard
#                          --custom-as-backup, used by the llama.cpp fallback)
#                          are NOT available to the installed CLI.
#   SKIP_LLAMA_BUNDLE=1    Don't bundle a llama.cpp llama-server binary into
#                          the app -- the local-model fallback (see
#                          OPENCLAW_INSTALLER_DEFAULT_LLAMA_MODEL in
#                          installer.env.example) is then skipped entirely at
#                          install/first-launch time, since there is no
#                          bundled server to run it with.
#   OPENCLAW_LLAMA_VERSION  llama.cpp release tag to bundle (e.g. "b11149"; also
#                          read from installer.env when not set here), or
#                          "latest" (default) to resolve the newest GitHub
#                          release at build time. Pin an exact tag for
#                          reproducible builds.
#   BUILD_ZIP=1            Also produce a .zip (known to occasionally trip
#                          Gatekeeper's "damaged" check after transfer on
#                          some Macs -- prefer the dmg; see the note below).
#   DMG_VOLUME_NAME / DMG_WINDOW_BOUNDS / DMG_ICON_SIZE / DMG_APP_POS /
#   DMG_APPS_POS           Forwarded to scripts/create-dmg.sh (its defaults
#                          already match this installer's original layout).
#
# Must run on real macOS (hdiutil/ditto/PlistBuddy/codesign -- all ship
# with the OS, no Xcode install required).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/plistbuddy.sh"

# macOS's system bash (3.2) drops into the "C" locale with no locale env at
# all (as a bare invocation can give it), and its byte classification there
# can misparse embedded non-ASCII text badly enough to corrupt a nearby
# $VAR expansion -- good general practice to force real UTF-8 regardless.
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

DIST_DIR="$ROOT_DIR/dist"
INPUT="${1:-$DIST_DIR/OpenClaw.app}"
if [[ ! -e "$INPUT" ]]; then
  echo "ERROR: Not found: $INPUT" >&2
  echo "Usage: $0 [path/to/OpenClaw.app | path/to/OpenClaw-*.dmg]" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
APP="$DIST_DIR/OpenClaw.app"

# ---------------------------------------------------------------------
# 1. Resolve the app to mutate. A .app is mutated in place (if it isn't
#    already at $APP, it's moved there first). A .dmg is mounted, its .app
#    extracted to $APP, then mounted image detached -- same as before.
# ---------------------------------------------------------------------
SRC_MOUNT=""
detach_src() { [[ -n "$SRC_MOUNT" ]] && hdiutil detach "$SRC_MOUNT" -quiet 2>/dev/null || true; }
trap detach_src EXIT

case "$INPUT" in
  *.app)
    if [[ "$(cd "$INPUT" && pwd)" != "$APP" ]]; then
      echo "==> Moving $INPUT to $APP"
      rm -rf "$APP"
      mv "$INPUT" "$APP"
    fi
    ;;
  *.dmg)
    echo "==> Mounting $INPUT"
    SRC_MOUNT="$(mktemp -d)"
    hdiutil attach "$INPUT" -mountpoint "$SRC_MOUNT" -nobrowse -quiet
    FOUND_APP="$(find "$SRC_MOUNT" -maxdepth 1 -iname '*.app' | head -1)"
    if [[ -z "$FOUND_APP" ]]; then
      echo "ERROR: No .app bundle found inside $INPUT" >&2
      exit 1
    fi
    echo "==> Found $FOUND_APP -- copying to $APP"
    rm -rf "$APP"
    ditto "$FOUND_APP" "$APP"
    ;;
  *)
    echo "ERROR: Input must be an .app bundle or a .dmg: $INPUT" >&2
    exit 1
    ;;
esac

if [[ ! -d "$APP" ]]; then
  echo "ERROR: Not a valid app bundle: $APP" >&2
  exit 1
fi

APP_BIN="$APP/Contents/MacOS/OpenClaw"
if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: $APP_BIN not found or not executable -- not a valid OpenClaw.app build." >&2
  exit 1
fi

APP_VERSION="$(plist_print_required "$APP/Contents/Info.plist" CFBundleShortVersionString)"
echo "==> App: $APP (version $APP_VERSION)"

if codesign -dv "$APP_BIN" 2>&1 | grep -q '^Signature=adhoc$'; then
  echo "WARN: The build being transformed is only ad-hoc signed. Re-signing"
  echo "      below (ad-hoc or otherwise) doesn't change that this is a"
  echo "      dev/local build, not an Apple-notarized one -- Gatekeeper will"
  echo "      still need a right-click -> Open on first launch on any other Mac."
fi

# ---------------------------------------------------------------------
# 2. Bundle a Node.js runtime tarball (on by default): downloads, once,
# the official nodejs.org tarball for whichever CPU architecture(s) this
# app bundle actually contains, caches it under .artifacts/ for future
# builds, and copies it into Contents/Resources/node-runtime/. This is
# what lets the .pkg installer below provision Node completely offline
# via scripts/install-cli.sh's OPENCLAW_NODE_TARBALL support, instead of
# everyone's first run needing its own nodejs.org download. Skip with
# SKIP_NODE_BUNDLE=1 -- the app's onboarding UI and the pkg's postinstall
# script both still work fine without it, install-cli.sh just downloads
# Node itself at install time like it always did.
# ---------------------------------------------------------------------
NODE_VERSION_FOR_BUNDLE="${OPENCLAW_NODE_VERSION:-24.19.0}"
rm -rf "$APP/Contents/Resources/node-runtime"
if [[ "${SKIP_NODE_BUNDLE:-0}" == "1" ]]; then
  echo "==> SKIP_NODE_BUNDLE=1 -- not bundling a Node runtime; installs will fetch Node from nodejs.org"
else
  NODE_CACHE_DIR="$ROOT_DIR/.artifacts/mac-installer-node-cache"
  mkdir -p "$NODE_CACHE_DIR" "$APP/Contents/Resources/node-runtime"
  APP_ARCHS="$(lipo -archs "$APP_BIN" 2>/dev/null || uname -m)"
  fetch_node_tarball() {
    local arch="$1" tarball url expected_sha actual_sha
    tarball="node-v${NODE_VERSION_FOR_BUNDLE}-darwin-${arch}.tar.gz"
    url="https://nodejs.org/dist/v${NODE_VERSION_FOR_BUNDLE}/${tarball}"
    if [[ ! -f "$NODE_CACHE_DIR/$tarball" ]]; then
      echo "    Downloading $tarball (cached under .artifacts/ for future builds)"
      curl -fsSL --proto '=https' --tlsv1.2 -o "$NODE_CACHE_DIR/$tarball.tmp" "$url"
      mv "$NODE_CACHE_DIR/$tarball.tmp" "$NODE_CACHE_DIR/$tarball"
    fi
    if [[ ! -f "$NODE_CACHE_DIR/$tarball.sha256" ]]; then
      curl -fsSL --proto '=https' --tlsv1.2 -o "$NODE_CACHE_DIR/SHASUMS256.txt.tmp" \
        "https://nodejs.org/dist/v${NODE_VERSION_FOR_BUNDLE}/SHASUMS256.txt"
      expected_sha="$(grep "  ${tarball}$" "$NODE_CACHE_DIR/SHASUMS256.txt.tmp" | awk '{print $1}' | head -n1)"
      rm -f "$NODE_CACHE_DIR/SHASUMS256.txt.tmp"
      if [[ -z "$expected_sha" ]]; then
        echo "ERROR: could not resolve sha256 for $tarball" >&2
        exit 1
      fi
      echo "$expected_sha" > "$NODE_CACHE_DIR/$tarball.sha256"
    fi
    expected_sha="$(cat "$NODE_CACHE_DIR/$tarball.sha256")"
    actual_sha="$(shasum -a 256 "$NODE_CACHE_DIR/$tarball" | awk '{print $1}')"
    if [[ "$actual_sha" != "$expected_sha" ]]; then
      echo "ERROR: cached $tarball sha256 mismatch (expected $expected_sha, got $actual_sha) -- delete $NODE_CACHE_DIR/$tarball and retry" >&2
      exit 1
    fi
    cp "$NODE_CACHE_DIR/$tarball" "$APP/Contents/Resources/node-runtime/$tarball"
    cp "$NODE_CACHE_DIR/$tarball.sha256" "$APP/Contents/Resources/node-runtime/$tarball.sha256"
  }
  echo "==> Bundling Node ${NODE_VERSION_FOR_BUNDLE} for: $APP_ARCHS"
  for arch in $APP_ARCHS; do
    case "$arch" in
      arm64 | x86_64) fetch_node_tarball "$arch" ;;
      *) echo "    (skipping unrecognized arch: $arch)" ;;
    esac
  done
fi

# ---------------------------------------------------------------------
# 2b. Bundle the local scripts/postinstall-bundled-plugins.mjs (interim
# workaround for a real, already-fixed bug: npm's own "postinstall"
# invocation of this script gets a *relative* argv[1], which can realpath
# to a different-looking string than this module's own absolute path on
# some macOS/APFS setups -- so isDirectPostinstallInvocation() silently
# returned false and .openclaw-lifecycle-pending was never removed, even
# though `npm install` itself reported success. The fix lives in this
# repo, but install-cli.sh always installs `openclaw@latest` from the
# real npm registry, so a plain rebuild of this .app can't pick the fix
# up on its own until it's actually published as a new openclaw version.
# Bundling this one file here, and having scripts/mac-pkg-postinstall.sh
# pass its path through install-cli.sh's OPENCLAW_POSTINSTALL_SCRIPT_OVERRIDE
# support, overwrites the freshly-npm-installed copy with this fixed
# version and re-runs it before install-cli.sh checks whether the install
# actually completed -- so a pkg/dmg built from this repo works correctly
# today, without waiting on an npm release. Safe to delete this step (and
# its Resources file, and the OPENCLAW_POSTINSTALL_SCRIPT_OVERRIDE support
# in install-cli.sh) once that release has shipped and had a chance to
# roll out.
# ---------------------------------------------------------------------
cp "$ROOT_DIR/scripts/postinstall-bundled-plugins.mjs" "$APP/Contents/Resources/postinstall-bundled-plugins-fixed.mjs"

# ---------------------------------------------------------------------
# 2c. Refresh Contents/Resources/install-cli.sh from this repo's current
# copy. scripts/package-mac-app.sh (the full JS+Swift build) is what
# normally puts install-cli.sh there -- but it's a plain shell script,
# untouched by that build's JS/Swift steps, so it's safe (and much
# faster) to also re-copy it here. Without this, iterating on
# install-cli.sh itself (like the OPENCLAW_POSTINSTALL_SCRIPT_OVERRIDE
# support above) would silently keep testing against whatever
# install-cli.sh happened to be baked in by the last full
# `pnpm mac:installer` run, even when only running the fast
# `pnpm mac:installer:wrap` path -- exactly the mismatch that first
# shipped the "2b" step above without actually being exercised.
# ---------------------------------------------------------------------
cp "$ROOT_DIR/scripts/install-cli.sh" "$APP/Contents/Resources/install-cli.sh"
chmod 0644 "$APP/Contents/Resources/install-cli.sh"
# Same reasoning for the llama.cpp fallback setup script: package-mac-app.sh
# copies it, so a `pnpm mac:installer:wrap`-only run would otherwise ship
# whatever copy the last full build left in the bundle.
cp "$ROOT_DIR/scripts/mac-llama-fallback-setup.sh" "$APP/Contents/Resources/mac-llama-fallback-setup.sh"
chmod 0644 "$APP/Contents/Resources/mac-llama-fallback-setup.sh"

# ---------------------------------------------------------------------
# 2d. Bundle this checkout's own OpenClaw CLI as an npm package (.tgz).
# install-cli.sh otherwise installs `openclaw@latest` from the npm
# registry, so any CLI-side change made in this repo (onboard
# --custom-as-backup for the llama.cpp fallback, fixes not yet published,
# ...) never reaches the installed CLI, and the CLI version drifts from the
# app's. With the package bundled, CLIInstaller.swift and
# mac-pkg-postinstall.sh point install-cli.sh at it via
# OPENCLAW_PACKAGE_TGZ -- same pattern as the Node tarball in step 2.
# Dependencies are still resolved from the npm registry at install time.
#
# Packs with the repo's canonical package builder
# (scripts/package-openclaw-for-docker.mjs, which also bundles the
# @openclaw/ai workspace package and verifies the tarball) using
# --skip-build: dist/ was just built by package-mac-app.sh's `pnpm build`.
# Never let the packer rebuild here -- its build step wipes dist/, which is
# where dist/OpenClaw.app (the app this script is packaging) lives.
# When running this script alone (pnpm mac:installer:wrap), dist/ is
# whatever the last full build left behind.
# ---------------------------------------------------------------------
rm -rf "$APP/Contents/Resources/openclaw-cli"
if [[ "${SKIP_CLI_BUNDLE:-0}" == "1" ]]; then
  echo "==> SKIP_CLI_BUNDLE=1 -- not bundling a CLI package; installs will fetch openclaw from the npm registry"
else
  if [[ ! -f "$ROOT_DIR/dist/entry.js" ]]; then
    echo "ERROR: $ROOT_DIR/dist/entry.js is missing -- run the full pipeline (pnpm mac:installer) first, or set SKIP_CLI_BUNDLE=1" >&2
    exit 1
  fi
  # Finder drops .DS_Store (and ._* AppleDouble files on some volumes) into
  # any folder you open, e.g. dist/ when looking at dist/OpenClaw.app. npm
  # pack always leaves those out of the tarball, but the packer's dist
  # inventory walks dist/ itself and records them, so the tarball check then
  # fails with "Inventory references absent tar entry dist/.DS_Store".
  # Clear them first (outside .app bundles, which the package excludes).
  find "$ROOT_DIR/dist" -type f \( -name '.DS_Store' -o -name '._*' \) -not -path '*.app/*' -delete
  CLI_PACKAGE_VERSION="$(node -p "require(process.argv[1]).version" "$ROOT_DIR/package.json")"
  CLI_PACK_DIR="$ROOT_DIR/.artifacts/mac-installer-cli-package"
  rm -rf "$CLI_PACK_DIR"
  mkdir -p "$CLI_PACK_DIR"
  # npm pack writes temporary files to its cache even with --ignore-scripts.
  # Keep installer packaging independent of a root-owned or otherwise stale
  # user cache (common after an earlier sudo npm invocation).
  if [[ -z "${NPM_CONFIG_CACHE:-}" ]]; then
    export NPM_CONFIG_CACHE="$ROOT_DIR/.artifacts/mac-installer-npm-cache"
  fi
  mkdir -p "$NPM_CONFIG_CACHE"
  # This script's own outputs (dist/OpenClaw-<version>-Install.dmg/.pkg/.zip
  # from a previous run) also live in dist/, and the package's "files" list
  # only excludes dist/**/*.app -- so they were being packed into the CLI
  # tarball (observed: 70M -> 784M), and each rerun would pack an installer
  # that already contained the previous tarball. Park them outside dist/ while
  # packing and put them back afterwards (this run overwrites them later).
  DIST_STASH_DIR="$ROOT_DIR/.artifacts/mac-installer-dist-stash"
  rm -rf "$DIST_STASH_DIR"
  mkdir -p "$DIST_STASH_DIR"
  restore_dist_stash() {
    find "$DIST_STASH_DIR" -maxdepth 1 -type f -exec mv -f {} "$ROOT_DIR/dist/" \; 2>/dev/null || true
  }
  trap 'restore_dist_stash; detach_src' EXIT
  find "$ROOT_DIR/dist" -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.pkg' -o -name '*.zip' \) \
    -exec mv -f {} "$DIST_STASH_DIR/" \;
  echo "==> Packing this checkout's OpenClaw CLI ${CLI_PACKAGE_VERSION} (reusing dist/ from pnpm build)"
  CLI_TGZ="$(cd "$ROOT_DIR" && node scripts/package-openclaw-for-docker.mjs \
    --skip-build \
    --allow-unreleased-changelog \
    --output-dir "$CLI_PACK_DIR" \
    --output-name "openclaw-${CLI_PACKAGE_VERSION}.tgz" | tail -n 1)"
  restore_dist_stash
  trap detach_src EXIT
  if [[ -z "$CLI_TGZ" || ! -f "$CLI_TGZ" ]]; then
    echo "ERROR: CLI pack did not produce a tarball (got: '${CLI_TGZ}') -- see output above, or set SKIP_CLI_BUNDLE=1" >&2
    exit 1
  fi
  # A normal CLI package is well under 100M; anything this large means
  # something that is not part of the CLI leaked into dist/ and got packed.
  CLI_TGZ_KB="$(du -k "$CLI_TGZ" | cut -f1)"
  if (( CLI_TGZ_KB > 300 * 1024 )); then
    echo "ERROR: $(basename "$CLI_TGZ") is $((CLI_TGZ_KB / 1024))M -- unexpectedly large; list the biggest entries with:" >&2
    echo "       tar -tvzf '$CLI_TGZ' | sort -k3 -n | tail" >&2
    exit 1
  fi
  mkdir -p "$APP/Contents/Resources/openclaw-cli"
  cp "$CLI_TGZ" "$APP/Contents/Resources/openclaw-cli/"
  shasum -a 256 "$CLI_TGZ" | awk '{print $1}' \
    > "$APP/Contents/Resources/openclaw-cli/$(basename "$CLI_TGZ").sha256"
  echo "    Bundled $(basename "$CLI_TGZ") ($(du -h "$CLI_TGZ" | cut -f1))"
fi

# ---------------------------------------------------------------------
ENV_FILE="$ROOT_DIR/installer.env"
read_env_var() {
  [[ -f "$ENV_FILE" ]] || return 0
  # Optional installer.env keys are allowed to be absent. Keep grep's
  # no-match status from triggering the caller's set -e exit path.
  grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n1 | cut -d'=' -f2- || true
}

# ---------------------------------------------------------------------
# 3. llama.cpp local-model fallback (optional): bundles the prebuilt
# `llama-server` release archive (the binary plus its dylibs) into
# the app per architecture, the same offline-friendly way step 2 bundles
# Node's .tar.gz -- unpacked at install time, not at build time. This is
# the binary only -- no GGUF model weights ship in the installer; those are fetched
# from HuggingFace at first launch (see AutoOnboardBootstrap.swift /
# mac-pkg-postinstall.sh) for whichever model
# OPENCLAW_INSTALLER_DEFAULT_LLAMA_MODEL names, and only then is the local
# server started and registered as a *backup* (non-primary) model -- see
# --custom-as-backup on `openclaw onboard` (src/wizard/setup.model-auth.ts /
# src/commands/onboard-non-interactive/local/auth-choice.ts). The online
# default model configured in installer.env, if any, is unaffected and
# stays primary.
#
# Skipped entirely (no bundling, no download, no fallback at
# install/first-launch time) when installer.env has no
# OPENCLAW_INSTALLER_DEFAULT_LLAMA_MODEL set, or with SKIP_LLAMA_BUNDLE=1.
# ---------------------------------------------------------------------
rm -rf "$APP/Contents/Resources/llama-runtime"
LLAMA_MODEL_FOR_BUNDLE="$(read_env_var OPENCLAW_INSTALLER_DEFAULT_LLAMA_MODEL)"
if [[ "${SKIP_LLAMA_BUNDLE:-0}" == "1" ]]; then
  echo "==> SKIP_LLAMA_BUNDLE=1 -- not bundling llama-server; the local-model fallback is disabled for this build"
elif [[ -z "$LLAMA_MODEL_FOR_BUNDLE" ]]; then
  echo "==> No OPENCLAW_INSTALLER_DEFAULT_LLAMA_MODEL in $ENV_FILE -- skipping llama-server bundling (no fallback model configured)"
else
  # The environment wins; otherwise take the pin from installer.env (see
  # installer.env.example), so a pinned build needs no extra env var.
  if [[ -z "${OPENCLAW_LLAMA_VERSION:-}" ]]; then
    OPENCLAW_LLAMA_VERSION="$(read_env_var OPENCLAW_LLAMA_VERSION)"
  fi
  echo "==> llama.cpp release: ${OPENCLAW_LLAMA_VERSION:-latest}"
  LLAMA_CACHE_DIR="$ROOT_DIR/.artifacts/mac-installer-llama-cache"
  mkdir -p "$LLAMA_CACHE_DIR" "$APP/Contents/Resources/llama-runtime"
  APP_ARCHS="$(lipo -archs "$APP_BIN" 2>/dev/null || uname -m)"

  # llama.cpp publishes its macOS binaries on the rolling bNNNN nightly
  # releases (llama-bNNNN-bin-macos-<arch>.tar.gz; older ones used .zip).
  # Its occasional semver releases (e.g. v0.5.0) can be marked "Latest" on
  # GitHub while carrying NO binaries at all, so "latest" here means "the
  # newest release that actually has a macos-<arch> build", not GitHub's
  # /releases/latest. GITHUB_TOKEN, if set, avoids the API's anonymous rate
  # limit. Pin OPENCLAW_LLAMA_VERSION=bNNNN for reproducible (and, once
  # cached, offline) builds.
  llama_api_get() {
    local url="$1"
    local auth_header=()
    [[ -n "${GITHUB_TOKEN:-}" ]] && auth_header=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
    curl -fsSL --proto '=https' --tlsv1.2 --retry 2 \
      -H "Accept: application/vnd.github+json" \
      ${auth_header[@]+"${auth_header[@]}"} "$url"
  }

  # Prints "<tag>\t<asset url>\t<zip|tar.gz>" for the first matching release.
  resolve_llama_asset() {
    local mac_asset_arch="$1" requested="${OPENCLAW_LLAMA_VERSION:-latest}" api_url json
    if [[ "$requested" == "latest" ]]; then
      api_url="https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=50"
    else
      api_url="https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${requested}"
    fi
    if ! json="$(llama_api_get "$api_url")"; then
      echo "ERROR: GitHub API request failed: $api_url" >&2
      echo "       (rate limited or offline? set GITHUB_TOKEN, or pin OPENCLAW_LLAMA_VERSION=bNNNN once it is cached)" >&2
      return 1
    fi
    printf '%s' "$json" | node -e '
      const arch = process.argv[1];
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        const data = JSON.parse(raw);
        const releases = Array.isArray(data) ? data : [data];
        const pattern = new RegExp("bin-macos-" + arch + "\\.(zip|tar\\.gz)$");
        for (const release of releases) {
          if (!release || release.draft) continue;
          const asset = (release.assets || []).find((entry) => pattern.test(entry.name || ""));
          if (asset) {
            const ext = asset.name.endsWith(".zip") ? "zip" : "tar.gz";
            process.stdout.write(release.tag_name + "\t" + asset.browser_download_url + "\t" + ext + "\n");
            return;
          }
        }
        process.exit(3);
      });
    ' "$mac_asset_arch"
  }

  # Bundles the raw release archive itself (plus a sha256 sidecar), the same
  # way step 2 bundles Node's .tar.gz -- NOT extracted at build time, so no
  # loose Mach-O files land under this script's --deep re-sign pass.
  # scripts/mac-llama-fallback-setup.sh extracts it into ~/.openclaw/llama
  # on the target machine (AutoOnboardBootstrap.swift for the dmg,
  # mac-pkg-postinstall.sh for the pkg).
  fetch_llama_archive() {
    local arch="$1" mac_asset_arch requested resolved tag="" asset_url="" ext="" cache_file="" candidate
    local expected_sha actual_sha
    case "$arch" in
      arm64) mac_asset_arch="arm64" ;;
      x86_64) mac_asset_arch="x64" ;;
      *) return 0 ;;
    esac
    requested="${OPENCLAW_LLAMA_VERSION:-latest}"
    if [[ "$requested" != "latest" ]]; then
      for candidate in zip tar.gz; do
        if [[ -f "$LLAMA_CACHE_DIR/$requested/llama-macos-${mac_asset_arch}.${candidate}" ]]; then
          tag="$requested"
          ext="$candidate"
          cache_file="$LLAMA_CACHE_DIR/$requested/llama-macos-${mac_asset_arch}.${candidate}"
          break
        fi
      done
    fi
    if [[ -z "$cache_file" ]]; then
      echo "    Resolving llama.cpp ${requested} macos-${mac_asset_arch} release asset"
      if ! resolved="$(resolve_llama_asset "$mac_asset_arch")" || [[ -z "$resolved" ]]; then
        echo "ERROR: found no llama.cpp release with a macos-${mac_asset_arch} build (requested: ${requested})." >&2
        echo "       Releases: https://github.com/ggml-org/llama.cpp/releases" >&2
        echo "       Set OPENCLAW_LLAMA_VERSION to a bNNNN release that has one, or SKIP_LLAMA_BUNDLE=1." >&2
        exit 1
      fi
      IFS=$'\t' read -r tag asset_url ext <<<"$resolved"
      cache_file="$LLAMA_CACHE_DIR/$tag/llama-macos-${mac_asset_arch}.${ext}"
      if [[ ! -f "$cache_file" ]]; then
        mkdir -p "$LLAMA_CACHE_DIR/$tag"
        echo "    Downloading $(basename "$asset_url") (cached under .artifacts/ for future builds)"
        if ! curl -fSL --proto '=https' --tlsv1.2 --retry 3 -o "$cache_file.tmp" "$asset_url"; then
          rm -f "$cache_file.tmp"
          echo "ERROR: download failed: $asset_url" >&2
          exit 1
        fi
        mv "$cache_file.tmp" "$cache_file"
        shasum -a 256 "$cache_file" | awk '{print $1}' > "$cache_file.sha256"
      fi
    fi
    expected_sha="$(cat "$cache_file.sha256" 2>/dev/null || true)"
    actual_sha="$(shasum -a 256 "$cache_file" | awk '{print $1}')"
    if [[ -n "$expected_sha" && "$actual_sha" != "$expected_sha" ]]; then
      echo "ERROR: cached $cache_file sha256 mismatch -- delete it and retry" >&2
      exit 1
    fi
    [[ -f "$cache_file.sha256" ]] || echo "$actual_sha" > "$cache_file.sha256"
    cp "$cache_file" "$APP/Contents/Resources/llama-runtime/llama-macos-${mac_asset_arch}.${ext}"
    cp "$cache_file.sha256" "$APP/Contents/Resources/llama-runtime/llama-macos-${mac_asset_arch}.${ext}.sha256"
    echo "$tag" > "$APP/Contents/Resources/llama-runtime/release-tag.txt"
    echo "    Bundled llama.cpp $tag (llama-macos-${mac_asset_arch}.${ext}, $(du -h "$cache_file" | cut -f1))"
  }

  echo "==> Bundling llama-server for: $APP_ARCHS (fallback model: $LLAMA_MODEL_FOR_BUNDLE)"
  for arch in $APP_ARCHS; do
    case "$arch" in
      arm64 | x86_64) fetch_llama_archive "$arch" ;;
      *) echo "    (skipping unrecognized arch: $arch)" ;;
    esac
  done
fi

# ---------------------------------------------------------------------
# 4. Default AI provider (optional): if installer.env exists at the repo
# root, bake its OPENCLAW_INSTALLER_DEFAULT_AI_* (and
# OPENCLAW_INSTALLER_DEFAULT_LLAMA_MODEL) values into the app bundle
# as a plain resource file. These values ship in PLAINTEXT inside the
# bundle -- anyone who unzips/inspects Resources can read them. This is
# meant for a shared default backend, not a personal credential; do not
# bake in a personal API key you don't want handed to everyone who
# receives this build. See installer.env.example. No installer.env -> this
# step is skipped.
#
# scripts/mac-pkg-postinstall.sh reads this file at pkg-install time and
# passes it to `openclaw onboard --custom-base-url/--custom-model-id/...`,
# so the pkg installer lands straight in chat with a working model already
# configured. The dmg's plain app never reads this file -- someone who
# drags it to Applications by hand still goes through the normal onboarding
# model picker. AutoOnboardBootstrap.swift reads the same file for the dmg's
# own silent first-launch provisioning, including DEFAULT_LLAMA_MODEL below.
# ---------------------------------------------------------------------
if [[ -f "$ENV_FILE" ]]; then
  echo "==> Baking default AI provider config from $ENV_FILE into the app (consumed by the pkg installer's postinstall script)"
  {
    echo "DEFAULT_AI_PROVIDER=$(read_env_var OPENCLAW_INSTALLER_DEFAULT_AI_PROVIDER)"
    echo "DEFAULT_AI_BASE_URL=$(read_env_var OPENCLAW_INSTALLER_DEFAULT_AI_BASE_URL)"
    echo "DEFAULT_AI_MODEL=$(read_env_var OPENCLAW_INSTALLER_DEFAULT_AI_MODEL)"
    echo "DEFAULT_AI_API_KEY=$(read_env_var OPENCLAW_INSTALLER_DEFAULT_AI_API_KEY)"
    echo "DEFAULT_LLAMA_MODEL=$LLAMA_MODEL_FOR_BUNDLE"
    # llama-server context size (tokens) for the local model; see
    # scripts/mac-llama-fallback-setup.sh. Empty -> model-native context.
    LLAMA_CTX_FOR_BUNDLE="$(read_env_var OPENCLAW_LLAMA_FALLBACK_CTX)"
    if [[ -n "$LLAMA_CTX_FOR_BUNDLE" && ! "$LLAMA_CTX_FOR_BUNDLE" =~ ^[0-9]+$ ]]; then
      echo "ERROR: OPENCLAW_LLAMA_FALLBACK_CTX must be a whole number of tokens, got '${LLAMA_CTX_FOR_BUNDLE}'" >&2
      exit 1
    fi
    echo "DEFAULT_LLAMA_CTX=$LLAMA_CTX_FOR_BUNDLE"
  } > "$APP/Contents/Resources/default-ai-provider.env"
else
  echo "==> No $ENV_FILE -- skipping default AI provider config"
fi

# ---------------------------------------------------------------------
# 5. Signing identity -- same auto-selection and ALLOW_ADHOC_SIGNING
# fallback as scripts/codesign-mac-app.sh, so this behaves consistently
# with package-mac-app.sh rather than defaulting to ad-hoc silently. See
# the "IMPORTANT signing/entitlements caveat" note at the top of this file:
# this is a plain whole-bundle re-sign, not a reproduction of
# codesign-mac-app.sh's per-binary entitlements/Team-ID-audit handling.
# --deep re-signs everything inside the bundle (openclaw-mac,
# openclaw-mlx-tts, Sparkle.framework, ...) in one consistent pass, needed
# because adding default-ai-provider.env above changes the bundle's
# contents after package-mac-app.sh's own signing pass.
# ---------------------------------------------------------------------
select_identity() {
  local preferred
  local pattern
  for pattern in "Developer ID Application" "Apple Distribution" "Apple Development"; do
    preferred="$(security find-identity -p codesigning -v 2>/dev/null \
      | awk -F'"' -v p="$pattern" '$0 ~ p { print $2; exit }')"
    [[ -n "$preferred" ]] && { echo "$preferred"; return 0; }
  done
  preferred="$(security find-identity -p codesigning -v 2>/dev/null \
    | sed -n 's/.*"\(.*\)"/\1/p' | head -n1)"
  [[ -n "$preferred" ]] && { echo "$preferred"; return 0; }
  return 1
}

IDENTITY="${SIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  if ! IDENTITY="$(select_identity)"; then
    if [[ "${ALLOW_ADHOC_SIGNING:-}" == "1" ]]; then
      echo "WARN: No signing identity found -- falling back to ad-hoc signing (-)."
      echo "      Gatekeeper will show \"cannot verify developer\" on first launch;"
      echo "      right-click -> Open once to get past it. TCC permissions also"
      echo "      won't persist across rebuilds (ad-hoc signature changes every build)."
      IDENTITY="-"
    else
      echo "ERROR: No signing identity found. Set SIGN_IDENTITY, or ALLOW_ADHOC_SIGNING=1 to ad-hoc sign." >&2
      exit 1
    fi
  fi
fi
echo "==> Re-signing $APP with: $IDENTITY"
if [[ "$IDENTITY" == "-" ]]; then
  codesign --force --deep --sign - "$APP"
else
  codesign --force --deep --sign "$IDENTITY" --options runtime --timestamp "$APP"
fi

echo "==> Verifying signature (simulates Gatekeeper locally, before this leaves the build machine)"
codesign --verify --deep --strict --verbose=2 "$APP" || echo "WARN: codesign --verify failed -- investigate before distributing"
spctl --assess --type execute --verbose=2 "$APP" || echo "WARN: spctl assessment failed -- Gatekeeper will likely block this; investigate before distributing"

detach_src
trap - EXIT

# ---------------------------------------------------------------------
# Notarization (NOTARIZE=1 only; needs a real, non-ad-hoc SIGN_IDENTITY).
# Reuses this repo's own scripts/notarize-mac-artifact.sh -- same
# NOTARYTOOL_* env vars it documents (NOTARYTOOL_PROFILE, or
# NOTARYTOOL_KEY+KEY_ID+ISSUER). See the entitlements caveat above before
# reaching for this.
# ---------------------------------------------------------------------
NOTARIZED=0
if [[ "${NOTARIZE:-0}" == "1" ]]; then
  if [[ "$IDENTITY" == "-" ]]; then
    echo "WARN: NOTARIZE=1 but signing is ad-hoc -- notarization requires a real Developer ID identity. Skipping."
  else
    echo "==> Submitting for notarization"
    NOTARIZE_ZIP="$(mktemp -t openclaw-installer-notarize).zip"
    rm -f "$NOTARIZE_ZIP"
    ditto -c -k --keepParent "$APP" "$NOTARIZE_ZIP"
    STAPLE_APP_PATH="$APP" "$ROOT_DIR/scripts/notarize-mac-artifact.sh" "$NOTARIZE_ZIP"
    rm -f "$NOTARIZE_ZIP"
    NOTARIZED=1
  fi
fi

gatekeeper_reminder() {
  if [[ "$NOTARIZED" == "1" ]]; then
    echo "Signed with a real identity and notarized: no Gatekeeper warning on double-click."
  elif [[ "$IDENTITY" != "-" ]]; then
    echo "Signed with a real identity but not notarized: Gatekeeper may still warn once."
  else
    echo "Ad-hoc signed: first double-click will need right-click -> Open once."
  fi
}

# ---------------------------------------------------------------------
# zip -- opt-in only. A real prior build's zip was flagged "damaged" by
# Gatekeeper after AirDrop to a second Mac while the equivalent dmg opened
# fine (suspected: signature verification of the many nested node_modules
# files not surviving a ditto zip/unzip round trip cleanly; root cause not
# conclusively pinned down). The dmg is the only format actually verified
# to distribute cleanly -- set BUILD_ZIP=1 only if a zip is specifically
# needed.
# ---------------------------------------------------------------------
ZIP_PATH=""
if [[ "${BUILD_ZIP:-0}" == "1" ]]; then
  ZIP_NAME="OpenClaw-${APP_VERSION}-Install.zip"
  ZIP_PATH="$DIST_DIR/$ZIP_NAME"
  echo "==> BUILD_ZIP=1 -- also building a zip ($ZIP_PATH); prefer the dmg below if both are available (see note above)"
  rm -f "$ZIP_PATH"
  ditto -c -k --keepParent "$APP" "$ZIP_PATH"
fi

# ---------------------------------------------------------------------
# .pkg installer (skip with SKIP_PKG=1): the artifact that actually gets
# Node/CLI/Gateway installed silently before first launch -- see this
# script's header comment and scripts/mac-pkg-postinstall.sh. Signed with
# a Developer ID Installer identity when one is available (a *different*
# identity type than the Developer ID Application one used to sign the
# app above -- security find-identity lists both separately); otherwise
# built unsigned, which still installs fine locally but shows Gatekeeper's
# "unidentified developer" warning once (right-click -> Open), same as an
# ad-hoc-signed app.
# ---------------------------------------------------------------------
OUT_PKG=""
if [[ "${SKIP_PKG:-0}" == "1" ]]; then
  echo "==> SKIP_PKG=1 -- not building the .pkg installer"
else
  echo "==> Building .pkg installer (silent Node/CLI/Gateway provisioning)"
  PKG_BUNDLE_ID="$(plist_print_required "$APP/Contents/Info.plist" CFBundleIdentifier)"
  PKG_ROOT="$(mktemp -d)"
  PKG_SCRIPTS_DIR="$(mktemp -d)"
  ditto "$APP" "$PKG_ROOT/OpenClaw.app"
  cp "$ROOT_DIR/scripts/mac-pkg-postinstall.sh" "$PKG_SCRIPTS_DIR/postinstall"
  chmod 0755 "$PKG_SCRIPTS_DIR/postinstall"

  select_installer_identity() {
    local preferred
    local pattern
    for pattern in "Developer ID Installer" "Mac Installer Distribution" "3rd Party Mac Developer Installer"; do
      preferred="$(security find-identity -v 2>/dev/null \
        | awk -F'"' -v p="$pattern" '$0 ~ p { print $2; exit }')"
      [[ -n "$preferred" ]] && { echo "$preferred"; return 0; }
    done
    return 1
  }

  # A plain `pkgbuild --root` auto-derives a component plist that marks
  # OpenClaw.app "relocatable" -- installd then treats *any* path Launch
  # Services already has this bundle id registered at (a developer's own
  # dist/OpenClaw.app build output, say, if it was ever opened directly
  # from there) as the real install target, and silently updates that
  # copy in place instead of writing to --install-location. Installer.app
  # still reports success either way, but /Applications and
  # ~/.openclaw end up untouched -- this bit a real dev machine and isn't
  # fixable by clearing pkgutil receipts or lsregister state (or not
  # reliably: Spotlight's own mdfind index can keep reporting the old
  # path regardless). --component-plist below with BundleIsRelocatable
  # forced to false makes every install always land at
  # --install-location, ignoring whatever Launch Services thinks it
  # already knows. BundleIsVersionChecked=false is the companion fix for
  # a same-version reinstall otherwise being silently skipped because a
  # prior pkgutil receipt already matches.
  COMPONENT_PLIST="$(mktemp -t openclaw-pkg-component).plist"
  rm -f "$COMPONENT_PLIST"
  pkgbuild --analyze --root "$PKG_ROOT" "$COMPONENT_PLIST"
  plist_set_or_add_bool "$COMPONENT_PLIST" "0:BundleIsRelocatable" false
  plist_set_or_add_bool "$COMPONENT_PLIST" "0:BundleIsVersionChecked" false

  COMPONENT_PKG="$DIST_DIR/.OpenClaw-component.pkg"
  rm -f "$COMPONENT_PKG"
  pkgbuild --root "$PKG_ROOT" \
    --component-plist "$COMPONENT_PLIST" \
    --scripts "$PKG_SCRIPTS_DIR" \
    --identifier "${PKG_BUNDLE_ID}.installer" \
    --version "$APP_VERSION" \
    --install-location /Applications \
    "$COMPONENT_PKG"
  rm -f "$COMPONENT_PLIST"

  OUT_PKG="$DIST_DIR/OpenClaw-${APP_VERSION}-Install.pkg"
  rm -f "$OUT_PKG"
  if PKG_IDENTITY="$(select_installer_identity)"; then
    echo "==> Signing pkg with: $PKG_IDENTITY"
    productsign --sign "$PKG_IDENTITY" "$COMPONENT_PKG" "$OUT_PKG"
    rm -f "$COMPONENT_PKG"
  else
    echo "WARN: No Developer ID Installer identity found -- building an unsigned pkg."
    echo "      It still installs fine locally; Gatekeeper will warn \"unidentified"
    echo "      developer\" the first time (right-click -> Open), same as an"
    echo "      ad-hoc-signed app. Set up a Developer ID Installer certificate and"
    echo "      re-run for a pkg that installs cleanly on other Macs."
    mv "$COMPONENT_PKG" "$OUT_PKG"
  fi
  rm -rf "$PKG_ROOT" "$PKG_SCRIPTS_DIR"
fi

# ---------------------------------------------------------------------
# dmg (skip with SKIP_DMG=1): a plain, unmodified "OpenClaw.app + an
# Applications shortcut" -- same as any normal Mac app, no silent
# provisioning, no admin-password prompt to mount/drag-install it.
# ---------------------------------------------------------------------
OUT_DMG=""
if [[ "${SKIP_DMG:-0}" == "1" ]]; then
  echo "==> SKIP_DMG=1 -- not building the styled dmg"
else
  echo "==> Building styled dmg (scripts/create-dmg.sh)"
  export DMG_VOLUME_NAME="${DMG_VOLUME_NAME:-Install OpenClaw}"
  OUT_DMG="$DIST_DIR/OpenClaw-${APP_VERSION}-Install.dmg"
  "$ROOT_DIR/scripts/create-dmg.sh" "$APP" "$OUT_DMG"

  if [[ "$IDENTITY" != "-" ]]; then
    echo "==> Signing dmg"
    codesign --force --sign "$IDENTITY" --timestamp "$OUT_DMG"
  fi
fi

echo ""
echo "Done."
echo "  App: $APP"
[[ -n "$OUT_PKG" ]] && echo "  pkg (recommended -- installs Node/CLI/Gateway silently, lands in chat): $OUT_PKG"
[[ -n "$OUT_DMG" ]] && echo "  dmg (plain manual install, no admin password): $OUT_DMG"
[[ -n "$ZIP_PATH" ]] && echo "  zip: $ZIP_PATH"
echo ""
echo "The pkg installs OpenClaw.app to /Applications and, right after, silently"
echo "installs Node/the CLI/the Gateway and marks onboarding as seen (see"
echo "scripts/mac-pkg-postinstall.sh) -- first launch should land straight in"
echo "chat. The dmg is exactly \"OpenClaw.app\" plus an Applications shortcut,"
echo "same as any normal Mac app, with no silent provisioning -- first-run"
echo "Node/CLI/Gateway setup there is handled by the app's own onboarding UI,"
echo "same as an official build."
echo ""
gatekeeper_reminder
