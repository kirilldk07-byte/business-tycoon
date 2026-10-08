#!/usr/bin/env bash
# Build the client and publish it to the gh-pages branch (GitHub Pages).
#   WS_URL=wss://your-server/ws bash scripts/deploy-pages.sh
# The WebSocket URL goes into config.json (read at runtime), so changing the
# server address only needs a re-run of this script — no code changes.
set -euo pipefail
: "${WS_URL:?set WS_URL=wss://.../ws}"
cd "$(dirname "$0")/.."
npx vite build >/dev/null
TMP=$(mktemp -d)
cp -r dist/client/. "$TMP"
printf '{ "wsUrl": "%s" }\n' "$WS_URL" > "$TMP/config.json"
touch "$TMP/.nojekyll"
REMOTE=$(git remote get-url origin)
(
  cd "$TMP"
  git init -q -b gh-pages
  git add -A
  git -c user.name="$(git -C "$OLDPWD" config user.name)" -c user.email="$(git -C "$OLDPWD" config user.email)" commit -qm "Deploy client ($WS_URL)"
  git push -qf "$REMOTE" gh-pages
)
rm -rf "$TMP"
echo "Published to gh-pages with wsUrl=$WS_URL"
