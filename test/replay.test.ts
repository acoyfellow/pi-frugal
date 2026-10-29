import { test } from "node:test";
import assert from "node:assert/strict";
import { FIVE_MINUTE_POLICY, ONE_HOUR_POLICY, derivePrices, replaySession, sumScores, type ReplayTurn } from "../src/replay.ts";

const MINUTE = 60_000;
const prices = new Map([["m", { inputPerToken: 1, outputPerToken: 5 }]]);

function turn(atMinute: number, context: number, output = 0): ReplayTurn {
  return { atMs: atMinute * MINUTE, model: "m", input: 0, cacheRead: 0, cacheWrite: context, output, recordedCost: 1 };
}

test("a warm turn reads the previous context and writes only the new part", () => {
  const score = replaySession([turn(0, 100), turn(1, 150)], prices, FIVE_MINUTE_POLICY);
  assert.equal(score.cost, 100 * 1.25 + 100 * 0.1 + 50 * 1.25);
  assert.equal(score.cacheBreaks, 0);
});

test("a gap past the time to live is a cache break and rewrites everything", () => {
  const score = replaySession([turn(0, 100), turn(10, 150)], prices, FIVE_MINUTE_POLICY);
  assert.equal(score.cost, 100 * 1.25 + 150 * 1.25);
  assert.equal(score.cacheBreaks, 1);
});

test("one-hour retention costs more per write but survives a ten-minute gap", () => {
  const turns = [turn(0, 100_000), turn(10, 100_000), turn(20, 100_000)];
  const short = replaySession(turns, prices, FIVE_MINUTE_POLICY);
  const long = replaySession(turns, prices, ONE_HOUR_POLICY);
  assert.equal(short.cacheBreaks, 2);
  assert.equal(long.cacheBreaks, 0);
  assert.ok(long.cost < short.cost);
});

test("one-hour retention loses when every turn is back to back", () => {
  const turns = [turn(0, 100_000), turn(1, 100_000), turn(2, 100_000)];
  assert.ok(replaySession(turns, prices, ONE_HOUR_POLICY).cost > replaySession(turns, prices, FIVE_MINUTE_POLICY).cost);
});

test("a shrunk context after compaction reads only what is still cached", () => {
  const score = replaySession([turn(0, 300), turn(1, 100)], prices, FIVE_MINUTE_POLICY);
  assert.equal(score.cost, 300 * 1.25 + 100 * 0.1);
});

test("a model switch is a cache break", () => {
  const other = { ...turn(1, 100), model: "n" };
  const both = new Map([...prices, ["n", { inputPerToken: 1, outputPerToken: 5 }]]);
  assert.equal(replaySession([turn(0, 100), other], both, FIVE_MINUTE_POLICY).cacheBreaks, 1);
});

test("unknown models keep their recorded cost", () => {
  const score = replaySession([{ ...turn(0, 100), model: "x", recordedCost: 7 }], prices, FIVE_MINUTE_POLICY);
  assert.equal(score.cost, 7);
});

test("totals add sessions and prices come from real token costs", () => {
  const a = replaySession([turn(0, 100)], prices, FIVE_MINUTE_POLICY);
  assert.equal(sumScores("all", [a, a]).cost, 2 * a.cost);
  const derived = derivePrices([{ model: "m", input: 1000, output: 200, inputCost: 0.004, outputCost: 0.004 }]);
  assert.deepEqual(derived.get("m"), { inputPerToken: 0.000004, outputPerToken: 0.00002 });
});
