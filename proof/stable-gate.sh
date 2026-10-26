#!/usr/bin/env bash
set -euo pipefail
export PATH=/Users/jcoeyman/.nvm/versions/node/v22.22.2/bin:/Users/jcoeyman/.bun/bin:$PATH
root="$(cd "$(dirname "$0")/.." && pwd)"
comments=/Users/jcoeyman/.pi/agent/extensions/no-added-comments
terraloop=/Users/jcoeyman/cloudflare/terraloop-mode

echo "== 1. no-added-comments tests"
(cd "$comments" && bun test)

echo "== 2. terraloop-mode tests"
(cd "$terraloop" && bun test)

echo "== 3. pi-frugal gate"
"$root/proof/gate.sh"

echo "== 4. two runs in one session keep the prompt stable"
work=$(mktemp -d)
export PI_FRUGAL_DIR="$work/frugal"
provider=/Users/jcoeyman/.pi/agent/extensions/opencode-cloudflare/index.ts
run() {
  perl -e 'alarm shift; exec @ARGV' 180 pi -p --no-extensions --session-dir "$work/sessions" -e "$provider" \
    -e "$root/src/extension.ts" -e "$comments/src/extension.ts" -e "$terraloop/extension.ts" \
    "$@" </dev/null >>"$work/pi.out" 2>&1
}
cd "$work"
run "Arm terraloop with terraloop_control action=arm northStar='stability probe'. Then reply ok and stop."
run -c "Run bash: echo one. Reply ok."
run -c "Reply ok."
cat "$work/pi.out"
changes="$PI_FRUGAL_DIR/prompt-changes.jsonl"
touch "$changes"
cat "$changes"
between=$(grep -c '"phase":"between-runs"' "$changes" || true)
runs=$(wc -l <"$PI_FRUGAL_DIR/metrics.jsonl")
echo "runs=$runs between-run prompt changes=$between"
test "$runs" -ge 3 || { echo "FAIL: expected 3 runs"; exit 1; }
test "$between" -eq 0 || { echo "FAIL: prompt changed between runs"; exit 1; }
hashes=$(grep -o '"toHash":"[0-9a-f]*"' "$changes" | tail -2 | sort -u | wc -l | tr -d ' ')
echo "distinct prompt hashes in runs 2 and 3 after arming: $hashes"
test "$hashes" -le 1 || { echo "FAIL: armed prompt differs across runs"; exit 1; }
echo "STABLE GATE PASS"
