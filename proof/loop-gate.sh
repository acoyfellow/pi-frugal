#!/usr/bin/env bash
set -euo pipefail
export PATH=/Users/jcoeyman/.nvm/versions/node/v22.22.2/bin:$PATH
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
results="$root/results.jsonl"
mode="${1:-}"

echo "== 1. unit tests"
npm test --silent >/dev/null && echo "unit tests pass"

echo "== 2. offline replay"
node --experimental-strip-types proof/eval.ts proof/eval-set.json eval.json >/dev/null
node -e '
const r = require("./eval.json");
if (r.sessions < 6) { console.log("FAIL: only " + r.sessions + " sessions in the eval set"); process.exit(1); }
for (const s of r.scores) console.log(s.policy, "cost=$" + s.cost.toFixed(2), "recorded=$" + s.recordedCost.toFixed(2), "breaks=" + s.cacheBreaks, "medianCtx=" + s.medianContext, "p95Ctx=" + s.p95Context);
console.log("sessions", r.sessions, JSON.stringify(r.kinds));
'

echo "== 3. results ledger"
touch "$results"
node -e '
const fs = require("fs");
const rows = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const baseline = rows.find((r) => r.kind === "baseline");
const attempts = rows.filter((r) => r.kind === "attempt");
const kept = attempts.filter((r) => r.kept);
let streak = 0;
for (const r of [...attempts].reverse()) { if (r.kept) break; streak++; }
const spent = attempts.reduce((s, r) => s + (r.liveCost ?? 0), 0);
const budget = Number(process.env.TUNE_BUDGET ?? 15);
const ageDays = baseline ? (Date.now() - Date.parse(baseline.at)) / 86400000 : 0;
console.log("baseline", baseline ? "$" + baseline.offlineCost.toFixed(2) : "none", "attempts", attempts.length, "kept", kept.length, "noGainStreak", streak, "liveSpent $" + spent.toFixed(2) + "/" + budget, "days", ageDays.toFixed(1));
for (const r of kept) {
  if (!baseline || r.offlineCost >= baseline.offlineCost) { console.log("FAIL: kept change does not beat baseline:", r.change); process.exit(1); }
  if (r.livePass !== undefined && baseline.livePass !== undefined && r.livePass < baseline.livePass) { console.log("FAIL: kept change lowers live pass rate:", r.change); process.exit(1); }
}
const stop = streak >= 5 || spent >= budget || ageDays >= 3;
if (process.argv[2] === "--dry-run") { console.log("DRY RUN: stop condition " + (stop ? "met" : "not met")); process.exit(0); }
if (!stop) { console.log("NOT DONE: no stop condition met (5 no-gain attempts, budget, or 3 days)"); process.exit(1); }
console.log("stop condition met");
' "$results" "$mode"

echo "LOOP GATE PASS"
