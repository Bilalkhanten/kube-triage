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

function confidenceFor(evidence: Evidence[]): Confidence {
  const sources = new Set(evidence.map((e) => e.source));
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
  const rank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
}
