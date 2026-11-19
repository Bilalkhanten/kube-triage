import { describe, expect, it } from "vitest";
import { buildConnectorsFromEnv } from "../src/index.js";

describe("buildConnectorsFromEnv", () => {
  it("builds only Prometheus when Kubernetes is disabled", () => {
    const c = buildConnectorsFromEnv({ KUBE_TRIAGE_NO_KUBERNETES: "1", PROMETHEUS_URL: "http://prom:9090" });
    expect(c.map((x) => x.name)).toEqual(["prometheus"]);
  });

  it("builds nothing when everything is disabled", () => {
    expect(buildConnectorsFromEnv({ KUBE_TRIAGE_NO_KUBERNETES: "1" })).toEqual([]);
  });
});
