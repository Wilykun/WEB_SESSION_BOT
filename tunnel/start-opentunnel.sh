#!/usr/bin/env bash
# start-opentunnel.sh — jalankan tunnel OpenTunnel untuk SessionBot.
#
# Yang dilakukan:
#   1. Pakai CLI opentunnel di ~/.local/bin (instal dulu lewat
#      tunnel/install-opentunnel.sh kalau belum ada).
#   2. Pakai identitas tunnel yang SUDAH ADA kalau tersimpan
#      (~/.local/share/opentunnel + ~/.config/opentunnel) — URL publik
#      tetap sama. Kalau belum ada, `opentunnel up` membuat tunnel baru
#      (butuh ~3-5 menit sekali saja, pembuatan pertama jangan dibunuh
#      di bawah 2 menit; sertifikat ACME).
#   3. Pastikan rute `sessionbot` -> 127.0.0.1:3001 ada (URL publik:
#      https://sessionbot.<tunnel-id>.opentunnel.xyz).
#   4. Tulis URL publik ke tunnel/opentunnel-url.txt.
#   5. Guard cooldown 3 menit (file $HOME/.cache/sessionbot-opentunnel-last-start-at):
#      jangan start bertubi-tubi — pelajaran dari tunnl.gg yang kena
#      rate limit karena restart tiap menit.
#   6. Kalau service sudah connected, langsung selesai (tidak restart).
#   7. Kalau OpenTunnel gagal total, fallback ke tunnl.gg
#      (tunnel/start-tunnel.sh stable) supaya SessionBot tetap punya jalan.
#
# Transport: HTTPS/WebSocket lewat HTTPS_PROXY + CA proxy VM
# (SSL_CERT_FILE). Tidak butuh akun/token. Tidak mengganggu tunnel
# tunnl.gg yang sedang live — keduanya boleh jalan bersamaan.
#
# PENTING: server SessionBot harus jalan di PORT 3001 (bukan 3000 —
# port 3000 sudah dipakai panel ReadSW di VM ini):
#   PORT=3001 npm start
#
# Cara pakai:  bash tunnel/start-opentunnel.sh
# Log:         /tmp/sessionbot-opentunnel.log
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="/tmp/sessionbot-opentunnel.log"
URL_FILE="$SCRIPT_DIR/opentunnel-url.txt"
LAST_FILE="${OPENTUNNEL_LAST_START_FILE:-$HOME/.cache/sessionbot-opentunnel-last-start-at}"
ROUTE_NAME="${OPENTUNNEL_ROUTE_NAME:-sessionbot}"
TARGET="${OPENTUNNEL_TARGET:-127.0.0.1:3001}"

log() { echo "[$(date '+%F %T %Z')] $*" | tee -a "$LOG"; }

# --- 0. CLI: cari, kalau tidak ada coba instal -----------------------------
OT=""
for c in "$HOME/.local/bin/opentunnel" /usr/local/bin/opentunnel "$(command -v opentunnel 2>/dev/null || true)"; do
  [[ -n "$c" && -x "$c" ]] && { OT="$c"; break; }
done
if [[ -z "$OT" ]]; then
  log "opentunnel belum ada, mencoba instal..."
  if [[ -x "$SCRIPT_DIR/install-opentunnel.sh" ]]; then
    bash "$SCRIPT_DIR/install-opentunnel.sh" >>"$LOG" 2>&1 || true
  fi
  [[ -x "$HOME/.local/bin/opentunnel" ]] && OT="$HOME/.local/bin/opentunnel"
fi
if [[ -z "$OT" ]]; then
  log "GAGAL: CLI opentunnel tidak ditemukan dan instalasi gagal. Fallback ke tunnl.gg."
  [[ -x "$SCRIPT_DIR/start-tunnel.sh" ]] && bash "$SCRIPT_DIR/start-tunnel.sh" stable >>"$LOG" 2>&1 || true
  exit 1
fi

# CA proxy VM (MITM egress). Tanpa ini TLS ke opentunnel.xyz ditolak.
CA_ARGS=()
CA_CERT="${SSL_CERT_FILE:-/run/hatch/egress-tls/ca-bundle.pem}"
[[ -f "$CA_CERT" ]] && CA_ARGS=(--ca-cert "$CA_CERT")

# --- 1. Guard cooldown 3 menit --------------------------------------------
NOW="$(date +%s)"
if [[ -f "$LAST_FILE" ]]; then
  LAST="$(cat "$LAST_FILE" 2>/dev/null || echo 0)"
  if [[ "$LAST" =~ ^[0-9]+$ ]] && (( NOW - LAST < 180 )); then
    # Kecuali service memang sedang mati, jangan start ulang.
    if "$OT" "${CA_ARGS[@]}" status 2>/dev/null | grep -q "connected"; then
      log "opentunnel cooldown: terakhir start $((NOW - LAST)) dtk lalu, service sudah connected — skip."
      exit 0
    fi
    log "opentunnel cooldown: terakhir start $((NOW - LAST)) dtk lalu, tapi service mati — lanjut start."
  fi
fi
mkdir -p "$(dirname "$LAST_FILE")"
date +%s > "$LAST_FILE"

# --- 2. Sudah connected? ---------------------------------------------------
if "$OT" "${CA_ARGS[@]}" status 2>/dev/null | grep -q "connected"; then
  log "opentunnel sudah connected, tidak perlu start ulang."
else
  log "Menjalankan opentunnel up ($("$OT" --version 2>/dev/null))..."
  # `up` membuat tunnel bila belum ada + menjalankan service (daemon).
  # Butuh waktu di pembuatan pertama (sertifikat ACME ~3-5 mnt).
  if ! "$OT" "${CA_ARGS[@]}" up >>"$LOG" 2>&1; then
    log "GAGAL: opentunnel up exit non-zero. Fallback ke tunnl.gg."
    [[ -x "$SCRIPT_DIR/start-tunnel.sh" ]] && bash "$SCRIPT_DIR/start-tunnel.sh" stable >>"$LOG" 2>&1 || true
    exit 1
  fi
fi

# --- 3. Pastikan rute sessionbot -> SessionBot ------------------------------
if ! "$OT" "${CA_ARGS[@]}" route list 2>/dev/null | grep -q "^${ROUTE_NAME}\."; then
  log "Menambah rute ${ROUTE_NAME} -> ${TARGET}..."
  "$OT" "${CA_ARGS[@]}" route add --name "$ROUTE_NAME" "$TARGET" >>"$LOG" 2>&1 \
    || log "PERINGATAN: route add gagal, cek $LOG (tunnel mungkin tetap jalan dengan rute lama)."
else
  log "Rute ${ROUTE_NAME} sudah ada."
fi

# --- 4. Tulis URL publik + verifikasi ---------------------------------------
TUNNEL_HOST="$("$OT" "${CA_ARGS[@]}" status 2>/dev/null | grep -m1 'Hostname:' | awk '{print $2}')"
if [[ -n "$TUNNEL_HOST" ]]; then
  URL="https://${ROUTE_NAME}.${TUNNEL_HOST}"
  echo "$URL" > "$URL_FILE"
  log "URL publik OpenTunnel: $URL (tersimpan di tunnel/opentunnel-url.txt)"
else
  log "PERINGATAN: hostname tunnel tidak terbaca dari status."
fi

# Verifikasi ringan: tunggu service connected (maks ~60 dtk).
for _ in $(seq 1 12); do
  "$OT" "${CA_ARGS[@]}" status 2>/dev/null | grep -q "connected" && break
  sleep 5
done
if "$OT" "${CA_ARGS[@]}" status 2>/dev/null | grep -q "connected"; then
  log "OpenTunnel CONNECTED. SessionBot: ${URL:-<cek opentunnel-url.txt>}"
else
  log "PERINGATAN: service belum connected setelah ~60 dtk — cek $LOG dan 'opentunnel status'."
  exit 1
fi

# --- 5. Server SessionBot-nya jalan? ----------------------------------------
if curl -fsS -m 5 "http://127.0.0.1:3001/api/health" >/dev/null 2>&1; then
  log "Server SessionBot OK di 127.0.0.1:3001 (/api/health)."
else
  log "PERINGATAN: server SessionBot TIDAK merespons di 127.0.0.1:3001 — jalankan dulu: PORT=3001 npm start"
fi
