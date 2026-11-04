import { test } from "node:test";
import assert from "node:assert/strict";
import { armForSession, parseAbConfig, spillForArm } from "../src/ab.ts";

test("arm is stable for a session id", () => {
  assert.equal(armForSession("01a19ccb-b18f"), armForSession("01a19ccb-b18f"));
});

test("arms split roughly in half", () => {
  let on = 0;
  for (let index = 0; index < 2000; index++) if (armForSession(`session-${index}-${index * 7919}`) === "on") on++;
  assert.ok(on > 900 && on < 1100, `on=${on}`);
});

test("ab config needs a valid spill setting", () => {
  assert.deepEqual(parseAbConfig({ ab: { spill: "10000,1600" } }), { spill: { thresholdChars: 10_000, stubChars: 1_600 } });
  assert.equal(parseAbConfig({ ab: { spill: "bad" } }), undefined);
  assert.equal(parseAbConfig({}), undefined);
  assert.equal(parseAbConfig(null), undefined);
});

test("fixed env setting wins, otherwise only the on arm spills", () => {
  const ab = { spill: { thresholdChars: 10_000, stubChars: 1_600 } };
  const fixed = { thresholdChars: 20_000, stubChars: 1_600 };
  assert.deepEqual(spillForArm(fixed, ab, "off"), fixed);
  assert.deepEqual(spillForArm(undefined, ab, "on"), ab.spill);
  assert.equal(spillForArm(undefined, ab, "off"), undefined);
  assert.equal(spillForArm(undefined, undefined, "on"), undefined);
});
