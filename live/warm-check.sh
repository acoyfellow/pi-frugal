#!/usr/bin/env bash
set -uo pipefail
export PATH="$(dirname "$(command -v node)"):$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/live/out-warm"
rm -rf "$out"
mkdir -p "$out"
provider="${PI_PROVIDER_EXTENSION:?set PI_PROVIDER_EXTENSION to your model provider extension}"

run_id=$(date +%s)
for arm in pinged control; do
  node -e 'const [arm, id] = process.argv.slice(1); const facts = Array.from({ length: 2600 }, (_, i) => `Fact ${i}: code ${arm}-${id}-${(i * 7919) % 100003}.`); console.log(`Reference notes for ${arm} ${id}. ${facts.join(" ")}`)' "$arm" "$run_id" >"$out/pad-$arm.txt"
done

turn() {
  local arm="$1"
  shift
  (cd "$root" && pi -p --no-extensions --session-dir "$out/sessions-$arm" -e "$provider" --model claude-opus-5-5 --system-prompt "$(cat "$out/pad-$arm.txt")" "$@" </dev/null >>"$out/$arm.txt" 2>&1)
  echo "$arm $(date +%s) $*" >>"$out/steps.txt"
}

turn pinged "Reply with the word ready."
turn control "Reply with the word ready."
sleep 220
turn pinged -c "Reply with the word ok."
sleep 220
turn pinged -c "Reply with the word ok."
sleep 220
turn pinged -c "Reply with the word done."
turn control -c "Reply with the word done."
node "$root/live/warm-score.mjs" "$out"
