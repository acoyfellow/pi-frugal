import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applySpill, spillCount, type SessionEvent, type SpillRule } from "../src/context-rules.ts";
import { FIVE_MINUTE_POLICY, ONE_HOUR_POLICY, derivePricesFromCostParts, replaySession, sumScores, type PricedTurn, type ReplayTurn } from "../src/replay.ts";

interface RawUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

interface SessionFile {
  path: string;
  turns: ReplayTurn[];
  raw: PricedTurn[];
  events: SessionEvent[];
  kind: "terraloop" | "long" | "short";
}

const sessionsRoot = process.env.PI_SESSIONS_DIR ?? join(homedir(), ".pi/agent/sessions");
const setPath = process.argv[2] ?? join(import.meta.dirname, "eval-set.json");
const outPath = process.argv[3] ?? join(import.meta.dirname, "..", "eval.json");
const perKind = 4;

function listSessionFiles(): string[] {
  return readdirSync(sessionsRoot).flatMap((dir) => {
    const full = join(sessionsRoot, dir);
    if (!statSync(full).isDirectory()) return [];
    return readdirSync(full).filter((name) => name.endsWith(".jsonl")).map((name) => join(full, name));
  });
}

function toolResultEvent(content: unknown): SessionEvent {
  const parts: unknown[] = Array.isArray(content) ? content : [content];
  let chars = 0;
  let images = 0;
  for (const part of parts) {
    if (typeof part === "string") chars += part.length;
    if (typeof part !== "object" || part === null) continue;
    if ("type" in part && part.type === "image") images++;
    else if ("text" in part && typeof part.text === "string") chars += part.text.length;
  }
  return { kind: "tool-result", chars, images };
}

function readSession(path: string): SessionFile {
  const turns: ReplayTurn[] = [];
  const raw: SessionFile["raw"] = [];
  const events: SessionEvent[] = [];
  let terraloop = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length === 0) continue;
    if (!terraloop && line.includes("terraloop_control")) terraloop = true;
    if (line.includes("\"type\":\"compaction\"")) events.push({ kind: "compaction" });
    if (line.includes("\"role\":\"toolResult\"")) {
      const result: unknown = JSON.parse(line);
      if (typeof result === "object" && result !== null && "message" in result && typeof result.message === "object" && result.message !== null && "content" in result.message) {
        events.push(toolResultEvent(result.message.content));
      }
      continue;
    }
    if (!line.includes("\"usage\"")) continue;
    const entry: unknown = JSON.parse(line);
    if (typeof entry !== "object" || entry === null || !("message" in entry)) continue;
    const message = entry.message;
    if (typeof message !== "object" || message === null || !("usage" in message) || !("timestamp" in message)) continue;
    const usage: RawUsage = typeof message.usage === "object" && message.usage !== null ? message.usage : {};
    const model = "model" in message && typeof message.model === "string" ? message.model : "unknown";
    const atMs = typeof message.timestamp === "number" ? message.timestamp : Date.parse(String(message.timestamp));
    const turn: ReplayTurn = {
      atMs,
      model,
      input: usage.input ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      output: usage.output ?? 0,
      recordedCost: usage.cost?.total ?? 0,
    };
    turns.push(turn);
    events.push({ kind: "turn", turn });
    raw.push({
      model,
      input: turn.input,
      output: turn.output,
      cacheRead: turn.cacheRead,
      cacheWrite: turn.cacheWrite,
      inputCost: usage.cost?.input ?? 0,
      outputCost: usage.cost?.output ?? 0,
      readCost: usage.cost?.cacheRead ?? 0,
      writeCost: usage.cost?.cacheWrite ?? 0,
    });
  }
  const kind = terraloop ? "terraloop" : turns.length >= 150 ? "long" : "short";
  return { path, turns, raw, events, kind };
}

function pickSet(): string[] {
  const candidates = listSessionFiles()
    .filter((path) => statSync(path).size > 20_000)
    .map(readSession)
    .filter((session) => session.turns.length >= 10)
    .sort((a, b) => a.path.localeCompare(b.path));
  const picked: string[] = [];
  for (const kind of ["long", "terraloop", "short"] as const) {
    const ofKind = candidates.filter((session) => session.kind === kind);
    const step = Math.max(1, Math.floor(ofKind.length / perKind));
    for (let index = 0; index < ofKind.length && picked.filter((path) => readSession(path).kind === kind).length < perKind; index += step) {
      const session = ofKind[index];
      if (session) picked.push(session.path);
    }
  }
  return picked;
}

const set: string[] = existsSync(setPath) ? JSON.parse(readFileSync(setPath, "utf8")) : pickSet();
if (!existsSync(setPath)) writeFileSync(setPath, `${JSON.stringify(set, null, 2)}\n`);
const sessions = set.filter((path) => existsSync(path)).map(readSession);
const prices = derivePricesFromCostParts(sessions.flatMap((session) => session.raw));
const policies = [FIVE_MINUTE_POLICY, ONE_HOUR_POLICY];

function parseSpill(value: string | undefined): SpillRule | undefined {
  if (!value) return undefined;
  const [threshold, stub] = value.split(",").map(Number);
  return threshold && stub !== undefined ? { thresholdChars: threshold, stubChars: stub } : undefined;
}

const spill = parseSpill(process.env.TUNE_SPILL);
const result = {
  at: new Date().toISOString(),
  sessions: sessions.length,
  missing: set.length - sessions.length,
  kinds: Object.fromEntries(["long", "terraloop", "short"].map((kind) => [kind, sessions.filter((session) => session.kind === kind).length])),
  models: [...prices.keys()],
  unpricedTurns: sessions.reduce((sum, session) => sum + session.turns.filter((turn) => !prices.has(turn.model)).length, 0),
  scores: policies.map((policy) => sumScores(policy.name, sessions.map((session) => replaySession(session.turns, prices, policy)))),
  rule: spill
    ? {
        spill,
        spills: sessions.reduce((sum, session) => sum + spillCount(session.events, spill), 0),
        scores: policies.map((policy) => sumScores(policy.name, sessions.map((session) => replaySession(applySpill(session.events, spill), prices, policy)))),
      }
    : null,
};
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
