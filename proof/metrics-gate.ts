import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseMetricsLines, reportMetrics } from "../src/core.ts";

const BASELINE_NEW_RUN_BREAK_RATE = 0.2;
const file = process.argv[2] ?? join(process.env.PI_FRUGAL_DIR ?? join(homedir(), ".pi", "agent", "frugal"), "metrics.jsonl");
const report = reportMetrics(parseMetricsLines(readFileSync(file, "utf8")));

console.log(`metrics file: ${file}`);
console.log(JSON.stringify(report, null, 2));
console.log(`turns > 200k: ${report.turnsOver200k}`);
console.log(`new-run cache break rate: ${(report.newRunBreakRate * 100).toFixed(1)}% (baseline ${BASELINE_NEW_RUN_BREAK_RATE * 100}%)`);

if (report.runs === 0) {
  console.error("FAIL: no runs recorded");
  process.exit(1);
}
if (report.turnsOver200k > 0) {
  console.error("FAIL: turns over 200k context found");
  process.exit(1);
}
console.log("PASS");
