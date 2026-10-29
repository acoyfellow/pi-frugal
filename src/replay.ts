export interface ReplayTurn {
  atMs: number;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  recordedCost: number;
}

export interface ModelPrices {
  inputPerToken: number;
  outputPerToken: number;
  readPerToken: number;
  writePerToken: number;
}

export interface CachePolicy {
  name: string;
  ttlMs: number;
  writeCost: (price: ModelPrices) => number;
}

export const FIVE_MINUTE_POLICY: CachePolicy = { name: "cache-5m", ttlMs: 5 * 60_000, writeCost: (price) => price.writePerToken };
export const ONE_HOUR_POLICY: CachePolicy = { name: "cache-1h", ttlMs: 60 * 60_000, writeCost: (price) => price.inputPerToken * 2 };

export interface ReplayScore {
  policy: string;
  turns: number;
  cost: number;
  recordedCost: number;
  cacheBreaks: number;
  medianContext: number;
  p95Context: number;
}

export function contextOf(turn: ReplayTurn): number {
  return turn.input + turn.cacheRead + turn.cacheWrite;
}

function percentile(sorted: readonly number[], share: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(share * sorted.length));
  return sorted[index] ?? 0;
}

export function replaySession(
  turns: readonly ReplayTurn[],
  prices: ReadonlyMap<string, ModelPrices>,
  policy: CachePolicy,
  prefixEdits: readonly (number | undefined)[] = [],
): ReplayScore {
  let cost = 0;
  let recordedCost = 0;
  let cacheBreaks = 0;
  let previous: ReplayTurn | undefined;
  const contexts: number[] = [];
  for (const turn of turns) {
    const price = prices.get(turn.model);
    const context = contextOf(turn);
    contexts.push(context);
    recordedCost += turn.recordedCost;
    if (!price) {
      cost += turn.recordedCost;
      previous = turn;
      continue;
    }
    const warm = previous !== undefined && previous.model === turn.model && turn.atMs - previous.atMs <= policy.ttlMs;
    const edit = prefixEdits[contexts.length - 1];
    const intactPrefix = warm && previous ? Math.min(contextOf(previous), context) : 0;
    const cachedPrefix = edit === undefined ? intactPrefix : Math.min(intactPrefix, edit);
    const written = context - cachedPrefix;
    if (!warm && previous !== undefined) cacheBreaks++;
    cost +=
      cachedPrefix * price.readPerToken +
      written * policy.writeCost(price) +
      turn.output * price.outputPerToken;
    previous = turn;
  }
  const sorted = [...contexts].sort((a, b) => a - b);
  return {
    policy: policy.name,
    turns: turns.length,
    cost,
    recordedCost,
    cacheBreaks,
    medianContext: percentile(sorted, 0.5),
    p95Context: percentile(sorted, 0.95),
  };
}

export function sumScores(policy: string, scores: readonly ReplayScore[]): ReplayScore {
  const total = (pick: (score: ReplayScore) => number) => scores.reduce((sum, score) => sum + pick(score), 0);
  const medians = scores.map((score) => score.medianContext).sort((a, b) => a - b);
  const p95s = scores.map((score) => score.p95Context).sort((a, b) => a - b);
  return {
    policy,
    turns: total((score) => score.turns),
    cost: total((score) => score.cost),
    recordedCost: total((score) => score.recordedCost),
    cacheBreaks: total((score) => score.cacheBreaks),
    medianContext: percentile(medians, 0.5),
    p95Context: percentile(p95s, 0.95),
  };
}

export interface PricedTurn {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  inputCost: number;
  outputCost: number;
  readCost: number;
  writeCost: number;
}

const MIN_SAMPLE_TOKENS = 100;

function rate(cost: number, tokens: number): number | undefined {
  return tokens >= MIN_SAMPLE_TOKENS && cost > 0 ? cost / tokens : undefined;
}

export function derivePricesFromCostParts(turns: readonly PricedTurn[]): Map<string, ModelPrices> {
  const found = new Map<string, Partial<ModelPrices>>();
  for (const turn of turns) {
    const known = found.get(turn.model) ?? {};
    known.inputPerToken ??= rate(turn.inputCost, turn.input);
    known.outputPerToken ??= rate(turn.outputCost, turn.output);
    known.readPerToken ??= rate(turn.readCost, turn.cacheRead);
    known.writePerToken ??= rate(turn.writeCost, turn.cacheWrite);
    found.set(turn.model, known);
  }
  const prices = new Map<string, ModelPrices>();
  for (const [model, known] of found) {
    const write = known.writePerToken;
    const input = known.inputPerToken ?? (write === undefined ? undefined : write / 1.25);
    if (input === undefined || known.outputPerToken === undefined) continue;
    prices.set(model, {
      inputPerToken: input,
      outputPerToken: known.outputPerToken,
      readPerToken: known.readPerToken ?? input * 0.1,
      writePerToken: write ?? input * 1.25,
    });
  }
  return prices;
}

export interface KeepWarmRule {
  pingEveryMs: number;
  maxIdleMs: number;
}

export function insertKeepWarmPings(turns: readonly ReplayTurn[], rule: KeepWarmRule | undefined): ReplayTurn[] {
  if (!rule) return [...turns];
  const out: ReplayTurn[] = [];
  let previous: ReplayTurn | undefined;
  for (const turn of turns) {
    if (previous && previous.model === turn.model) {
      const gap = turn.atMs - previous.atMs;
      const limit = Math.min(gap, rule.maxIdleMs);
      for (let at = previous.atMs + rule.pingEveryMs; at < previous.atMs + limit; at += rule.pingEveryMs) {
        out.push({ ...previous, atMs: at, output: 1, recordedCost: 0 });
      }
    }
    out.push(turn);
    previous = turn;
  }
  return out;
}
