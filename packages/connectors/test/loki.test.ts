import { describe, expect, it } from "vitest";
import type { InvestigationScope } from "@kube-triage/core";
import { LokiClient, LokiConnector, assertReadOnlyLokiPath, signature } from "../src/index.js";
import { expectConnectorContract } from "./contract.js";

const scope: InvestigationScope = {
  namespace: "shop",
  service: "checkout",
  from: "2026-01-01T10:00:00Z",
  to: "2026-01-01T11:00:00Z",
};
const ns = (iso: string) => `${Date.parse(iso)}000000`;

interface Call {
  method: string | undefined;
  path: string;
  query: string;
  headers: Headers;
}

function fakeLoki(values: Array<[string, string]>, pod = "checkout-abc") {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input.toString());
    calls.push({
      method: init?.method,
      path: url.pathname,
      query: url.searchParams.get("query") ?? "",
      headers: new Headers(init?.headers),
    });
    return new Response(
      JSON.stringify({ status: "success", data: { resultType: "streams", result: [{ stream: { pod, namespace: "shop" }, values }] } }),
    );
  };
  return { fetchImpl, calls };
}

const lines: Array<[string, string]> = [
  [ns("2026-01-01T10:20:00Z"), "ERROR payment 4821 failed: connection refused to db"],
  [ns("2026-01-01T10:20:05Z"), "ERROR payment 9917 failed: connection refused to db"],
  [ns("2026-01-01T10:20:09Z"), "ERROR payment 1203 failed: connection refused to db"],
  [ns("2026-01-01T10:25:00Z"), "panic: runtime error: invalid memory address, token=abc123secret"],
];

describe("LokiConnector", () => {
  it("satisfies the connector contract", async () => {
    const { fetchImpl } = fakeLoki(lines);
    await expectConnectorContract(new LokiConnector({ baseUrl: "http://loki:3100", fetch: fetchImpl }), scope);
  });

  it("groups repeated errors into one piece of evidence with a count and the first time seen", async () => {
    const { fetchImpl } = fakeLoki(lines);
    const evidence = await new LokiConnector({ baseUrl: "http://loki", fetch: fetchImpl }).collect(scope);
    expect(evidence).toHaveLength(2);
    const grouped = evidence.find((e) => e.summary.includes("connection refused"));
    expect(grouped?.summary).toContain("(x3)");
    expect(grouped?.observedAt).toBe("2026-01-01T10:20:00.000Z");
    expect(grouped?.severity).toBe("warning");
    expect(grouped?.tags).toEqual(["log-errors"]);
  });

  it("treats panics as critical and redacts secrets in the sample", async () => {
    const { fetchImpl } = fakeLoki(lines);
    const evidence = await new LokiConnector({ baseUrl: "http://loki", fetch: fetchImpl }).collect(scope);
    const panic = evidence.find((e) => e.summary.includes("panic"));
    expect(panic?.severity).toBe("critical");
    expect(JSON.stringify(panic)).not.toContain("abc123secret");
  });

  it("tags out-of-memory messages so they support the OOM hypothesis", async () => {
    const { fetchImpl } = fakeLoki([[ns("2026-01-01T10:30:00Z"), "java.lang.OutOfMemoryError: Java heap space"]]);
    const [e] = await new LokiConnector({ baseUrl: "http://loki", fetch: fetchImpl }).collect(scope);
    expect(e?.tags).toEqual(["log-errors", "oom-killed"]);
  });

  it("truncates long samples and flags when the line limit was hit", async () => {
    const long = "ERROR " + "x".repeat(2000);
    const { fetchImpl } = fakeLoki([[ns("2026-01-01T10:30:00Z"), long]]);
    const [e] = await new LokiConnector({ baseUrl: "http://loki", fetch: fetchImpl, maxLines: 1 }).collect(scope);
    expect(e?.summary.length).toBeLessThan(400);
    expect(e?.data["truncated"]).toBe(true);
  });

  it("returns nothing when there are no matching lines", async () => {
    const { fetchImpl } = fakeLoki([]);
    expect(await new LokiConnector({ baseUrl: "http://loki", fetch: fetchImpl }).collect(scope)).toEqual([]);
  });

  it("only issues GET requests to the allowlisted endpoint and scopes the query", async () => {
    const { fetchImpl, calls } = fakeLoki(lines);
    await new LokiConnector({ baseUrl: "http://loki", fetch: fetchImpl, tenantId: "team-a" }).collect(scope);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(() => assertReadOnlyLokiPath(calls[0]!.path)).not.toThrow();
    expect(calls[0]?.query).toContain('namespace="shop"');
    expect(calls[0]?.query).toContain('pod=~"checkout.*"');
    expect(calls[0]?.headers.get("x-scope-orgid")).toBe("team-a");
  });
});

describe("LokiClient", () => {
  it("rejects paths outside the allowlist", () => {
    expect(() => assertReadOnlyLokiPath("/loki/api/v1/push")).toThrow(/non-allowlisted/);
    expect(() => assertReadOnlyLokiPath("/loki/api/v1/delete")).toThrow(/non-allowlisted/);
  });

  it("surfaces HTTP and Loki errors and rejects malformed bodies", async () => {
    const http = new LokiClient({ baseUrl: "http://loki", fetch: async () => new Response("no", { status: 502 }) });
    await expect(http.queryRange("{a=\"b\"}", { from: new Date(0), to: new Date(1), limit: 1 })).rejects.toThrow(/HTTP 502/);

    const err = new LokiClient({
      baseUrl: "http://loki",
      fetch: async () => new Response(JSON.stringify({ status: "error", error: "parse error" })),
    });
    await expect(err.queryRange("x", { from: new Date(0), to: new Date(1), limit: 1 })).rejects.toThrow(/parse error/);

    const bad = new LokiClient({ baseUrl: "http://loki", fetch: async () => new Response(JSON.stringify({ status: "success", data: {} })) });
    await expect(bad.queryRange("x", { from: new Date(0), to: new Date(1), limit: 1 })).rejects.toThrow();
  });
});

describe("signature", () => {
  it("makes lines with different ids and numbers look the same", () => {
    expect(signature("order 123 failed for 7f3c9a2e-1b2c-4d5e-8f90-123456789abc")).toBe(
      signature("order 999 failed for 11111111-2222-3333-4444-555555555555"),
    );
    expect(signature("timeout after 30s")).not.toBe(signature("connection refused"));
  });
});
