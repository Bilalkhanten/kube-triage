import { describe, expect, it } from "vitest";
import {
  EvidenceSchema,
  buildTimeline,
  investigate,
  type Connector,
  type EvidenceInput,
  type InvestigationScope,
} from "../src/index.js";

const scope: InvestigationScope = {
  namespace: "shop",
  service: "checkout",
  from: "2026-01-01T10:00:00Z",
  to: "2026-01-01T11:00:00Z",
};

const ev = (over: Partial<EvidenceInput> & { id: string }): EvidenceInput => ({
  source: "kubernetes",
  kind: "k8s.test",
  observedAt: "2026-01-01T10:30:00Z",
  severity: "warning",
  summary: "something happened",
  subject: { kind: "Pod", name: "checkout-1", namespace: "shop" },
  tags: [],
  data: {},
  ...over,
});

describe("buildTimeline", () => {
  it("orders by time, then severity", () => {
    const t = buildTimeline({
      scope,
      evidence: [
        ev({ id: "c", observedAt: "2026-01-01T10:40:00Z" }),
        ev({ id: "b", observedAt: "2026-01-01T10:10:00Z", severity: "info" }),
        ev({ id: "a", observedAt: "2026-01-01T10:10:00Z", severity: "critical" }),
      ],
    });
    expect(t.entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("deduplicates by id and keeps the latest observation", () => {
    const t = buildTimeline({
      scope,
      evidence: [
        ev({ id: "x", observedAt: "2026-01-01T10:10:00Z", summary: "old" }),
        ev({ id: "x", observedAt: "2026-01-01T10:20:00Z", summary: "new" }),
      ],
    });
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0]?.summary).toBe("new");
  });

  it("redacts secrets in summaries and data", () => {
    const t = buildTimeline({
      scope,
      evidence: [ev({ id: "s", summary: "login failed password=hunter2", data: { token: "abc" } })],
    });
    expect(JSON.stringify(t)).not.toContain("hunter2");
    expect(t.entries[0]?.data["token"]).toBe("[REDACTED]");
  });

  it("rejects malformed evidence", () => {
    expect(() => buildTimeline({ scope, evidence: [ev({ id: "" })] })).toThrow();
  });

  it("derives hypotheses that cite their evidence, with higher confidence when sources agree", () => {
    const t = buildTimeline({
      scope,
      evidence: [
        ev({ id: "k", tags: ["oom-killed"], severity: "critical" }),
        ev({ id: "p", source: "prometheus", tags: ["memory-pressure"] }),
        ev({ id: "q", tags: ["image-pull-failure"], severity: "info" }),
      ],
    });
    const oom = t.hypotheses.find((h) => h.id === "oom-killed");
    expect(oom?.confidence).toBe("high");
    expect(oom?.evidenceIds.sort()).toEqual(["k", "p"]);
    const pull = t.hypotheses.find((h) => h.id === "image-pull-failure");
    expect(pull?.confidence).toBe("low");
    expect(t.hypotheses[0]?.id).toBe("oom-killed");
  });

  it("produces no hypotheses from untagged evidence", () => {
    expect(buildTimeline({ scope, evidence: [ev({ id: "n" })] }).hypotheses).toEqual([]);
  });
});

describe("investigate", () => {
  const good: Connector = { name: "good", collect: async () => [EvidenceSchema.parse(ev({ id: "g" }))] };
  const bad: Connector = {
    name: "bad",
    collect: async () => {
      throw new Error("connection refused, token=abc123");
    },
  };

  it("returns a partial timeline when a connector fails, with the error redacted", async () => {
    const t = await investigate(scope, [good, bad]);
    expect(t.entries.map((e) => e.id)).toEqual(["g"]);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0]?.source).toBe("bad");
    expect(t.errors[0]?.message).not.toContain("abc123");
  });

  it("validates the scope", async () => {
    await expect(investigate({ ...scope, namespace: "Bad Namespace!" }, [good])).rejects.toThrow();
    await expect(investigate({ ...scope, from: scope.to, to: scope.from }, [good])).rejects.toThrow();
  });
});

describe("recent-change correlation", () => {
  const change = (id: string, at: string, over: Partial<EvidenceInput> = {}): EvidenceInput =>
    ev({ id, observedAt: at, severity: "info", source: "github-deploys", tags: ["deploy"], ...over });
  const problem = (id: string, at: string, over: Partial<EvidenceInput> = {}): EvidenceInput =>
    ev({ id, observedAt: at, severity: "critical", tags: ["crash-loop"], ...over });
  const run = (evidence: EvidenceInput[]) => buildTimeline({ scope, evidence }).hypotheses.find((h) => h.id === "recent-change");

  it("blames a deployment that precedes the first problem, citing both", () => {
    const h = run([change("d", "2026-01-01T10:15:00Z"), problem("p", "2026-01-01T10:20:00Z")]);
    expect(h?.title).toMatch(/deployment/);
    expect(h?.evidenceIds).toEqual(["d", "p"]);
    expect(h?.rationale).toContain("5 minutes");
    expect(h?.confidence).toBe("high"); // recorded deploy, tight gap, independent sources
  });

  it("never blames a change that came after the first problem", () => {
    expect(run([change("d", "2026-01-01T10:30:00Z"), problem("p", "2026-01-01T10:20:00Z")])).toBeUndefined();
  });

  it("ignores changes more than 30 minutes before the first problem", () => {
    expect(run([change("d", "2026-01-01T10:00:00Z"), problem("p", "2026-01-01T10:45:00Z")])).toBeUndefined();
  });

  it("picks the change closest to the first problem", () => {
    const h = run([change("old", "2026-01-01T10:05:00Z"), change("new", "2026-01-01T10:18:00Z"), problem("p", "2026-01-01T10:20:00Z")]);
    expect(h?.evidenceIds[0]).toBe("new");
  });

  it("is only medium when the evidence is a plain rollout, and low when the gap is wide", () => {
    const rollout = (id: string, at: string) => change(id, at, { source: "kubernetes", tags: ["rollout"] });
    expect(run([rollout("r", "2026-01-01T10:15:00Z"), problem("p", "2026-01-01T10:20:00Z")])?.confidence).toBe("medium");
    expect(run([rollout("r", "2026-01-01T10:00:00Z"), problem("p", "2026-01-01T10:25:00Z")])?.confidence).toBe("low");
  });

  it("stays medium for a recorded deployment when the gap is wide or the source is the same", () => {
    expect(run([change("d", "2026-01-01T10:00:00Z"), problem("p", "2026-01-01T10:25:00Z")])?.confidence).toBe("medium");
    expect(run([change("d", "2026-01-01T10:15:00Z", { source: "kubernetes" }), problem("p", "2026-01-01T10:20:00Z")])?.confidence).toBe("medium");
  });

  it("does nothing without a change or without a problem", () => {
    expect(run([problem("p", "2026-01-01T10:20:00Z")])).toBeUndefined();
    expect(run([change("d", "2026-01-01T10:15:00Z")])).toBeUndefined();
  });
});

describe("hypothesis ranking", () => {
  const change = (at: string, over: Partial<EvidenceInput> = {}): EvidenceInput =>
    ev({ id: "d", observedAt: at, severity: "info", source: "github-deploys", tags: ["deploy"], ...over });
  const crashes: EvidenceInput[] = [
    ev({ id: "k", observedAt: "2026-01-01T10:20:00Z", severity: "critical", tags: ["crash-loop"], source: "kubernetes" }),
    ev({ id: "p", observedAt: "2026-01-01T10:21:00Z", severity: "warning", tags: ["restarts"], source: "prometheus" }),
  ];
  const ranked = (evidence: EvidenceInput[]) => buildTimeline({ scope, evidence }).hypotheses.map((h) => `${h.id}:${h.confidence}`);

  it("puts a high-confidence deployment correlation ahead of an equally confident symptom", () => {
    expect(ranked([change("2026-01-01T10:15:00Z"), ...crashes])).toEqual(["recent-change:high", "crash-loop:high"]);
  });

  it("does not let a weaker change suspicion jump ahead", () => {
    const rollout = change("2026-01-01T10:15:00Z", { source: "kubernetes", tags: ["rollout"] });
    const order = ranked([rollout, ...crashes]);
    expect(order[0]).toBe("crash-loop:high");
    expect(order).toContain("recent-change:medium");
  });
});

describe("independence of log sources", () => {
  const logEvidence = (id: string, source: string): EvidenceInput =>
    ev({ id, source, kind: `${source}.log-pattern`, severity: "warning", tags: ["log-errors"], observedAt: "2026-01-01T10:20:00Z" });
  const confidence = (evidence: EvidenceInput[]) => buildTimeline({ scope, evidence }).hypotheses.find((h) => h.id === "app-errors")?.confidence;

  it("does not treat Loki and Kubernetes logs of the same pod as two witnesses", () => {
    // One single warning from one origin stays low even when two tools reported it.
    expect(confidence([logEvidence("a", "loki")])).toBe("low");
    expect(confidence([logEvidence("a", "loki"), logEvidence("b", "kubernetes")])).toBe("medium");
  });

  it("still raises confidence when logs agree with a genuinely different source", () => {
    const prom = ev({ id: "p", source: "prometheus", severity: "warning", tags: ["log-errors"] });
    expect(confidence([logEvidence("a", "loki"), prom])).toBe("high");
  });
});
