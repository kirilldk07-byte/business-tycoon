#!/usr/bin/env bash
# Build the client with the production WS URL and zip it for Yandex Games upload.
#   VITE_WS_URL=wss://tycoon.example.com/ws bash scripts/pack-yandex.sh
set -euo pipefail
: "${VITE_WS_URL:?set VITE_WS_URL=wss://your-domain/ws}"
npx vite build
rm -f dist/yandex-game.zip
if command -v zip >/dev/null; then (cd dist/client && zip -qr ../yandex-game.zip .); else (cd dist/client && python3 -m zipfile -c ../yandex-game.zip *); fi
echo "dist/yandex-game.zip ready (index.html at archive root). WS: $VITE_WS_URL"
