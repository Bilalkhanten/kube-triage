import { z } from "zod";
import { matchRunbooks, type Runbook } from "./runbooks.js";
import type { Hypothesis } from "./schemas.js";

/** A pointer from a likely cause to a runbook, small enough to ship in every response. */
export const RunbookRefSchema = z.object({
  hypothesisId: z.string(),
  id: z.string(),
  title: z.string(),
});
export type RunbookRef = z.infer<typeof RunbookRefSchema>;

/**
 * Which runbooks apply to which likely causes, as plain references. The CLI, the MCP server,
 * the API and the dashboard all use this one shape. Runbook bodies are never sent, only ids
 * and titles; the Markdown stays in the repository where people read it.
 */
export function runbookRefs(hypotheses: Hypothesis[], runbooks: Runbook[]): RunbookRef[] {
  return [...matchRunbooks(hypotheses, runbooks)].flatMap(([hypothesisId, list]) => list.map((r) => ({ hypothesisId, id: r.id, title: r.title })));
}
