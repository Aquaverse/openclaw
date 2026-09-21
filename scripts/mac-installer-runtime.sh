#!/bin/bash
#
# OpenClaw self-installing app runtime.
#
# This IS "OpenClaw.app" -- scripts/build-mac-installer.sh transforms the
# plain build that scripts/package-mac-app.sh produces into a single,
# self-contained app bundle: it moves the real, Swift-compiled GUI binary
# from Contents/MacOS/OpenClaw to Contents/MacOS/OpenClaw-bin, and puts a
# tiny compiled AppleScript applet stub in its place as the new
# Contents/MacOS/OpenClaw (Launch Services' CFBundleExecutable target).
# There is no second, nested OpenClaw.app anywhere in the bundle.
#
# On every single double-click, that stub first runs
# Contents/Resources/OpenClawDispatch.sh (scripts/mac-app-installer-dispatch.sh
# at build time), which decides in well under a second whether this Mac
# already has everything provisioned. The overwhelmingly common case -- every
# launch after the first -- exits 0 having already launched Contents/MacOS/
# OpenClaw-bin directly; the stub never opens Terminal and nothing below this
# line ever runs. Only on a genuine first run (dispatch exits 1) does the
# stub fall through to running THIS script inside a visible Terminal window,
# which:
#
#   1. Copies itself (this running app bundle) into /Applications, unless
#      it's already running from there (does not touch its own code
#      signature/bytes -- see the "why not --deep" note in
#      build-mac-installer.sh for the equivalent concern on the signing side).
#   2. Makes sure a supported Node.js is on PATH -- extracting the copy
#      build-mac-installer.sh bundled into Contents/Resources/node-runtime/
#      (no network needed) or, failing that, downloading an official
#      nodejs.org build straight from disk — see the "why not
#      Homebrew" note below.
#   3. Silently provisions the openclaw CLI via the official installer,
#      fully non-interactively (it now finds Node already satisfied and
#      skips its own Node install step entirely).
#   4. Silently finishes `openclaw onboard --non-interactive`: creates the
#      first agent workspace, configures the local Gateway, and installs the
#      launchd daemon so it's already running. If build-mac-installer.sh
#      baked in a default AI provider from installer.env, that gets attached
#      here too, AND OpenClaw.app's own first-run onboarding UI (welcome →
#      permissions → "choose a model") is marked already-seen, so the user
#      lands straight in the main chat window. Without a baked installer.env,
#      no provider is attached and the app's own first-run screen is left
#      alone, same as before — the user picks a provider themselves there.
#   5. Launches Contents/MacOS/OpenClaw-bin directly (bypassing the dispatch
#      stub, since we already know at this point that it's needed).
#
# All output is also logged to ~/Library/Logs/OpenClawInstaller.log for
# troubleshooting. Every step here is safe to re-run: install.sh and
# `openclaw onboard` both detect and preserve an existing installation (this
# script itself now also skips re-running `openclaw onboard` once a config
# file already exists — see Step 4). In practice it should essentially never
# run twice on the same Mac, though, since OpenClawDispatch.sh's fast path
# will short-circuit before Terminal even opens once Step 1-4 have run once.
#
set -uo pipefail

# Force a real UTF-8 locale before anything else runs — good general
# practice, even though this script's own strings are now plain ASCII (an
# earlier version had Chinese text embedded here, and a GUI double-click
# gives this process no locale env at all, which drops macOS's old system
# bash 3.2 into the "C" locale; its byte-classification there once misparsed
# that text well enough to corrupt a nearby $VAR expansion into a real
# "unbound variable" failure — see build-installer.sh's history for the
# concrete symptom. That whole class of bug is now moot with no non-ASCII
# text left, but there's no reason to reintroduce the risk either).
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

# This script itself lives in Contents/Resources/ alongside the embedded
# OpenClaw.app (see build-installer.sh) — the actual CFBundleExecutable is a
# tiny compiled AppleScript applet stub that just shells out to this file.
# That indirection exists only to dodge a Rosetta-install prompt: Launch
# Services can't tell a plain shell-script CFBundleExecutable is
# Apple-Silicon-native (it has no Mach-O header to inspect) and falls back to
# assuming it needs Intel/Rosetta. A real compiled stub avoids that.
APP_RESOURCES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/Library/Logs"
LOG_FILE="$LOG_DIR/OpenClawInstaller.log"
mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

# GUI double-click launches this with a minimal environment (no ~/.zshrc,
# no ~/.zprofile PATH additions), so make sure we can find Homebrew, the
# openclaw wrapper it just installed, and its private Node runtime.
export PATH="$HOME/.local/bin:$HOME/.openclaw/tools/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="${HOME:-$(eval echo ~"$(id -un)")}"

# Our own private Node/npm prefix (see Step 2 below) — put on PATH here,
# unconditionally, as early as possible, not just inside Step 2's "need to
# provision Node" branch. On a Mac with no usable system Node, this is also
# where install.sh ends up publishing the `openclaw` wrapper and all its npm
# packages, since it's whatever npm prefix is active at install time. Every
# `command -v openclaw` check below (the fast-path check, Step 3's "already
# installed?" check) needs this on PATH from the very start to correctly see
# a PREVIOUS run's install. Without this fix, on such a machine: the fast
# path never triggered (couldn't find openclaw), Step 2 then re-extracted
# Node into a freshly wiped directory — silently destroying the previously
# installed openclaw CLI and all its npm packages along with it — and Step 4
# then re-ran `openclaw onboard` against a config that (from before the wipe)
# already existed, which openclaw's own safety logic correctly refuses to
# silently overwrite, surfacing as a confusing onboard failure on every
# second run against an already-good install (see Step 2/4 below for the
# rest of that fix). This one PATH change is what makes all of it work.
#
# This MUST be openclaw's own managed layout -- the exact same one
# openclaw.ai/install-cli.sh uses (~/.openclaw/tools/node-v<version>, symlinked
# from ~/.openclaw/tools/node) -- not a private location of our own. An earlier
# version of this script used its own
# "~/Library/Application Support/OpenClawInstaller/node" prefix instead, which
# worked but silently broke parity with a normal openclaw install: the Gateway
# launchd daemon bakes in whatever `node` binary is on PATH at the moment
# `openclaw onboard --install-daemon` runs, so it ended up launching from that
# nonstandard path instead of the familiar
# ~/.openclaw/tools/node-v24.19.0/bin/node ... dist/index.js gateway --port ...
# every other openclaw install uses. Matching the real layout also means
# openclaw's own update/doctor/self-repair logic (which specifically knows
# about ~/.openclaw/tools/node-v*) recognizes this Node as its own instead of
# a foreign runtime it has to work around.
OPENCLAW_HOME_PREFIX="$HOME/.openclaw"
NODE_INSTALL_PREFIX="$OPENCLAW_HOME_PREFIX/tools/node"
export PATH="$NODE_INSTALL_PREFIX/bin:$PATH"

notify() {
  /usr/bin/osascript -e "display notification \"$2\" with title \"OpenClawInstall\" subtitle \"$1\"" >/dev/null 2>&1 || true
}

fatal() {
  echo "[FATAL] $1"
  /usr/bin/osascript -e "display dialog \"$1\n\nLog file: $LOG_FILE\" with title \"OpenClawInstall Failed\" buttons {\"OK\"} default button 1 with icon stop" >/dev/null 2>&1 || true
  exit 1
}

# A real run got stuck-looking right after the startup banner, with zero
# further output for a long stretch — `ditto` copying the app bundle (and
# other steps like a `curl`/`tar`, or the CLT install below) produce nothing
# on stdout while they run, so from the Terminal window it's indistinguishable
# from a genuinely frozen script. Wrap any such step in this helper: it prints
# the given message, then appends a "." every few seconds for as long as the
# command keeps running, so there's always visible proof of life. Usage:
#   run_with_heartbeat "Copying OpenClaw.app to /Applications" ditto "$SELF_APP" "$DEST_APP"
run_with_heartbeat() {
  local msg="$1"; shift
  printf '%s' "$msg"
  ( while true; do sleep 1; printf '...'; done ) &
  local heartbeat_pid=$!
  disown "$heartbeat_pid" 2>/dev/null || true
  "$@"
  local status=$?
  kill "$heartbeat_pid" 2>/dev/null || true
  wait "$heartbeat_pid" 2>/dev/null || true
  echo ""
  return $status
}

# A double-click that seems slow tempts a second double-click — and a second
# instance racing the first over the same Node/npm install directory is
# exactly what produced a real, garbled failure once (interleaved log output,
# npm EEXIST symlink collisions, "Directory not empty" from two concurrent
# `rm -rf`s). `mkdir` is atomic on every filesystem macOS uses, so it doubles
# as a portable lock — no `flock` dependency (not guaranteed present on
# macOS).
LOCK_DIR="$HOME/Library/Application Support/OpenClawInstaller/.installer.lock"
mkdir -p "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  /usr/bin/osascript -e 'display dialog "OpenClawInstall is already running — give it a minute or two to finish, no need to click it again." with title "OpenClawInstall" buttons {"OK"} default button 1' >/dev/null 2>&1 || true
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

echo "=================================================="
echo "OpenClaw installer starting: $(date)"
echo "PATH=$PATH"
echo "=================================================="

# ---------------------------------------------------------------------
# Step 1: install/refresh OpenClaw.app in /Applications
#
# Safe to run against an existing install: it never touches the app's own
# data (Gateway connection profiles, Keychain items, app preferences all
# live outside the bundle, under ~/Library/..., untouched by this copy).
# It does still avoid two easy mistakes: clobbering a build that's newer
# than the one bundled in this installer, and overwriting bundle files
# while the app is actively running.
# ---------------------------------------------------------------------
notify "Step 1/4" "Installing OpenClaw.app…"
# This script's own Contents/Resources -> walk up two levels to the .app
# bundle root that is CURRENTLY RUNNING (wherever it was double-clicked
# from -- Downloads, a mounted dmg, or already /Applications itself).
SELF_APP="$(cd "$APP_RESOURCES/../.." && pwd)"
DEST_APP="/Applications/OpenClaw.app"

bundle_version() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$1/Contents/Info.plist" 2>/dev/null || echo "0"
}

SKIP_APP_COPY=0
if [[ "$SELF_APP" == "$DEST_APP" ]]; then
  echo "Already running from $DEST_APP — nothing to copy."
  SKIP_APP_COPY=1
else
  SRC_VERSION="$(bundle_version "$SELF_APP")"
  if [[ -d "$DEST_APP" ]]; then
    DEST_VERSION="$(bundle_version "$DEST_APP")"
    echo "Existing /Applications/OpenClaw.app found: installed=$DEST_VERSION bundled=$SRC_VERSION"
    # Numeric build-number compare when possible; anything non-numeric falls
    # through to "always replace" rather than silently blocking an update.
    if [[ "$DEST_VERSION" =~ ^[0-9]+$ && "$SRC_VERSION" =~ ^[0-9]+$ && "$DEST_VERSION" -ge "$SRC_VERSION" ]]; then
      echo "Installed OpenClaw.app is already current (or newer) — leaving it in place."
      SKIP_APP_COPY=1
    else
      # Quit a running instance before replacing its files on disk. Its saved
      # Gateway connection, credentials, and preferences live under
      # ~/Library/Application Support and ~/Library/Preferences, not inside
      # the bundle, so quitting/replacing loses nothing there.
      if pgrep -qf "$DEST_APP/Contents/MacOS/" 2>/dev/null; then
        echo "OpenClaw.app is running — quitting it before replacing files."
        /usr/bin/osascript -e 'tell application "OpenClaw" to quit' >/dev/null 2>&1 || true
        for _ in 1 2 3 4 5 6 7 8 9 10; do
          pgrep -qf "$DEST_APP/Contents/MacOS/" 2>/dev/null || break
          sleep 1
        done
      fi
    fi
  fi

  if [[ "$SKIP_APP_COPY" != "1" ]]; then
    rm -rf "$DEST_APP" 2>/dev/null || true
    if ! run_with_heartbeat "Copying OpenClaw.app to /Applications (this can take a little while, especially the first time)" ditto "$SELF_APP" "$DEST_APP"; then
      fatal "Failed to copy OpenClaw.app to /Applications — check disk space/permissions and try again."
    fi
    # This running copy already carries com.apple.quarantine from being
    # downloaded; clear it on the installed copy so the app opens straight
    # away instead of showing the "downloaded from internet" prompt a
    # second time (this running copy still triggered that prompt once).
    xattr -dr com.apple.quarantine "$DEST_APP" 2>/dev/null || true
    echo "OpenClaw.app installed at $DEST_APP"
  fi
fi

# No separate "already fully set up, just launch" fast path here on
# purpose: Contents/Resources/OpenClawDispatch.sh already made that exact
# check BEFORE Terminal ever opened (see the header comment) -- if this
# script is running at all, dispatch already determined provisioning is
# genuinely needed, so there's nothing to skip.

# ---------------------------------------------------------------------
# Step 2: make sure a supported Node.js is on PATH — without Homebrew.
#
# Why: openclaw's own install.sh has exactly one path to provision Node on
# macOS, and it's unconditional Homebrew (installs Homebrew first if
# missing, then `brew install node`). Homebrew's own installer refused to
# run unattended on one test Mac (an M2, with no prior Homebrew install)
# with "Homebrew on macOS is only supported on Apple Silicon processors!" —
# a nonsensical message on Apple Silicon hardware, most likely because
# something in the launch chain (Rosetta, a stale env var, a mirrored/
# intercepted download of Homebrew's installer script) made that particular
# run of it misdetect its own architecture. Whatever the exact cause,
# openclaw's install.sh has no flag to skip the Homebrew step, so it's not
# fixable from there. Simplest robust fix: hand install.sh a Node that
# already satisfies its own version check before it ever gets to decide
# whether to install one, so it skips that step — and Homebrew — entirely.
# ---------------------------------------------------------------------
notify "Step 2/4" "Preparing the Node.js runtime…"

# Resolve which Node version this installer would provision, before knowing
# yet whether we'll actually need to (matches build-mac-installer.sh's
# NODE_PIN_VERSION so the bundled tarball and this name always agree) -- the
# managed layout below needs this to build ~/.openclaw/tools/node-v<version>,
# openclaw's own versioned directory name, whether or not we end up using it.
NODE_VERSION_FILE="$APP_RESOURCES/node-runtime/version.txt"
if [[ -f "$NODE_VERSION_FILE" ]]; then
  NODE_PIN_VERSION="$(tr -d '[:space:]' < "$NODE_VERSION_FILE")"
else
  NODE_PIN_VERSION="24.19.0"
fi
NODE_VERSIONED_DIR="$OPENCLAW_HOME_PREFIX/tools/node-v${NODE_PIN_VERSION}"

node_on_path_is_supported() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node --version 2>/dev/null | sed 's/^v//')"
  major="${v%%.*}"
  minor="${v#*.}"; minor="${minor%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  # openclaw's own support matrix (see node-version.mjs): 24.16+ or 26.1+.
  # 25.x is a non-LTS line and is explicitly NOT supported even though its
  # major number is higher than 24 — so this can't just be "major > 24".
  if (( major == 24 && minor >= 16 )); then return 0; fi
  if (( major == 26 && minor >= 1 )); then return 0; fi
  if (( major > 26 )); then return 0; fi
  return 1
}

if node_on_path_is_supported; then
  echo "Node.js already satisfies openclaw's requirement: $(node --version) ($(command -v node))"
else
  case "$(uname -m)" in
    arm64) NODE_DIST_ARCH="arm64" ;;
    x86_64) NODE_DIST_ARCH="x64" ;;
    *) fatal "Unrecognized CPU architecture: $(uname -m) — cannot prepare Node.js." ;;
  esac

  # Extract into openclaw's own versioned directory (~/.openclaw/tools/
  # node-v<version>), then repoint the ~/.openclaw/tools/node symlink at it --
  # the exact same layout openclaw.ai/install-cli.sh's own install_node()
  # produces, so this Node is indistinguishable from one a normal openclaw
  # install provisioned itself (see the PATH-priming comment near the top of
  # this script for why that parity matters). Only reached here if the check
  # above found nothing usable yet, so it's safe to wipe and re-provision.
  rm -rf "$NODE_VERSIONED_DIR"
  mkdir -p "$NODE_VERSIONED_DIR"

  # build-installer.sh bakes an official nodejs.org tarball for both macOS
  # architectures straight into the app (Contents/Resources/node-runtime/) —
  # see its "bake the Node.js runtime into the installer" step. Prefer that:
  # it's instant and needs no network. Only fall back to downloading one now
  # (the old behavior) if this specific installer build doesn't have it
  # bundled.
  BUNDLED_NODE_TARBALL="$APP_RESOURCES/node-runtime/node-darwin-${NODE_DIST_ARCH}.tar.gz"
  if [[ -f "$BUNDLED_NODE_TARBALL" ]]; then
    echo "Using Node.js bundled inside the installer (no download needed): $BUNDLED_NODE_TARBALL"
    if ! run_with_heartbeat "Extracting the bundled Node.js" tar -xzf "$BUNDLED_NODE_TARBALL" -C "$NODE_VERSIONED_DIR" --strip-components=1; then
      fatal "Failed to extract the Node.js bundled inside this installer (the installer package may be corrupt — try re-downloading/rebuilding it)."
    fi
  else
    echo "This installer build has no bundled Node.js for ${NODE_DIST_ARCH} — fetching one from nodejs.org instead (no Homebrew involved)."
    # Pin to the exact version resolved above (from build-mac-installer.sh's
    # own version.txt when bundled) rather than scraping nodejs.org's
    # "latest-vN.x" listing — a floating "latest" is exactly what produced a
    # real failure once (a too-new patch with no matching koffi prebuilt
    # binary yet, see OpenClawInstaller-4.log).
    NODE_TARBALL_NAME="node-v${NODE_PIN_VERSION}-darwin-${NODE_DIST_ARCH}.tar.gz"
    NODE_DOWNLOAD_URL="https://nodejs.org/dist/v${NODE_PIN_VERSION}/${NODE_TARBALL_NAME}"

    NODE_TMP_TARBALL="$(mktemp -t openclaw-node).tar.gz"
    if ! run_with_heartbeat "Downloading Node.js (${NODE_TARBALL_NAME})" curl -fsSL --proto '=https' --tlsv1.2 "$NODE_DOWNLOAD_URL" -o "$NODE_TMP_TARBALL"; then
      fatal "Failed to download Node.js (${NODE_TARBALL_NAME}) — check your network connection and try again."
    fi
    if ! run_with_heartbeat "Extracting Node.js" tar -xzf "$NODE_TMP_TARBALL" -C "$NODE_VERSIONED_DIR" --strip-components=1; then
      rm -f "$NODE_TMP_TARBALL"
      fatal "Failed to extract Node.js."
    fi
    rm -f "$NODE_TMP_TARBALL"
  fi

  # Point ~/.openclaw/tools/node at the versioned dir we just filled -- same
  # alias install-cli.sh's own install_node() maintains, and what
  # NODE_INSTALL_PREFIX/PATH above already assumes.
  ln -sfn "$NODE_VERSIONED_DIR" "$NODE_INSTALL_PREFIX"

  # (PATH already includes $NODE_INSTALL_PREFIX/bin — exported up top.)
  if ! node_on_path_is_supported; then
    fatal "The Node.js that was prepared ($(node --version 2>/dev/null)) doesn't meet the version requirement — try again or get in touch."
  fi
  echo "Node.js ready: $(node --version) ($(command -v node))"
fi

# install.sh needs a real `git` even for its default npm install method
# ("required for npm installs that may fetch from git or apply patches" per
# openclaw's own scripts/install.sh) and, like Node, falls back to Homebrew
# if missing — the same Homebrew path Step 2 already avoids. `git`'s
# placeholder at /usr/bin/git ships on every stock Mac, but until Xcode
# Command Line Tools are actually installed, running it either opens an
# interactive "install now?" GUI dialog (which hangs forever with no one
# there to click it) or fails outright.
#
# Rather than stopping here and telling the user to open Terminal
# themselves, install CLT non-interactively via `softwareupdate` — the same
# trick CI systems use to provision a bare Mac unattended. It still needs
# ONE macOS admin-password confirmation (installing into /Library requires
# admin rights; there's no way around that part), shown as the normal system
# password/Touch ID prompt — no Terminal, no GUI installer click-through.
# This step alone can take several minutes (the CLT download is several
# hundred MB to a bit over 1GB) so it gets its own notification first.
if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
  notify "Installing system components" "This Mac doesn't have the Xcode Command Line Tools yet (git needs them) — installing automatically, one system password prompt will appear, this can take a few minutes…"

  # NOTE on temp file locations: an earlier version used `mktemp -t`, which
  # creates files under the INVOKING user's own private per-user TMPDIR
  # (/var/folders/<user-hash>/T/...). A real failure showed the diagnostic
  # output file coming back completely empty even though the "do shell
  # script ... with administrator privileges" call itself clearly ran (the
  # user confirmed: password prompt appeared and was answered, network was
  # fine, no MDM restriction on the software update catalog) — the likely
  # cause is that root, once elevated through AppleScript's authorization
  # trampoline, doesn't reliably get to write into another user's private
  # per-user temp directory. /private/tmp (what /tmp is a symlink to) is
  # world-writable with the sticky bit, so both the normal user and the
  # elevated root process can read/write the same file there without any
  # ownership ambiguity.
  XCODE_CLT_HELPER="/private/tmp/.openclaw-installer-clt-helper.$$.sh"
  XCODE_CLT_OUTPUT="/private/tmp/.openclaw-installer-clt-output.$$.log"
  rm -f "$XCODE_CLT_HELPER" "$XCODE_CLT_OUTPUT"
  cat > "$XCODE_CLT_HELPER" <<'HELPER'
#!/bin/bash
set -uo pipefail
marker="/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress"
touch "$marker"
echo "--- softwareupdate -l (raw output) ---"
SU_LIST_OUTPUT="$(softwareupdate -l 2>&1)"
echo "$SU_LIST_OUTPUT"
echo "---------------------------------------"
# A real failure showed the OLD pattern here ('\* Command Line Tools',
# assuming a line like "  * Command Line Tools (...)") matching NOTHING on a
# current macOS: `softwareupdate -l` there actually lists
# "* Label: Command Line Tools for Xcode-16.2" — a "Label: " prefix the old
# pattern didn't account for — so this always fell through to "no entry
# found" and the slower manual-click fallback below, even with CLT entries
# clearly present. Match "*.*Command Line Tools" (anywhere after the
# asterisk) instead, then strip everything up to the first "C" — this is the
# same well-known trick CI bootstrap scripts for macOS have used for years,
# and it tolerates both this "Label: " style and the older plain style.
label="$(echo "$SU_LIST_OUTPUT" | grep '\*.*Command Line Tools' | tail -n 1 | sed -E 's/^[^C]*//; s/[[:space:]]*$//')"
rm -f "$marker"
if [[ -z "$label" ]]; then
  echo "No 'Command Line Tools' entry found in 'softwareupdate -l' output above."
  exit 1
fi
echo "Installing: $label"
softwareupdate -i "$label" --verbose
ec=$?
# This whole helper runs elevated (root) via "do shell script ... with
# administrator privileges", and its stdout/stderr is redirected to
# $XCODE_CLT_OUTPUT by the OUTER command (see below) — so that file gets
# created by root, inside /private/tmp. A real failure showed that file
# coming back completely empty when our own (non-root) script tried to read
# it afterwards: root's default umask there left it unreadable by anyone
# else. chmod it world-readable here, while we're still root, so the
# diagnostic content this was added for is actually visible afterwards.
chmod 644 "$XCODE_CLT_OUTPUT" 2>/dev/null || true
exit $ec
HELPER
  chmod +x "$XCODE_CLT_HELPER"

  # Also capture osascript's OWN stderr (the AppleScript-level error, e.g.
  # "execution error: The command exited with a non-zero status. (1)")
  # separately from the helper's redirected output above, so both ends of
  # the privilege boundary are visible in the log on a repeat failure.
  OSASCRIPT_STDERR="/private/tmp/.openclaw-installer-clt-osaerr.$$.log"
  rm -f "$OSASCRIPT_STDERR"
  # This whole call blocks until the elevated helper finishes — which can be
  # several minutes of the CLT package actually downloading/installing — and
  # none of that produces any output here (it's captured into $XCODE_CLT_OUTPUT
  # instead, only shown afterwards). Wrap it in the heartbeat helper so the
  # Terminal window doesn't look frozen for that whole stretch.
  run_with_heartbeat "Installing Xcode Command Line Tools (this can take several minutes)" \
    osascript -e "do shell script \"/bin/bash '$XCODE_CLT_HELPER' > '$XCODE_CLT_OUTPUT' 2>&1\" with administrator privileges with prompt \"OpenClawInstall needs to install the Xcode Command Line Tools (git needs them) — enter your Mac password to continue, this can take a few minutes.\"" 2>"$OSASCRIPT_STDERR"
  CLT_INSTALL_STATUS=$?
  echo "--- Xcode CLT auto-install output ---"
  cat "$XCODE_CLT_OUTPUT" 2>/dev/null
  echo "--- osascript stderr ---"
  cat "$OSASCRIPT_STDERR" 2>/dev/null
  echo "--------------------------------------"
  rm -f "$XCODE_CLT_HELPER" "$OSASCRIPT_STDERR"
  # $XCODE_CLT_OUTPUT was created by root inside /private/tmp, which has the
  # sticky bit set — only its owner (root) or root itself may unlink a file
  # there, never the plain invoking user, no matter its permission bits. So
  # this delete is EXPECTED to fail; that's not a real error, just macOS
  # cleaning it up on its own schedule, hence the silenced stderr (a bare
  # `rm -f` here still printed a scary, confusing "Permission denied" line).
  rm -f "$XCODE_CLT_OUTPUT" 2>/dev/null || true

  if [[ "$CLT_INSTALL_STATUS" != "0" ]] || ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
    # The `softwareupdate` marker-file trick above is an unofficial
    # CI-provisioning hack, not something Apple guarantees — it's known to
    # get less reliable across macOS releases and can simply fail on some
    # machines even with a good network and no MDM restriction (as just
    # happened). Rather than dead-ending here and telling a novice user to
    # go open Terminal, fall back to Apple's own always-supported path:
    # `xcode-select --install`, which pops the native "Install Command Line
    # Developer Tools" window. It costs one extra click instead of zero, but
    # needs no Terminal and it actually works on every macOS version.
    echo "The non-interactive softwareupdate method failed — falling back to macOS's own xcode-select --install prompt."
    notify "One click needed" "The automatic method didn't work — falling back to macOS's own \"Install Command Line Developer Tools\" window. Please click \"Install\" in it."
    /usr/bin/osascript -e 'display dialog "OpenClawInstall needs to install the Xcode Command Line Tools (git needs them).\n\nmacOS'\''s own \"Install Command Line Developer Tools\" window will appear next — please click \"Install\" in it. No Terminal needed; this installer will continue automatically once it finishes." with title "OpenClawInstall" buttons {"Got it"} default button 1 with icon note' >/dev/null 2>&1 || true
    xcode-select --install >/dev/null 2>&1 || true
    printf 'Waiting for the user to click Install in the system prompt… (up to 20 minutes)'
    CLT_WAIT_ELAPSED=0
    CLT_WAIT_LIMIT=1200
    while ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; do
      sleep 10
      printf '.'
      CLT_WAIT_ELAPSED=$((CLT_WAIT_ELAPSED + 10))
      if (( CLT_WAIT_ELAPSED >= CLT_WAIT_LIMIT )); then
        echo ""
        fatal "Still no git detected after waiting 20 minutes — the \"Install Command Line Developer Tools\" window may not have been clicked, or the install may not have finished yet. Once it's done, just reopen this installer; you can also run 'xcode-select --install' yourself in Terminal."
      fi
    done
    echo ""
  fi
fi
echo "git ready: $(git --version)"

# ---------------------------------------------------------------------
# Step 3: provision the openclaw CLI, no prompts (Node is already on PATH
# from Step 2, so install.sh's own Homebrew-based Node install is skipped).
#
# If a supervised install already exists on this machine (from an earlier
# manual setup, or a previous run of this installer), do NOT run install.sh
# again over it. install.sh's default path is a plain `npm install -g` aimed
# at a *fresh* install; run against an existing one it produced a real,
# reproducible failure twice — npm itself reported success ("changed 330
# packages") but openclaw's own postinstall never cleared its completion
# marker ("OpenClaw lifecycle scripts did not complete"), and a first retry
# failed identically both times. Stopping the Gateway first did NOT fix it
# either (tried that — same failure). openclaw's own docs say plainly which
# path is actually meant for this: "Prefer `openclaw update` for supervised
# installs: it can coordinate the package swap with the running Gateway
# service" (docs/install/updating/update-methods.md) — so for an existing
# install, hand it to `openclaw update --yes` instead (its documented
# non-interactive form — see the `ssh ... 'openclaw update --yes' </dev/null`
# example in docs/cli/update.md) and skip install.sh entirely.
# ---------------------------------------------------------------------
EXISTING_OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"
if [[ -n "$EXISTING_OPENCLAW_BIN" ]]; then
  notify "Step 3/4" "Found an existing openclaw install — updating…"
  echo "Existing openclaw CLI found at ${EXISTING_OPENCLAW_BIN} — running 'openclaw update --yes' instead of install.sh."
  if ! "$EXISTING_OPENCLAW_BIN" update --yes --accept-capabilities; then
    fatal "openclaw update failed — check the log to troubleshoot (safe to re-run this installer)."
  fi
else
  notify "Step 3/4" "Installing the openclaw command-line tool…"
  if ! curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh \
      | /bin/bash -s -- --no-prompt --no-onboard; then
    fatal "openclaw CLI installation failed — check your network connection and try again."
  fi
fi

# install.sh doesn't always publish the openclaw wrapper at the "usual"
# ~/.local/bin/openclaw — it links it into whichever npm global prefix is
# active at install time. When Step 2 provisioned our own private Node (the
# Homebrew-free nodejs.org download), THAT Node's own npm prefix is what's
# active, so the real link lands under
# ~/.openclaw/tools/node-v<version>/bin/openclaw instead (reachable via the
# ~/.openclaw/tools/node/bin symlink) — the same place a normal openclaw
# install would put it. Resolve it from PATH rather than hardcoding a path —
# Step 2 already made sure the right bin dir is first on PATH either way, so
# `command -v` finds whichever one is actually correct.
OPENCLAW_BIN="$(command -v openclaw 2>/dev/null || true)"
if [[ -z "$OPENCLAW_BIN" || ! -x "$OPENCLAW_BIN" ]]; then
  fatal "The CLI install finished but no openclaw command was found on PATH. PATH=${PATH}"
fi
echo "openclaw CLI ready at ${OPENCLAW_BIN}"

# ---------------------------------------------------------------------
# Persist ~/.openclaw/tools/node/bin on PATH for future interactive shells.
#
# Everything above only puts openclaw on PATH for THIS script's own process
# (see the PATH-priming block near the top). install.sh's own default (npm)
# install path never persists anything to the user's shell rc files itself
# -- ensure_openclaw_bin_link() (install.sh) just symlinks the wrapper into
# whatever npm global prefix is active, which for us is always the Node we
# provisioned in Step 2, i.e. ~/.openclaw/tools/node-v<version>/bin/openclaw
# (reachable through the ~/.openclaw/tools/node/bin symlink). install.sh DOES
# have PATH-persisting logic (persist_shell_path_prepend,
# ensure_user_local_bin_on_path), but only its --install-method git path
# calls it, targeting the unrelated ~/.local/bin -- not the plain npm
# install path this script actually uses. Net effect without this block:
# openclaw works fine inside this installer (and any other script that
# explicitly PATHs it in) but "command not found" in a brand new Terminal
# window, which is exactly the report this fixes.
# ---------------------------------------------------------------------
PATH_MARKER="# Added by OpenClaw.app installer"
PATH_LINE="export PATH=\"\$HOME/.openclaw/tools/node/bin:\$PATH\"  ${PATH_MARKER}"
PATH_RC_CANDIDATES=("$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bash_profile" "$HOME/.bashrc")
PATH_RC_ANY_EXISTS=0
for rc in "${PATH_RC_CANDIDATES[@]}"; do
  [[ -f "$rc" ]] && PATH_RC_ANY_EXISTS=1
done
if [[ "$PATH_RC_ANY_EXISTS" == "0" ]]; then
  # Genuinely fresh account with no shell rc files at all yet -- create the
  # one modern macOS Terminal.app actually sources for a login shell (zsh
  # has been the default shell since Catalina).
  echo "$PATH_LINE" >> "$HOME/.zprofile"
  echo "Created ~/.zprofile with ~/.openclaw/tools/node/bin on PATH"
else
  for rc in "${PATH_RC_CANDIDATES[@]}"; do
    [[ -f "$rc" ]] || continue
    grep -qF "$PATH_MARKER" "$rc" 2>/dev/null && continue
    { echo ""; echo "$PATH_LINE"; } >> "$rc"
    echo "Added ~/.openclaw/tools/node/bin to PATH in $rc"
  done
fi
# (fish users: add ~/.openclaw/tools/node/bin to ~/.config/fish/conf.d/ yourself -- not covered here.)

# ---------------------------------------------------------------------
# Step 4: finish onboarding non-interactively — local Gateway + launchd
# daemon, workspace/bootstrap files.
#
# Also wires up a default AI model/provider, IF build-installer.sh baked one
# in from the project's .env at packaging time (its "default AI model
# config" step writes Contents/Resources/default-ai-provider.env when a .env
# exists). This is what lets the end user land straight in OpenClaw.app's
# main window instead of its first-run "pick a model" screen. If that
# resource file is missing (no .env at build time) or incomplete, this falls
# back to the original behavior: --auth-choice is simply omitted, which
# openclaw's own onboarding defaults to "skip" — the user picks a provider
# themselves, exactly like before this was added.
# ---------------------------------------------------------------------
notify "Step 4/4" "Setting up the local Gateway and background service…"

# Built as an array, not a string, so values with spaces/special characters
# survive intact; guarded with the `+` expansion below because macOS's system
# bash (3.2) throws "unbound variable" under `set -u` when expanding an EMPTY
# array's "${arr[@]}" — a real Bash <4.4 quirk, not a typo.
ONBOARD_EXTRA_ARGS=()
HAS_BAKED_AI_PROVIDER=0
AI_PROVIDER_ENV_FILE="$APP_RESOURCES/default-ai-provider.env"
if [[ -f "$AI_PROVIDER_ENV_FILE" ]]; then
  read_baked_var() {
    grep -E "^[[:space:]]*$1=" "$AI_PROVIDER_ENV_FILE" | tail -n1 | cut -d'=' -f2-
  }
  BAKED_AI_PROVIDER="$(read_baked_var DEFAULT_AI_PROVIDER)"
  BAKED_AI_BASE_URL="$(read_baked_var DEFAULT_AI_BASE_URL)"
  BAKED_AI_MODEL="$(read_baked_var DEFAULT_AI_MODEL)"
  BAKED_AI_API_KEY="$(read_baked_var DEFAULT_AI_API_KEY)"
  if [[ -n "$BAKED_AI_BASE_URL" && -n "$BAKED_AI_MODEL" ]]; then
    echo "Default AI provider baked in at build time: ${BAKED_AI_PROVIDER:-custom} @ ${BAKED_AI_BASE_URL} (${BAKED_AI_MODEL})"
    HAS_BAKED_AI_PROVIDER=1
    ONBOARD_EXTRA_ARGS+=(
      --auth-choice custom-api-key
      --custom-base-url "$BAKED_AI_BASE_URL"
      --custom-model-id "$BAKED_AI_MODEL"
      --custom-compatibility openai
    )
    [[ -n "$BAKED_AI_PROVIDER" ]] && ONBOARD_EXTRA_ARGS+=(--custom-provider-id "$BAKED_AI_PROVIDER")
    [[ -n "$BAKED_AI_API_KEY" ]] && ONBOARD_EXTRA_ARGS+=(--custom-api-key "$BAKED_AI_API_KEY")
  else
    echo "default-ai-provider.env exists but is missing base URL/model — skipping default AI provider setup."
  fi
fi

OPENCLAW_CONFIG_FILE="$HOME/.openclaw/openclaw.json"
if [[ -f "$OPENCLAW_CONFIG_FILE" ]]; then
  # A config file only exists once onboarding has actually completed once —
  # by this installer on an earlier run, or some other way. Re-running
  # `openclaw onboard --custom-api-key ...` against an EXISTING config is not
  # a harmless no-op: onboard treats re-supplying those flags as REPLACING an
  # already-configured credential, and its own safety logic refuses to
  # silently activate the replacement — it saves it as an inactive "setup
  # profile" and returns a rejection ("Replacement credential saved but
  # inactive...") instead, which this script was treating as fatal. This is
  # a real failure that was hit on a genuine second run against an
  # already-good install (Step 3's `openclaw update` above already keeps the
  # CLI/daemon current in that case) — onboarding itself only needs to run
  # once, so just skip it here rather than re-triggering that rejection.
  echo "Config already exists (${OPENCLAW_CONFIG_FILE}) — skipping onboard again, keeping the existing config as-is."
else
  if ! "$OPENCLAW_BIN" onboard --non-interactive --accept-risk \
      --install-daemon --skip-health --skip-ui --skip-hooks \
      --skip-channels --skip-search \
      ${ONBOARD_EXTRA_ARGS[@]+"${ONBOARD_EXTRA_ARGS[@]}"}; then
    fatal "openclaw onboard failed to initialize — check the log to troubleshoot (safe to re-run this installer)."
  fi
fi

# If we have a working baked-in default AI provider, also mark OpenClaw.app's
# OWN first-run onboarding UI as already done. Without this, the user still
# lands on the app's GUI onboarding (welcome → permissions → "choose a
# model", 3 screens) even though this script already fully configured
# everything — and that 3rd screen won't even enable "Finish" until the app
# runs its OWN live setup.activate/setup.verify handshake against the
# Gateway; a pre-set model in openclaw.json is deliberately NOT treated as
# proof of a working connection by that screen (see Onboarding.swift's
# isAISetupBlocking gate). What actually controls whether the onboarding
# window shows at all is a separate pair of UserDefaults keys the Mac app
# itself reads at launch (Constants.swift / AppState.swift / MenuBar.swift's
# scheduleFirstRunOnboardingIfNeeded), under the app's own preferences
# domain — its CFBundleIdentifier — not anything in openclaw.json.
#
# That domain is NOT always "ai.openclaw.mac": package-mac-app.sh defaults
# BUNDLE_ID to "ai.openclaw.mac.debug" for any build that doesn't explicitly
# pass BUNDLE_ID=ai.openclaw.mac BUILD_CONFIG=release (an ordinary dev/local
# build, like the one this installer wraps, is normally the ".debug"
# variant). An earlier version of this script hardcoded "ai.openclaw.mac"
# here, which silently wrote to the WRONG preferences domain for a debug
# build — the `defaults write` "succeeded" but the running app, whose real
# domain was "ai.openclaw.mac.debug", never saw it, so onboarding kept
# showing anyway. Read the ACTUAL bundle id back out of the app we just
# installed instead of assuming one, so this works for a debug build, a real
# release build, or any future renaming.
#
# Pre-seeding these keys is safe specifically BECAUSE we already know a real,
# working provider is configured (the .env-baked defaults above); with no
# baked default there is nothing to skip to, so this stays gated on
# HAS_BAKED_AI_PROVIDER. `currentOnboardingVersion` (8) is a constant from
# this exact openclaw build's Constants.swift — if a future OpenClaw.app
# bumps it, this simply falls back to showing onboarding again, same as
# today; no crash either way.
if [[ "$HAS_BAKED_AI_PROVIDER" == "1" && -f "$OPENCLAW_CONFIG_FILE" ]]; then
  APP_BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$DEST_APP/Contents/Info.plist" 2>/dev/null || true)"
  if [[ -z "$APP_BUNDLE_ID" ]]; then
    echo "Could not read CFBundleIdentifier from $DEST_APP — falling back to ai.openclaw.mac (may not match a debug build)."
    APP_BUNDLE_ID="ai.openclaw.mac"
  fi
  echo "Default AI model configured — marking OpenClaw.app's first-run onboarding as done for ${APP_BUNDLE_ID} (skips the welcome/model-selection screens)"
  defaults write "$APP_BUNDLE_ID" openclaw.onboardingSeen -bool true 2>/dev/null || true
  defaults write "$APP_BUNDLE_ID" openclaw.onboardingVersion -int 8 2>/dev/null || true
fi

echo "=================================================="
echo "OpenClaw installer finished: $(date)"
echo "=================================================="
echo "Install complete! Opening OpenClaw… this window will close itself in a few seconds."

notify "Done" "OpenClaw is ready — opening it…"
nohup "$DEST_APP/Contents/MacOS/OpenClaw-bin" >/dev/null 2>&1 &
disown
exit 0
