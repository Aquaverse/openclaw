#!/bin/bash

# Both direct packaging and restart publish only a completely verified bundle.
replace_mac_app_bundle() {
  local staged="$1" target="$2" previous previous_name
  previous_name="${target##*/}"
  previous="$(mktemp -d "${target}.previous.XXXXXX")" || return 1
  if [[ -e "$target" ]]; then
    mv "$target" "$previous/$previous_name" || return 1
  fi
  if ! mv "$staged" "$target"; then
    if [[ -e "$previous/$previous_name" ]]; then
      mv "$previous/$previous_name" "$target" || {
        echo "ERROR: Restore the previous app from $previous/$previous_name" >&2
        return 1
      }
    fi
    rmdir "$previous"
    return 1
  fi
  rm -rf "$previous"
}
