import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpillConfig, spillStub } from "../src/spill.ts";

const configCases: readonly { value: string | undefined; expected: ReturnType<typeof parseSpillConfig>; why: string }[] = [
  { value: "20000,1600", expected: { thresholdChars: 20_000, stubChars: 1_600 }, why: "normal" },
  { value: undefined, expected: undefined, why: "unset means off" },
  { value: "", expected: undefined, why: "empty means off" },
  { value: "abc", expected: undefined, why: "garbage means off" },
  { value: "1000,2000", expected: undefined, why: "stub larger than threshold" },
  { value: "0,10", expected: undefined, why: "zero threshold" },
  { value: "5000,0", expected: { thresholdChars: 5_000, stubChars: 0 }, why: "a bare note is allowed" },
];

test("spill config follows the case table", () => {
  for (const { value, expected, why } of configCases) assert.deepEqual(parseSpillConfig(value), expected, why);
});

test("output at or under the threshold is untouched", () => {
  const text = "x".repeat(100);
  assert.deepEqual(spillStub(text, { thresholdChars: 100, stubChars: 10 }, "/p"), { spill: false, stub: text });
});

test("large output keeps its head and tail and names the file", () => {
  const text = `HEAD${"m".repeat(10_000)}TAIL`;
  const { spill, stub } = spillStub(text, { thresholdChars: 1_000, stubChars: 400 }, "/tmp/spill/a.txt");
  assert.equal(spill, true);
  assert.ok(stub.startsWith("HEAD"));
  assert.ok(stub.endsWith("TAIL"));
  assert.match(stub, /\/tmp\/spill\/a\.txt/);
  assert.match(stub, /read tool/);
  assert.match(stub, /9608 chars/);
  assert.ok(stub.length < 700);
});
