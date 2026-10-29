import { test } from "node:test";
import assert from "node:assert/strict";
import { FIVE_MINUTE_POLICY, ONE_HOUR_POLICY, derivePricesFromCostParts, insertKeepWarmPings, replaySession, sumScores, type PricedTurn, type ReplayTurn } from "../src/replay.ts";

const MINUTE = 60_000;
const unitPrice = { inputPerToken: 1, outputPerToken: 5, readPerToken: 0.1, writePerToken: 1.25 };
const prices = new Map([["m", unitPrice]]);

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

test("an edit inside the warm prefix rewrites everything after it", () => {
  const turns = [turn(0, 100), turn(1, 150)];
  const intact = replaySession(turns, prices, FIVE_MINUTE_POLICY);
  const edited = replaySession(turns, prices, FIVE_MINUTE_POLICY, [undefined, 40]);
  assert.equal(edited.cost, 100 * 1.25 + 40 * 0.1 + 110 * 1.25);
  assert.ok(edited.cost > intact.cost);
});

test("a model switch is a cache break", () => {
  const other = { ...turn(1, 100), model: "n" };
  const both = new Map([...prices, ["n", unitPrice]]);
  assert.equal(replaySession([turn(0, 100), other], both, FIVE_MINUTE_POLICY).cacheBreaks, 1);
});

test("unknown models keep their recorded cost", () => {
  const score = replaySession([{ ...turn(0, 100), model: "x", recordedCost: 7 }], prices, FIVE_MINUTE_POLICY);
  assert.equal(score.cost, 7);
});

test("totals add sessions and prices come from real token costs", () => {
  const a = replaySession([turn(0, 100)], prices, FIVE_MINUTE_POLICY);
  assert.equal(sumScores("all", [a, a]).cost, 2 * a.cost);
});

function priced(parts: Partial<PricedTurn>): PricedTurn {
  return { model: "m", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, inputCost: 0, outputCost: 0, readCost: 0, writeCost: 0, ...parts };
}

test("prices come from each recorded cost part", () => {
  const derived = derivePricesFromCostParts([
    priced({ input: 1000, inputCost: 0.004, output: 200, outputCost: 0.004, cacheRead: 10_000, readCost: 0.002, cacheWrite: 1000, writeCost: 0.005 }),
  ]);
  assert.deepEqual(derived.get("m"), { inputPerToken: 0.000004, outputPerToken: 0.00002, readPerToken: 0.0000002, writePerToken: 0.000005 });
});

test("a cache-heavy model with tiny uncached input is still priced", () => {
  const derived = derivePricesFromCostParts([
    priced({ model: "opus", input: 4, inputCost: 0.000016, output: 196, outputCost: 0.00392, cacheWrite: 24_772, writeCost: 0.12386 }),
    priced({ model: "opus", input: 3, output: 300, outputCost: 0.006, cacheRead: 50_000, readCost: 0.01 }),
  ]);
  const opus = derived.get("opus");
  assert.ok(opus);
  assert.ok(Math.abs(opus.writePerToken - 0.000005) < 1e-12, `write ${opus.writePerToken}`);
  assert.equal(opus.readPerToken, 0.0000002);
  assert.equal(opus.inputPerToken, 0.000004);
});

test("a model with no output sample stays unpriced", () => {
  assert.equal(derivePricesFromCostParts([priced({ input: 1000, inputCost: 0.004 })]).size, 0);
});

test("keep-warm pings fill an idle gap up to the idle limit", () => {
  const rule = { pingEveryMs: 4 * MINUTE, maxIdleMs: 30 * MINUTE };
  assert.deepEqual(insertKeepWarmPings([turn(0, 100), turn(13, 100)], rule).map((t) => t.atMs / MINUTE), [0, 4, 8, 12, 13]);
  assert.equal(insertKeepWarmPings([turn(0, 100), turn(120, 100)], rule).length, 2 + 7);
  assert.equal(insertKeepWarmPings([turn(0, 100), turn(3, 100)], rule).length, 2);
  assert.equal(insertKeepWarmPings([turn(0, 100), turn(13, 100)], undefined).length, 2);
});

test("pings turn a short idle gap from a cache break into cheap reads", () => {
  const rule = { pingEveryMs: 4 * MINUTE, maxIdleMs: 30 * MINUTE };
  const turns = [turn(0, 100_000), turn(13, 100_000)];
  const plain = replaySession(turns, prices, FIVE_MINUTE_POLICY);
  const warm = replaySession(insertKeepWarmPings(turns, rule), prices, FIVE_MINUTE_POLICY);
  assert.equal(plain.cacheBreaks, 1);
  assert.equal(warm.cacheBreaks, 0);
  assert.ok(warm.cost < plain.cost);
});

test("pings that run out before the user returns only add cost", () => {
  const rule = { pingEveryMs: 4 * MINUTE, maxIdleMs: 30 * MINUTE };
  const turns = [turn(0, 100_000), turn(120, 100_000)];
  assert.ok(replaySession(insertKeepWarmPings(turns, rule), prices, FIVE_MINUTE_POLICY).cost > replaySession(turns, prices, FIVE_MINUTE_POLICY).cost);
});
