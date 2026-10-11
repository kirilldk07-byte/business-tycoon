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

# YANDEX_TEST_BUILD=1 → a clearly labelled DRAFT-TEST zip that may point at the temporary tunnel
# (for Yandex Draft testing before the domain exists). Never upload it for moderation.
TEST="${YANDEX_TEST_BUILD:-0}"
die() { echo "✗ $*" >&2; exit 1; }
host=$(printf '%s' "$VITE_WS_URL" | sed -E 's#^wss://([^/:]+).*#\1#')
case "$VITE_WS_URL" in wss://*) ;; *) die "VITE_WS_URL must start with wss:// (Yandex Games is HTTPS-only; ws:// is blocked)";; esac
printf '%s' "$host" | grep -Eq '^[0-9.]+$|^\[' && die "use a domain, not an IP: Yandex CSP does not accept IP addresses"
printf '%s' "$VITE_WS_URL" | grep -Eq '^wss://[^/]+:[0-9]+' && die "no explicit port: Yandex CSP does not accept ports"
printf '%s' "$host" | grep -Eiq '^localhost$|\.local$|\.localhost$' && die "localhost is not a production backend"
printf '%s' "$host" | grep -Eiq '(^|\.)DOMAIN\.TLD$|(^|\.)example\.(com|org|net)$|your-domain|placeholder' && die "placeholder domain ($host) — use the real one"
if printf '%s' "$host" | grep -Eiq '\.trycloudflare\.com$'; then
  [ "$TEST" = 1 ] || die "temporary Cloudflare quick tunnel ($host): its URL changes on restart — NO production package. Use the named-tunnel domain (docs/PRODUCTION_DEPLOY.md) or YANDEX_TEST_BUILD=1 for a draft-only test zip."
  echo "⚠ DRAFT-TEST build against a temporary tunnel — do not send it to moderation"
fi

npx vite build >/dev/null
OUT=dist/yandex
ZIP=dist/yandex-game.zip
[ "$TEST" = 1 ] && ZIP=dist/yandex-game.DRAFT-TEST.zip
rm -rf "$OUT" "$ZIP"
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
if [ "$TEST" != 1 ] && grep -rl 'trycloudflare' "$OUT" >/dev/null; then echo "✗ temporary tunnel URL baked into the bundle"; fail=1; fi
if grep -rlE 'BEGIN (RSA |EC )?PRIVATE KEY|ghp_[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}' "$OUT" >/dev/null; then echo "✗ secret-looking string in the bundle"; fail=1; fi
if grep -q 'src="/' "$OUT/index.html" && grep -o 'src="/[^"]*"' "$OUT/index.html" | grep -v '/sdk.js' >/dev/null; then echo "✗ absolute asset path in index.html"; fail=1; fi
size_kb=$(du -sk "$OUT" | cut -f1)
[ "$size_kb" -le 102400 ] || { echo "✗ unpacked size ${size_kb} KB > 100 MB"; fail=1; }
[ $fail = 0 ] || exit 1

Z=$(basename "$ZIP")
if command -v zip >/dev/null; then (cd "$OUT" && zip -qr -X "../$Z" .); else (cd "$OUT" && python3 -m zipfile -c "../$Z" ./*); fi
echo "✓ $ZIP  ($(du -k "$ZIP" | cut -f1) KB zipped, ${size_kb} KB unpacked)"
echo "  backend: $VITE_WS_URL   → add host '$host' in the console CSP tab"
