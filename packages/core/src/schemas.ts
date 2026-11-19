import { z } from "zod";

/** Kubernetes DNS-1123 label: used to keep scope values safe to embed in queries. */
const dnsLabel = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "must be a DNS-1123 label");

export const SeveritySchema = z.enum(["info", "warning", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const SubjectSchema = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  namespace: z.string().optional(),
});
export type Subject = z.infer<typeof SubjectSchema>;

/** One observed fact, with where it came from and when it was true. */
export const EvidenceSchema = z.object({
  /** Stable and deterministic, so re-collecting the same fact deduplicates. */
  id: z.string().min(1),
  /** Connector name, e.g. "kubernetes" or "prometheus". */
  source: z.string().min(1),
  /** Dotted fact type, e.g. "k8s.pod.container-state". */
  kind: z.string().min(1),
  observedAt: z.iso.datetime({ offset: true }),
  severity: SeveritySchema,
  summary: z.string().min(1),
  subject: SubjectSchema,
  /** Machine-readable labels that hypothesis rules match on, e.g. "oom-killed". */
  tags: z.array(z.string()).default([]),
  /** Raw details for drill-down. Never include secrets; redaction is applied anyway. */
  data: z.record(z.string(), z.unknown()).default({}),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
export type EvidenceInput = z.input<typeof EvidenceSchema>;

export const InvestigationScopeSchema = z
  .object({
    namespace: dnsLabel,
    service: dnsLabel.optional(),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .refine((s) => Date.parse(s.from) < Date.parse(s.to), {
    message: "`from` must be before `to`",
    path: ["from"],
  });
export type InvestigationScope = z.infer<typeof InvestigationScopeSchema>;

export const ConfidenceSchema = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const HypothesisSchema = z.object({
  id: z.string(),
  title: z.string(),
  confidence: ConfidenceSchema,
  rationale: z.string(),
  /** Every hypothesis must point at the evidence that supports it. */
  evidenceIds: z.array(z.string()).min(1),
  suggestedChecks: z.array(z.string()),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const ConnectorErrorSchema = z.object({
  source: z.string(),
  message: z.string(),
});
export type ConnectorError = z.infer<typeof ConnectorErrorSchema>;

export const TimelineSchema = z.object({
  scope: InvestigationScopeSchema,
  generatedAt: z.iso.datetime({ offset: true }),
  /** Ascending by `observedAt`. */
  entries: z.array(EvidenceSchema),
  hypotheses: z.array(HypothesisSchema),
  /** Connectors that failed. A partial timeline is still returned. */
  errors: z.array(ConnectorErrorSchema),
});
export type Timeline = z.infer<typeof TimelineSchema>;
