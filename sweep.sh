#!/usr/bin/env bash
export PATH=/Users/jcoeyman/.nvm/versions/node/v22.22.2/bin:$PATH
cd "$(dirname "$0")"
for idle in 10 20 40; do
  TUNE_SPILL=10000,1600 TUNE_WARM_MAX_IDLE_MIN=$idle node --experimental-strip-types proof/eval.ts proof/eval-set.json "eval-r6-warm$idle.json" >/dev/null && echo "done warm$idle"
done
echo SWEEP DONE
