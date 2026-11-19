import { describe, expect, it } from "vitest";
import type { InvestigationScope } from "@kube-triage/core";
import { PrometheusClient, PrometheusConnector, assertReadOnlyPath, defaultChecks, escapeLabelValue } from "../src/index.js";
import { expectConnectorContract } from "./contract.js";

const scope: InvestigationScope = {
  namespace: "shop",
  service: "checkout",
  from: "2026-01-01T10:00:00Z",
  to: "2026-01-01T11:00:00Z",
};
const t = (iso: string) => Date.parse(iso) / 1000;

interface Call {
  method: string | undefined;
  path: string;
  query: string;
}

function fakePrometheus() {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input.toString());
    const query = url.searchParams.get("query") ?? "";
    calls.push({ method: init?.method, path: url.pathname, query });

    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

    if (url.pathname === "/api/v1/alerts") {
      return json({
        status: "success",
        data: {
          alerts: [
            {
              labels: { alertname: "CheckoutHighErrorRate", namespace: "shop", severity: "critical", pod: "checkout-abc" },
              annotations: { summary: "5xx above 5%" },
              state: "firing",
              activeAt: "2026-01-01T10:20:00Z",
              value: "0.12",
            },
            { labels: { alertname: "Other", namespace: "other" }, annotations: {}, state: "firing", activeAt: "2026-01-01T10:20:00Z" },
            { labels: { alertname: "Pending", namespace: "shop" }, annotations: {}, state: "pending" },
          ],
        },
      });
    }
    if (url.pathname === "/api/v1/query_range") {
      const series = (pod: string, values: [number, string][]) => ({ metric: { pod, namespace: "shop" }, values });
      if (query.includes("restarts_total")) {
        return json({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              series("checkout-abc", [
                [t("2026-01-01T10:00:00Z"), "0"],
                [t("2026-01-01T10:15:00Z"), "0"],
                [t("2026-01-01T10:20:00Z"), "2"],
                [t("2026-01-01T10:25:00Z"), "4"],
              ]),
              series("checkout-def", [[t("2026-01-01T10:00:00Z"), "0"]]),
            ],
          },
        });
      }
      if (query.includes("throttled_periods")) {
        return json({
          status: "success",
          data: { resultType: "matrix", result: [series("checkout-abc", [[t("2026-01-01T10:10:00Z"), "NaN"], [t("2026-01-01T10:12:00Z"), "0.4"]])] },
        });
      }
      return json({ status: "success", data: { resultType: "matrix", result: [] } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

describe("PrometheusConnector", () => {
  it("satisfies the connector contract", async () => {
    const { fetchImpl } = fakePrometheus();
    const connector = new PrometheusConnector({ baseUrl: "http://prom:9090", fetch: fetchImpl });
    await expectConnectorContract(connector, scope);
  });

  it("reports when a threshold was first crossed, not when we looked", async () => {
    const { fetchImpl } = fakePrometheus();
    const evidence = await new PrometheusConnector({ baseUrl: "http://prom", fetch: fetchImpl }).collect(scope);

    const restarts = evidence.find((e) => e.id === "prometheus:restarts:checkout-abc");
    expect(restarts?.observedAt).toBe("2026-01-01T10:20:00.000Z");
    expect(restarts?.tags).toEqual(["restarts"]);
    expect(restarts?.summary).toContain("peak 4");

    // The pod that never crossed the threshold produces nothing.
    expect(evidence.some((e) => e.id.endsWith(":checkout-def"))).toBe(false);

    // NaN samples are ignored; the real breach is used.
    const throttle = evidence.find((e) => e.id === "prometheus:cpu-throttling:checkout-abc");
    expect(throttle?.observedAt).toBe("2026-01-01T10:12:00.000Z");
  });

  it("turns firing alerts in the namespace into evidence and ignores the rest", async () => {
    const { fetchImpl } = fakePrometheus();
    const evidence = await new PrometheusConnector({ baseUrl: "http://prom", fetch: fetchImpl }).collect(scope);
    const alerts = evidence.filter((e) => e.kind === "prom.alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "critical", tags: ["alert-firing"], observedAt: "2026-01-01T10:20:00.000Z" });
  });

  it("only ever issues GET requests to allowlisted read endpoints", async () => {
    const { fetchImpl, calls } = fakePrometheus();
    await new PrometheusConnector({ baseUrl: "http://prom", fetch: fetchImpl }).collect(scope);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.method).toBe("GET");
      expect(() => assertReadOnlyPath(c.path)).not.toThrow();
    }
  });

  it("supports caller-defined checks", async () => {
    const { fetchImpl, calls } = fakePrometheus();
    const connector = new PrometheusConnector({
      baseUrl: "http://prom",
      fetch: fetchImpl,
      checks: () => [{ ...defaultChecks(scope)[0]!, id: "custom", promql: "vector(1)" }],
    });
    await connector.collect(scope);
    expect(calls.some((c) => c.query === "vector(1)")).toBe(true);
  });
});

describe("PrometheusClient", () => {
  it("rejects paths outside the allowlist", () => {
    expect(() => assertReadOnlyPath("/api/v1/admin/tsdb/delete_series")).toThrow(/non-allowlisted/);
    expect(() => assertReadOnlyPath("/-/reload")).toThrow(/non-allowlisted/);
  });

  it("surfaces Prometheus errors and HTTP failures", async () => {
    const errorBody = new PrometheusClient({
      baseUrl: "http://prom",
      fetch: async () => new Response(JSON.stringify({ status: "error", errorType: "bad_data", error: "parse error" })),
    });
    await expect(errorBody.query("up{", new Date())).rejects.toThrow(/bad_data.*parse error/);

    const http500 = new PrometheusClient({ baseUrl: "http://prom", fetch: async () => new Response("boom", { status: 500 }) });
    await expect(http500.alerts()).rejects.toThrow(/HTTP 500/);
  });

  it("rejects responses that do not match the expected shape", async () => {
    const client = new PrometheusClient({
      baseUrl: "http://prom",
      fetch: async () => new Response(JSON.stringify({ status: "success", data: { nope: true } })),
    });
    await expect(client.query("up", new Date())).rejects.toThrow();
  });
});

describe("PromQL construction", () => {
  it("escapes label values so scope input cannot break out of a matcher", () => {
    expect(escapeLabelValue('a"b\\c\n')).toBe('a\\"b\\\\c\\n');
  });

  it("scopes checks to the namespace and service", () => {
    const [restarts] = defaultChecks({ namespace: "shop", service: "check.out" });
    expect(restarts?.promql).toContain('namespace="shop"');
    expect(restarts?.promql).toContain('pod=~"check\\\\.out.*"');
  });
});
