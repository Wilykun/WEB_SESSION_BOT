#!/bin/bash
# Start tunnl.gg tunnel for SessionBot on 127.0.0.1:3001 (fallback kalau
# OpenTunnel gagal; tunnel ini bertahan paling lama 24 jam, URL berubah
# tiap restart).
# Usage: start-tunnel.sh [random|stable]  (default random)
MODE="${1:-random}"
USER="proxy.tunnl.gg"
[ "$MODE" = "stable" ] && USER="stable@proxy.tunnl.gg"
DIR="$(cd "$(dirname "$0")" && pwd)"
setsid nohup ssh -o ProxyCommand="python3 $DIR/proxy_ssh.py %h %p" \
  -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -i "$HOME/.ssh/tunnl_sessionbot" \
  -n -T -R 80:localhost:3001 "$USER" output=json > /tmp/sessionbot-tunnl.log 2>&1 < /dev/null &
echo "tunnl ssh pid $! mode=$MODE log=/tmp/sessionbot-tunnl.log"
