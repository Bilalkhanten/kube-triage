import { redactSecrets, redactValue, type CollectOptions, type Connector, type Evidence, type InvestigationScope, type Severity } from "@kube-triage/core";
import { looksLikeError, logPatternEvidence, type LogEntry } from "../logs.js";
import { EventSchema, PodSchema, type KubeEvent, type KubeReader, type Pod } from "./reader.js";

const WAITING_REASONS: Record<string, { tags: string[]; severity: Severity }> = {
  CrashLoopBackOff: { tags: ["crash-loop"], severity: "critical" },
  ImagePullBackOff: { tags: ["image-pull-failure"], severity: "critical" },
  ErrImagePull: { tags: ["image-pull-failure"], severity: "critical" },
  InvalidImageName: { tags: ["image-pull-failure"], severity: "critical" },
  CreateContainerConfigError: { tags: ["config-error"], severity: "critical" },
  CreateContainerError: { tags: ["config-error"], severity: "critical" },
};

/** Normal events worth showing because they mark rollouts and lifecycle changes. */
const NOTABLE_NORMAL_REASONS = new Set([
  "Killing",
  "ScalingReplicaSet",
  "SuccessfulCreate",
  "SuccessfulDelete",
  "Scheduled",
]);

const RESTART_THRESHOLD = 3;

export interface KubernetesConnectorOptions {
  reader: KubeReader;
  /** Read recent logs of unhealthy pods. Only takes effect when the reader can read logs. */
  podLogs?: { tailLines?: number; maxPods?: number };
}

export class KubernetesConnector implements Connector {
  readonly name = "kubernetes";
  private readonly reader: KubeReader;
  private readonly podLogs: { tailLines: number; maxPods: number } | undefined;

  constructor(options: KubernetesConnectorOptions) {
    this.reader = options.reader;
    this.podLogs = options.podLogs ? { tailLines: options.podLogs.tailLines ?? 200, maxPods: options.podLogs.maxPods ?? 5 } : undefined;
  }

  async collect(scope: InvestigationScope, options: CollectOptions = {}): Promise<Evidence[]> {
    const [rawPods, rawEvents] = await Promise.all([
      this.reader.listPods(scope.namespace, options.signal),
      this.reader.listEvents(scope.namespace, options.signal),
    ]);
    const pods = rawPods.map((p) => PodSchema.parse(p)).filter((p) => matchesService(p.metadata.name, p.metadata.labels, scope.service));
    const events = rawEvents.map((e) => EventSchema.parse(e));

    const logEvidence = this.podLogs && this.reader.readPodLog ? await this.readLogs(pods, scope, options.signal) : [];

    // Event messages, pod status text and log lines are free-form and can contain secrets.
    return [
      ...pods.flatMap((p) => podEvidence(p, scope)),
      ...events.flatMap((e) => eventEvidence(e, scope)),
      ...logEvidence,
    ].map((e) => redactValue(e));
  }

  /** Reads the logs of a few unhealthy pods and keeps only their error lines. */
  private async readLogs(pods: Pod[], scope: InvestigationScope, signal?: AbortSignal): Promise<Evidence[]> {
    const config = this.podLogs as { tailLines: number; maxPods: number };
    const read = this.reader.readPodLog as NonNullable<KubeReader["readPodLog"]>;
    const from = Date.parse(scope.from);
    const to = Date.parse(scope.to);
    const out: Evidence[] = [];
    let truncated = false;

    const targets = pods.flatMap((pod) => logTargets(pod).map((t) => ({ pod: pod.metadata.name, ...t }))).slice(0, config.maxPods);
    for (const t of targets) {
      let text: string;
      try {
        text = await read({ namespace: scope.namespace, pod: t.pod, container: t.container, previous: t.previous, tailLines: config.tailLines }, signal);
      } catch (error) {
        // A pod whose logs cannot be read (no previous instance, permission) must not hide the rest.
        out.push({
          id: `kubernetes:pod:${t.pod}:${t.container}:log-unavailable`,
          source: "kubernetes",
          kind: "k8s.pod.log-unavailable",
          observedAt: new Date(to).toISOString(),
          severity: "info",
          summary: `Could not read logs of ${t.container} in ${t.pod}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`.slice(0, 300),
          subject: { kind: "Pod", name: t.pod, namespace: scope.namespace },
          tags: [],
          data: { container: t.container, previous: t.previous },
        });
        continue;
      }
      const lines = text.split("\n").filter(Boolean);
      if (lines.length >= config.tailLines) truncated = true;
      const entries: LogEntry[] = [];
      for (const raw of lines) {
        const { timeMs, line } = parseLogLine(raw, to);
        if (timeMs < from || timeMs > to || !looksLikeError(line)) continue;
        entries.push({ timeMs, line, pod: t.pod });
      }
      out.push(...logPatternEvidence({ source: "kubernetes", kind: "k8s.pod.log-pattern", scope, entries, truncated }));
    }
    return out;
  }
}

function matchesService(name: string, labels: Record<string, string> | undefined, service?: string): boolean {
  if (!service) return true;
  return (
    name === service ||
    name.startsWith(`${service}-`) ||
    labels?.["app"] === service ||
    labels?.["app.kubernetes.io/name"] === service
  );
}

function podEvidence(pod: Pod, scope: InvestigationScope): Evidence[] {
  const out: Evidence[] = [];
  const name = pod.metadata.name;
  const subject = { kind: "Pod", name, namespace: scope.namespace };
  const fallbackTime = pod.status?.startTime ?? new Date(scope.to);

  for (const cs of pod.status?.containerStatuses ?? []) {
    const waiting = cs.state?.waiting;
    const waitingRule = waiting?.reason ? WAITING_REASONS[waiting.reason] : undefined;
    const lastTerminated = cs.lastState?.terminated ?? cs.state?.terminated;

    if (waiting?.reason && waitingRule) {
      out.push({
        id: `kubernetes:pod:${name}:${cs.name}:waiting:${waiting.reason}`,
        source: "kubernetes",
        kind: "k8s.pod.container-state",
        observedAt: (lastTerminated?.finishedAt ?? fallbackTime).toISOString(),
        severity: waitingRule.severity,
        summary: `Container ${cs.name} in ${name} is ${waiting.reason}${waiting.message ? `: ${waiting.message}` : ""}`,
        subject,
        tags: waitingRule.tags,
        data: { container: cs.name, reason: waiting.reason, restartCount: cs.restartCount },
      });
    }

    if (lastTerminated?.reason === "OOMKilled") {
      out.push({
        id: `kubernetes:pod:${name}:${cs.name}:terminated:OOMKilled`,
        source: "kubernetes",
        kind: "k8s.pod.container-terminated",
        observedAt: (lastTerminated.finishedAt ?? fallbackTime).toISOString(),
        severity: "critical",
        summary: `Container ${cs.name} in ${name} was OOMKilled (exit code ${lastTerminated.exitCode ?? "unknown"})`,
        subject,
        tags: ["oom-killed"],
        data: { container: cs.name, exitCode: lastTerminated.exitCode, restartCount: cs.restartCount },
      });
    } else if (lastTerminated && (lastTerminated.exitCode ?? 0) !== 0) {
      out.push({
        id: `kubernetes:pod:${name}:${cs.name}:terminated:${lastTerminated.reason ?? "Error"}`,
        source: "kubernetes",
        kind: "k8s.pod.container-terminated",
        observedAt: (lastTerminated.finishedAt ?? fallbackTime).toISOString(),
        severity: "warning",
        summary: `Container ${cs.name} in ${name} exited with code ${lastTerminated.exitCode}${lastTerminated.reason ? ` (${lastTerminated.reason})` : ""}`,
        subject,
        tags: ["container-error"],
        data: { container: cs.name, exitCode: lastTerminated.exitCode, reason: lastTerminated.reason },
      });
    }

    if (cs.restartCount >= RESTART_THRESHOLD) {
      out.push({
        id: `kubernetes:pod:${name}:${cs.name}:restarts`,
        source: "kubernetes",
        kind: "k8s.pod.restarts",
        observedAt: new Date(scope.to).toISOString(),
        severity: "warning",
        summary: `Container ${cs.name} in ${name} has restarted ${cs.restartCount} times`,
        subject,
        tags: ["restarts"],
        data: { container: cs.name, restartCount: cs.restartCount },
      });
    }
  }

  for (const cond of pod.status?.conditions ?? []) {
    if (cond.type === "PodScheduled" && cond.status === "False") {
      out.push({
        id: `kubernetes:pod:${name}:unschedulable`,
        source: "kubernetes",
        kind: "k8s.pod.condition",
        observedAt: (cond.lastTransitionTime ?? fallbackTime).toISOString(),
        severity: "critical",
        summary: `Pod ${name} cannot be scheduled${cond.message ? `: ${cond.message}` : ""}`,
        subject,
        tags: ["unschedulable"],
        data: { reason: cond.reason },
      });
    }
    if (cond.type === "Ready" && cond.status === "False" && pod.status?.phase === "Running") {
      out.push({
        id: `kubernetes:pod:${name}:not-ready`,
        source: "kubernetes",
        kind: "k8s.pod.condition",
        observedAt: (cond.lastTransitionTime ?? fallbackTime).toISOString(),
        severity: "warning",
        summary: `Pod ${name} is running but not ready${cond.reason ? ` (${cond.reason})` : ""}`,
        subject,
        tags: ["not-ready"],
        data: { reason: cond.reason, message: cond.message },
      });
    }
  }
  return out;
}

function eventTime(e: KubeEvent): Date | undefined {
  return e.eventTime ?? e.lastTimestamp ?? e.firstTimestamp ?? e.metadata?.creationTimestamp;
}

function eventTags(e: KubeEvent): string[] {
  const reason = e.reason ?? "";
  const message = e.message ?? "";
  const tags: string[] = [];
  if (reason === "FailedScheduling") tags.push("unschedulable");
  if (reason === "BackOff" && /restarting failed container/i.test(message)) tags.push("crash-loop");
  if (/ErrImagePull|ImagePullBackOff|Failed to pull image/i.test(`${reason} ${message}`)) tags.push("image-pull-failure");
  if (reason === "Unhealthy") tags.push("probe-failure");
  if (reason === "OOMKilling" || /out of memory/i.test(message)) tags.push("oom-killed");
  if (reason === "FailedMount" || reason === "FailedAttachVolume") tags.push("mount-failure");
  if (reason === "Evicted") tags.push("evicted");
  // A Deployment scaling ReplicaSets is how rollouts show up. It also happens on plain scaling,
  // so correlation treats it as weaker evidence than a recorded deployment.
  if (reason === "ScalingReplicaSet") tags.push("rollout");
  return tags;
}

function eventEvidence(e: KubeEvent, scope: InvestigationScope): Evidence[] {
  const time = eventTime(e);
  const objectName = e.involvedObject.name;
  if (!time || !objectName || !e.reason) return [];
  if (time.getTime() < Date.parse(scope.from) || time.getTime() > Date.parse(scope.to)) return [];
  if (scope.service && !matchesService(objectName, undefined, scope.service)) return [];

  const isWarning = e.type === "Warning";
  if (!isWarning && !NOTABLE_NORMAL_REASONS.has(e.reason)) return [];

  const times = e.count && e.count > 1 ? ` (x${e.count})` : "";
  return [
    {
      id: `kubernetes:event:${e.involvedObject.kind ?? "Object"}:${objectName}:${e.reason}`,
      source: "kubernetes",
      kind: "k8s.event",
      observedAt: time.toISOString(),
      severity: isWarning ? "warning" : "info",
      summary: `${e.involvedObject.kind ?? "Object"} ${objectName}: ${e.reason}${e.message ? ` - ${e.message}` : ""}${times}`,
      subject: { kind: e.involvedObject.kind ?? "Object", name: objectName, namespace: scope.namespace },
      tags: eventTags(e),
      data: { reason: e.reason, type: e.type, count: e.count },
    },
  ];
}

/** Containers whose logs are worth reading: crashing, restarted, or last exited with an error. */
function logTargets(pod: Pod): Array<{ container: string; previous: boolean }> {
  const targets: Array<{ container: string; previous: boolean }> = [];
  for (const cs of pod.status?.containerStatuses ?? []) {
    const lastExit = cs.lastState?.terminated ?? cs.state?.terminated;
    const failedExit = lastExit !== undefined && (lastExit.exitCode ?? 0) !== 0;
    const crashing = cs.state?.waiting?.reason === "CrashLoopBackOff";
    if (!failedExit && !crashing && cs.restartCount < 1) continue;
    // The crashed instance holds the explanation; the current one may have just started.
    targets.push({ container: cs.name, previous: cs.restartCount > 0 || cs.lastState?.terminated !== undefined });
  }
  return targets;
}

const TIMESTAMPED = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s(.*)$/;

/** Splits "2026-01-01T10:20:00.123Z message" into time and message; unstamped lines get a fallback time. */
function parseLogLine(raw: string, fallbackMs: number): { timeMs: number; line: string } {
  const m = TIMESTAMPED.exec(raw);
  if (!m) return { timeMs: fallbackMs, line: raw };
  const t = Date.parse(m[1] as string);
  return { timeMs: Number.isNaN(t) ? fallbackMs : t, line: m[2] as string };
}
