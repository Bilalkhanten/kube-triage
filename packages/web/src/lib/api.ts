import { RunbookRefSchema, TimelineSchema } from "@kube-triage/core";
import { z } from "zod";

/**
 * Server-side only. The API key is read from the environment and never sent to the browser.
 * Use a key with the viewer role: this dashboard only reads.
 */
const Summary = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  createdBy: z.string(),
  namespace: z.string(),
  service: z.string().nullable(),
  status: z.enum(["open", "resolved"]),
  severity: z.enum(["none", "info", "warning", "critical"]),
  title: z.string(),
});
const Detail = Summary.extend({
  windowFrom: z.iso.datetime({ offset: true }),
  windowTo: z.iso.datetime({ offset: true }),
  timeline: TimelineSchema,
  /** Older API versions do not send this. */
  runbooks: z.array(RunbookRefSchema).default([]),
});

export type IncidentSummary = z.infer<typeof Summary>;
export type IncidentDetail = z.infer<typeof Detail>;

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`The incident API returned HTTP ${status}.`);
  }
}

async function get(path: string): Promise<Response> {
  const base = process.env["KUBE_TRIAGE_API_URL"] ?? "http://localhost:8080";
  const key = process.env["KUBE_TRIAGE_API_KEY"];
  if (!key) throw new Error("KUBE_TRIAGE_API_KEY is not set.");
  return fetch(new URL(path, base), { headers: { authorization: `Bearer ${key}` }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
}

export async function listIncidents(): Promise<IncidentSummary[]> {
  const res = await get("/v1/incidents?limit=50");
  if (!res.ok) throw new ApiError(res.status);
  return z.object({ incidents: z.array(Summary) }).parse(await res.json()).incidents;
}

export async function getIncident(id: string): Promise<IncidentDetail | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const res = await get(`/v1/incidents/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(res.status);
  return Detail.parse(await res.json());
}
