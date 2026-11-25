import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { EXPECTED, LOG_EXPECTED, checkTimeline } from "../assert-timeline.mjs";

/**
 * Static checks on the demo. They run without a cluster. The real verification is the `demo` job
 * in CI, which brings the demo up on kind and runs the CLI against it.
 */
const dir = fileURLToPath(new URL("..", import.meta.url));
const root = join(dir, "..");
const docs = (file: string) =>
  parseAllDocuments(readFileSync(join(dir, "manifests", file), "utf8")).map((d) => d.toJS() as Record<string, any>);

function timelineFor(causes: string[], sources = ["kubernetes", "prometheus"], withLog = true) {
  const entries = [
    ...EXPECTED.map(({ app }, i) => ({ id: `e${i}`, source: sources[0], subject: { kind: "Pod", name: `${app}-abc-xyz` } })),
    ...(withLog ? [{ id: "l0", source: "kubernetes", kind: "k8s.pod.log-pattern", summary: `Log errors in ${LOG_EXPECTED.app}-abc-xyz: ERROR ${LOG_EXPECTED.message} token=[REDACTED]`, subject: { kind: "Pod", name: `${LOG_EXPECTED.app}-abc-xyz` } }] : []),
    ...sources.slice(1).map((source, i) => ({ id: `p${i}`, source, subject: { kind: "Pod", name: "oom-abc-xyz" } })),
  ];
  const hypotheses = EXPECTED.filter((x) => causes.includes(x.cause)).map(({ cause }) => ({ id: cause, evidenceIds: [`e${EXPECTED.findIndex((x) => x.cause === cause)}`] }));
  return { entries, hypotheses, errors: [] as { source: string; message: string }[] };
}

describe("demo assertions", () => {
  const all = EXPECTED.map((x) => x.cause);

  it("passes when every expected cause cites evidence about its own app", () => {
    expect(checkTimeline(timelineFor(all))).toEqual([]);
  });

  it("names each missing cause", () => {
    const failures = checkTimeline(timelineFor(["oom-killed"]));
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toContain("image-pull-failure");
    expect(failures.join("\n")).toContain("probe-failure");
  });

  it("fails when a cause cites evidence about the wrong pod", () => {
    const t = timelineFor(all);
    t.hypotheses[0]!.evidenceIds = ["e1"];
    expect(checkTimeline(t).join("\n")).toContain('"oom-killed" does not cite evidence about a pod of oom');
  });

  it("fails when a connector is missing or errored, or a citation dangles", () => {
    expect(checkTimeline(timelineFor(all, ["kubernetes"])).join("\n")).toContain("no evidence from the prometheus connector");
    const t = timelineFor(all);
    t.errors.push({ source: "prometheus", message: "connection refused" });
    t.hypotheses[0]!.evidenceIds.push("nope");
    const out = checkTimeline(t).join("\n");
    expect(out).toContain("connection refused");
    expect(out).toContain("not in the timeline");
  });

  it("requires the pod log evidence, and that secrets in logs are redacted", () => {
    expect(checkTimeline(timelineFor(all, ["kubernetes", "prometheus"], false)).join("\n")).toContain("no pod log evidence about crashlog");
    const t = timelineFor(all);
    const log = t.entries.find((e) => e.id === "l0") as { summary: string };
    log.summary = `ERROR ${LOG_EXPECTED.message} token=${LOG_EXPECTED.secret}-123`;
    expect(checkTimeline(t).join("\n")).toContain("unredacted");
  });

  it("does not throw on garbage input", () => {
    expect(checkTimeline(null).length).toBeGreaterThan(0);
  });
});

describe("demo manifests", () => {
  const all = [...docs("apps.yaml"), ...docs("monitoring.yaml")].filter(Boolean);
  const images = all.flatMap((d) => (d["spec"]?.template?.spec?.containers ?? []).map((c: any) => c.image as string));

  it("defines one Deployment per expected broken app plus the log app, in the demo namespace", () => {
    const names = docs("apps.yaml").filter((d) => d["kind"] === "Deployment").map((d) => `${d["metadata"].namespace}/${d["metadata"].name}`);
    expect(names.sort()).toEqual([...EXPECTED.map((x) => x.app), LOG_EXPECTED.app].map((a) => `demo/${a}`).sort());
  });

  it("pins every image to an explicit non-latest tag", () => {
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(image, image).toMatch(/:[\w.-]+$/);
    expect(images.filter((i) => i.endsWith(":latest"))).toEqual([]);
  });

  it("gives kube-state-metrics read-only access only", () => {
    const role = all.find((d) => d["kind"] === "ClusterRole")!;
    const verbs = new Set(role["rules"].flatMap((r: any) => r.verbs));
    expect([...verbs].sort()).toEqual(["list", "watch"]);
    expect(JSON.stringify(role)).not.toContain("secrets");
  });

  it("the run script targets only the dedicated kind cluster and a loopback Prometheus", () => {
    const script = readFileSync(join(dir, "run.sh"), "utf8");
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain('--context "$CONTEXT"');
    expect(script).not.toMatch(/kubectl (?!--context)/);
    expect(script).toContain("http://127.0.0.1:19090");
    expect(readFileSync(join(dir, "kind-config.yaml"), "utf8")).toContain("kube-triage-demo");
  });

  it("the log app emits the asserted message and a fake secret, and the run script turns pod logs on", () => {
    const app = docs("apps.yaml").find((d) => d["metadata"]?.name === LOG_EXPECTED.app)!;
    const command = app["spec"].template.spec.containers[0].command.join(" ");
    expect(command).toContain(LOG_EXPECTED.message);
    expect(command).toContain(LOG_EXPECTED.secret);
    expect(readFileSync(join(dir, "run.sh"), "utf8")).toContain("KUBE_TRIAGE_POD_LOGS=1");
  });

  it("the failure diagnostics only list pods and read logs, and CI runs them on failure", () => {
    const script = readFileSync(join(dir, "debug-pod-logs.mjs"), "utf8");
    expect(script).toContain("listPods");
    expect(script).toContain("readPodLog");
    expect(script).not.toMatch(/\.(create|patch|delete|replace)\w*\(/);
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/if: failure\(\)[\s\S]*node demo\/debug-pod-logs\.mjs/);
  });

  it("CI runs the demo", () => {
    expect(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")).toContain("demo/run.sh");
  });
});
