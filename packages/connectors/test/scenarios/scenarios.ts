import { crashLooping, pod, scaled, warning, type World } from "./world.js";

export interface Scenario {
  name: string;
  world: World;
  /** The hypothesis that must rank first, or "none" when nothing should be suspected. */
  top: string | "none";
  /** Hypotheses that must also appear. */
  includes?: string[];
  /** Hypotheses that must NOT appear. */
  excludes?: string[];
  /** The minimum confidence of the top hypothesis. */
  minConfidence?: "low" | "medium" | "high";
  /** Connector names expected to be reported as unreadable. */
  errors?: string[];
}

const oomPod = pod("checkout-abc", {
  containers: [crashLooping(5, { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-01-01T10:20:00Z" })],
  ready: false,
});

export const SCENARIOS: Scenario[] = [
  {
    name: "healthy service produces nothing to suspect",
    world: { pods: [pod("checkout-abc"), pod("checkout-def")] },
    top: "none",
  },
  {
    name: "container OOM-killed",
    world: { pods: [oomPod], memory: [["checkout-abc", [["2026-01-01T10:15:00Z", 0.97]]]] },
    top: "oom-killed",
    includes: ["oom-killed"],
  },
  {
    name: "OOM confirmed by Kubernetes and by the logs of the same pod",
    world: {
      pods: [oomPod],
      logs: [["2026-01-01T10:19:50Z", "java.lang.OutOfMemoryError: Java heap space"]],
    },
    top: "oom-killed",
    minConfidence: "high",
  },
  {
    name: "image cannot be pulled",
    world: {
      pods: [pod("checkout-img", { phase: "Pending", containers: [{ name: "app", restartCount: 0, state: { waiting: { reason: "ImagePullBackOff", message: "pull access denied" } } }] })],
    },
    top: "image-pull-failure",
  },
  {
    name: "pod cannot be scheduled",
    world: {
      pods: [pod("checkout-pending", { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes are available: insufficient memory", lastTransitionTime: "2026-01-01T10:40:00Z" }], containers: [] })],
      events: [warning("checkout-pending", "FailedScheduling", "0/3 nodes are available", "2026-01-01T10:40:00Z")],
    },
    top: "unschedulable",
    minConfidence: "low",
  },
  {
    name: "readiness probe failing on a running pod",
    world: {
      pods: [pod("checkout-abc", { ready: false })],
      events: [warning("checkout-abc", "Unhealthy", "Readiness probe failed: HTTP probe failed with statuscode: 503", "2026-01-01T10:30:00Z")],
    },
    top: "probe-failure",
  },
  {
    name: "missing ConfigMap blocks the container",
    world: {
      pods: [pod("checkout-cfg", { phase: "Pending", containers: [{ name: "app", restartCount: 0, state: { waiting: { reason: "CreateContainerConfigError", message: 'configmap "checkout-config" not found' } } }] })],
    },
    top: "config-error",
  },
  {
    name: "crash loop with errors in the logs",
    world: {
      pods: [pod("checkout-abc", { containers: [crashLooping(7, { reason: "Error", exitCode: 1, finishedAt: "2026-01-01T10:25:00Z" })], ready: false })],
      logs: [["2026-01-01T10:24:55Z", "ERROR failed to connect to db: connection refused"]],
    },
    top: "crash-loop",
    includes: ["app-errors"],
  },
  {
    name: "crash loop explained by the previous container's logs, read through Kubernetes",
    world: {
      pods: [pod("checkout-abc", { containers: [crashLooping(7, { reason: "Error", exitCode: 1, finishedAt: "2026-01-01T10:25:00Z" })], ready: false })],
      podLogs: {
        "checkout-abc:previous": [
          "2026-01-01T10:24:50.000Z INFO starting checkout",
          "2026-01-01T10:24:55.000Z ERROR missing required setting PAYMENTS_URL",
        ],
      },
      down: ["loki"],
    },
    top: "crash-loop",
    includes: ["app-errors"],
    errors: ["loki"],
  },
  {
    name: "out of memory seen only in pod logs still supports the OOM cause",
    world: {
      pods: [pod("checkout-abc", { containers: [crashLooping(3, { reason: "Error", exitCode: 1, finishedAt: "2026-01-01T10:25:00Z" })], ready: false })],
      podLogs: { "checkout-abc:previous": ["2026-01-01T10:24:55.000Z java.lang.OutOfMemoryError: Java heap space"] },
    },
    // The out-of-memory message explains the crash loop, so it outranks the symptom.
    top: "oom-killed",
    includes: ["crash-loop"],
  },
  {
    name: "CPU throttling alone",
    world: { throttling: [["checkout-abc", [["2026-01-01T10:20:00Z", 0.6]]]] },
    top: "cpu-throttling",
    excludes: ["crash-loop", "oom-killed"],
  },
  {
    name: "pod evicted",
    world: { events: [warning("checkout-abc", "Evicted", "The node was low on resource: memory", "2026-01-01T10:30:00Z")] },
    top: "eviction",
  },
  {
    name: "volume cannot be mounted",
    world: { events: [warning("checkout-abc", "FailedMount", "Unable to attach or mount volumes", "2026-01-01T10:30:00Z")] },
    top: "mount-failure",
  },
  {
    name: "bad deploy: crash loop begins minutes after a recorded deployment",
    world: {
      deployments: [{ id: 7, sha: "c0ffee1234567890", at: "2026-01-01T10:15:00Z" }],
      pods: [pod("checkout-abc", { containers: [crashLooping(4, { reason: "Error", exitCode: 1, finishedAt: "2026-01-01T10:19:00Z" })], ready: false })],
      restarts: [["checkout-abc", [["2026-01-01T10:20:00Z", 3]]]],
    },
    top: "recent-change",
    includes: ["crash-loop"],
    minConfidence: "high",
  },
  {
    name: "rollout alone is only weak suspicion",
    world: {
      pods: [pod("checkout-abc", { containers: [crashLooping(4, { reason: "Error", exitCode: 1, finishedAt: "2026-01-01T10:19:00Z" })], ready: false })],
      events: [scaled("2026-01-01T10:15:00Z")],
    },
    top: "crash-loop",
    includes: ["recent-change"],
  },
  {
    name: "a deploy AFTER the failures is not blamed",
    world: {
      deployments: [{ id: 8, sha: "deadbeef12345678", at: "2026-01-01T10:45:00Z" }],
      pods: [pod("checkout-abc", { containers: [crashLooping(4, { reason: "Error", exitCode: 1, finishedAt: "2026-01-01T10:19:00Z" })], ready: false })],
      restarts: [["checkout-abc", [["2026-01-01T10:20:00Z", 3]]]],
    },
    top: "crash-loop",
    excludes: ["recent-change"],
  },
  {
    name: "a deploy long before the failures is not blamed",
    world: {
      deployments: [{ id: 9, sha: "0123456789abcdef", at: "2026-01-01T10:01:00Z" }],
      restarts: [["checkout-abc", [["2026-01-01T10:50:00Z", 3]]]],
    },
    top: "crash-loop",
    excludes: ["recent-change"],
  },
  {
    name: "Prometheus down: still diagnoses from Kubernetes and says what it could not read",
    world: { pods: [oomPod], down: ["prometheus"] },
    top: "oom-killed",
    errors: ["prometheus"],
  },
  {
    name: "Kubernetes down: diagnoses from metrics and logs",
    world: {
      restarts: [["checkout-abc", [["2026-01-01T10:20:00Z", 3]]]],
      down: ["kubernetes"],
    },
    top: "crash-loop",
    errors: ["kubernetes"],
  },
  {
    name: "every source down: no evidence, no invented cause, all errors reported",
    world: { down: ["prometheus", "loki", "github", "kubernetes"] },
    top: "none",
    errors: ["kubernetes", "prometheus", "loki", "github-deploys"],
  },
];
