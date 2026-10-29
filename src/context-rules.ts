import type { ReplayTurn } from "./replay.ts";

export const CHARS_PER_TOKEN = 4;

export type SessionEvent =
  | { kind: "tool-result"; chars: number; images: number }
  | { kind: "compaction" }
  | { kind: "turn"; turn: ReplayTurn };

export interface SpillRule {
  thresholdChars: number;
  stubChars: number;
}

export function spilledTokens(chars: number, rule: SpillRule | undefined): number {
  if (!rule || chars <= rule.thresholdChars) return 0;
  return Math.floor((chars - rule.stubChars) / CHARS_PER_TOKEN);
}

function withContext(turn: ReplayTurn, context: number): ReplayTurn {
  return { ...turn, input: 0, cacheRead: 0, cacheWrite: Math.max(0, context) };
}

export function applySpill(events: readonly SessionEvent[], rule: SpillRule | undefined): ReplayTurn[] {
  const turns: ReplayTurn[] = [];
  let removed = 0;
  for (const event of events) {
    if (event.kind === "compaction") removed = 0;
    if (event.kind === "tool-result") removed += spilledTokens(event.chars, rule);
    if (event.kind === "turn") {
      const recorded = event.turn.input + event.turn.cacheRead + event.turn.cacheWrite;
      turns.push(withContext(event.turn, recorded - removed));
    }
  }
  return turns;
}

export function spillCount(events: readonly SessionEvent[], rule: SpillRule | undefined): number {
  return events.filter((event) => event.kind === "tool-result" && spilledTokens(event.chars, rule) > 0).length;
}
