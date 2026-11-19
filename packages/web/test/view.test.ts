import { describe, expect, it } from "vitest";
import { buildTimeline, type EvidenceInput } from "@kube-triage/core";
import { clock, dateTime, hypothesisCards, timelineRows } from "../src/lib/view.js";

const scope = { namespace: "shop", from: "2026-01-01T10:00:00Z", to: "2026-01-01T11:00:00Z" };
const ev = (id: string, at: string, tags: string[] = [], severity: EvidenceInput["severity"] = "warning"): EvidenceInput => ({
  id,
  source: "kubernetes",
  kind: "k8s.test",
  observedAt: at,
  severity,
  summary: `summary of ${id}`,
  subject: { kind: "Pod", name: "p" },
  tags,
});

describe("view model", () => {
  const timeline = buildTimeline({
    scope,
    evidence: [ev("late", "2026-01-01T10:40:00Z"), ev("oom", "2026-01-01T10:20:00Z", ["oom-killed"], "critical"), ev("probe", "2026-01-01T10:30:00Z", ["probe-failure"])],
  });

  it("numbers rows in timeline order and records which causes cite them", () => {
    const rows = timelineRows(timeline);
    expect(rows.map((r) => [r.number, r.id])).toEqual([
      [1, "oom"],
      [2, "probe"],
      [3, "late"],
    ]);
    const causeFor = (id: string) => rows.find((r) => r.id === id)?.citedBy;
    expect(causeFor("oom")?.length).toBe(1);
    expect(causeFor("late")).toEqual([]);
  });

  it("turns each cause's evidence ids into row numbers", () => {
    const cards = hypothesisCards(timeline);
    const oom = cards.find((c) => c.id === "oom-killed");
    expect(oom?.cites).toEqual([1]);
    expect(cards.find((c) => c.id === "probe-failure")?.cites).toEqual([2]);
    expect(cards.map((c) => c.number)).toEqual(cards.map((_, i) => i + 1));
  });

  it("ignores citations of evidence that is not in the timeline", () => {
    const broken = { ...timeline, hypotheses: [{ ...timeline.hypotheses[0]!, evidenceIds: ["missing", "oom"] }] };
    expect(hypothesisCards(broken)[0]?.cites).toEqual([1]);
  });

  it("formats times in UTC regardless of the machine's timezone", () => {
    expect(clock("2026-01-01T10:20:05+02:00")).toBe("08:20:05");
    expect(dateTime("2026-01-01T23:59:59Z")).toBe("2026-01-01 23:59 UTC");
  });
});
