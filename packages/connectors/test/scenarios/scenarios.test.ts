import { describe, expect, it } from "vitest";
import type { Confidence, Timeline } from "@kube-triage/core";
import { SCENARIOS, type Scenario } from "./scenarios.js";
import { investigateWorld } from "./world.js";

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** Returns a list of problems; empty means the scenario passed. */
function check(s: Scenario, t: Timeline): string[] {
  const problems: string[] = [];
  const ids = t.hypotheses.map((h) => h.id);
  const top = t.hypotheses[0];

  if (s.top === "none") {
    if (ids.length > 0) problems.push(`expected no hypotheses, got ${ids.join(", ")}`);
  } else if (top?.id !== s.top) {
    problems.push(`expected top "${s.top}", got "${top?.id ?? "nothing"}" (all: ${ids.join(", ") || "none"})`);
  } else if (s.minConfidence && RANK[top.confidence] < RANK[s.minConfidence]) {
    problems.push(`expected confidence >= ${s.minConfidence}, got ${top.confidence}`);
  }
  for (const id of s.includes ?? []) if (!ids.includes(id)) problems.push(`missing "${id}"`);
  for (const id of s.excludes ?? []) if (ids.includes(id)) problems.push(`must not include "${id}"`);
  if (s.errors) {
    const got = t.errors.map((e) => e.source).sort();
    if (JSON.stringify(got) !== JSON.stringify([...s.errors].sort())) problems.push(`expected errors from ${s.errors.join(", ")}, got ${got.join(", ") || "none"}`);
  }
  // Every hypothesis must cite evidence that is really in the timeline.
  const evidence = new Set(t.entries.map((e) => e.id));
  for (const h of t.hypotheses) for (const id of h.evidenceIds) if (!evidence.has(id)) problems.push(`"${h.id}" cites missing evidence ${id}`);
  return problems;
}

describe("diagnosis scenarios", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", async (_name, scenario) => {
    const timeline = await investigateWorld(scenario.world);
    expect(check(scenario, timeline), JSON.stringify(timeline.hypotheses.map((h) => [h.id, h.confidence]))).toEqual([]);
  });

  it("reports a pass rate across all scenarios", async () => {
    const failures: string[] = [];
    for (const s of SCENARIOS) {
      const problems = check(s, await investigateWorld(s.world));
      if (problems.length > 0) failures.push(`${s.name}: ${problems.join("; ")}`);
    }
    const passed = SCENARIOS.length - failures.length;
    console.log(`scenario pass rate: ${passed}/${SCENARIOS.length} (${Math.round((100 * passed) / SCENARIOS.length)}%)`);
    expect(failures).toEqual([]);
  });

  it("covers every hypothesis rule the engine has", async () => {
    const seen = new Set<string>();
    for (const s of SCENARIOS) for (const h of (await investigateWorld(s.world)).hypotheses) seen.add(h.id);
    const { HYPOTHESIS_IDS } = await import("@kube-triage/core");
    // config-error appears in its own scenario; the rest are exercised by the table above.
    expect([...HYPOTHESIS_IDS].filter((id) => !seen.has(id))).toEqual([]);
  });
});
