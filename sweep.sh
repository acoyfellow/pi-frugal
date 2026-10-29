#!/usr/bin/env bash
export PATH=/Users/jcoeyman/.nvm/versions/node/v22.22.2/bin:$PATH
cd "$(dirname "$0")"
for cfg in 80000,1600 40000,1600 20000,1600 10000,1600; do
  TUNE_SPILL=$cfg node --experimental-strip-types proof/eval.ts proof/eval-set.json "eval-spill-$cfg.json" >/dev/null && echo "done $cfg"
done
echo SWEEP DONE
