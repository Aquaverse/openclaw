#!/bin/bash

# Select the bundled Node archive for the process that will run install-cli.sh.
# Installer.app can launch package scripts through Rosetta on Apple Silicon, in
# which case `uname -m` reports x86_64 even though the installed arm64 app and
# its bundled Node archive are native arm64.
select_bundled_node_arch() {
  local runtime_dir="$1"
  local process_arch="$2"
  local translated="$3"
  local candidate

  if [[ "$process_arch" == "x86_64" && "$translated" == "1" ]]; then
    candidate="arm64"
    if compgen -G "$runtime_dir/node-v*-darwin-${candidate}.tar.gz" >/dev/null; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  case "$process_arch" in
    arm64 | x86_64) candidate="$process_arch" ;;
    *) return 1 ;;
  esac
  if compgen -G "$runtime_dir/node-v*-darwin-${candidate}.tar.gz" >/dev/null; then
    printf '%s\n' "$candidate"
    return 0
  fi
  return 1
}
