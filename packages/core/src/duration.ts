const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses "90s", "30m", "2h", "1d" into milliseconds. */
export function parseDuration(input: string): number {
  const match = /^(\d+)([smhd])$/.exec(input.trim());
  if (!match) throw new Error(`Invalid duration "${input}". Use forms like 90s, 30m, 2h or 1d.`);
  const ms = Number(match[1]) * UNITS[match[2] as string]!;
  if (ms <= 0) throw new Error("Duration must be greater than zero.");
  return ms;
}
