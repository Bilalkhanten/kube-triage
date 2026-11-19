import { redactValue, type Connector, type CollectOptions, type Evidence, type InvestigationScope } from "@kube-triage/core";
import { defaultChecks, type Check } from "./checks.js";
import { PrometheusClient, type PrometheusClientOptions, type RangeSeries } from "./client.js";

export interface PrometheusConnectorOptions extends PrometheusClientOptions {
  /** Replaces the default checks. Use this to add error-rate or latency checks for your services. */
  checks?: (scope: InvestigationScope) => Check[];
}

export class PrometheusConnector implements Connector {
  readonly name = "prometheus";
  private readonly client: PrometheusClient;
  private readonly checks: (scope: InvestigationScope) => Check[];

  constructor(options: PrometheusConnectorOptions) {
    this.client = new PrometheusClient(options);
    this.checks = options.checks ?? ((scope) => defaultChecks(scope));
  }

  async collect(scope: InvestigationScope, options: CollectOptions = {}): Promise<Evidence[]> {
    const [checkEvidence, alertEvidence] = await Promise.all([
      this.collectChecks(scope, options.signal),
      this.collectAlerts(scope, options.signal),
    ]);
    // Alert annotations are free-form text.
    return [...checkEvidence, ...alertEvidence].map((e) => redactValue(e));
  }

  private async collectChecks(scope: InvestigationScope, signal?: AbortSignal): Promise<Evidence[]> {
    const from = new Date(scope.from);
    const to = new Date(scope.to);
    const stepSeconds = Math.max(15, Math.ceil((to.getTime() - from.getTime()) / 1000 / 120));

    const perCheck = await Promise.all(
      this.checks(scope).map(async (check) => {
        const series = await this.client.queryRange(check.promql, { from, to, stepSeconds }, signal);
        return series.flatMap((s) => evidenceFromSeries(check, s));
      }),
    );
    return perCheck.flat();
  }

  private async collectAlerts(scope: InvestigationScope, signal?: AbortSignal): Promise<Evidence[]> {
    const alerts = await this.client.alerts(signal);
    return alerts
      .filter((a) => a.state === "firing" && a.labels["namespace"] === scope.namespace)
      .map((a) => {
        const name = a.labels["alertname"] ?? "unknown";
        const subject = a.labels["pod"] ?? a.labels["service"] ?? a.labels["deployment"] ?? scope.namespace;
        const sev = a.labels["severity"];
        return {
          id: `prometheus:alert:${name}:${subject}`,
          source: this.name,
          kind: "prom.alert",
          observedAt: new Date(a.activeAt ?? scope.to).toISOString(),
          severity: sev === "critical" ? "critical" : "warning",
          summary: `Alert ${name} is firing${a.annotations["summary"] ? `: ${a.annotations["summary"]}` : ""}`,
          subject: { kind: a.labels["pod"] ? "Pod" : "Namespace", name: subject, namespace: scope.namespace },
          tags: ["alert-firing"],
          data: { labels: a.labels, annotations: a.annotations, value: a.value },
        } satisfies Evidence;
      });
  }
}

function breaches(check: Check, value: number): boolean {
  return Number.isFinite(value) && (check.comparator === ">" ? value > check.threshold : value < check.threshold);
}

function evidenceFromSeries(check: Check, series: RangeSeries): Evidence[] {
  const first = series.values.find(([, v]) => breaches(check, v));
  if (!first) return [];
  const peak = series.values.reduce((p, [, v]) => (Number.isFinite(v) && Math.abs(v) > Math.abs(p) ? v : p), first[1]);
  const subject = series.metric[check.subjectLabel] ?? "unknown";
  const namespace = series.metric["namespace"];
  const peakText = Number.isInteger(peak) ? String(peak) : peak.toFixed(2);

  return [
    {
      id: `prometheus:${check.id}:${subject}`,
      source: "prometheus",
      kind: `prom.check.${check.id}`,
      observedAt: new Date(first[0] * 1000).toISOString(),
      severity: check.severity,
      summary: `${check.title}: ${subject} crossed ${check.comparator} ${check.threshold} (peak ${peakText}${check.unit ?? ""})`,
      subject: { kind: check.subjectKind, name: subject, ...(namespace ? { namespace } : {}) },
      tags: check.tags,
      data: { promql: check.promql, labels: series.metric, peak, threshold: check.threshold },
    },
  ];
}
