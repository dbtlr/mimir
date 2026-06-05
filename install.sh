#!/bin/sh
# mimir installer.
#
# Downloads the standalone binary for your platform from the latest GitHub
# release and installs it to ~/.local/bin. Override the directory with
# MIMIR_INSTALL_DIR; pin a version with MIMIR_VERSION=v0.1.0.
#
#   curl -fsSL https://raw.githubusercontent.com/dbtlr/mimir/main/install.sh | sh
#
set -eu

REPO="dbtlr/mimir"
INSTALL_DIR="${MIMIR_INSTALL_DIR:-$HOME/.local/bin}"

err() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}
info() { printf '%s\n' "$1" >&2; }

command -v curl >/dev/null 2>&1 || err "curl is required"

# Detect platform → asset name (must match the release workflow's outputs).
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) err "unsupported OS: $os (try: bun add -g github:$REPO)" ;;
esac
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) err "unsupported architecture: $arch" ;;
esac

# Intel macs have no published binary yet — install from source instead.
if [ "$os" = darwin ] && [ "$arch" = x64 ]; then
  err "no prebuilt binary for Intel macOS yet — install from source: bun add -g github:$REPO"
fi
asset="mimir-${os}-${arch}"

if [ -n "${MIMIR_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/$MIMIR_VERSION"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

info "downloading $asset ..."
curl -fSL --proto '=https' --tlsv1.2 "$base/$asset" -o "$tmp/mimir" \
  || err "download failed: $base/$asset"

# Verify against SHA256SUMS when the release publishes it.
if curl -fsSL --proto '=https' "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" 2>/dev/null; then
  expected=$(grep " ${asset}$" "$tmp/SHA256SUMS" 2>/dev/null | awk '{print $1}')
  if [ -n "${expected:-}" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$tmp/mimir" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      actual=$(shasum -a 256 "$tmp/mimir" | awk '{print $1}')
    else
      actual=""
    fi
    if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
      err "checksum mismatch for $asset"
    fi
    [ -n "$actual" ] && info "checksum ok"
  fi
fi

chmod +x "$tmp/mimir"
mkdir -p "$INSTALL_DIR"
mv "$tmp/mimir" "$INSTALL_DIR/mimir"
info "installed mimir to $INSTALL_DIR/mimir"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    info "note: $INSTALL_DIR is not on your PATH — add it:"
    info "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

info "done — run: mimir --help"
