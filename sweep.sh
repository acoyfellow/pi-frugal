#!/usr/bin/env bash
export PATH=/Users/jcoeyman/.nvm/versions/node/v22.22.2/bin:$PATH
cd "$(dirname "$0")"
TUNE_SPILL=10000,1600 node --experimental-strip-types proof/eval.ts proof/eval-set.json eval-r4-spill.json >/dev/null && echo "done spill"
for keep in 1 2 4; do
  TUNE_SPILL=10000,1600 TUNE_DROP_KEEP=$keep node --experimental-strip-types proof/eval.ts proof/eval-set.json "eval-r4-drop$keep.json" >/dev/null && echo "done drop$keep"
done
echo SWEEP DONE
