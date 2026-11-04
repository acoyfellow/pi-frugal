export const RESUME_IDLE_MS = 60 * 60 * 1000;
export const RESUME_MIN_WINDOW_SHARE = 0.5;
export const MAX_SLEEP_SECONDS = 5;
export const BIG_CONTEXT_TOKENS = 200_000;
export const CACHE_BREAK_WRITE_TOKENS = 100_000;

export interface ResumeInput {
  nowMs: number;
  lastAssistantMs: number | undefined;
  contextTokens: number | null | undefined;
  contextWindow: number | undefined;
}

export function shouldCompactOnResume(input: ResumeInput): boolean {
  if (input.lastAssistantMs === undefined) return false;
  if (input.contextTokens === null || input.contextTokens === undefined) return false;
  if (!input.contextWindow || input.contextWindow <= 0) return false;
  const idleMs = input.nowMs - input.lastAssistantMs;
  const windowShare = input.contextTokens / input.contextWindow;
  return idleMs > RESUME_IDLE_MS && windowShare >= RESUME_MIN_WINDOW_SHARE;
}

export interface WaitVerdict {
  blocked: boolean;
  reason: string;
}

const SLEEP_PATTERN = /(?:^|[\s;&|(`])sleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g;
const LOOP_PATTERN = /(?:^|[\s;&|(])(for|while|until)\s/;
const SLEEP_WORD = /(?:^|[\s;&|(`])sleep\s/;
const UNIT_SECONDS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

export const WAIT_ALTERNATIVES =
  "Do not wait inside a turn. Use loops_task to check again on an interval, start the job in the background so it notifies on finish, or set an alarm. Then end the turn.";

export function longestSleepSeconds(command: string): number {
  let longest = 0;
  for (const match of command.matchAll(SLEEP_PATTERN)) {
    const seconds = Number(match[1]) * (UNIT_SECONDS[match[2]] ?? 1);
    if (seconds > longest) longest = seconds;
  }
  return longest;
}

export const MAX_TOOL_CALL_SECONDS = 120;
export const ALLOW_LONG_MARKER = "# frugal:allow-long";

const TIMEOUT_LIMIT = /(?:^|[\s;&|(`])g?timeout\s+(?:-\S+\s+)*(\d+(?:\.\d+)?)([smhd]?)(?=\s|$)/g;
const PERL_SHIFT_LIMIT = /perl\s+-e\s+(['"])[^'"]*\balarm\s+shift\b[^'"]*\1\s+(\d+)/g;
const ALARM_LITERAL_LIMIT = /\balarm\s*\(?\s*(\d+)/g;
const BACKGROUND_RUN = /(?:^|[\s;&|(])nohup\s|[^&]&\s*$|^\s*\S.*\s&\s*(?:;|$)/;
function runsScript(path: string): RegExp {
  const runner = String.raw`(?:^|[;&|(]\s*|\b(?:bash|sh|zsh|node|bun|tsx|npx)\s+(?:--?\S+\s+)*)`;
  return new RegExp(String.raw`${runner}(?:[\w.~/-]*/)?${path}`);
}

const LONG_SCRIPTS: readonly { name: string; pattern: RegExp }[] = [
  { name: "gate.sh", pattern: runsScript(String.raw`gate\.sh\b`) },
  { name: "gate.mjs", pattern: runsScript(String.raw`gate\.mjs\b`) },
  { name: "a proof/ script", pattern: runsScript(String.raw`proof/\S+`) },
  { name: "wrangler deploy", pattern: /\bwrangler\s+deploy\b/ },
  { name: "ship.sh", pattern: runsScript(String.raw`ship\.sh\b`) },
  { name: "npm test", pattern: /(?:^|[;&|(]\s*|\b(?:exec|env|time)\s+)(?:npm|pnpm|yarn|bun)\s+(?:--?\S+\s+(?:[^-\s;&|]\S*\s+)?)*(?:run\s+)?test(?=\s|$|;|&|\|)/ },
  { name: "npx test", pattern: /(?:^|[;&|(]\s*)npx\s+(?:--?\S+\s+)*(?:jest|mocha|test)(?=\s|$|;|&|\|)/ },
];
const VITEST_CALL = /(?:^|[;&|(]\s*|\b(?:npx|pnpm|bunx|yarn|exec)\s+(?:--?\S+\s+)*|node_modules\/\.bin\/)vitest(?=\s|$)((?:\s+[^\s;&|]+)*)/;
const VITEST_MODES = new Set(["run", "watch", "related"]);

export const LONG_CALL_ALTERNATIVES =
  `If it can finish in under ${MAX_TOOL_CALL_SECONDS}s, add a time limit and run it in the foreground so you see its real output: timeout 110 <command> (or perl -e 'alarm 110; exec @ARGV' <command>). Only if it needs longer, run it in the background (nohup <command> > log 2>&1 &, or a background job that notifies on finish), end the turn, and check with loops_task. Write that log to a fresh file in this project, never a shared path like /tmp/deploy.log, and read only that file. A human can end the command with "${ALLOW_LONG_MARKER}" to run it anyway.`;

function secondsOf(value: string, unit: string): number {
  return Number(value) * (UNIT_SECONDS[unit] ?? 1);
}

const PERL_ALARM_LITERAL = /perl\s+-e\s+(['"])[^'"]*\balarm\s*\(?\s*(\d+)[^'"]*\1/g;

export function timeLimitsSeconds(command: string, code: string = command): number[] {
  const limits: number[] = [];
  for (const match of code.matchAll(TIMEOUT_LIMIT)) limits.push(secondsOf(match[1], match[2]));
  for (const match of command.matchAll(PERL_SHIFT_LIMIT)) limits.push(Number(match[2]));
  const literals = code === command ? command.matchAll(ALARM_LITERAL_LIMIT) : command.matchAll(PERL_ALARM_LITERAL);
  for (const match of literals) limits.push(Number(match[match.length - 1]));
  return limits;
}

function vitestRunsEverything(command: string): boolean {
  const call = VITEST_CALL.exec(command);
  if (!call) return false;
  const args = call[1].trim().split(/\s+/).filter((arg) => arg.length > 0);
  return !args.some((arg) => !arg.startsWith("-") && !VITEST_MODES.has(arg));
}

export function longScriptName(command: string): string | undefined {
  const script = LONG_SCRIPTS.find((entry) => entry.pattern.test(command));
  if (script) return script.name;
  return vitestRunsEverything(command) ? "vitest without a file" : undefined;
}

export function judgeLongCommand(command: string, rawCommand: string = command): WaitVerdict {
  const trimmed = command.trimEnd();
  if (trimmed.endsWith(ALLOW_LONG_MARKER)) return { blocked: false, reason: "" };
  if (BACKGROUND_RUN.test(trimmed)) return { blocked: false, reason: "" };
  const limits = timeLimitsSeconds(rawCommand, command);
  const longest = Math.max(0, ...limits);
  if (longest > MAX_TOOL_CALL_SECONDS) {
    return {
      blocked: true,
      reason: `pi-frugal blocked a ${longest}s time limit (max ${MAX_TOOL_CALL_SECONDS}s). Pi looks frozen and Escape cannot stop it. ${LONG_CALL_ALTERNATIVES}`,
    };
  }
  const script = longScriptName(trimmed);
  if (script && limits.length === 0) {
    return {
      blocked: true,
      reason: `pi-frugal blocked ${script} with no time limit. It can run for many minutes, and Pi looks frozen while it runs. ${LONG_CALL_ALTERNATIVES}`,
    };
  }
  return { blocked: false, reason: "" };
}

const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g;
const SHELL_C = /(\bnohup\s+)?\b(?:bash|sh|zsh)\s+(?:-\w+\s+)*-c\s+(['"])([\s\S]*?)\2([^\n;|]*)/g;
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;

export function shellCode(command: string): string {
  const inner: string[] = [];
  const withoutHeredocs = command.replace(HEREDOC, "<<HEREDOC");
  for (const match of withoutHeredocs.matchAll(SHELL_C)) {
    const backgrounded = Boolean(match[1]) || /&\s*(?:disown\b|$)/.test(match[4] ?? "");
    if (!backgrounded) inner.push(match[3]);
  }
  const outer = withoutHeredocs.replace(QUOTED, "''");
  return [outer, ...inner.map(shellCode)].join("\n");
}

export function judgeBashCommand(rawCommand: string): WaitVerdict {
  const marked = rawCommand.trimEnd().endsWith(ALLOW_LONG_MARKER);
  const command = shellCode(rawCommand) + (marked ? ` ${ALLOW_LONG_MARKER}` : "");
  const loop = LOOP_PATTERN.exec(command);
  if (loop && SLEEP_WORD.test(command)) {
    return { blocked: true, reason: `pi-frugal blocked a ${loop[1]} loop that polls with sleep. ${WAIT_ALTERNATIVES}` };
  }
  const seconds = longestSleepSeconds(command);
  if (seconds > MAX_SLEEP_SECONDS) {
    return { blocked: true, reason: `pi-frugal blocked sleep ${seconds}s (limit ${MAX_SLEEP_SECONDS}s). ${WAIT_ALTERNATIVES}` };
  }
  return judgeLongCommand(command, rawCommand);
}

export interface PromptSnapshot {
  hash: string;
  systemPrompt: string;
  tools: string[];
}

export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function snapshotPrompt(systemPrompt: string, tools: readonly string[]): PromptSnapshot {
  const sortedTools = [...tools].sort();
  return { hash: hashText(`${systemPrompt}\u0000${sortedTools.join(",")}`), systemPrompt, tools: sortedTools };
}

export interface PromptChange {
  fromHash: string;
  toHash: string;
  toolsAdded: string[];
  toolsRemoved: string[];
  linesAdded: string[];
  linesRemoved: string[];
}

const MAX_REPORTED_LINES = 5;
const MAX_LINE_LENGTH = 160;

function shortLines(lines: string[]): string[] {
  return lines.filter((line) => line.trim() !== "").slice(0, MAX_REPORTED_LINES).map((line) => line.slice(0, MAX_LINE_LENGTH));
}

function linesMissingFrom(source: string[], target: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const line of target) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const missing: string[] = [];
  for (const line of source) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else missing.push(line);
  }
  return missing;
}

export function comparePrompts(before: PromptSnapshot, after: PromptSnapshot): PromptChange | undefined {
  if (before.hash === after.hash) return undefined;
  const beforeLines = before.systemPrompt.split("\n");
  const afterLines = after.systemPrompt.split("\n");
  return {
    fromHash: before.hash,
    toHash: after.hash,
    toolsAdded: after.tools.filter((tool) => !before.tools.includes(tool)),
    toolsRemoved: before.tools.filter((tool) => !after.tools.includes(tool)),
    linesAdded: shortLines(linesMissingFrom(afterLines, beforeLines)),
    linesRemoved: shortLines(linesMissingFrom(beforeLines, afterLines)),
  };
}

export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export function contextTokensOf(usage: TurnUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

export function isCacheBreak(previous: TurnUsage | undefined, current: TurnUsage): boolean {
  if (current.cacheWrite <= CACHE_BREAK_WRITE_TOKENS) return false;
  if (previous === undefined) return false;
  return current.cacheRead < previous.cacheRead / 2;
}

export interface RunCounters {
  blockedSleeps: number;
  compactions: number;
  promptChanges: number;
  memoryInjections?: number;
  memoryChars?: number;
  memoryUsed?: number;
  spills?: number;
  toolErrors?: number;
  arm?: string;
  compactArm?: string;
}

export interface RunMetrics extends RunCounters {
  sessionId: string;
  endedAt: string;
  turns: number;
  maxContext: number;
  turnsOver200k: number;
  cacheRead: number;
  cacheWrite: number;
  breaks: number;
  newRunBreak: boolean;
  cost: number;
}

export function summarizeRun(
  sessionId: string,
  endedAt: string,
  previousRunLastTurn: TurnUsage | undefined,
  turns: readonly TurnUsage[],
  counters: RunCounters,
): RunMetrics {
  let previous = previousRunLastTurn;
  let breaks = 0;
  let newRunBreak = false;
  let maxContext = 0;
  let turnsOver200k = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  turns.forEach((turn, index) => {
    const broke = isCacheBreak(previous, turn);
    if (broke) breaks++;
    if (broke && index === 0) newRunBreak = true;
    const context = contextTokensOf(turn);
    if (context > maxContext) maxContext = context;
    if (context > BIG_CONTEXT_TOKENS) turnsOver200k++;
    cacheRead += turn.cacheRead;
    cacheWrite += turn.cacheWrite;
    cost += turn.cost;
    previous = turn;
  });
  return {
    sessionId,
    endedAt,
    turns: turns.length,
    maxContext,
    turnsOver200k,
    cacheRead,
    cacheWrite,
    breaks,
    newRunBreak,
    cost: Math.round(cost * 1e6) / 1e6,
    ...counters,
  };
}

export interface MetricsReport {
  runs: number;
  turns: number;
  turnsOver200k: number;
  newRunBreaks: number;
  newRunBreakRate: number;
  midRunBreaks: number;
  blockedSleeps: number;
  compactions: number;
  promptChanges: number;
  memoryInjections: number;
  memoryChars: number;
  memoryUsed: number;
  cost: number;
}

export function parseMetricsLines(text: string): RunMetrics[] {
  const runs: RunMetrics[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const value: unknown = JSON.parse(line);
    if (isRunMetrics(value)) runs.push(value);
  }
  return runs;
}

function isRunMetrics(value: unknown): value is RunMetrics {
  return typeof value === "object" && value !== null && "turns" in value && "turnsOver200k" in value && "newRunBreak" in value;
}

export function reportMetrics(runs: readonly RunMetrics[]): MetricsReport {
  const sum = (pick: (run: RunMetrics) => number) => runs.reduce((total, run) => total + pick(run), 0);
  const newRunBreaks = runs.filter((run) => run.newRunBreak).length;
  return {
    runs: runs.length,
    turns: sum((run) => run.turns),
    turnsOver200k: sum((run) => run.turnsOver200k),
    newRunBreaks,
    newRunBreakRate: runs.length === 0 ? 0 : newRunBreaks / runs.length,
    midRunBreaks: sum((run) => run.breaks) - newRunBreaks,
    blockedSleeps: sum((run) => run.blockedSleeps),
    compactions: sum((run) => run.compactions),
    promptChanges: sum((run) => run.promptChanges),
    memoryInjections: sum((run) => run.memoryInjections ?? 0),
    memoryChars: sum((run) => run.memoryChars ?? 0),
    memoryUsed: sum((run) => run.memoryUsed ?? 0),
    cost: Math.round(sum((run) => run.cost) * 100) / 100,
  };
}

export interface DejaPrimerReport {
  injections: number;
  chars: number;
  used: number;
}

export function dejaPrimerReport(data: unknown): DejaPrimerReport | undefined {
  if (typeof data !== "object" || data === null || !("outcome" in data)) return undefined;
  const event = data as { outcome: unknown; chars?: unknown; used?: unknown };
  const count = (value: unknown) => (typeof value === "number" && value > 0 ? value : 0);
  if (event.outcome === "injected") return { injections: 1, chars: count(event.chars), used: 0 };
  if (event.outcome === "graded") return { injections: 0, chars: 0, used: count(event.used) };
  return undefined;
}
