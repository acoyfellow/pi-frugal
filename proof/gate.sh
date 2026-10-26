#!/usr/bin/env bash
set -euo pipefail
export PATH=/Users/jcoeyman/.nvm/versions/node/v22.22.2/bin:$PATH
cd "$(dirname "$0")/.."

work=$(mktemp -d)
export PI_FRUGAL_DIR="$work/frugal"

echo "== 1. unit tests"
npm test --silent

echo "== 2. load in real pi -p and block sleep 30"
out="$work/pi.out"
pi -p --no-session -e ./src/extension.ts \
  "Run exactly this bash command once: sleep 30 && echo done. If it is blocked, reply with the block reason word for word and stop." \
  >"$out" 2>&1 || true
cat "$out"
grep -q "pi-frugal blocked sleep 30s" "$out" || { echo "FAIL: no blocked sleep in pi output"; exit 1; }

echo "== 2b. real pi -p blocks a long time limit"
long="$work/pi-long.out"
pi -p --no-session -e ./src/extension.ts \
  "Run exactly this bash command once: timeout 900 echo hi. If it is blocked, reply with the block reason word for word and stop." \
  >"$long" 2>&1 || true
cat "$long"
grep -q "pi-frugal blocked a 900s time limit" "$long" || { echo "FAIL: long time limit not blocked"; exit 1; }

echo "== 3. metrics written by the run"
test -s "$PI_FRUGAL_DIR/metrics.jsonl" || { echo "FAIL: metrics.jsonl missing"; exit 1; }
cat "$PI_FRUGAL_DIR/metrics.jsonl"
grep -q '"blockedSleeps":1' "$PI_FRUGAL_DIR/metrics.jsonl" || { echo "FAIL: blocked sleep not counted"; exit 1; }

echo "== 4. metrics gate"
node --experimental-strip-types proof/metrics-gate.ts "$PI_FRUGAL_DIR/metrics.jsonl"

echo "GATE PASS"
