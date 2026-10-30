#!/usr/bin/env bash
export PATH="$(dirname "$(command -v node)"):$PATH"
cd "$(dirname "$0")"
for cfg in 4:5 4:15 4.5:10 3:10; do
  IFS=: read -r every idle <<<"$cfg"
  TUNE_SPILL=10000,1600 TUNE_WARM_EVERY_MIN=$every TUNE_WARM_MAX_IDLE_MIN=$idle node --experimental-strip-types proof/eval.ts proof/eval-set.json "eval-r7-every${every}-idle${idle}.json" >/dev/null && echo "done $cfg"
done
echo SWEEP DONE
