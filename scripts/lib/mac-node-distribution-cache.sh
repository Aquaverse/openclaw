#!/bin/bash

# Build-time cache for official Node.js archives used by both the private app
# runtime and the distributable installer. Callers still verify the archive on
# every use; the network is needed only when this exact version/OS/CPU is absent.
OPENCLAW_MAC_NODE_VERSION="${OPENCLAW_NODE_VERSION:-24.22.1}"

openclaw_download_node_cache_file() {
  local url="$1"
  local destination="$2"
  local temporary="${destination}.tmp.$$"
  local attempt

  rm -f "$temporary"
  for attempt in 1 2 3; do
    if curl -fL --proto '=https' --tlsv1.2 --connect-timeout 20 \
      --speed-limit 1024 --speed-time 60 -o "$temporary" "$url"; then
      mv -f "$temporary" "$destination"
      return 0
    fi
    rm -f "$temporary"
    [[ "$attempt" -eq 3 ]] || sleep $((attempt * 2))
  done
  echo "ERROR: failed to download $url after 3 attempts" >&2
  return 1
}

openclaw_cache_node_distribution() {
  local cache_dir="$1"
  local os="$2"
  local arch="$3"
  local distribution_arch="$arch"
  local version="$OPENCLAW_MAC_NODE_VERSION"
  local tarball sidecar shasums expected_sha actual_sha

  [[ "$arch" == "x86_64" ]] && distribution_arch="x64"
  tarball="node-v${version}-${os}-${distribution_arch}.tar.gz"
  sidecar="$cache_dir/$tarball.sha256"
  shasums="$cache_dir/SHASUMS256-v${version}.txt"
  mkdir -p "$cache_dir"

  # Older installer builds already cached a verified per-archive sidecar. Use
  # it directly so upgrading the build scripts remains offline-capable.
  expected_sha=""
  if [[ -f "$sidecar" ]]; then
    expected_sha="$(head -n1 "$sidecar" | tr -d '[:space:]')"
    [[ "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || expected_sha=""
  fi
  if [[ -z "$expected_sha" ]]; then
    if [[ ! -f "$shasums" ]]; then
      echo "    Downloading Node ${version} checksums (cached for future builds)"
      openclaw_download_node_cache_file \
        "https://nodejs.org/dist/v${version}/SHASUMS256.txt" "$shasums"
    fi
    expected_sha="$(grep "  ${tarball}$" "$shasums" | awk '{print $1}' | head -n1 || true)"
  fi
  if [[ -z "$expected_sha" ]]; then
    echo "ERROR: could not resolve sha256 for $tarball" >&2
    return 1
  fi

  if [[ ! -f "$cache_dir/$tarball" ]]; then
    echo "    Downloading $tarball (cached for future builds)"
    openclaw_download_node_cache_file \
      "https://nodejs.org/dist/v${version}/${tarball}" "$cache_dir/$tarball"
  fi
  # Some macOS developer-tool installations create xcrun_db under TMPDIR on
  # first use. Keep that tool-owned cache inside this cache owner instead of
  # leaking it into the runtime staging directory.
  actual_sha="$(TMPDIR="$cache_dir" shasum -a 256 "$cache_dir/$tarball" | awk '{print $1}')"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "ERROR: cached $tarball sha256 mismatch (expected $expected_sha, got $actual_sha)" >&2
    echo "       Delete $cache_dir/$tarball and retry." >&2
    return 1
  fi

  printf '%s\n' "$expected_sha" > "$sidecar"
  OPENCLAW_CACHED_NODE_TARBALL="$cache_dir/$tarball"
  OPENCLAW_CACHED_NODE_TARBALL_SHA256="$expected_sha"
}
