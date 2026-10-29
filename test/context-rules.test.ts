import { test } from "node:test";
import assert from "node:assert/strict";
import { applySpill, spillCount, spilledTokens, type SessionEvent } from "../src/context-rules.ts";
import type { ReplayTurn } from "../src/replay.ts";

const rule = { thresholdChars: 20_000, stubChars: 400 };

function turn(context: number): SessionEvent {
  const recorded: ReplayTurn = { atMs: 0, model: "m", input: 10, cacheRead: context - 10, cacheWrite: 0, output: 5, recordedCost: 1 };
  return { kind: "turn", turn: recorded };
}

function contexts(events: readonly SessionEvent[], spill: typeof rule | null = rule): number[] {
  return applySpill(events, spill ?? undefined).map((t) => t.input + t.cacheRead + t.cacheWrite);
}

const spillCases: readonly { chars: number; tokens: number; why: string }[] = [
  { chars: 20_000, tokens: 0, why: "at the threshold stays inline" },
  { chars: 20_400, tokens: 5_000, why: "just over spills all but the stub" },
  { chars: 400_400, tokens: 100_000, why: "a huge log spills" },
  { chars: 500, tokens: 0, why: "small output stays inline" },
];

test("spilled tokens follow the case table", () => {
  for (const { chars, tokens, why } of spillCases) assert.equal(spilledTokens(chars, rule), tokens, why);
  assert.equal(spilledTokens(400_400, undefined), 0);
});

test("a spill shrinks every later turn, not earlier ones", () => {
  const events: SessionEvent[] = [turn(50_000), { kind: "tool-result", chars: 40_400, images: 0 }, turn(70_000), turn(71_000)];
  assert.deepEqual(contexts(events), [50_000, 60_000, 61_000]);
});

test("compaction ends the saving because the output is already gone", () => {
  const events: SessionEvent[] = [{ kind: "tool-result", chars: 40_400, images: 0 }, turn(70_000), { kind: "compaction" }, turn(30_000)];
  assert.deepEqual(contexts(events), [60_000, 30_000]);
});

test("no rule keeps the recorded context and the turn order", () => {
  const events: SessionEvent[] = [turn(10_000), { kind: "tool-result", chars: 90_000, images: 0 }, turn(40_000)];
  assert.deepEqual(contexts(events, null), [10_000, 40_000]);
  assert.equal(spillCount(events, rule), 1);
  assert.equal(spillCount(events, undefined), 0);
});

test("context never goes below zero", () => {
  assert.deepEqual(contexts([{ kind: "tool-result", chars: 400_400, images: 0 }, turn(1_000)]), [0]);
});

test("image bytes are never counted as spillable text", () => {
  const screenshot: SessionEvent = { kind: "tool-result", chars: 400, images: 1 };
  assert.deepEqual(contexts([screenshot, turn(5_000)]), [5_000]);
  assert.equal(spillCount([screenshot], rule), 0);
});
