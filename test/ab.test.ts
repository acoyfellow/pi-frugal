import { test } from "node:test";
import assert from "node:assert/strict";
import { armForSession, parseAbConfig, readAfterTurn, readCompactAb, readFixedSpill, shouldCompactAfterRun, spillForArm, parseCompactAb } from "../src/ab.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

test("afterTurn command is read from the top level of config", () => {
  assert.deepEqual(parseAbConfig({ ab: { spill: "10000,1600" }, afterTurn: "echo hi" }), { spill: { thresholdChars: 10_000, stubChars: 1_600 }, afterTurn: "echo hi" });
  assert.deepEqual(parseAbConfig({ ab: { spill: "10000,1600" }, afterTurn: "  " }), { spill: { thresholdChars: 10_000, stubChars: 1_600 } });
});

test("top-level spill in config turns spill on for everyone", () => {
  const dir = mkdtempSync(join(tmpdir(), "frugal-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ spill: "10000,1600" }));
  assert.deepEqual(readFixedSpill(dir), { thresholdChars: 10_000, stubChars: 1_600 });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ ab: { spill: "10000,1600" } }));
  assert.equal(readFixedSpill(dir), undefined);
});

test("afterTurn works without an ab block", () => {
  const dir = mkdtempSync(join(tmpdir(), "frugal-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ spill: "10000,1600", afterTurn: "echo hi" }));
  assert.equal(readAfterTurn(dir), "echo hi");
});

test("compact A/B: only the on arm compacts, and only past the threshold", () => {
  const ab = parseCompactAb({ compactAb: { thresholdTokens: 200_000, since: "2026-11-04T20:30" } });
  assert.deepEqual(ab, { thresholdTokens: 200_000, since: "2026-11-04T20:30" });
  assert.equal(shouldCompactAfterRun(250_000, ab, "on"), true);
  assert.equal(shouldCompactAfterRun(150_000, ab, "on"), false);
  assert.equal(shouldCompactAfterRun(250_000, ab, "off"), false);
  assert.equal(shouldCompactAfterRun(undefined, ab, "on"), false);
  assert.equal(parseCompactAb({ compactAb: { thresholdTokens: 1000, since: "x" } }), undefined);
  const dir = mkdtempSync(join(tmpdir(), "frugal-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ compactAb: { thresholdTokens: 200_000, since: "s" } }));
  assert.deepEqual(readCompactAb(dir), { thresholdTokens: 200_000, since: "s" });
});
