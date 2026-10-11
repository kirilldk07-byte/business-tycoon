#!/usr/bin/env bash
# Install / refresh the user-level systemd services for the game servers (no root needed).
#   bash scripts/install-services.sh
# - creates ~/.config/business-tycoon/{prod,dev}.env from deploy/env/*.example if missing (chmod 600)
# - copies deploy/systemd/*.service to ~/.config/systemd/user/, daemon-reload, enable + (re)start
#   business-tycoon (prod :3040) and business-tycoon-dev (dev :3041)
# - replaces legacy nohup processes on those ports (only our own dist/server/index.js)
# - cloudflared-tunnel.service is installed but NOT enabled (needs the domain — docs/PRODUCTION_DEPLOY.md)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
CFG="$HOME/.config/business-tycoon"
UNITS="$HOME/.config/systemd/user"

mkdir -p "$CFG" "$UNITS"
chmod 700 "$CFG"
for e in prod dev; do
  if [ ! -f "$CFG/$e.env" ]; then
    sed "s#/home/kirill/projects/business-tycoon#$ROOT#g" "deploy/env/$e.env.example" > "$CFG/$e.env"
    echo "created $CFG/$e.env"
  fi
  chmod 600 "$CFG/$e.env"
done
mkdir -p data data-dev
chmod 700 data data-dev

# lingering = user services start at boot without a login session
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  loginctl enable-linger "$USER" || echo "⚠ could not enable linger — run once: sudo loginctl enable-linger $USER"
fi

for u in business-tycoon business-tycoon-dev cloudflared-tunnel; do
  sed "s#%h/projects/business-tycoon#$ROOT#g" "deploy/systemd/$u.service" > "$UNITS/$u.service"
done
systemctl --user daemon-reload

# Legacy nohup servers on our ports → stop them so systemd owns the port (never two servers in parallel).
for port in 3040 3041; do
  pid=$(ss -ltnpH "sport = :$port" 2>/dev/null | sed -nE 's/.*pid=([0-9]+).*/\1/p' | head -1)
  [ -z "$pid" ] && continue
  unit=$(ps -o unit= -p "$pid" 2>/dev/null | tr -d ' ')
  case "$unit" in business-tycoon*.service) continue;; esac
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  if [[ "$cmd" == *"dist/server/index.js"* && "$cwd" == "$ROOT" ]]; then
    echo "stopping legacy nohup server on :$port (pid $pid)"
    kill "$pid"
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  else
    echo "✗ port $port is used by something else (pid $pid: $cmd) — not touching it" >&2
    exit 1
  fi
done

systemctl --user enable business-tycoon business-tycoon-dev >/dev/null
systemctl --user restart business-tycoon business-tycoon-dev
sleep 2
for u in business-tycoon business-tycoon-dev; do echo "$u: $(systemctl --user is-active $u) / $(systemctl --user is-enabled $u)"; done
curl -fsS --max-time 5 http://127.0.0.1:3040/health && echo
