import type { Confidence, Evidence, Hypothesis } from "./schemas.js";

interface Rule {
  id: string;
  /** Evidence carrying any of these tags supports the rule. */
  tags: string[];
  title: string;
  rationale: string;
  checks: string[];
}

const RULES: Rule[] = [
  {
    id: "oom-killed",
    tags: ["oom-killed", "memory-pressure"],
    title: "Container is running out of memory",
    rationale: "A container was OOM-killed or is close to its memory limit.",
    checks: [
      "Compare memory working set with the container's memory limit over the window.",
      "Check whether memory use grew after a recent deploy or traffic increase.",
    ],
  },
  {
    id: "crash-loop",
    tags: ["crash-loop", "container-error", "restarts"],
    title: "Container is crash looping",
    rationale: "A container is repeatedly exiting or restarting.",
    checks: [
      "Read the previous container's logs (`kubectl logs --previous`).",
      "Look at the exit code and last termination reason in the pod status.",
    ],
  },
  {
    id: "image-pull-failure",
    tags: ["image-pull-failure"],
    title: "Image cannot be pulled",
    rationale: "The kubelet cannot pull the container image.",
    checks: [
      "Verify the image name and tag exist in the registry.",
      "Check the imagePullSecrets and registry credentials in the namespace.",
    ],
  },
  {
    id: "config-error",
    tags: ["config-error"],
    title: "Container cannot start because of its configuration",
    rationale: "A referenced ConfigMap, Secret or similar object is missing or invalid.",
    checks: ["Check that referenced ConfigMaps and Secrets exist and have the expected keys."],
  },
  {
    id: "unschedulable",
    tags: ["unschedulable"],
    title: "Pod cannot be scheduled",
    rationale: "The scheduler cannot find a node that satisfies the pod's requirements.",
    checks: [
      "Compare the pod's resource requests with free capacity on the nodes.",
      "Check node taints, affinity rules and PersistentVolume zone constraints.",
    ],
  },
  {
    id: "probe-failure",
    tags: ["probe-failure", "not-ready"],
    title: "Pod is failing readiness or liveness checks",
    rationale: "The pod is running but is not passing its health probes.",
    checks: [
      "Check the probe path, port and timeout against what the app actually serves.",
      "Check dependencies the health endpoint relies on (database, cache, upstream).",
    ],
  },
  {
    id: "cpu-throttling",
    tags: ["cpu-throttling"],
    title: "CPU is being throttled",
    rationale: "The container is hitting its CPU limit, which adds latency.",
    checks: ["Compare CPU usage with the CPU limit and consider raising the limit."],
  },
  {
    id: "app-errors",
    tags: ["log-errors"],
    title: "Application is logging errors",
    rationale: "Error-level messages appear in the logs inside the investigated window.",
    checks: [
      "Read the first occurrence of each log pattern and compare its time with the first failure above.",
      "Check whether the errors point at a dependency (database, cache, upstream service).",
    ],
  },
  {
    id: "mount-failure",
    tags: ["mount-failure"],
    title: "Volume cannot be mounted",
    rationale: "A volume failed to attach or mount.",
    checks: ["Check the PersistentVolumeClaim status and the storage backend."],
  },
  {
    id: "eviction",
    tags: ["evicted"],
    title: "Pod was evicted from its node",
    rationale: "The node ran short of a resource and evicted the pod.",
    checks: ["Check node conditions (MemoryPressure, DiskPressure) at that time."],
  },
];

/** Every hypothesis id this engine can produce. Runbooks are matched against these. */
export const HYPOTHESIS_IDS: readonly string[] = [...RULES.map((r) => r.id), "recent-change"];

function confidenceFor(evidence: Evidence[]): Confidence {
  // Loki and kubectl logs read the same log lines, so they are one origin, not two witnesses.
  const sources = new Set(evidence.map((e) => (e.kind.endsWith(".log-pattern") ? "logs" : e.source)));
  const hasCritical = evidence.some((e) => e.severity === "critical");
  if (sources.size >= 2) return "high";
  if (hasCritical || evidence.length >= 2) return "medium";
  return "low";
}

/**
 * Rule-based and deterministic: every hypothesis cites the evidence it rests on.
 * Confidence rises when independent sources agree.
 */
export function deriveHypotheses(entries: Evidence[]): Hypothesis[] {
  const out: Hypothesis[] = [];
  for (const rule of RULES) {
    const supporting = entries.filter((e) => e.tags.some((t) => rule.tags.includes(t)));
    if (supporting.length === 0) continue;
    out.push({
      id: rule.id,
      title: rule.title,
      confidence: confidenceFor(supporting),
      rationale: rule.rationale,
      evidenceIds: supporting.map((e) => e.id),
      suggestedChecks: rule.checks,
    });
  }
  const change = recentChangeHypothesis(entries);
  if (change) out.push(change);
  // Most confident first. Among equals, a strongly supported change goes first: "this began right
  // after a deployment" is the most actionable thing to know. A weaker suspicion (for example a
  // bare rollout, which an autoscaler also causes) keeps its normal place. Array.sort is stable,
  // so otherwise rule order decides.
  const rank: Record<Confidence, number> = { high: 0, medium: 2, low: 4 };
  const key = (h: Hypothesis) => rank[h.confidence] + (h.id === "recent-change" && h.confidence === "high" ? -0.5 : 0);
  return out.sort((a, b) => key(a) - key(b));
}

const CHANGE_TAGS = ["deploy", "rollout"];
/** A change only counts as a suspect if the first problem follows it this closely. */
const CORRELATION_WINDOW_MS = 30 * 60_000;
const TIGHT_WINDOW_MS = 10 * 60_000;

/**
 * Looks for a deploy or rollout shortly before the first problem. It is correlation, not proof:
 * a change that comes after the first problem is never blamed, and the confidence stays modest
 * unless a recorded deployment and an independent source agree on a tight gap.
 */
function recentChangeHypothesis(entries: Evidence[]): Hypothesis | undefined {
  const isChange = (e: Evidence) => e.tags.some((t) => CHANGE_TAGS.includes(t));
  const problems = entries.filter((e) => !isChange(e) && e.severity !== "info");
  const changes = entries.filter(isChange);
  if (problems.length === 0 || changes.length === 0) return undefined;

  const firstProblem = problems.reduce((a, b) => (Date.parse(b.observedAt) < Date.parse(a.observedAt) ? b : a));
  const firstProblemMs = Date.parse(firstProblem.observedAt);

  // The change closest before the first problem, within the window.
  const suspect = changes
    .filter((c) => {
      const gap = firstProblemMs - Date.parse(c.observedAt);
      return gap >= 0 && gap <= CORRELATION_WINDOW_MS;
    })
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  if (!suspect) return undefined;

  const gapMs = firstProblemMs - Date.parse(suspect.observedAt);
  const recordedDeploy = suspect.tags.includes("deploy");
  const independent = suspect.source !== firstProblem.source;
  const confidence: Confidence = recordedDeploy ? (gapMs <= TIGHT_WINDOW_MS && independent ? "high" : "medium") : gapMs <= TIGHT_WINDOW_MS ? "medium" : "low";
  const minutes = Math.round(gapMs / 60_000);

  return {
    id: "recent-change",
    title: recordedDeploy ? "Problems began shortly after a deployment" : "Problems began shortly after a rollout",
    confidence,
    rationale: `The first problem appeared ${minutes === 0 ? "within a minute" : `${minutes} minute${minutes === 1 ? "" : "s"}`} after the change. This is correlation, not proof.`,
    evidenceIds: [suspect.id, firstProblem.id],
    suggestedChecks: [
      "Compare what the change contained with what is failing.",
      "If the change is the cause, rolling back is the usual remedy. kube-triage never does that itself.",
    ],
  };
}
