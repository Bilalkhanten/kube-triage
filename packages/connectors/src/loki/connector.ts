import { createHash } from "node:crypto";
import {
  redactSecrets,
  redactValue,
  type CollectOptions,
  type Connector,
  type Evidence,
  type InvestigationScope,
} from "@kube-triage/core";
import { escapeLabelValue } from "../prometheus/checks.js";
import { LokiClient, type LogLine, type LokiClientOptions } from "./client.js";

const ERROR_PATTERN = "(?i)(error|exception|panic|fatal|traceback|oomkilled|out of memory|outofmemory)";
const CRITICAL_PATTERN = /\b(panic|fatal)\b|oomkilled|out of memory|outofmemory/i;
// No trailing word boundary: Java reports "OutOfMemoryError".
const OOM_PATTERN = /oomkilled|out of memory|outofmemory/i;
const MAX_SAMPLE_CHARS = 300;

export interface LokiConnectorOptions extends LokiClientOptions {
  /** Log label holding the namespace. */
  namespaceLabel?: string;
  /** Log label holding the pod name. */
  podLabel?: string;
  /** Most lines fetched per investigation. */
  maxLines?: number;
}

/**
 * Finds error-looking log lines in the scope and collapses repeats into one piece of
 * evidence per pod and message shape, so a noisy loop does not flood the timeline.
 */
export class LokiConnector implements Connector {
  readonly name = "loki";
  private readonly client: LokiClient;
  private readonly namespaceLabel: string;
  private readonly podLabel: string;
  private readonly maxLines: number;

  constructor(options: LokiConnectorOptions) {
    this.client = new LokiClient(options);
    this.namespaceLabel = options.namespaceLabel ?? "namespace";
    this.podLabel = options.podLabel ?? "pod";
    this.maxLines = options.maxLines ?? 500;
  }

  async collect(scope: InvestigationScope, options: CollectOptions = {}): Promise<Evidence[]> {
    const lines = await this.client.queryRange(
      this.logql(scope),
      { from: new Date(scope.from), to: new Date(scope.to), limit: this.maxLines },
      options.signal,
    );
    const truncated = lines.length >= this.maxLines;

    const groups = new Map<string, { first: LogLine; count: number; pod: string }>();
    for (const line of lines) {
      const pod = line.labels[this.podLabel] ?? "unknown";
      const key = `${pod}:${signature(line.line)}`;
      const group = groups.get(key);
      if (group) group.count += 1;
      else groups.set(key, { first: line, count: 1, pod });
    }

    return [...groups.entries()].map(([key, g]) => {
      const sample = redactSecrets(g.first.line).slice(0, MAX_SAMPLE_CHARS);
      const critical = CRITICAL_PATTERN.test(g.first.line);
      const tags = ["log-errors"];
      if (OOM_PATTERN.test(g.first.line)) tags.push("oom-killed");
      return redactValue({
        id: `loki:log-pattern:${g.pod}:${createHash("sha1").update(key).digest("hex").slice(0, 10)}`,
        source: this.name,
        kind: "loki.log-pattern",
        observedAt: new Date(g.first.timeMs).toISOString(),
        severity: critical ? ("critical" as const) : ("warning" as const),
        summary: `Log errors in ${g.pod}: ${sample}${g.count > 1 ? ` (x${g.count}${truncated ? "+" : ""})` : ""}`,
        subject: { kind: "Pod", name: g.pod, namespace: scope.namespace },
        tags,
        data: { count: g.count, truncated, firstSeenMs: g.first.timeMs },
      });
    });
  }

  private logql(scope: InvestigationScope): string {
    const ns = escapeLabelValue(scope.namespace);
    const pod = scope.service ? `,${this.podLabel}=~"${escapeLabelValue(escapeRegex(scope.service))}.*"` : "";
    return `{${this.namespaceLabel}="${ns}"${pod}} |~ "${ERROR_PATTERN}"`;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
