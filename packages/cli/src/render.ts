import type { Severity, Timeline } from "@kube-triage/core";

export interface RenderOptions {
  color: boolean;
}

const CODES = { red: 31, yellow: 33, green: 32, cyan: 36, dim: 2, bold: 1 } as const;

function paint(enabled: boolean, code: keyof typeof CODES, text: string): string {
  return enabled ? `\u001b[${CODES[code]}m${text}\u001b[0m` : text;
}

const SEVERITY_LABEL: Record<Severity, { text: string; color: keyof typeof CODES }> = {
  critical: { text: "CRIT", color: "red" },
  warning: { text: "WARN", color: "yellow" },
  info: { text: "INFO", color: "dim" },
};

function clock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

/** Plain-text timeline. Hypotheses cite evidence by its [number] in the list above. */
export function renderTimeline(timeline: Timeline, { color }: RenderOptions): string {
  const { scope, entries, hypotheses, errors } = timeline;
  const lines: string[] = [];
  const target = scope.service ? `${scope.namespace}/${scope.service}` : scope.namespace;
  const minutes = Math.round((Date.parse(scope.to) - Date.parse(scope.from)) / 60_000);

  lines.push(paint(color, "bold", `Investigation of ${target}`));
  lines.push(paint(color, "dim", `${scope.from} to ${scope.to} (${minutes}m, times in UTC)`));
  lines.push("");

  const numberById = new Map<string, number>();
  lines.push(paint(color, "bold", `Timeline (${entries.length} ${entries.length === 1 ? "item" : "items"})`));
  if (entries.length === 0) lines.push("  No evidence of a problem was found in this window.");
  entries.forEach((e, i) => {
    numberById.set(e.id, i + 1);
    const sev = SEVERITY_LABEL[e.severity];
    const n = `[${i + 1}]`.padStart(String(entries.length).length + 2);
    lines.push(
      `  ${n} ${clock(e.observedAt)}  ${paint(color, sev.color, sev.text)}  ${paint(color, "cyan", e.source.padEnd(10))} ${e.summary}`,
    );
  });

  if (hypotheses.length > 0) {
    lines.push("", paint(color, "bold", "Likely causes"));
    hypotheses.forEach((h, i) => {
      const cites = h.evidenceIds.map((id) => numberById.get(id)).filter((n): n is number => n !== undefined);
      lines.push(`  ${i + 1}. ${paint(color, h.confidence === "high" ? "green" : "yellow", `[${h.confidence}]`)} ${h.title}`);
      lines.push(`     ${h.rationale}`);
      lines.push(`     evidence: ${cites.map((n) => `[${n}]`).join(" ")}`);
      for (const check of h.suggestedChecks) lines.push(`     - ${check}`);
    });
  }

  if (errors.length > 0) {
    lines.push("", paint(color, "yellow", "Some sources could not be read, so this picture is incomplete:"));
    for (const err of errors) lines.push(`  ${err.source}: ${err.message}`);
  }
  return lines.join("\n") + "\n";
}
