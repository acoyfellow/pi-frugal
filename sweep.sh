#!/usr/bin/env bash
export PATH=/Users/jcoeyman/.nvm/versions/node/v22.22.2/bin:$PATH
cd "$(dirname "$0")"
for at in 300000 200000 150000; do
  TUNE_SPILL=10000,1600 TUNE_COMPACT_AT=$at node --experimental-strip-types proof/eval.ts proof/eval-set.json "eval-r5-at$at.json" >/dev/null && echo "done at$at"
done
echo SWEEP DONE
