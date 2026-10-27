import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  comparePrompts,
  judgeBashCommand,
  shouldCompactOnResume,
  snapshotPrompt,
  summarizeRun,
  type PromptSnapshot,
  type RunCounters,
  type TurnUsage,
} from "./core.ts";

interface AssistantLike {
  role: "assistant";
  timestamp: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
}

function frugalDir(): string {
  return process.env.PI_FRUGAL_DIR ?? join(homedir(), ".pi", "agent", "frugal");
}

function appendJsonLine(fileName: string, value: unknown): void {
  const dir = frugalDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, fileName), `${JSON.stringify(value)}\n`);
}

function isAssistantWithUsage(message: unknown): message is AssistantLike {
  if (typeof message !== "object" || message === null) return false;
  if (!("role" in message) || message.role !== "assistant") return false;
  return "usage" in message && typeof message.usage === "object" && message.usage !== null;
}

function toTurnUsage(message: AssistantLike): TurnUsage {
  const usage = message.usage;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cost: usage.cost?.total ?? 0,
  };
}

function lastAssistantOnBranch(ctx: ExtensionContext): AssistantLike | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "message" && isAssistantWithUsage(entry.message)) return entry.message;
  }
  return undefined;
}

function emptyCounters(): RunCounters {
  return { blockedSleeps: 0, compactions: 0, promptChanges: 0 };
}

export default function frugal(pi: ExtensionAPI) {
  let counters = emptyCounters();
  let previousRunLastTurn: TurnUsage | undefined;
  let promptBaseline: PromptSnapshot | undefined;
  let resumeCompactionPending = false;
  let runsSinceStart = 0;

  pi.on("session_start", async (_event, ctx) => {
    const last = lastAssistantOnBranch(ctx);
    previousRunLastTurn = last ? toTurnUsage(last) : undefined;
    promptBaseline = snapshotPrompt(ctx.getSystemPrompt(), pi.getActiveTools());
    counters = emptyCounters();
    runsSinceStart = 0;
  });

  pi.on("input", async (event, ctx) => {
    if (resumeCompactionPending || event.streamingBehavior !== undefined || event.source === "extension") {
      return { action: "continue" };
    }
    const usage = ctx.getContextUsage();
    const decision = shouldCompactOnResume({
      nowMs: Date.now(),
      lastAssistantMs: lastAssistantOnBranch(ctx)?.timestamp,
      contextTokens: usage?.tokens,
      contextWindow: usage?.contextWindow,
    });
    if (!decision) return { action: "continue" };
    resumeCompactionPending = true;
    const deliver = () => {
      resumeCompactionPending = false;
      pi.sendUserMessage(event.images?.length ? [{ type: "text", text: event.text }, ...event.images] : event.text);
    };
    if (ctx.hasUI) ctx.ui.notify("pi-frugal: cache is cold and context is large, compacting before this prompt", "info");
    ctx.compact({
      customInstructions: "Session resumed after idle time; the prompt cache expired. Keep what the next prompt needs.",
      onComplete: deliver,
      onError: deliver,
    });
    return { action: "handled" };
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;
    const command = event.input.command;
    if (typeof command !== "string") return undefined;
    const verdict = judgeBashCommand(command);
    if (!verdict.blocked) return undefined;
    counters.blockedSleeps++;
    return { block: true, reason: verdict.reason };
  });

  pi.on("session_compact", async () => {
    counters.compactions++;
  });

  pi.on("agent_start", async (_event, ctx) => {
    const current = snapshotPrompt(ctx.getSystemPrompt(), pi.getActiveTools());
    const change = promptBaseline ? comparePrompts(promptBaseline, current) : undefined;
    promptBaseline = current;
    const phase = runsSinceStart === 0 ? "first-run" : "between-runs";
    runsSinceStart++;
    if (!change) return;
    appendJsonLine("prompt-changes.jsonl", { at: new Date().toISOString(), sessionId: ctx.sessionManager.getSessionId(), phase, ...change });
    if (phase === "first-run") return;
    counters.promptChanges++;
    if (ctx.hasUI) ctx.ui.notify(`pi-frugal: system prompt changed (${change.fromHash} -> ${change.toHash}); see frugal/prompt-changes.jsonl`, "warning");
  });

  pi.on("agent_end", async (event, ctx) => {
    const turns = event.messages.filter(isAssistantWithUsage).map(toTurnUsage);
    const metrics = summarizeRun(ctx.sessionManager.getSessionId(), new Date().toISOString(), previousRunLastTurn, turns, counters);
    appendJsonLine("metrics.jsonl", metrics);
    if (turns.length > 0) previousRunLastTurn = turns[turns.length - 1];
    counters = emptyCounters();
  });
}
