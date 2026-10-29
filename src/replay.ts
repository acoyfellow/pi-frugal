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
}

export interface CachePolicy {
  name: string;
  ttlMs: number;
  writeMultiplier: number;
}

export const READ_MULTIPLIER = 0.1;
export const FIVE_MINUTE_POLICY: CachePolicy = { name: "cache-5m", ttlMs: 5 * 60_000, writeMultiplier: 1.25 };
export const ONE_HOUR_POLICY: CachePolicy = { name: "cache-1h", ttlMs: 60 * 60_000, writeMultiplier: 2 };

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

export function replaySession(turns: readonly ReplayTurn[], prices: ReadonlyMap<string, ModelPrices>, policy: CachePolicy): ReplayScore {
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
    const cachedPrefix = warm && previous ? Math.min(contextOf(previous), context) : 0;
    const written = context - cachedPrefix;
    if (!warm && previous !== undefined) cacheBreaks++;
    cost +=
      cachedPrefix * price.inputPerToken * READ_MULTIPLIER +
      written * price.inputPerToken * policy.writeMultiplier +
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

export function derivePrices(turns: readonly { model: string; input: number; output: number; inputCost: number; outputCost: number }[]): Map<string, ModelPrices> {
  const prices = new Map<string, ModelPrices>();
  for (const turn of turns) {
    if (prices.has(turn.model) || turn.input < 100 || turn.output < 100) continue;
    prices.set(turn.model, { inputPerToken: turn.inputCost / turn.input, outputPerToken: turn.outputCost / turn.output });
  }
  return prices;
}
