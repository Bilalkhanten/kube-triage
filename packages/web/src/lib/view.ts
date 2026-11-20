import type { Confidence, RunbookRef, Severity, Timeline } from "@kube-triage/core";

export type Tone = Severity | "none";

export interface TimelineRow {
  /** 1-based, so hypotheses can cite evidence as [n]. */
  number: number;
  id: string;
  clock: string;
  tone: Severity;
  source: string;
  summary: string;
  /** Numbers of the likely causes that cite this evidence. */
  citedBy: number[];
}

export interface HypothesisCard {
  number: number;
  id: string;
  title: string;
  confidence: Confidence;
  rationale: string;
  /** Numbers of the timeline rows this rests on. */
  cites: number[];
  checks: string[];
  /** Runbooks that apply to this cause, by title. The Markdown stays in the repository. */
  runbooks: Array<{ id: string; title: string }>;
}

/** "10:20:00", always UTC so a shared screen reads the same for everyone. */
export function clock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

/** "2026-01-01 10:20 UTC" */
export function dateTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function timelineRows(timeline: Timeline): TimelineRow[] {
  const citedBy = new Map<string, number[]>();
  timeline.hypotheses.forEach((h, i) => {
    for (const id of h.evidenceIds) citedBy.set(id, [...(citedBy.get(id) ?? []), i + 1]);
  });
  return timeline.entries.map((e, i) => ({
    number: i + 1,
    id: e.id,
    clock: clock(e.observedAt),
    tone: e.severity,
    source: e.source,
    summary: e.summary,
    citedBy: citedBy.get(e.id) ?? [],
  }));
}

export function hypothesisCards(timeline: Timeline, runbooks: RunbookRef[] = []): HypothesisCard[] {
  const numberById = new Map(timeline.entries.map((e, i) => [e.id, i + 1]));
  return timeline.hypotheses.map((h, i) => ({
    number: i + 1,
    id: h.id,
    title: h.title,
    confidence: h.confidence,
    rationale: h.rationale,
    cites: h.evidenceIds.map((id) => numberById.get(id)).filter((n): n is number => n !== undefined),
    checks: h.suggestedChecks,
    runbooks: runbooks.filter((r) => r.hypothesisId === h.id).map((r) => ({ id: r.id, title: r.title })),
  }));
}

/** Tailwind classes per tone. Text carries a label too, so colour is never the only signal. */
export const TONE_CLASSES: Record<Tone, string> = {
  critical: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  warning: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  info: "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  none: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
};

export const TONE_LABEL: Record<Tone, string> = { critical: "Critical", warning: "Warning", info: "Info", none: "Clear" };

export const CONFIDENCE_CLASSES: Record<Confidence, string> = {
  high: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  medium: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  low: "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
};
