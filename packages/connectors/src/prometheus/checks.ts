import type { Severity } from "@kube-triage/core";

export interface Check {
  id: string;
  title: string;
  /** PromQL returning one series per subject (pod). */
  promql: string;
  comparator: ">" | "<";
  threshold: number;
  severity: Severity;
  tags: string[];
  /** Label identifying the subject of each series. */
  subjectLabel: string;
  subjectKind: string;
  unit?: string;
}

/** Escapes a value for use inside a double-quoted PromQL label matcher. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Checks that rely only on kube-state-metrics and cAdvisor, so they work on most clusters.
 * Application-level checks (error rate, latency) depend on how a service is instrumented
 * and are supplied by the caller.
 */
export function defaultChecks(scope: { namespace: string; service?: string | undefined }): Check[] {
  const ns = escapeLabelValue(scope.namespace);
  const podMatcher = scope.service ? `,pod=~"${escapeLabelValue(escapeRegex(scope.service))}.*"` : "";
  const sel = `namespace="${ns}"${podMatcher}`;
  const container = `${sel},container!="",container!="POD"`;

  return [
    {
      id: "restarts",
      title: "Container restarts in the last 10m",
      promql: `sum by (pod) (increase(kube_pod_container_status_restarts_total{${sel}}[10m]))`,
      comparator: ">",
      threshold: 0,
      severity: "warning",
      tags: ["restarts"],
      subjectLabel: "pod",
      subjectKind: "Pod",
    },
    {
      id: "cpu-throttling",
      title: "CPU throttling ratio",
      promql:
        `sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{${container}}[5m]))` +
        ` / sum by (pod) (rate(container_cpu_cfs_periods_total{${container}}[5m]))`,
      comparator: ">",
      threshold: 0.25,
      severity: "warning",
      tags: ["cpu-throttling"],
      subjectLabel: "pod",
      subjectKind: "Pod",
    },
    {
      id: "memory-near-limit",
      title: "Memory use as a fraction of its limit",
      promql:
        `max by (pod) (container_memory_working_set_bytes{${container}})` +
        ` / max by (pod) (kube_pod_container_resource_limits{${sel},resource="memory"})`,
      comparator: ">",
      threshold: 0.9,
      severity: "warning",
      tags: ["memory-pressure"],
      subjectLabel: "pod",
      subjectKind: "Pod",
    },
  ];
}
