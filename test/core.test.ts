import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comparePrompts,
  judgeBashCommand,
  judgeLongCommand,
  longestSleepSeconds,
  timeLimitsSeconds,
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

const longCallCases: readonly { command: string; blocked: boolean; why: string }[] = [
  { command: "perl -e 'alarm shift; exec @ARGV' 1500 ./proof/stable-gate.sh", blocked: true, why: "the 25-minute freeze" },
  { command: "perl -e 'alarm shift; exec @ARGV' 90 pi -p hi", blocked: false, why: "perl alarm under the limit" },
  { command: "perl -e 'alarm(600); exec @ARGV' make", blocked: true, why: "literal perl alarm" },
  { command: "timeout 300 npm test", blocked: true, why: "timeout over the limit" },
  { command: "gtimeout 5m bun test", blocked: true, why: "gtimeout with a unit" },
  { command: "timeout -k 5 100 ./gate.sh", blocked: false, why: "limited gate under the limit" },
  { command: "timeout 2h make", blocked: true, why: "timeout in hours" },
  { command: "./proof/gate.sh", blocked: true, why: "proof script, no limit" },
  { command: "cd ~/x && bash gate.sh", blocked: true, why: "gate.sh, no limit" },
  { command: "node scripts/gate.mjs", blocked: true, why: "gate.mjs, no limit" },
  { command: "npx wrangler deploy", blocked: true, why: "wrangler deploy, no limit" },
  { command: "./ship.sh prod", blocked: true, why: "ship.sh, no limit" },
  { command: "npm test", blocked: true, why: "npm test, no limit" },
  { command: "npm run test -- --watch=false", blocked: true, why: "npm run test, no limit" },
  { command: "npx vitest run", blocked: true, why: "vitest without a file" },
  { command: "npx vitest", blocked: true, why: "bare vitest" },
  { command: "npx vitest run src/core.test.ts", blocked: false, why: "vitest with a file" },
  { command: "nohup ./proof/gate.sh > /tmp/gate.log 2>&1 &", blocked: false, why: "background with nohup" },
  { command: "./proof/gate.sh > gate.log 2>&1 &", blocked: false, why: "background job" },
  { command: "./proof/gate.sh # frugal:allow-long", blocked: false, why: "human override marker" },
  { command: "timeout 900 ./ship.sh # frugal:allow-long", blocked: false, why: "marker beats a long limit" },
  { command: "wrangler dev --port 8787 &", blocked: false, why: "backgrounded dev server" },
  { command: "git status && ls", blocked: false, why: "ordinary command" },
  { command: "grep -rn timeout src", blocked: false, why: "timeout as a search word" },
  { command: "./proof/gate.sh && true", blocked: true, why: "&& is not a background job" },
];

test("long tool calls follow the case table", () => {
  for (const { command, blocked, why } of longCallCases) {
    assert.equal(judgeLongCommand(command).blocked, blocked, `${why}: ${command}`);
    assert.equal(judgeBashCommand(command).blocked, blocked, `bash verdict, ${why}: ${command}`);
  }
});

test("long call blocks say how to run it in the background", () => {
  for (const command of ["perl -e 'alarm shift; exec @ARGV' 1500 ./x.sh", "./proof/gate.sh"]) {
    const { reason } = judgeLongCommand(command);
    assert.match(reason, /nohup/);
    assert.match(reason, /> log 2>&1 &/);
    assert.match(reason, /end the turn/);
    assert.match(reason, /loops_task/);
    assert.match(reason, /# frugal:allow-long/);
  }
  assert.match(judgeLongCommand("timeout 300 make").reason, /300s time limit \(max 120s\)/);
  assert.match(judgeLongCommand("npm test").reason, /npm test with no time limit/);
});

test("time limits are read from timeout, gtimeout and perl alarm", () => {
  assert.deepEqual(timeLimitsSeconds("timeout 30s a; gtimeout 2m b"), [30, 120]);
  assert.deepEqual(timeLimitsSeconds("perl -e 'alarm shift; exec @ARGV' 1500 x"), [1500]);
  assert.deepEqual(timeLimitsSeconds("echo hi"), []);
});
