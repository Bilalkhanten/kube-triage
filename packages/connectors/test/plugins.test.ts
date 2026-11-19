import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/index.js";

describe("built-in plugins", () => {
  it("registers kubernetes, prometheus and loki", () => {
    expect(createDefaultRegistry().list().map((p) => p.name)).toEqual(["kubernetes", "prometheus", "loki"]);
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
