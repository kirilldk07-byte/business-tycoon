#!/usr/bin/env bash
# Expose the local game server (PORT, default 3040) over HTTPS/WSS with a
# Cloudflare quick tunnel and republish GitHub Pages with the new address.
# Quick-tunnel URLs change on every restart; for a permanent address use a
# named Cloudflare tunnel or a domain with TLS (see README).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-3040}"
LOG="${TUNNEL_LOG:-/tmp/bt-tunnel.log}"
CF="${CLOUDFLARED:-$HOME/bin/cloudflared}"
pkill -f "cloudflared tunnel --no-autoupdate --url http://localhost:$PORT" 2>/dev/null || true
nohup "$CF" tunnel --no-autoupdate --url "http://localhost:$PORT" > "$LOG" 2>&1 &
for _ in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [ -n "${URL:-}" ] && break
  sleep 1
done
[ -n "${URL:-}" ] || { echo "tunnel did not start, see $LOG"; exit 1; }
echo "Tunnel: $URL"
WS_URL="${URL/https:/wss:}/ws" bash scripts/deploy-pages.sh
