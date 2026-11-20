import { describe, expect, it } from "vitest";
import type { InvestigationScope } from "@kube-triage/core";
import { KubernetesConnector, type KubeReader, type PodLogRequest } from "../src/index.js";
import { expectConnectorContract } from "./contract.js";

const scope: InvestigationScope = { namespace: "shop", service: "checkout", from: "2026-01-01T10:00:00Z", to: "2026-01-01T11:00:00Z" };

const crashed = (name: string, restartCount = 3) => ({
  metadata: { name, namespace: "shop", labels: { app: "checkout" } },
  status: {
    phase: "Running",
    containerStatuses: [
      {
        name: "app",
        restartCount,
        state: { waiting: { reason: "CrashLoopBackOff" } },
        lastState: { terminated: { reason: "Error", exitCode: 1, finishedAt: "2026-01-01T10:20:00Z" } },
      },
    ],
  },
});
const healthy = (name: string) => ({
  metadata: { name, namespace: "shop", labels: { app: "checkout" } },
  status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{ name: "app", restartCount: 0, state: {} }] },
});

function readerWith(pods: unknown[], logs: Record<string, string | Error>) {
  const requests: PodLogRequest[] = [];
  const reader: KubeReader = {
    listPods: async () => pods,
    listEvents: async () => [],
    readPodLog: async (r) => {
      requests.push(r);
      const entry = logs[`${r.pod}${r.previous ? ":previous" : ""}`];
      if (entry === undefined) return "";
      if (entry instanceof Error) throw entry;
      return entry;
    },
  };
  return { reader, requests };
}

const log = (time: string, message: string) => `${time} ${message}`;

describe("pod logs", () => {
  it("satisfies the connector contract", async () => {
    const { reader } = readerWith([crashed("checkout-abc")], {
      "checkout-abc:previous": log("2026-01-01T10:19:58.123Z", "ERROR cannot connect to db"),
    });
    await expectConnectorContract(new KubernetesConnector({ reader, podLogs: {} }), scope);
  });

  it("reads the previous instance of a crashing container and keeps only error lines, with their time", async () => {
    const { reader, requests } = readerWith([crashed("checkout-abc")], {
      "checkout-abc:previous": [
        log("2026-01-01T10:19:50.000Z", "INFO starting up"),
        log("2026-01-01T10:19:58.123Z", "ERROR cannot connect to db: connection refused"),
        log("2026-01-01T10:19:59.000Z", "ERROR cannot connect to db: connection refused"),
        log("2026-01-01T10:19:59.500Z", "INFO shutting down"),
      ].join("\n"),
    });
    const evidence = await new KubernetesConnector({ reader, podLogs: { tailLines: 100 } }).collect(scope);
    expect(requests).toEqual([{ namespace: "shop", pod: "checkout-abc", container: "app", previous: true, tailLines: 100 }]);
    const logs = evidence.filter((e) => e.kind === "k8s.pod.log-pattern");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ source: "kubernetes", observedAt: "2026-01-01T10:19:58.123Z", tags: ["log-errors"], severity: "warning" });
    expect(logs[0]?.summary).toContain("(x2)");
    expect(logs[0]?.summary).not.toContain("starting up");
  });

  it("never reads logs of healthy pods", async () => {
    const { reader, requests } = readerWith([healthy("checkout-ok"), crashed("checkout-abc")], {});
    await new KubernetesConnector({ reader, podLogs: {} }).collect(scope);
    expect(requests.map((r) => r.pod)).toEqual(["checkout-abc"]);
  });

  it("does nothing unless pod logs are switched on", async () => {
    const { reader, requests } = readerWith([crashed("checkout-abc")], { "checkout-abc:previous": "2026-01-01T10:19:58Z ERROR x" });
    const evidence = await new KubernetesConnector({ reader }).collect(scope);
    expect(requests).toEqual([]);
    expect(evidence.some((e) => e.kind.startsWith("k8s.pod.log"))).toBe(false);
  });

  it("does nothing when the reader cannot read logs", async () => {
    const reader: KubeReader = { listPods: async () => [crashed("checkout-abc")], listEvents: async () => [] };
    const evidence = await new KubernetesConnector({ reader, podLogs: {} }).collect(scope);
    expect(evidence.some((e) => e.kind.startsWith("k8s.pod.log"))).toBe(false);
  });

  it("redacts secrets in log lines", async () => {
    const { reader } = readerWith([crashed("checkout-abc")], {
      "checkout-abc:previous": log("2026-01-01T10:19:58Z", "ERROR login failed password=hunter2 token=abc123 postgres://app:s3cret@db/x"),
    });
    const evidence = await new KubernetesConnector({ reader, podLogs: {} }).collect(scope);
    const text = JSON.stringify(evidence);
    for (const secret of ["hunter2", "abc123", "s3cret"]) expect(text).not.toContain(secret);
  });

  it("ignores lines outside the window", async () => {
    const { reader } = readerWith([crashed("checkout-abc")], {
      "checkout-abc:previous": [log("2025-12-31T08:00:00Z", "ERROR old problem"), log("2026-01-01T12:00:00Z", "ERROR future problem")].join("\n"),
    });
    const evidence = await new KubernetesConnector({ reader, podLogs: {} }).collect(scope);
    expect(evidence.filter((e) => e.kind === "k8s.pod.log-pattern")).toEqual([]);
  });

  it("reports unreadable logs as evidence without losing the rest", async () => {
    const { reader } = readerWith([crashed("checkout-a"), crashed("checkout-b")], {
      "checkout-a:previous": new Error('previous terminated container "app" in pod "checkout-a" not found, token=abc123'),
      "checkout-b:previous": log("2026-01-01T10:19:58Z", "ERROR boom"),
    });
    const evidence = await new KubernetesConnector({ reader, podLogs: {} }).collect(scope);
    const unavailable = evidence.find((e) => e.kind === "k8s.pod.log-unavailable");
    expect(unavailable?.severity).toBe("info");
    expect(unavailable?.summary).toContain("Could not read logs");
    expect(unavailable?.summary).not.toContain("abc123");
    expect(evidence.some((e) => e.kind === "k8s.pod.log-pattern" && e.subject.name === "checkout-b")).toBe(true);
    // Pod status evidence is still there.
    expect(evidence.some((e) => e.kind === "k8s.pod.container-state")).toBe(true);
  });

  it("caps how many pods are read", async () => {
    const pods = ["a", "b", "c", "d"].map((n) => crashed(`checkout-${n}`));
    const { reader, requests } = readerWith(pods, {});
    await new KubernetesConnector({ reader, podLogs: { maxPods: 2 } }).collect(scope);
    expect(requests).toHaveLength(2);
  });
});
