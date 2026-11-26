#!/usr/bin/env bash
# install-opentunnel.sh — pasang CLI OpenTunnel (anomalyco, opentunnel.xyz)
# ke ~/.local/bin/opentunnel kalau belum ada.
#
# OpenTunnel adalah tunnel HTTPS/WebSocket yang LOLOS dari VM Muse
# (transport lewat HTTPS_PROXY, tanpa UDP, tanpa SSH) — lihat
# tunnel/README-TUNNEL.md dan ~/workspace/your_files/CATATAN-tunnel-lolos-VM.md.
#
# Cara pakai:  bash tunnel/install-opentunnel.sh
#   - Deteksi OS/arch (linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64).
#   - Ambil rilis terbaru dari GitHub anomalyco/opentunnel; kalau API
#     GitHub tidak bisa dijangkau, fallback ke v0.7.0 (versi yang sudah
#     teruji end-to-end di VM ini, 25 Nov 2026).
#   - Tidak butuh akun/token. Tidak menyentuh identitas tunnel lama
#     (~/.local/share/opentunnel, ~/.config/opentunnel).
set -uo pipefail

BIN_DIR="${OPENTUNNEL_BIN_DIR:-$HOME/.local/bin}"
BIN="$BIN_DIR/opentunnel"
FALLBACK_VERSION="v0.7.0"

if [[ -x "$BIN" ]]; then
  echo "opentunnel sudah ada: $BIN ($("$BIN" --version 2>/dev/null || echo '?'))"
  exit 0
fi

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Arsitektur tidak didukung: $ARCH" >&2; exit 1 ;;
esac
case "$OS" in
  linux|darwin) ;;
  *) echo "OS tidak didukung: $OS" >&2; exit 1 ;;
esac
ASSET="opentunnel-${OS}-${ARCH}.tar.gz"

# Versi terbaru dari GitHub API; gagal -> pakai versi fallback yang teruji.
VERSION="$FALLBACK_VERSION"
if command -v curl >/dev/null 2>&1; then
  LATEST="$(curl -fsSL --max-time 20 https://api.github.com/repos/anomalyco/opentunnel/releases/latest 2>/dev/null \
    | grep -m1 '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  [[ -n "$LATEST" ]] && VERSION="$LATEST"
fi
URL="https://github.com/anomalyco/opentunnel/releases/download/${VERSION}/${ASSET}"

echo "Mengunduh opentunnel ${VERSION} (${ASSET})..."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if ! curl -fsSL --max-time 120 -o "$TMP/$ASSET" "$URL"; then
  echo "Gagal unduh $URL" >&2
  exit 1
fi
tar -xzf "$TMP/$ASSET" -C "$TMP"
# Tarball berisi satu binary 'opentunnel' di root.
if [[ ! -f "$TMP/opentunnel" ]]; then
  FOUND="$(find "$TMP" -name opentunnel -type f | head -1)"
  [[ -n "$FOUND" ]] && cp "$FOUND" "$TMP/opentunnel"
fi
[[ -f "$TMP/opentunnel" ]] || { echo "Binary opentunnel tidak ada di $ASSET" >&2; exit 1; }
mkdir -p "$BIN_DIR"
cp "$TMP/opentunnel" "$BIN"
chmod +x "$BIN"
echo "Terpasang: $BIN ($("$BIN" --version))"
echo "PATH: tambah $BIN_DIR ke PATH kalau belum (export PATH=\"\$HOME/.local/bin:\$PATH\")"
