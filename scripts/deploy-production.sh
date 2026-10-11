#!/usr/bin/env bash
# Deploy the current working tree to the production backend (this VPS, systemd user service).
#   bash scripts/deploy-production.sh            # build + restart prod (+ dev test server)
#   DEPLOY_PULL=1 bash scripts/deploy-production.sh   # git pull --ff-only first
# Steps: (pull) → deps if lockfile changed → typecheck → build → restart via systemd (never a 2nd process)
#        → wait for /health → on failure roll back to the previous server bundle.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${DEPLOY_PULL:-0}" = 1 ]; then git pull --ff-only; fi
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "── installing dependencies (lockfile changed)"
  npm ci --no-audit --no-fund
fi

echo "── typecheck + build"
npm run typecheck >/dev/null
rm -rf dist/server.prev
[ -d dist/server ] && cp -r dist/server dist/server.prev
npm run build >/dev/null

wait_health() {
  for _ in $(seq 1 30); do
    curl -fsS --max-time 2 http://127.0.0.1:3040/health >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

echo "── restarting business-tycoon (systemd sends SIGTERM → state saved → clients reconnect)"
systemctl --user restart business-tycoon
if ! wait_health; then
  echo "✗ new build is not healthy — rolling back" >&2
  journalctl --user -u business-tycoon --no-pager -n 30 >&2
  if [ -d dist/server.prev ]; then
    rm -rf dist/server && mv dist/server.prev dist/server
    systemctl --user restart business-tycoon
    wait_health && echo "↩ rolled back to the previous server bundle" >&2
  fi
  exit 1
fi
systemctl --user restart business-tycoon-dev 2>/dev/null || true

listeners=$(ss -ltnpH 'sport = :3040' | wc -l)
[ "$listeners" = 1 ] || { echo "✗ $listeners processes listen on :3040" >&2; exit 1; }
echo "✓ $(systemctl --user is-active business-tycoon) · pid $(systemctl --user show -p MainPID --value business-tycoon) · $(curl -fsS http://127.0.0.1:3040/health)"
