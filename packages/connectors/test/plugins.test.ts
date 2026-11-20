import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/index.js";

describe("built-in plugins", () => {
  it("registers kubernetes, prometheus and loki", () => {
    expect(createDefaultRegistry().list().map((p) => p.name)).toEqual(["kubernetes", "prometheus", "loki", "github-deploys"]);
  });

  it("keeps pod log reading off unless KUBE_TRIAGE_POD_LOGS=1", () => {
    const k8s = createDefaultRegistry().list().find((p) => p.name === "kubernetes")!;
    expect(k8s.env).toContain("KUBE_TRIAGE_POD_LOGS");
  });

  it("enables Prometheus and Loki only when their URLs are set", () => {
    const registry = createDefaultRegistry();
    const base = { KUBE_TRIAGE_NO_KUBERNETES: "1" };
    expect(registry.connectorsFromEnv(base)).toEqual([]);
    expect(registry.connectorsFromEnv({ ...base, PROMETHEUS_URL: "http://p" }).map((c) => c.name)).toEqual(["prometheus"]);
    expect(registry.connectorsFromEnv({ ...base, PROMETHEUS_URL: "http://p", LOKI_URL: "http://l" }).map((c) => c.name)).toEqual([
      "prometheus",
      "loki",
    ]);
  });

  it("enables GitHub deployments only when a repository is set, and validates it", () => {
    const registry = createDefaultRegistry();
    const base = { KUBE_TRIAGE_NO_KUBERNETES: "1" };
    expect(registry.connectorsFromEnv({ ...base, GITHUB_DEPLOYS_REPO: "acme/shop" }).map((c) => c.name)).toEqual(["github-deploys"]);
    expect(() => registry.connectorsFromEnv({ ...base, GITHUB_DEPLOYS_REPO: "not a repo" })).toThrow(/Invalid repository/);
  });

  it("can disable a configured plugin", () => {
    const env = { KUBE_TRIAGE_NO_KUBERNETES: "1", PROMETHEUS_URL: "http://p", LOKI_URL: "http://l", KUBE_TRIAGE_DISABLE: "loki" };
    expect(createDefaultRegistry().connectorsFromEnv(env).map((c) => c.name)).toEqual(["prometheus"]);
  });

  it("documents the environment each plugin reads", () => {
    for (const p of createDefaultRegistry().list()) {
      expect(p.env.length).toBeGreaterThan(0);
      expect(p.description).not.toBe("");
    }
  });
});
