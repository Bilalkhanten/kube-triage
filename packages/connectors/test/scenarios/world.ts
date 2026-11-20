import { investigate, type Timeline } from "@kube-triage/core";
import {
  GitHubDeploysConnector,
  KubernetesConnector,
  LokiConnector,
  PrometheusConnector,
  type KubeReader,
} from "../../src/index.js";

/**
 * A small fake world: pods, events, metric series, firing alerts, log lines and deployments.
 * Scenarios describe it declaratively and run it through the REAL connectors and the REAL
 * investigation engine, so a scenario exercises everything except the network.
 */
export const SCOPE = { namespace: "shop", service: "checkout", from: "2026-01-01T10:00:00Z", to: "2026-01-01T11:00:00Z" };
export const NOW = new Date(SCOPE.to);

const sec = (iso: string) => Date.parse(iso) / 1000;
const ns = (iso: string) => `${Date.parse(iso)}000000`;

export interface World {
  pods?: unknown[];
  events?: unknown[];
  /** Metric samples by check: [pod, [[isoTime, value], ...]] */
  restarts?: Array<[string, Array<[string, number]>]>;
  throttling?: Array<[string, Array<[string, number]>]>;
  memory?: Array<[string, Array<[string, number]>]>;
  alerts?: Array<{ name: string; pod: string; at: string; severity?: string }>;
  logs?: Array<[string, string]>;
  /** Pod logs read through Kubernetes, keyed "pod" or "pod:previous"; each entry is timestamped lines. */
  podLogs?: Record<string, string[]>;
  deployments?: Array<{ id: number; sha: string; at: string; environment?: string; state?: string }>;
  /** Sources that are down for this scenario. */
  down?: Array<"prometheus" | "loki" | "github" | "kubernetes">;
}

const json = (body: unknown) => new Response(JSON.stringify(body));

function promFetch(world: World): typeof fetch {
  return async (input) => {
    const url = new URL(input.toString());
    const q = url.searchParams.get("query") ?? "";
    if (url.pathname === "/api/v1/alerts") {
      return json({
        status: "success",
        data: {
          alerts: (world.alerts ?? []).map((a) => ({
            labels: { alertname: a.name, namespace: "shop", pod: a.pod, severity: a.severity ?? "critical" },
            annotations: {},
            state: "firing",
            activeAt: a.at,
          })),
        },
      });
    }
    const pick = q.includes("restarts_total") ? world.restarts : q.includes("throttled_periods") ? world.throttling : q.includes("working_set_bytes") ? world.memory : [];
    const result = (pick ?? []).map(([pod, samples]) => ({
      metric: { pod, namespace: "shop" },
      values: samples.map(([t, v]) => [sec(t), String(v)]),
    }));
    return json({ status: "success", data: { resultType: "matrix", result } });
  };
}

function lokiFetch(world: World): typeof fetch {
  return async () =>
    json({
      status: "success",
      data: { resultType: "streams", result: [{ stream: { pod: "checkout-abc", namespace: "shop" }, values: (world.logs ?? []).map(([t, l]) => [ns(t), l]) }] },
    });
}

function githubFetch(world: World): typeof fetch {
  return async (input) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/deployments")) {
      return json(
        (world.deployments ?? []).map((d) => ({
          id: d.id,
          sha: d.sha,
          ref: "main",
          environment: d.environment ?? "production",
          description: null,
          created_at: d.at,
          creator: { login: "release-bot" },
        })),
      );
    }
    const id = Number(/deployments\/(\d+)\/statuses/.exec(url.pathname)?.[1]);
    const state = world.deployments?.find((d) => d.id === id)?.state ?? "success";
    return json([{ state, description: null, created_at: SCOPE.from }]);
  };
}

const down = (name: string): typeof fetch => async () => {
  throw new Error(`${name} is unreachable`);
};

export async function investigateWorld(world: World): Promise<Timeline> {
  const isDown = (s: NonNullable<World["down"]>[number]) => world.down?.includes(s) ?? false;
  const reader: KubeReader = {
    listPods: async () => {
      if (isDown("kubernetes")) throw new Error("kubernetes is unreachable");
      return world.pods ?? [];
    },
    listEvents: async () => world.events ?? [],
    readPodLog: async (r) => (world.podLogs?.[r.previous ? `${r.pod}:previous` : r.pod] ?? []).join("\n"),
  };
  return investigate(
    SCOPE,
    [
      new KubernetesConnector({ reader, podLogs: {} }),
      new PrometheusConnector({ baseUrl: "http://prom", fetch: isDown("prometheus") ? down("prometheus") : promFetch(world) }),
      new LokiConnector({ baseUrl: "http://loki", fetch: isDown("loki") ? down("loki") : lokiFetch(world) }),
      new GitHubDeploysConnector({ repo: "acme/shop", fetch: isDown("github") ? down("github") : githubFetch(world) }),
    ],
    { now: NOW },
  );
}

// ---- builders -------------------------------------------------------------------------------

export function pod(
  name: string,
  over: { phase?: string; ready?: boolean; /** When it stopped being ready. */ notReadyAt?: string; containers?: unknown[]; conditions?: unknown[] } = {},
) {
  return {
    metadata: { name, namespace: "shop", labels: { app: "checkout" } },
    status: {
      phase: over.phase ?? "Running",
      startTime: "2026-01-01T09:00:00Z",
      conditions: over.conditions ?? [
        {
          type: "Ready",
          status: over.ready === false ? "False" : "True",
          // A pod that is not ready stopped being ready recently, not at the start of the window.
          lastTransitionTime: over.ready === false ? (over.notReadyAt ?? "2026-01-01T10:22:00Z") : "2026-01-01T09:00:00Z",
        },
      ],
      containerStatuses: over.containers ?? [{ name: "app", restartCount: 0, state: {} }],
    },
  };
}

export const crashLooping = (restartCount = 6, lastTerminated?: unknown) => ({
  name: "app",
  restartCount,
  state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s restarting failed container" } },
  lastState: lastTerminated ? { terminated: lastTerminated } : {},
});

export const warning = (name: string, reason: string, message: string, at: string) => ({
  type: "Warning",
  reason,
  message,
  lastTimestamp: at,
  involvedObject: { kind: "Pod", name },
});

export const scaled = (at: string) => ({
  type: "Normal",
  reason: "ScalingReplicaSet",
  message: "Scaled up replica set checkout-7d9 to 3",
  lastTimestamp: at,
  involvedObject: { kind: "Deployment", name: "checkout" },
});
