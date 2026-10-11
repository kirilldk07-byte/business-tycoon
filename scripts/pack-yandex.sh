#!/usr/bin/env bash
# Build the client for Yandex Games and pack the upload ZIP.
#   VITE_WS_URL=wss://tycoon.example.com/ws bash scripts/pack-yandex.sh
#
# Yandex rules enforced here:
#  - index.html at the archive root, relative paths, no spaces/Cyrillic in names (1.22), ≤ 100 MB unpacked (1.21);
#  - backend only over wss:// and by host NAME (the console CSP tab accepts a host without IP/port/path);
#  - SDK connected exactly as documented: <script src="/sdk.js"> in index.html (1.19.1);
#  - no source maps, no localhost/IP, no secrets in the bundle.
set -euo pipefail
: "${VITE_WS_URL:?set VITE_WS_URL=wss://your-domain/ws}"
cd "$(dirname "$0")/.."

host=$(printf '%s' "$VITE_WS_URL" | sed -E 's#^wss://([^/:]+).*#\1#')
case "$VITE_WS_URL" in wss://*) ;; *) echo "✗ VITE_WS_URL must start with wss:// (Yandex Games is HTTPS-only)" >&2; exit 1;; esac
if printf '%s' "$host" | grep -Eq '^[0-9.]+$'; then echo "✗ use a domain, not an IP: Yandex CSP does not accept IP addresses" >&2; exit 1; fi
if printf '%s' "$VITE_WS_URL" | grep -Eq '^wss://[^/]+:[0-9]+'; then echo "✗ no explicit port: Yandex CSP does not accept ports" >&2; exit 1; fi

npx vite build >/dev/null
OUT=dist/yandex
rm -rf "$OUT" dist/yandex-game.zip
cp -r dist/client "$OUT"
# Same backend at runtime (config.json has priority over the baked URL).
printf '{ "wsUrl": "%s" }\n' "$VITE_WS_URL" > "$OUT/config.json"
# Official SDK include — /sdk.js is served by Yandex next to the game.
sed -i 's#<head>#<head>\n  <script src="/sdk.js"></script>#' "$OUT/index.html"
find "$OUT" -name '*.map' -delete

# ---- checks ----
fail=0
[ -f "$OUT/index.html" ] || { echo "✗ index.html missing"; fail=1; }
if find "$OUT" | sed "s#^$OUT##" | LC_ALL=C grep -nP '[^\x21-\x7e]' ; then echo "✗ spaces / non-ASCII in file names"; fail=1; fi
if grep -rlE 'localhost|127\.0\.0\.1|107\.170\.' "$OUT" >/dev/null; then echo "✗ localhost / hardcoded IP in the bundle:"; grep -rlE 'localhost|127\.0\.0\.1|107\.170\.' "$OUT"; fail=1; fi
if grep -rlE 'BEGIN (RSA |EC )?PRIVATE KEY|ghp_[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}' "$OUT" >/dev/null; then echo "✗ secret-looking string in the bundle"; fail=1; fi
if grep -q 'src="/' "$OUT/index.html" && grep -o 'src="/[^"]*"' "$OUT/index.html" | grep -v '/sdk.js' >/dev/null; then echo "✗ absolute asset path in index.html"; fail=1; fi
size_kb=$(du -sk "$OUT" | cut -f1)
[ "$size_kb" -le 102400 ] || { echo "✗ unpacked size ${size_kb} KB > 100 MB"; fail=1; }
[ $fail = 0 ] || exit 1

if command -v zip >/dev/null; then (cd "$OUT" && zip -qr -X ../yandex-game.zip .); else (cd "$OUT" && python3 -m zipfile -c ../yandex-game.zip ./*); fi
echo "✓ dist/yandex-game.zip  ($(du -k dist/yandex-game.zip | cut -f1) KB zipped, ${size_kb} KB unpacked)"
echo "  backend: $VITE_WS_URL   → add host '$host' in the console CSP tab"
