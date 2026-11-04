import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSpillConfig, type SpillConfig } from "./spill.ts";

export type Arm = "on" | "off";

export interface AbConfig {
  spill: SpillConfig;
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
  return spill ? { spill } : undefined;
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
