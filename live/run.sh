#!/usr/bin/env bash
set -uo pipefail
export PATH=/Users/jcoeyman/.nvm/versions/node/v22.22.2/bin:$PATH
root="$(cd "$(dirname "$0")/.." && pwd)"
label="$1"
spill="${2:-}"
out="$root/live/out-$label"
rm -rf "$out"
mkdir -p "$out"
provider=/Users/jcoeyman/.pi/agent/extensions/opencode-cloudflare/index.ts
count=$(node -e 'console.log(require(process.argv[1]).length)' "$root/live/tasks.json")
for index in $(seq 0 $((count - 1))); do
  id=$(node -e 'console.log(require(process.argv[1])[process.argv[2]].id)' "$root/live/tasks.json" "$index")
  prompt=$(node -e 'console.log(require(process.argv[1])[process.argv[2]].prompt)' "$root/live/tasks.json" "$index")
  start=$(date +%s)
  (
    cd "$root"
    PI_FRUGAL_DIR="$out/frugal-$id" PI_FRUGAL_SPILL="$spill" perl -e 'alarm shift; exec @ARGV' 100 \
      pi -p --no-extensions --session-dir "$out/sessions-$id" -e "$provider" -e "$root/src/extension.ts" \
      --model claude-opus-5-5 "$prompt" </dev/null >"$out/$id.txt" 2>&1
  )
  echo "$id $(( $(date +%s) - start ))" >>"$out/times.txt"
done
node "$root/live/score.mjs" "$out" "$label" "$spill"
