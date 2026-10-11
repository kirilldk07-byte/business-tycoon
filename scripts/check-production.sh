#!/usr/bin/env bash
# Production readiness check (read-only — changes nothing).
#   bash scripts/check-production.sh                          # local backend + build artifacts
#   bash scripts/check-production.sh wss://game.example.com/ws  # + public HTTPS/WSS checks through Cloudflare
set -uo pipefail
cd "$(dirname "$0")/.."
URL="${1:-}"
pass=0 fail=0 warn=0
ok()   { echo "  ✓ $*"; pass=$((pass + 1)); }
bad()  { echo "  ✗ $*"; fail=$((fail + 1)); }
note() { echo "  ⚠ $*"; warn=$((warn + 1)); }

echo "── backend service"
[ "$(systemctl --user is-active business-tycoon 2>/dev/null)" = active ] && ok "business-tycoon.service active" || bad "business-tycoon.service not active"
[ "$(systemctl --user is-enabled business-tycoon 2>/dev/null)" = enabled ] && ok "autostart enabled" || bad "autostart not enabled"
[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = yes ] && ok "linger on (starts at boot without login)" || bad "linger off: loginctl enable-linger $USER"
n=$(ss -ltnpH 'sport = :3040' 2>/dev/null | wc -l)
[ "$n" = 1 ] && ok "exactly one listener on :3040" || bad "$n listeners on :3040"
if ss -ltnH 'sport = :3040' | grep -q '127.0.0.1:3040'; then ok "bound to 127.0.0.1 (not exposed directly)"; else note "backend listens on a public interface"; fi

echo "── health"
h=$(curl -fsS --max-time 5 http://127.0.0.1:3040/health 2>/dev/null) || h=''
if [ -n "$h" ]; then
  echo "$h" | grep -q '"status":"ok"' && ok "/health → $h" || bad "/health unexpected: $h"
  echo "$h" | grep -q '"devTools":false' && ok "dev tools OFF in production" || bad "dev tools are ON in production!"
else bad "/health not reachable on 127.0.0.1:3040"; fi

ws_probe() { # $1 = ws(s) URL → prints "open" when the WebSocket upgrade succeeds
  node -e '
    const WS = require("ws"); const s = new WS(process.argv[1], { handshakeTimeout: 8000 });
    s.on("open", () => { console.log("open"); s.close(); process.exit(0); });
    s.on("error", (e) => { console.log("error " + e.message); process.exit(1); });
    setTimeout(() => { console.log("timeout"); process.exit(1); }, 10000);' "$1" 2>/dev/null
}
r=$(ws_probe ws://127.0.0.1:3040/ws) && ok "local WebSocket /ws upgrade" || bad "local WebSocket: $r"

if [ -n "$URL" ]; then
  echo "── public endpoint $URL"
  host=$(printf '%s' "$URL" | sed -E 's#^wss://([^/:]+).*#\1#')
  case "$URL" in wss://*) ok "wss://";; *) bad "not wss://";; esac
  printf '%s' "$host" | grep -qi trycloudflare && note "temporary quick tunnel (URL changes on restart) — not for publication"
  pc=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$host/health")
  [ "$pc" = 200 ] && ok "https://$host/health → 200 (TLS OK)" || bad "https://$host/health → $pc"
  r=$(ws_probe "$URL") && ok "WSS upgrade through Cloudflare" || bad "WSS: $r"
fi

echo "── production frontend config"
if grep -rnE 'trycloudflare|107\.170\.36\.76' client/src client/index.html >/dev/null; then bad "temporary tunnel / server IP hardcoded in client sources"; grep -rnE 'trycloudflare|107\.170\.36\.76' client/src client/index.html | head -3; else ok "no tunnel/IP hardcoded in client sources"; fi
if grep -rn 'localhost' client/src | grep -v '^\s*//' | grep -vq 'location.host'; then note "'localhost' mentioned in client sources (check it is dev-only)"; else ok "no localhost in client sources"; fi

echo "── Yandex package"
if [ -f dist/yandex-game.zip ]; then
  z=dist/yandex-game.zip
  ok "dist/yandex-game.zip ($(du -k $z | cut -f1) KB)"
  unzip -l $z | awk '{print $4}' | grep -qx index.html && ok "index.html at archive root" || bad "index.html not at root"
  unzip -l $z | grep -q '\.map$' && bad "source maps in zip" || ok "no source maps"
  size=$(unzip -l $z | tail -1 | awk '{print $1}')
  [ "$size" -le 104857600 ] && ok "unpacked $((size / 1024)) KB ≤ 100 MB" || bad "unpacked size > 100 MB"
  tmp=$(mktemp -d); unzip -q $z -d "$tmp"
  grep -rqE 'trycloudflare|localhost|127\.0\.0\.1|107\.170\.' "$tmp" && bad "zip contains tunnel/localhost/IP" || ok "zip: no tunnel/localhost/IP"
  grep -rqE 'BEGIN (RSA |EC )?PRIVATE KEY|ghp_[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}' "$tmp" && bad "zip: secret-looking string" || ok "zip: no secrets"
  grep -q 'src="/sdk.js"' "$tmp/index.html" && ok "SDK <script src=\"/sdk.js\">" || bad "SDK script tag missing"
  echo "  backend in zip: $(cat "$tmp/config.json" 2>/dev/null)"
  rm -rf "$tmp"
else
  note "no production dist/yandex-game.zip yet (needs the real domain: VITE_WS_URL=wss://<domain>/ws bash scripts/pack-yandex.sh)"
fi
[ -f dist/yandex-game.DRAFT-TEST.zip ] && note "dist/yandex-game.DRAFT-TEST.zip exists — draft testing only, never for moderation"

echo "── secrets hygiene"
git ls-files | grep -qE '(^|/)\.env$|prod\.env$|data/profiles\.json' && bad "env/data tracked by git" || ok "no env/data files tracked by git"
p=$(stat -c %a "$HOME/.config/business-tycoon/prod.env" 2>/dev/null); [ "$p" = 600 ] && ok "prod.env permissions 600" || bad "prod.env permissions: ${p:-missing}"
d=$(stat -c %a data 2>/dev/null); [ "$d" = 700 ] && ok "data/ permissions 700" || note "data/ permissions: ${d:-missing}"

echo
echo "PASS $pass · WARN $warn · FAIL $fail"
[ $fail = 0 ]
