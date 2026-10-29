export interface SpillConfig {
  thresholdChars: number;
  stubChars: number;
}

export interface SpillDecision {
  spill: boolean;
  stub: string;
}

const TAIL_SHARE = 0.25;

export function parseSpillConfig(value: string | undefined): SpillConfig | undefined {
  if (!value) return undefined;
  const [threshold, stub] = value.split(",").map(Number);
  if (!threshold || threshold <= 0 || stub === undefined || !(stub >= 0) || stub >= threshold) return undefined;
  return { thresholdChars: threshold, stubChars: stub };
}

export function spillStub(text: string, config: SpillConfig, path: string): SpillDecision {
  if (text.length <= config.thresholdChars) return { spill: false, stub: text };
  const tailChars = Math.floor(config.stubChars * TAIL_SHARE);
  const head = text.slice(0, config.stubChars - tailChars);
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  const note = `[pi-frugal: ${text.length - head.length - tail.length} chars of this output were saved to ${path}. Use the read tool on that path, with offset and limit, if you need them.]`;
  return { spill: true, stub: `${head}\n${note}\n${tail}` };
}
