import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [oldPath, newPath] = process.argv.slice(2);
const { judgeBashCommand: judgeOld } = await import(oldPath);
const { judgeBashCommand: judgeNew } = await import(newPath);
const root = process.env.PI_SESSIONS_DIR ?? join(homedir(), ".pi/agent/sessions");
const sinceMs = Date.now() - Number(process.env.DAYS ?? "14") * 86_400_000;

function commandOf(argumentsValue: unknown): string | null {
  const value = typeof argumentsValue === "string" ? safeParse(argumentsValue) : argumentsValue;
  if (value && typeof value === "object" && "command" in value && typeof value.command === "string") return value.command;
  return null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const commands = new Set<string>();
for (const dir of readdirSync(root)) {
  const full = join(root, dir);
  if (!statSync(full).isDirectory()) continue;
  for (const name of readdirSync(full)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(full, name);
    if (statSync(path).mtimeMs < sinceMs) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.includes('"toolCall"')) continue;
      const entry = safeParse(line) as { message?: { content?: unknown } } | null;
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type === "toolCall" && part?.name === "bash") {
          const command = commandOf(part.arguments);
          if (command) commands.add(command);
        }
      }
    }
  }
}

let oldBlocks = 0;
let newBlocks = 0;
const unblocked: string[] = [];
const newlyBlocked: string[] = [];
for (const command of commands) {
  const before = judgeOld(command).blocked;
  const after = judgeNew(command).blocked;
  if (before) oldBlocks++;
  if (after) newBlocks++;
  if (before && !after) unblocked.push(command);
  if (!before && after) newlyBlocked.push(command);
}

const show = (list: string[]) => list.slice(0, 25).map((command) => `  - ${command.replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
console.log(`commands: ${commands.size}`);
console.log(`blocked before: ${oldBlocks}  after: ${newBlocks}`);
console.log(`no longer blocked: ${unblocked.length}\n${show(unblocked)}`);
console.log(`newly blocked: ${newlyBlocked.length}\n${show(newlyBlocked)}`);
