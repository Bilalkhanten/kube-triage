import { createHash } from "node:crypto";
import { redactSecrets, redactValue, type Evidence, type InvestigationScope } from "@kube-triage/core";

/** Lines worth looking at. Used as a LogQL regex and in code, so keep it a plain RE2-friendly pattern. */
export const ERROR_PATTERN = "(?i)(error|exception|panic|fatal|traceback|oomkilled|out of memory|outofmemory)";
const ERROR_LINE = /error|exception|panic|fatal|traceback|oomkilled|out of memory|outofmemory/i;
const CRITICAL_PATTERN = /\b(panic|fatal)\b|oomkilled|out of memory|outofmemory/i;
// No trailing word boundary: Java reports "OutOfMemoryError".
const OOM_PATTERN = /oomkilled|out of memory|outofmemory/i;
const MAX_SAMPLE_CHARS = 300;

export interface LogEntry {
  timeMs: number;
  line: string;
  /** Pod the line came from. */
  pod: string;
}

export function looksLikeError(line: string): boolean {
  return ERROR_LINE.test(line);
}

/** Reduces a log line to its shape: ids and numbers removed so repeats group together. */
export function signature(line: string): string {
  return line
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Collapses error lines into one piece of evidence per pod and message shape, with a count and
 * the first time seen, so a noisy loop does not flood the timeline. Samples are redacted and
 * truncated.
 */
export function logPatternEvidence(options: {
  source: string;
  kind: string;
  scope: InvestigationScope;
  entries: LogEntry[];
  /** True when the source may have held more lines than were read. */
  truncated: boolean;
}): Evidence[] {
  const { source, kind, scope, entries, truncated } = options;
  const groups = new Map<string, { first: LogEntry; count: number }>();
  for (const entry of [...entries].sort((a, b) => a.timeMs - b.timeMs)) {
    const key = `${entry.pod}:${signature(entry.line)}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { first: entry, count: 1 });
  }

  return [...groups.entries()].map(([key, g]) => {
    const sample = redactSecrets(g.first.line).slice(0, MAX_SAMPLE_CHARS);
    const tags = ["log-errors"];
    if (OOM_PATTERN.test(g.first.line)) tags.push("oom-killed");
    return redactValue({
      id: `${source}:log-pattern:${g.first.pod}:${createHash("sha1").update(key).digest("hex").slice(0, 10)}`,
      source,
      kind,
      observedAt: new Date(g.first.timeMs).toISOString(),
      severity: CRITICAL_PATTERN.test(g.first.line) ? ("critical" as const) : ("warning" as const),
      summary: `Log errors in ${g.first.pod}: ${sample}${g.count > 1 ? ` (x${g.count}${truncated ? "+" : ""})` : ""}`,
      subject: { kind: "Pod", name: g.first.pod, namespace: scope.namespace },
      tags,
      data: { count: g.count, truncated, firstSeenMs: g.first.timeMs },
    });
  });
}
