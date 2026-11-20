import { type CollectOptions, type Connector, type Evidence, type InvestigationScope } from "@kube-triage/core";
import { ERROR_PATTERN, logPatternEvidence } from "../logs.js";
import { escapeLabelValue } from "../prometheus/checks.js";
import { LokiClient, type LokiClientOptions } from "./client.js";

export interface LokiConnectorOptions extends LokiClientOptions {
  /** Log label holding the namespace. */
  namespaceLabel?: string;
  /** Log label holding the pod name. */
  podLabel?: string;
  /** Most lines fetched per investigation. */
  maxLines?: number;
}

/**
 * Finds error-looking log lines in the scope and collapses repeats into one piece of evidence
 * per pod and message shape, so a noisy loop does not flood the timeline.
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
    return logPatternEvidence({
      source: this.name,
      kind: "loki.log-pattern",
      scope,
      entries: lines.map((l) => ({ timeMs: l.timeMs, line: l.line, pod: l.labels[this.podLabel] ?? "unknown" })),
      truncated: lines.length >= this.maxLines,
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
