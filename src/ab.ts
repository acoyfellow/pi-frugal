import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSpillConfig, type SpillConfig } from "./spill.ts";

export type Arm = "on" | "off";

export interface AbConfig {
  spill: SpillConfig;
  afterTurn?: string;
}

export function armForSession(sessionId: string): Arm {
  let hash = 2166136261;
  for (let index = 0; index < sessionId.length; index++) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2 === 0 ? "on" : "off";
}

export function parseAbConfig(raw: unknown): AbConfig | undefined {
  if (typeof raw !== "object" || raw === null || !("ab" in raw)) return undefined;
  const ab = (raw as { ab: unknown }).ab;
  if (typeof ab !== "object" || ab === null || !("spill" in ab)) return undefined;
  const spillValue = (ab as { spill: unknown }).spill;
  const spill = typeof spillValue === "string" ? parseSpillConfig(spillValue) : undefined;
  const afterTurnValue = (raw as { afterTurn?: unknown }).afterTurn;
  const afterTurn = typeof afterTurnValue === "string" && afterTurnValue.trim() ? afterTurnValue : undefined;
  if (!spill) return undefined;
  return afterTurn ? { spill, afterTurn } : { spill };
}

export function readAbConfig(dir: string): AbConfig | undefined {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return undefined;
  try {
    return parseAbConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

export function spillForArm(fixed: SpillConfig | undefined, ab: AbConfig | undefined, arm: Arm | undefined): SpillConfig | undefined {
  if (fixed) return fixed;
  if (ab && arm === "on") return ab.spill;
  return undefined;
}

export function readFixedSpill(dir: string): SpillConfig | undefined {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { spill?: unknown };
    return typeof raw.spill === "string" ? parseSpillConfig(raw.spill) : undefined;
  } catch {
    return undefined;
  }
}

export interface CompactAb {
  thresholdTokens: number;
  since: string;
}

export function parseCompactAb(raw: unknown): CompactAb | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const block = (raw as { compactAb?: unknown }).compactAb;
  if (typeof block !== "object" || block === null) return undefined;
  const { thresholdTokens, since } = block as { thresholdTokens?: unknown; since?: unknown };
  if (typeof thresholdTokens !== "number" || !(thresholdTokens >= 50_000) || typeof since !== "string") return undefined;
  return { thresholdTokens, since };
}

export function readCompactAb(dir: string): CompactAb | undefined {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return undefined;
  try {
    return parseCompactAb(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

export function shouldCompactAfterRun(contextTokens: number | undefined, ab: CompactAb | undefined, arm: Arm | undefined): boolean {
  return Boolean(ab && arm === "on" && contextTokens !== undefined && contextTokens >= ab.thresholdTokens);
}

export function readAfterTurn(dir: string): string | undefined {
  const path = join(dir, "config.json");
  if (!existsSync(path)) return undefined;
  try {
    const value = (JSON.parse(readFileSync(path, "utf8")) as { afterTurn?: unknown }).afterTurn;
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}
