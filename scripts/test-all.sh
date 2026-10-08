#!/usr/bin/env bash
# Full regression: typecheck + all multiplayer e2e against a DEV server.
#   WS_URL=ws://<public-ip>:3041/ws bash scripts/test-all.sh [--quick]
set -uo pipefail
: "${WS_URL:=ws://localhost:3041/ws}"
export WS_URL
fail=0
run() { echo "── $1"; shift; if "$@" > /tmp/bt-test.log 2>&1; then tail -1 /tmp/bt-test.log; else cat /tmp/bt-test.log | tail -15; fail=1; fi; }
run "typecheck" npx tsc --noEmit -p .
run "e2e (0ms)" npx tsx scripts/e2e.ts
run "e2e (150ms)" env LATENCY=150 npx tsx scripts/e2e.ts
run "coop-e2e" npx tsx scripts/coop-e2e.ts
for f in scripts/*-e2e.ts; do
  case "$f" in scripts/coop-e2e.ts|scripts/grace-e2e.ts) continue;; esac
  run "$(basename "$f")" npx tsx "$f"
done
if [ "${1:-}" != "--quick" ]; then run "grace-e2e (45s)" npx tsx scripts/grace-e2e.ts; fi
[ $fail = 0 ] && echo "ALL GREEN" || { echo "REGRESSION!"; exit 1; }
