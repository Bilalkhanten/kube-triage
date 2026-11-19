import { deriveHypotheses } from "./hypotheses.js";
import { redactValue } from "./redact.js";
import type {
  ConnectorError,
  Evidence,
  EvidenceInput,
  InvestigationScope,
  Severity,
  Timeline,
} from "./schemas.js";
import { EvidenceSchema } from "./schemas.js";

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export interface BuildTimelineInput {
  scope: InvestigationScope;
  evidence: EvidenceInput[];
  errors?: ConnectorError[];
  now?: Date;
}

/**
 * Validates, redacts, deduplicates (by id, latest observation wins) and orders evidence,
 * then derives hypotheses from it.
 */
export function buildTimeline({ scope, evidence, errors = [], now = new Date() }: BuildTimelineInput): Timeline {
  const byId = new Map<string, Evidence>();
  for (const raw of evidence) {
    const parsed = EvidenceSchema.parse(raw);
    const clean = redactValue(parsed);
    const existing = byId.get(clean.id);
    if (!existing || Date.parse(clean.observedAt) >= Date.parse(existing.observedAt)) {
      byId.set(clean.id, clean);
    }
  }
  const entries = [...byId.values()].sort(
    (a, b) =>
      Date.parse(a.observedAt) - Date.parse(b.observedAt) ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.id.localeCompare(b.id),
  );
  return {
    scope,
    generatedAt: now.toISOString(),
    entries,
    hypotheses: deriveHypotheses(entries),
    errors: errors.map((e) => redactValue(e)),
  };
}
