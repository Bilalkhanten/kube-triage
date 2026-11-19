import { expect } from "vitest";
import { EvidenceSchema, redactValue, type Connector, type InvestigationScope } from "@kube-triage/core";

/**
 * Behaviour every connector must satisfy, regardless of data source.
 * Call it from each connector's test with a connector wired to fixtures.
 */
export async function expectConnectorContract(connector: Connector, scope: InvestigationScope) {
  expect(connector.name).toMatch(/^[a-z][a-z0-9-]*$/);

  const evidence = await connector.collect(scope);
  expect(evidence.length).toBeGreaterThan(0);

  const ids = new Set<string>();
  for (const e of evidence) {
    // Valid shape
    expect(() => EvidenceSchema.parse(e)).not.toThrow();
    // Attributed to the connector that produced it
    expect(e.source).toBe(connector.name);
    // Stable, unique ids so re-collection deduplicates
    expect(ids.has(e.id)).toBe(false);
    ids.add(e.id);
    // Already redacted: redacting again changes nothing
    expect(redactValue(e)).toEqual(e);
  }

  // Deterministic: collecting twice yields the same ids
  const again = await connector.collect(scope);
  expect(again.map((e) => e.id).sort()).toEqual([...ids].sort());

  return evidence;
}
