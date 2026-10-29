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

export interface ImageDropRule {
  keepLatest: number;
  tokensPerImage: number;
}

export interface RebuiltTurn {
  turn: ReplayTurn;
  prefixEditedFrom: number | undefined;
}

export function applySpillAndImageDrop(
  events: readonly SessionEvent[],
  spill: SpillRule | undefined,
  drop: ImageDropRule | undefined,
): RebuiltTurn[] {
  const turns: RebuiltTurn[] = [];
  let spilled = 0;
  let imagesSeen = 0;
  let imagesDropped = 0;
  let imageOffsets: number[] = [];
  let lastContext = 0;
  for (const event of events) {
    if (event.kind === "compaction") {
      spilled = 0;
      imagesSeen = 0;
      imagesDropped = 0;
      imageOffsets = [];
    }
    if (event.kind === "tool-result") {
      spilled += spilledTokens(event.chars, spill);
      for (let index = 0; index < event.images; index++) imageOffsets.push(lastContext);
      imagesSeen += event.images;
    }
    if (event.kind !== "turn") continue;
    const recorded = event.turn.input + event.turn.cacheRead + event.turn.cacheWrite;
    const shouldDrop = drop ? Math.max(0, imagesSeen - drop.keepLatest) : 0;
    const newlyDropped = shouldDrop - imagesDropped;
    const editedFrom = newlyDropped > 0 ? imageOffsets[imagesDropped] : undefined;
    imagesDropped = shouldDrop;
    const removed = spilled + imagesDropped * (drop?.tokensPerImage ?? 0);
    const context = Math.max(0, recorded - removed);
    turns.push({ turn: withContext(event.turn, context), prefixEditedFrom: editedFrom });
    lastContext = context;
  }
  return turns;
}

export function spillCount(events: readonly SessionEvent[], rule: SpillRule | undefined): number {
  return events.filter((event) => event.kind === "tool-result" && spilledTokens(event.chars, rule) > 0).length;
}

export interface CompactionRule {
  thresholdTokens: number;
  keepRecentTokens: number;
  summaryTokens: number;
}

const REAL_COMPACTION_SHRINK = 0.5;

export function applyCompactionThreshold(rebuilt: readonly RebuiltTurn[], rule: CompactionRule | undefined): RebuiltTurn[] {
  if (!rule) return [...rebuilt];
  const out: RebuiltTurn[] = [];
  let offset = 0;
  let lastRecorded = 0;
  let rewriteNext = false;
  for (const { turn, prefixEditedFrom } of rebuilt) {
    const recorded = turn.input + turn.cacheRead + turn.cacheWrite;
    if (recorded < lastRecorded * REAL_COMPACTION_SHRINK) offset = 0;
    lastRecorded = recorded;
    const context = Math.max(0, recorded - offset);
    out.push({ turn: { ...turn, input: 0, cacheRead: 0, cacheWrite: context }, prefixEditedFrom: rewriteNext ? 0 : prefixEditedFrom });
    rewriteNext = false;
    if (context > rule.thresholdTokens) {
      out.push({ turn: { ...turn, input: 0, cacheRead: 0, cacheWrite: context, output: rule.summaryTokens, recordedCost: 0 }, prefixEditedFrom: undefined });
      offset = recorded - (rule.keepRecentTokens + rule.summaryTokens);
      rewriteNext = true;
    }
  }
  return out;
}
