#!/bin/bash
set -euo pipefail

# Turn a plain OpenClaw.app (scripts/package-mac-app.sh's own output) into a
# SINGLE, self-installing OpenClaw.app: double-clicking it, on a Mac that
# doesn't have the CLI/Gateway set up yet, silently provisions a private
# Node.js runtime (bundled -- no download) and the `openclaw` CLI, finishes
# non-interactive onboarding (optionally with a baked default AI provider --
# see installer.env.example), installs the local Gateway as a launchd
# daemon, then launches straight into the app. Every launch after that first
# one is indistinguishable from a normal app launch -- no wizard, no visible
# delay. There is no separate wrapper app and no nested OpenClaw.app copy:
# this mutates the given app bundle IN PLACE into exactly one bundle that is
# both the installer and the app.
#
# How: the real, Swift-compiled GUI binary is moved from
# Contents/MacOS/OpenClaw to Contents/MacOS/OpenClaw-bin. A tiny compiled
# AppleScript applet stub takes its place at Contents/MacOS/OpenClaw --
# that's what Launch Services actually runs on every double-click (see the
# "why osacompile" note below). On every launch it first runs
# Contents/Resources/OpenClawDispatch.sh (scripts/mac-app-installer-dispatch.sh
# at build time): if this Mac is already fully provisioned, that script
# launches OpenClaw-bin directly and exits 0, and NOTHING else below this
# happens -- no Terminal, no delay. Only if it exits nonzero (genuine first
# run) does the stub open a visible Terminal window running
# Contents/Resources/OpenClawInstaller.sh (scripts/mac-installer-runtime.sh),
# which does the actual provisioning and then launches OpenClaw-bin itself.
#
# IMPORTANT signing/entitlements caveat: this script's own re-sign step
# (see "Signing identity" below) is a plain, whole-bundle codesign pass. It
# does NOT reproduce scripts/codesign-mac-app.sh's per-binary entitlements
# plist / Team-ID audit / hardened-runtime handling. For an ad-hoc-signed
# build (this script's default -- see ALLOW_ADHOC_SIGNING below) that's
# fine: hardened runtime isn't engaged either way, so entitlements plists
# are inert and TCC just tracks by bundle+path, same as an unmodified
# ad-hoc package-mac-app.sh build. If this is ever signed with a real
# Developer ID for actual distribution (hardened runtime IS engaged then),
# double check that Contents/MacOS/OpenClaw-bin -- not just the stub --
# still has whatever entitlements it needs (e.g. Apple Events automation
# for Peekaboo/computer-use); this script does not verify that for you.
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
#   SKIP_DMG=1             Only produce the mutated dist/OpenClaw.app, skip
#                          the styled dmg.
#   BUILD_ZIP=1            Also produce a .zip (known to occasionally trip
#                          Gatekeeper's "damaged" check after transfer on
#                          some Macs -- prefer the dmg; see the note below).
#   SKIP_NODE_BUNDLE=1     Don't bundle a Node.js runtime; the installer
#                          downloads one from nodejs.org on first run
#                          instead.
#   OPENCLAW_NODE_VERSION  Node version to bundle/pin (default: 24.19.0, a
#                          version verified to have prebuilt native
#                          dependencies -- see the comment at its use below).
#   DMG_VOLUME_NAME / DMG_WINDOW_BOUNDS / DMG_ICON_SIZE / DMG_APP_POS /
#   DMG_APPS_POS           Forwarded to scripts/create-dmg.sh (its defaults
#                          already match this installer's original layout).
#
# Must run on real macOS (hdiutil/ditto/PlistBuddy/osascript/osacompile/
# codesign -- all ship with the OS, no Xcode install required).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/plistbuddy.sh"

# See mac-installer-runtime.sh's own header for why this matters even though
# this file's own text is plain ASCII: macOS's system bash (3.2) drops into
# the "C" locale with no locale env at all (as a bare invocation can give
# it), and its byte classification there can misparse embedded non-ASCII
# text badly enough to corrupt a nearby $VAR expansion.
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

DIST_DIR="$ROOT_DIR/dist"
INPUT="${1:-$DIST_DIR/OpenClaw.app}"
if [[ ! -e "$INPUT" ]]; then
  echo "ERROR: Not found: $INPUT" >&2
  echo "Usage: $0 [path/to/OpenClaw.app | path/to/OpenClaw-*.dmg]" >&2
  exit 1
fi

command -v osacompile >/dev/null 2>&1 || { echo "ERROR: osacompile not found (should ship with macOS)" >&2; exit 1; }

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

REAL_BIN="$APP/Contents/MacOS/OpenClaw-bin"
STUB_BIN="$APP/Contents/MacOS/OpenClaw"

if [[ -e "$REAL_BIN" ]]; then
  echo "ERROR: $APP already looks transformed (Contents/MacOS/OpenClaw-bin already exists)." >&2
  echo "       Run scripts/package-mac-app.sh again first for a clean, untransformed build." >&2
  exit 1
fi
if [[ ! -f "$STUB_BIN" ]]; then
  echo "ERROR: $STUB_BIN not found -- not a valid OpenClaw.app build." >&2
  exit 1
fi

APP_VERSION="$(plist_print_required "$APP/Contents/Info.plist" CFBundleShortVersionString)"
echo "==> App: $APP (version $APP_VERSION)"

if codesign -dv "$STUB_BIN" 2>&1 | grep -q '^Signature=adhoc$'; then
  echo "WARN: The build being transformed is only ad-hoc signed. Re-signing"
  echo "      below (ad-hoc or otherwise) doesn't change that this is a"
  echo "      dev/local build, not an Apple-notarized one -- Gatekeeper will"
  echo "      still need a right-click -> Open on first launch on any other Mac."
fi

# ---------------------------------------------------------------------
# 2. Move the real GUI binary aside, splice in a compiled AppleScript
#    applet as the new Contents/MacOS/OpenClaw.
#
#    Why osacompile and not a raw shell script: a bundle whose
#    CFBundleExecutable is a plain text shell script has no Mach-O header
#    for Launch Services to read an architecture from. On Apple Silicon
#    that can make Launch Services fall back to assuming the app needs
#    Rosetta/Intel and prompt to install it, even though nothing in the app
#    actually needs Intel. osacompile produces a real, Apple-built,
#    natively-Apple-Silicon "applet runner" Mach-O as CFBundleExecutable;
#    its only job here is to run OpenClawDispatch.sh and, only if that says
#    this is a genuine first run, open Terminal for the visible install.
#
#    This splices JUST osacompile's generic applet-runner binary and its
#    compiled script into the EXISTING app bundle (keeping our own
#    Info.plist, icon, bundle id, etc. untouched) rather than using
#    osacompile's own generated bundle directly -- the applet runner reads
#    its script from Contents/Resources/Scripts/main.scpt relative to
#    whatever bundle it's actually running inside, so this works.
# ---------------------------------------------------------------------
echo "==> Moving the real GUI binary to Contents/MacOS/OpenClaw-bin"
mv "$STUB_BIN" "$REAL_BIN"

echo "==> Generating native launch stub with osacompile (avoids a false Rosetta prompt)"
BUILD_TMP="$(mktemp -d)"
cat > "$BUILD_TMP/dispatch.applescript" <<'APPLESCRIPT'
try
	set posixPath to POSIX path of (path to me)
	set dispatchScript to posixPath & "Contents/Resources/OpenClawDispatch.sh"
	set alreadyHandled to false
	try
		do shell script "/bin/bash " & quoted form of dispatchScript
		set alreadyHandled to true
	end try
	if not alreadyHandled then
		set installScript to posixPath & "Contents/Resources/OpenClawInstaller.sh"
		set shellCmd to "clear; /bin/bash " & quoted form of installScript
		tell application "Terminal"
			activate
			set installerTab to do script shellCmd
			try
				set custom title of installerTab to "OpenClaw"
			end try
			try
				set current settings of installerTab to settings set "Basic"
			end try
			try
				set background color of installerTab to {64250, 64250, 63710}
				set normal text color of installerTab to {8000, 8000, 8000}
				set bold text color of installerTab to {2000, 20000, 45000}
				set cursor color of installerTab to {8000, 8000, 8000}
			end try
			set installerWindow to front window
			try
				set winWidth to 900
				set winHeight to 560
				set screenWidth to 1440
				set screenHeight to 900
				try
					tell application "Finder" to set screenBounds to bounds of window of desktop
					set screenWidth to item 3 of screenBounds
					set screenHeight to item 4 of screenBounds
				end try
				set winX to ((screenWidth - winWidth) / 2) as integer
				set winY to ((screenHeight - winHeight) / 2) as integer
				if winY < 40 then set winY to 40
				set bounds of installerWindow to {winX, winY, winX + winWidth, winY + winHeight}
			end try
			repeat
				delay 1
				if not busy of installerTab then exit repeat
			end repeat
			-- OpenClawInstaller.sh's own fatal() helper always echoes a line
			-- starting with "[FATAL]" right before it shows its own dialog and
			-- exits non-zero -- reuse that as the success/failure signal instead
			-- of adding a whole separate status-file mechanism.
			set installFailed to false
			try
				if (history of installerTab) contains "[FATAL]" then set installFailed to true
			end try
			if not installFailed then
				delay 3
				try
					close installerWindow
				end try
			end if
		end tell
	end if
on error
	-- OpenClawInstaller.sh already shows its own friendly dialog (via
	-- osascript) and writes ~/Library/Logs/OpenClawInstaller.log whenever it
	-- fails, then exits non-zero. Swallowing any AppleScript-level error here
	-- (e.g. Terminal.app being unavailable) leaves that dialog as the only
	-- thing the user sees instead of a second, scarier system alert.
end try
APPLESCRIPT
STUB_BUILD_APP="$BUILD_TMP/DispatchStub.app"
osacompile -o "$STUB_BUILD_APP" "$BUILD_TMP/dispatch.applescript"

cp "$STUB_BUILD_APP/Contents/MacOS/applet" "$STUB_BIN"
chmod +x "$STUB_BIN"
mkdir -p "$APP/Contents/Resources/Scripts"
cp "$STUB_BUILD_APP/Contents/Resources/Scripts/main.scpt" "$APP/Contents/Resources/Scripts/main.scpt"

echo "==> Installing the dispatcher and installer runtime scripts"
cp "$ROOT_DIR/scripts/mac-app-installer-dispatch.sh" "$APP/Contents/Resources/OpenClawDispatch.sh"
chmod +x "$APP/Contents/Resources/OpenClawDispatch.sh"
cp "$ROOT_DIR/scripts/mac-installer-runtime.sh" "$APP/Contents/Resources/OpenClawInstaller.sh"
chmod +x "$APP/Contents/Resources/OpenClawInstaller.sh"

# ---------------------------------------------------------------------
# Default AI provider (optional): if installer.env exists at the repo root,
# bake its OPENCLAW_INSTALLER_DEFAULT_AI_* values into the app bundle so
# the end user lands in a working chat instead of OpenClaw.app's own
# first-run "pick a model" screen. These values ship in PLAINTEXT inside
# the bundle -- anyone who unzips/inspects Resources can read them. This is
# meant for a shared default backend, not a personal credential; do not
# bake in a personal API key you don't want handed to everyone who
# receives this build. See installer.env.example. No installer.env -> this
# step is skipped and behavior is unchanged (end user picks a provider
# themselves). This is intentionally a separate file from this repo's own
# .env (which the gateway/CLI load at runtime when run from source) so the
# two never mix.
# ---------------------------------------------------------------------
ENV_FILE="$ROOT_DIR/installer.env"
read_env_var() {
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n1 | cut -d'=' -f2-
}
if [[ -f "$ENV_FILE" ]]; then
  echo "==> Baking default AI provider config from $ENV_FILE into the app"
  {
    echo "DEFAULT_AI_PROVIDER=$(read_env_var OPENCLAW_INSTALLER_DEFAULT_AI_PROVIDER)"
    echo "DEFAULT_AI_BASE_URL=$(read_env_var OPENCLAW_INSTALLER_DEFAULT_AI_BASE_URL)"
    echo "DEFAULT_AI_MODEL=$(read_env_var OPENCLAW_INSTALLER_DEFAULT_AI_MODEL)"
    echo "DEFAULT_AI_API_KEY=$(read_env_var OPENCLAW_INSTALLER_DEFAULT_AI_API_KEY)"
  } > "$APP/Contents/Resources/default-ai-provider.env"
else
  echo "==> No $ENV_FILE -- skipping default AI provider config (end user picks one in the app, as usual)"
fi

# ---------------------------------------------------------------------
# Bundle a Node.js runtime so the target Mac doesn't need to download one.
# Cached under .artifacts/ (gitignored) so repeat builds don't re-download.
# Pinned to a specific version rather than "whatever's newest" -- see
# scripts/mac-installer-runtime.sh's own Step 2 comment for why a floating
# "latest" patch release is a real, hit-before failure mode (native deps
# like koffi without a matching prebuilt binary yet). Override with
# OPENCLAW_NODE_VERSION.
# ---------------------------------------------------------------------
if [[ "${SKIP_NODE_BUNDLE:-0}" == "1" ]]; then
  echo "==> SKIP_NODE_BUNDLE=1 -- installer will download Node.js on first run instead"
else
  NODE_PIN_VERSION="${OPENCLAW_NODE_VERSION:-24.19.0}"
  NODE_CACHE_DIR="$ROOT_DIR/.artifacts/mac-installer-node-cache"
  mkdir -p "$NODE_CACHE_DIR"
  NODE_RUNTIME_DIR="$APP/Contents/Resources/node-runtime"
  mkdir -p "$NODE_RUNTIME_DIR"

  fetch_node_tarball() {
    local dist_arch="$1" dest="$2"
    local tarball_name="node-v${NODE_PIN_VERSION}-darwin-${dist_arch}.tar.gz"
    local url="https://nodejs.org/dist/v${NODE_PIN_VERSION}/${tarball_name}"
    local cached="$NODE_CACHE_DIR/$tarball_name"
    if [[ ! -f "$cached" ]]; then
      echo "==> Downloading Node.js ($dist_arch): $tarball_name"
      curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "${cached}.part"
      mv "${cached}.part" "$cached"
    else
      echo "==> Node.js ($dist_arch) already cached: $tarball_name"
    fi
    cp "$cached" "$dest"
  }

  fetch_node_tarball "arm64" "$NODE_RUNTIME_DIR/node-darwin-arm64.tar.gz"
  fetch_node_tarball "x64" "$NODE_RUNTIME_DIR/node-darwin-x64.tar.gz"
  echo "$NODE_PIN_VERSION" > "$NODE_RUNTIME_DIR/version.txt"
fi

# ---------------------------------------------------------------------
# Signing identity -- same auto-selection and ALLOW_ADHOC_SIGNING fallback
# as scripts/codesign-mac-app.sh, so this behaves consistently with
# package-mac-app.sh rather than defaulting to ad-hoc silently. See the
# "IMPORTANT signing/entitlements caveat" note at the top of this file:
# this is a plain whole-bundle re-sign, not a reproduction of
# codesign-mac-app.sh's per-binary entitlements/Team-ID-audit handling.
# --deep is used here (unlike the old wrapper design) because there is no
# separately-owned, already-signed nested app to protect anymore -- this
# is one flat bundle, so recursively re-signing everything inside
# (OpenClaw-bin, the new stub, openclaw-mac, openclaw-mlx-tts,
# Sparkle.framework) in one consistent pass is exactly what's wanted.
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
rm -rf "$BUILD_TMP"

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

if [[ "${SKIP_DMG:-0}" == "1" ]]; then
  echo ""
  echo "Done (SKIP_DMG=1, styled dmg skipped)."
  echo "  App (self-installing): $APP"
  [[ -n "$ZIP_PATH" ]] && echo "  zip: $ZIP_PATH"
  echo ""
  gatekeeper_reminder
  exit 0
fi

echo "==> Building styled dmg (scripts/create-dmg.sh)"
export DMG_VOLUME_NAME="${DMG_VOLUME_NAME:-Install OpenClaw}"
OUT_DMG="$DIST_DIR/OpenClaw-${APP_VERSION}-Install.dmg"
"$ROOT_DIR/scripts/create-dmg.sh" "$APP" "$OUT_DMG"

if [[ "$IDENTITY" != "-" ]]; then
  echo "==> Signing dmg"
  codesign --force --sign "$IDENTITY" --timestamp "$OUT_DMG"
fi

echo ""
echo "Done."
echo "  App (self-installing): $APP"
echo "  dmg (recommended for distribution): $OUT_DMG"
[[ -n "$ZIP_PATH" ]] && echo "  zip: $ZIP_PATH"
echo ""
echo "One file, one double-click: the dmg contains exactly \"OpenClaw.app\" (plus an"
echo "Applications shortcut for anyone who prefers to drag it manually). Double-clicking"
echo "it directly from the mounted dmg, from Downloads, or after dragging it to"
echo "/Applications all work the same way."
echo ""
gatekeeper_reminder
