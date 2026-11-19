import { describe, expect, it } from "vitest";
import { EvidenceSchema, type Connector } from "@kube-triage/core";
import { createProgram, parseDuration, renderTimeline, type ProgramDeps } from "../src/index.js";

const NOW = new Date("2026-01-01T11:00:00Z");

const fake: Connector = {
  name: "kubernetes",
  collect: async () => [
    EvidenceSchema.parse({
      id: "k1",
      source: "kubernetes",
      kind: "k8s.pod.container-terminated",
      observedAt: "2026-01-01T10:20:00Z",
      severity: "critical",
      summary: "Container app in checkout-abc was OOMKilled (exit code 137)",
      subject: { kind: "Pod", name: "checkout-abc", namespace: "shop" },
      tags: ["oom-killed"],
    }),
  ],
};

function run(args: string[], overrides: Partial<ProgramDeps> = {}) {
  let out = "";
  let seen: { prometheusUrl: string | undefined; kubernetes: boolean } | undefined;
  const program = createProgram({
    buildConnectors: (options) => {
      seen = { prometheusUrl: options.prometheusUrl, kubernetes: options.kubernetes };
      return [fake];
    },
    now: () => NOW,
    write: (t) => (out += t),
    writeErr: () => {},
    env: {},
    isTTY: false,
    ...overrides,
  });
  return { program, output: () => out, seen: () => seen, parse: () => program.parseAsync(["node", "kube-triage", ...args]) };
}

describe("parseDuration", () => {
  it.each([
    ["90s", 90_000],
    ["30m", 1_800_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
  ])("parses %s", (input, ms) => expect(parseDuration(input)).toBe(ms));

  it.each(["", "5", "m", "1w", "-5m", "0m"])("rejects %j", (input) => expect(() => parseDuration(input)).toThrow());
});

describe("kube-triage investigate", () => {
  it("prints a timeline with likely causes that cite the evidence", async () => {
    const r = run(["investigate", "-n", "shop", "-s", "checkout", "--since", "1h"]);
    await r.parse();
    const text = r.output();
    expect(text).toContain("Investigation of shop/checkout");
    expect(text).toContain("10:20:00  CRIT");
    expect(text).toContain("OOMKilled");
    expect(text).toContain("Likely causes");
    expect(text).toContain("Container is running out of memory");
    expect(text).toContain("evidence: [1]");
    expect(text).not.toContain("\u001b["); // not a TTY: no colors
  });

  it("emits valid JSON with --json", async () => {
    const r = run(["investigate", "-n", "shop", "--json"]);
    await r.parse();
    const parsed = JSON.parse(r.output());
    expect(parsed.scope).toMatchObject({ namespace: "shop", from: "2026-01-01T10:30:00.000Z", to: "2026-01-01T11:00:00.000Z" });
    expect(parsed.entries).toHaveLength(1);
  });

  it("reads the Prometheus URL from the environment", async () => {
    const r = run(["investigate", "-n", "shop"], { env: { PROMETHEUS_URL: "http://prom:9090" } });
    await r.parse();
    expect(r.seen()?.prometheusUrl).toBe("http://prom:9090");
  });

  it("requires a namespace and a valid duration", async () => {
    await expect(run(["investigate"]).parse()).rejects.toThrow(/namespace/);
    await expect(run(["investigate", "-n", "shop", "--since", "soon"]).parse()).rejects.toThrow(/Invalid duration/);
  });

  it("refuses to run with no data source", async () => {
    const r = run(["investigate", "-n", "shop", "--no-kubernetes"], { buildConnectors: () => [] });
    await expect(r.parse()).rejects.toThrow(/Nothing to investigate/);
  });

  it("rejects namespaces that are not valid Kubernetes names", async () => {
    await expect(run(["investigate", "-n", 'x"} or vector(1) #']).parse()).rejects.toThrow();
  });
});

describe("renderTimeline", () => {
  it("says so when nothing was found, and lists failed sources", () => {
    const text = renderTimeline(
      {
        scope: { namespace: "shop", from: "2026-01-01T10:00:00Z", to: "2026-01-01T11:00:00Z" },
        generatedAt: NOW.toISOString(),
        entries: [],
        hypotheses: [],
        errors: [{ source: "prometheus", message: "connection refused" }],
      },
      { color: false },
    );
    expect(text).toContain("No evidence of a problem");
    expect(text).toContain("could not be read");
    expect(text).toContain("prometheus: connection refused");
  });
});
