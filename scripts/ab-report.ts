import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Row {
  sessionId: string;
  endedAt: string;
  arm?: string;
  compactArm?: string;
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
  medianSessionCostPerTurn: number;
  largestSessionTurnShare: number;
}

const dir = process.env.PI_FRUGAL_DIR ?? join(homedir(), ".pi", "agent", "frugal");
const sinceArg = process.argv.find((arg) => arg.startsWith("--since="));
const since = sinceArg ? sinceArg.slice(8) : "";
const asJson = process.argv.includes("--json");
const fieldArg = process.argv.find((arg) => arg.startsWith("--field="));
const field = (fieldArg ? fieldArg.slice(8) : "arm") as "arm" | "compactArm";

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
  .filter((row) => row[field] && row.endedAt >= since && row.turns > 0);

function summarize(arm: string): ArmSummary {
  const armRows = rows.filter((row) => row[field] === arm);
  const turns = armRows.reduce((sum, row) => sum + row.turns, 0);
  const cost = armRows.reduce((sum, row) => sum + row.cost, 0);
  const read = armRows.reduce((sum, row) => sum + row.cacheRead, 0);
  const write = armRows.reduce((sum, row) => sum + row.cacheWrite, 0);
  const errors = armRows.reduce((sum, row) => sum + (row.toolErrors ?? 0), 0);
  const bySession = new Map<string, { cost: number; turns: number }>();
  for (const row of armRows) {
    const entry = bySession.get(row.sessionId) ?? { cost: 0, turns: 0 };
    entry.cost += row.cost;
    entry.turns += row.turns;
    bySession.set(row.sessionId, entry);
  }
  const perSession = [...bySession.values()].map((entry) => entry.cost / entry.turns).sort((a, b) => a - b);
  const median = perSession.length ? perSession[Math.floor(perSession.length / 2)] : 0;
  const largest = Math.max(0, ...[...bySession.values()].map((entry) => entry.turns));
  return {
    medianSessionCostPerTurn: Math.round(median * 10000) / 10000,
    largestSessionTurnShare: turns ? Math.round((100 * largest) / turns) : 0,
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

function sessionTotals(arm: string): { cost: number; turns: number }[] {
  const bySession = new Map<string, { cost: number; turns: number }>();
  for (const row of rows.filter((candidate) => candidate[field] === arm)) {
    const entry = bySession.get(row.sessionId) ?? { cost: 0, turns: 0 };
    entry.cost += row.cost;
    entry.turns += row.turns;
    bySession.set(row.sessionId, entry);
  }
  return [...bySession.values()];
}

function pooledRatio(a: { cost: number; turns: number }[], b: { cost: number; turns: number }[]): number {
  const perTurn = (group: { cost: number; turns: number }[]) => group.reduce((sum, item) => sum + item.cost, 0) / Math.max(1, group.reduce((sum, item) => sum + item.turns, 0));
  return perTurn(a) / Math.max(1e-9, perTurn(b));
}

function permutationP(): number {
  const onSessions = sessionTotals("on");
  const offSessions = sessionTotals("off");
  if (!onSessions.length || !offSessions.length) return 1;
  const observed = pooledRatio(onSessions, offSessions);
  const pool = [...onSessions, ...offSessions];
  let seed = 1;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  let atLeastAsGood = 0;
  const trials = 4000;
  for (let trial = 0; trial < trials; trial++) {
    for (let index = pool.length - 1; index > 0; index--) {
      const swap = Math.floor(random() * (index + 1));
      [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }
    if (pooledRatio(pool.slice(0, onSessions.length), pool.slice(onSessions.length)) <= observed) atLeastAsGood++;
  }
  return Math.round((atLeastAsGood / trials) * 100) / 100;
}

const pValue = permutationP();
const significant = pValue < 0.05;
const result = { since, field, on, off, savingPct, enough, pValue, significant };

if (asJson) console.log(JSON.stringify(result));
else {
  console.log("arm  sessions  turns   cost$   $/turn   cacheHit%  spills  errors/turn");
  for (const s of [on, off]) {
    console.log(
      `${s.arm.padEnd(4)} ${String(s.sessions).padStart(8)} ${String(s.turns).padStart(6)} ${s.cost.toFixed(2).padStart(7)} ${s.costPerTurn.toFixed(4).padStart(8)} ${String(s.cacheHitPct).padStart(10)} ${String(s.spills).padStart(7)} ${s.toolErrorsPerTurn.toFixed(3).padStart(12)}`,
    );
  }
  console.log(`median session $/turn: on ${on.medianSessionCostPerTurn} vs off ${off.medianSessionCostPerTurn}; largest session share of turns: on ${on.largestSessionTurnShare}% vs off ${off.largestSessionTurnShare}%`);
  console.log(`saving per turn: ${savingPct}%, permutation p=${pValue} ${significant ? "(significant)" : "(not significant)"} ${enough ? "" : "(not enough data yet: need 20 sessions and 500 turns per arm)"}`);
}
