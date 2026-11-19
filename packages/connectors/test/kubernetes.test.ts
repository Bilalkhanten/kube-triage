import { describe, expect, it } from "vitest";
import type { InvestigationScope } from "@kube-triage/core";
import { KubernetesConnector, type KubeReader } from "../src/index.js";
import { expectConnectorContract } from "./contract.js";

const scope: InvestigationScope = {
  namespace: "shop",
  service: "checkout",
  from: "2026-01-01T10:00:00Z",
  to: "2026-01-01T11:00:00Z",
};

const pods = [
  {
    metadata: { name: "checkout-abc", namespace: "shop", labels: { app: "checkout" } },
    status: {
      phase: "Running",
      startTime: "2026-01-01T09:00:00Z",
      conditions: [{ type: "Ready", status: "False", reason: "ContainersNotReady", lastTransitionTime: "2026-01-01T10:21:00Z" }],
      containerStatuses: [
        {
          name: "app",
          restartCount: 5,
          state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s restarting failed container" } },
          lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-01-01T10:20:00Z" } },
        },
      ],
    },
  },
  {
    metadata: { name: "checkout-img", namespace: "shop", labels: { app: "checkout" } },
    status: {
      phase: "Pending",
      startTime: "2026-01-01T10:30:00Z",
      containerStatuses: [{ name: "app", restartCount: 0, state: { waiting: { reason: "ImagePullBackOff", message: "pull access denied" } } }],
    },
  },
  {
    metadata: { name: "checkout-pending", namespace: "shop" },
    status: {
      phase: "Pending",
      conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes are available: insufficient memory", lastTransitionTime: "2026-01-01T10:40:00Z" }],
    },
  },
  // Not part of the investigated service:
  {
    metadata: { name: "payments-1", namespace: "shop", labels: { app: "payments" } },
    status: { containerStatuses: [{ name: "app", restartCount: 9, state: { waiting: { reason: "CrashLoopBackOff" } } }] },
  },
  // Healthy pod of the service produces nothing:
  {
    metadata: { name: "checkout-ok", namespace: "shop", labels: { app: "checkout" } },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{ name: "app", restartCount: 0, state: {} }] },
  },
];

const events = [
  { type: "Warning", reason: "BackOff", message: "Back-off restarting failed container app in pod checkout-abc", count: 12, lastTimestamp: "2026-01-01T10:35:00Z", involvedObject: { kind: "Pod", name: "checkout-abc" } },
  { type: "Warning", reason: "FailedScheduling", message: "0/3 nodes are available", eventTime: "2026-01-01T10:40:00Z", involvedObject: { kind: "Pod", name: "checkout-pending" } },
  { type: "Normal", reason: "ScalingReplicaSet", message: "Scaled up replica set checkout-7d to 3", lastTimestamp: "2026-01-01T10:05:00Z", involvedObject: { kind: "Deployment", name: "checkout" } },
  { type: "Normal", reason: "Pulled", message: "Successfully pulled image", lastTimestamp: "2026-01-01T10:06:00Z", involvedObject: { kind: "Pod", name: "checkout-abc" } },
  { type: "Warning", reason: "BackOff", message: "old", lastTimestamp: "2026-01-01T08:00:00Z", involvedObject: { kind: "Pod", name: "checkout-abc" } },
  { type: "Warning", reason: "BackOff", message: "other service", lastTimestamp: "2026-01-01T10:35:00Z", involvedObject: { kind: "Pod", name: "payments-1" } },
  { type: "Warning", reason: "Failed", message: "Failed to pull image: password=hunter2", lastTimestamp: "2026-01-01T10:31:00Z", involvedObject: { kind: "Pod", name: "checkout-img" } },
];

function reader(overrides: Partial<KubeReader> = {}): KubeReader {
  return { listPods: async () => pods, listEvents: async () => events, ...overrides };
}

describe("KubernetesConnector", () => {
  it("satisfies the connector contract", async () => {
    await expectConnectorContract(new KubernetesConnector({ reader: reader() }), scope);
  });

  it("detects crash loops, OOM kills, image pull failures, unschedulable and not-ready pods", async () => {
    const evidence = await new KubernetesConnector({ reader: reader() }).collect(scope);
    const tagsFor = (id: string) => evidence.find((e) => e.id === id)?.tags;

    expect(tagsFor("kubernetes:pod:checkout-abc:app:waiting:CrashLoopBackOff")).toEqual(["crash-loop"]);
    expect(tagsFor("kubernetes:pod:checkout-abc:app:terminated:OOMKilled")).toEqual(["oom-killed"]);
    expect(tagsFor("kubernetes:pod:checkout-abc:app:restarts")).toEqual(["restarts"]);
    expect(tagsFor("kubernetes:pod:checkout-abc:not-ready")).toEqual(["not-ready"]);
    expect(tagsFor("kubernetes:pod:checkout-img:app:waiting:ImagePullBackOff")).toEqual(["image-pull-failure"]);
    expect(tagsFor("kubernetes:pod:checkout-pending:unschedulable")).toEqual(["unschedulable"]);
  });

  it("uses the time the failure actually happened", async () => {
    const evidence = await new KubernetesConnector({ reader: reader() }).collect(scope);
    expect(evidence.find((e) => e.id.endsWith("terminated:OOMKilled"))?.observedAt).toBe("2026-01-01T10:20:00.000Z");
    expect(evidence.find((e) => e.id.endsWith("pending:unschedulable") || e.id.endsWith("checkout-pending:unschedulable"))?.observedAt).toBe(
      "2026-01-01T10:40:00.000Z",
    );
  });

  it("only includes the investigated service", async () => {
    const evidence = await new KubernetesConnector({ reader: reader() }).collect(scope);
    expect(evidence.some((e) => e.subject.name === "payments-1")).toBe(false);
    expect(evidence.some((e) => e.subject.name === "checkout-ok")).toBe(false);
  });

  it("keeps warnings and notable rollout events inside the window, drops the rest", async () => {
    const evidence = await new KubernetesConnector({ reader: reader() }).collect(scope);
    const events = evidence.filter((e) => e.kind === "k8s.event");
    const reasons = events.map((e) => e.summary);
    expect(reasons.some((s) => s.includes("ScalingReplicaSet"))).toBe(true);
    expect(reasons.some((s) => s.includes("Pulled"))).toBe(false); // uninteresting Normal event
    expect(reasons.some((s) => s.includes("old"))).toBe(false); // outside the window
    expect(reasons.some((s) => s.includes("other service"))).toBe(false);
    expect(events.find((e) => e.summary.includes("FailedScheduling"))?.tags).toEqual(["unschedulable"]);
    // Rollouts are tagged so they can be correlated with the problems that follow.
    expect(events.find((e) => e.summary.includes("ScalingReplicaSet"))?.tags).toEqual(["rollout"]);
  });

  it("does not require a service filter", async () => {
    const evidence = await new KubernetesConnector({ reader: reader() }).collect({ ...scope, service: undefined });
    expect(evidence.some((e) => e.subject.name === "payments-1")).toBe(true);
  });

  it("accepts Date objects as returned by the official client", async () => {
    const withDates = [
      {
        metadata: { name: "checkout-d" },
        status: {
          containerStatuses: [
            {
              name: "app",
              restartCount: 1,
              state: {},
              lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: new Date("2026-01-01T10:20:00Z") } },
            },
          ],
        },
      },
    ];
    const evidence = await new KubernetesConnector({ reader: reader({ listPods: async () => withDates, listEvents: async () => [] }) }).collect(scope);
    expect(evidence[0]?.observedAt).toBe("2026-01-01T10:20:00.000Z");
  });

  it("fails loudly on a malformed API response instead of guessing", async () => {
    const bad = reader({ listPods: async () => [{ nope: true }] });
    await expect(new KubernetesConnector({ reader: bad }).collect(scope)).rejects.toThrow();
  });
});
