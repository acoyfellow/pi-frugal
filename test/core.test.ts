import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comparePrompts,
  judgeBashCommand,
  longestSleepSeconds,
  parseMetricsLines,
  reportMetrics,
  shouldCompactOnResume,
  snapshotPrompt,
  summarizeRun,
  type TurnUsage,
} from "../src/core.ts";

const MINUTE = 60_000;
const counters = { blockedSleeps: 0, compactions: 0, promptChanges: 0 };

function turn(cacheRead: number, cacheWrite: number, cost = 0.01): TurnUsage {
  return { input: 10, output: 100, cacheRead, cacheWrite, cost };
}

test("compact on resume needs idle time and a large context", () => {
  const now = 100 * MINUTE;
  assert.equal(shouldCompactOnResume({ nowMs: now, lastAssistantMs: now - 6 * MINUTE, contextTokens: 150_000 }), true);
  assert.equal(shouldCompactOnResume({ nowMs: now, lastAssistantMs: now - 4 * MINUTE, contextTokens: 150_000 }), false);
  assert.equal(shouldCompactOnResume({ nowMs: now, lastAssistantMs: now - 60 * MINUTE, contextTokens: 90_000 }), false);
  assert.equal(shouldCompactOnResume({ nowMs: now, lastAssistantMs: undefined, contextTokens: 150_000 }), false);
  assert.equal(shouldCompactOnResume({ nowMs: now, lastAssistantMs: 0, contextTokens: null }), false);
});

test("sleep longer than five seconds is blocked", () => {
  const verdict = judgeBashCommand("npm run build && sleep 30 && curl localhost");
  assert.equal(verdict.blocked, true);
  assert.match(verdict.reason, /loops_task/);
  assert.match(verdict.reason, /notifies on finish/);
  assert.match(verdict.reason, /alarm/);
  assert.equal(judgeBashCommand("sleep 2m").blocked, true);
  assert.equal(longestSleepSeconds("sleep 1; sleep 1.5h"), 5400);
});

test("short sleep and sleep-like words pass", () => {
  assert.equal(judgeBashCommand("sleep 3").blocked, false);
  assert.equal(judgeBashCommand("grep -r sleepy src").blocked, false);
  assert.equal(judgeBashCommand("echo nosleep 60").blocked, false);
  assert.equal(judgeBashCommand("for f in *.ts; do wc -l $f; done").blocked, false);
});

test("poll loops with sleep are blocked at any duration", () => {
  assert.equal(judgeBashCommand("until curl -s localhost:8080; do sleep 1; done").blocked, true);
  assert.equal(judgeBashCommand("while true; do sleep 2; done").blocked, true);
  assert.match(judgeBashCommand("for i in $(seq 10); do sleep 1; done").reason, /for loop/);
});

test("prompt snapshot ignores tool order and reports changes", () => {
  const before = snapshotPrompt("a\nb", ["read", "bash"]);
  assert.equal(comparePrompts(before, snapshotPrompt("a\nb", ["bash", "read"])), undefined);
  const change = comparePrompts(before, snapshotPrompt("a\nc", ["bash", "edit"]));
  assert.ok(change);
  assert.deepEqual(change.toolsAdded, ["edit"]);
  assert.deepEqual(change.toolsRemoved, ["read"]);
  assert.deepEqual(change.linesAdded, ["c"]);
  assert.deepEqual(change.linesRemoved, ["b"]);
});

test("run summary counts breaks, big turns and cost", () => {
  const run = summarizeRun("s1", "t", turn(150_000, 1_000), [turn(1_000, 160_000), turn(161_000, 50_000, 0.5)], counters);
  assert.equal(run.turns, 2);
  assert.equal(run.breaks, 1);
  assert.equal(run.newRunBreak, true);
  assert.equal(run.turnsOver200k, 1);
  assert.equal(run.maxContext, 211_010);
  assert.equal(run.cost, 0.51);
  const warm = summarizeRun("s1", "t", turn(150_000, 1_000), [turn(150_000, 2_000)], counters);
  assert.equal(warm.newRunBreak, false);
  assert.equal(summarizeRun("s1", "t", undefined, [turn(0, 120_000)], counters).breaks, 0);
});

test("metrics report sums runs and ignores foreign lines", () => {
  const lines = [
    JSON.stringify(summarizeRun("a", "t", turn(150_000, 0), [turn(0, 150_000)], { ...counters, blockedSleeps: 2 })),
    JSON.stringify({ other: true }),
    JSON.stringify(summarizeRun("b", "t", undefined, [turn(0, 1_000)], counters)),
    "",
  ].join("\n");
  const report = reportMetrics(parseMetricsLines(lines));
  assert.equal(report.runs, 2);
  assert.equal(report.newRunBreaks, 1);
  assert.equal(report.newRunBreakRate, 0.5);
  assert.equal(report.blockedSleeps, 2);
  assert.equal(report.turnsOver200k, 0);
});
