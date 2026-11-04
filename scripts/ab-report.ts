import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Row {
  sessionId: string;
  endedAt: string;
  arm?: string;
  turns: number;
  cost: number;
  cacheRead: number;
  cacheWrite: number;
  spills?: number;
  toolErrors?: number;
}

interface ArmSummary {
  arm: string;
  sessions: number;
  runs: number;
  turns: number;
  cost: number;
  costPerTurn: number;
  cacheHitPct: number;
  spills: number;
  toolErrorsPerTurn: number;
}

const dir = process.env.PI_FRUGAL_DIR ?? join(homedir(), ".pi", "agent", "frugal");
const sinceArg = process.argv.find((arg) => arg.startsWith("--since="));
const since = sinceArg ? sinceArg.slice(8) : "";
const asJson = process.argv.includes("--json");

const rows: Row[] = readFileSync(join(dir, "metrics.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line) as Row];
    } catch {
      return [];
    }
  })
  .filter((row) => row.arm && row.endedAt >= since && row.turns > 0);

function summarize(arm: string): ArmSummary {
  const armRows = rows.filter((row) => row.arm === arm);
  const turns = armRows.reduce((sum, row) => sum + row.turns, 0);
  const cost = armRows.reduce((sum, row) => sum + row.cost, 0);
  const read = armRows.reduce((sum, row) => sum + row.cacheRead, 0);
  const write = armRows.reduce((sum, row) => sum + row.cacheWrite, 0);
  const errors = armRows.reduce((sum, row) => sum + (row.toolErrors ?? 0), 0);
  return {
    arm,
    sessions: new Set(armRows.map((row) => row.sessionId)).size,
    runs: armRows.length,
    turns,
    cost: Math.round(cost * 100) / 100,
    costPerTurn: turns ? Math.round((cost / turns) * 10000) / 10000 : 0,
    cacheHitPct: read + write ? Math.round((100 * read) / (read + write)) : 0,
    spills: armRows.reduce((sum, row) => sum + (row.spills ?? 0), 0),
    toolErrorsPerTurn: turns ? Math.round((errors / turns) * 1000) / 1000 : 0,
  };
}

const on = summarize("on");
const off = summarize("off");
const savingPct = off.costPerTurn ? Math.round((100 * (off.costPerTurn - on.costPerTurn)) / off.costPerTurn) : 0;
const enough = on.sessions >= 20 && off.sessions >= 20 && on.turns >= 500 && off.turns >= 500;
const result = { since, on, off, savingPct, enough };

if (asJson) console.log(JSON.stringify(result));
else {
  console.log("arm  sessions  turns   cost$   $/turn   cacheHit%  spills  errors/turn");
  for (const s of [on, off]) {
    console.log(
      `${s.arm.padEnd(4)} ${String(s.sessions).padStart(8)} ${String(s.turns).padStart(6)} ${s.cost.toFixed(2).padStart(7)} ${s.costPerTurn.toFixed(4).padStart(8)} ${String(s.cacheHitPct).padStart(10)} ${String(s.spills).padStart(7)} ${s.toolErrorsPerTurn.toFixed(3).padStart(12)}`,
    );
  }
  console.log(`saving per turn: ${savingPct}% ${enough ? "" : "(not enough data yet: need 20 sessions and 500 turns per arm)"}`);
}
