import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { parseSpillConfig, spillStub, type SpillConfig } from "./spill.ts";
import { armForSession, readAbConfig, spillForArm, type Arm } from "./ab.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  comparePrompts,
  dejaPrimerReport,
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

function refreshAfterTurn(command: string | undefined): void {
  if (!command) return;
  const child = spawn("sh", ["-c", command], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
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
  return { blockedSleeps: 0, compactions: 0, promptChanges: 0, memoryInjections: 0, memoryChars: 0, memoryUsed: 0, spills: 0, toolErrors: 0 };
}

export default function frugal(pi: ExtensionAPI) {
  let counters = emptyCounters();
  let previousRunLastTurn: TurnUsage | undefined;
  let promptBaseline: PromptSnapshot | undefined;
  let resumeCompactionPending = false;
  let runsSinceStart = 0;
  const fixedSpill = parseSpillConfig(process.env.PI_FRUGAL_SPILL);
  const abConfig = readAbConfig(frugalDir());
  let arm: Arm | undefined;
  let spillConfig: SpillConfig | undefined = fixedSpill;

  pi.events.on("deja:primer", (data) => {
    const report = dejaPrimerReport(data);
    if (!report) return;
    counters.memoryInjections = (counters.memoryInjections ?? 0) + report.injections;
    counters.memoryChars = (counters.memoryChars ?? 0) + report.chars;
    counters.memoryUsed = (counters.memoryUsed ?? 0) + report.used;
  });

  pi.on("session_start", async (_event, ctx) => {
    const last = lastAssistantOnBranch(ctx);
    previousRunLastTurn = last ? toTurnUsage(last) : undefined;
    promptBaseline = snapshotPrompt(ctx.getSystemPrompt(), pi.getActiveTools());
    counters = emptyCounters();
    runsSinceStart = 0;
    arm = abConfig && !fixedSpill ? armForSession(ctx.sessionManager.getSessionId()) : undefined;
    spillConfig = spillForArm(fixedSpill, abConfig, arm);
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

  pi.on("tool_result", async (event) => {
    if (event.isError) counters.toolErrors = (counters.toolErrors ?? 0) + 1;
    if (!spillConfig || event.toolName === "read") return undefined;
    if (event.content.some((part) => part.type !== "text")) return undefined;
    const text = event.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    const path = join(frugalDir(), "spill", `${event.toolCallId.replace(/[^\w-]/g, "_")}.txt`);
    const decision = spillStub(text, spillConfig, path);
    if (!decision.spill) return undefined;
    mkdirSync(join(frugalDir(), "spill"), { recursive: true });
    writeFileSync(path, text);
    counters.spills = (counters.spills ?? 0) + 1;
    return { content: [{ type: "text", text: decision.stub }] };
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
    const metrics = summarizeRun(ctx.sessionManager.getSessionId(), new Date().toISOString(), previousRunLastTurn, turns, arm ? { ...counters, arm } : counters);
    appendJsonLine("metrics.jsonl", metrics);
    if (turns.length > 0) previousRunLastTurn = turns[turns.length - 1];
    counters = emptyCounters();
    refreshAfterTurn(process.env.PI_FRUGAL_AFTER_TURN ?? abConfig?.afterTurn);
  });
}
