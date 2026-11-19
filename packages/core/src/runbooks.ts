import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Hypothesis } from "./schemas.js";

export const RunbookSchema = z.object({
  /** File name without ".md". */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and hyphens"),
  title: z.string().min(1).max(120),
  /** Hypothesis ids this runbook helps with, for example "oom-killed". */
  hypotheses: z.array(z.string().min(1)).min(1),
  /** Markdown. Guidance for a person; kube-triage never runs anything from it. */
  body: z.string().min(1),
});
export type Runbook = z.infer<typeof RunbookSchema>;

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const MAX_BYTES = 64 * 1024;
const MAX_FILES = 200;

/**
 * Parses a runbook: a Markdown file that starts with a small front matter block.
 *
 *     ---
 *     title: Container is running out of memory
 *     hypotheses: oom-killed, crash-loop
 *     ---
 *     # Steps...
 */
export function parseRunbook(source: string, id: string): Runbook {
  const match = FRONT_MATTER.exec(source);
  if (!match) throw new Error(`Runbook "${id}" must start with a front matter block between --- lines.`);

  const meta = new Map<string, string>();
  for (const line of (match[1] as string).split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`Runbook "${id}": cannot read front matter line "${line}".`);
    meta.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  const hypotheses = (meta.get("hypotheses") ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);

  const parsed = RunbookSchema.safeParse({ id, title: meta.get("title") ?? "", hypotheses, body: (match[2] as string).trim() });
  if (!parsed.success) {
    const problem = parsed.error.issues.map((i) => `${i.path.join(".") || "runbook"}: ${i.message}`).join("; ");
    throw new Error(`Runbook "${id}" is invalid: ${problem}`);
  }
  return parsed.data;
}

/**
 * Reads every .md file directly inside `dir` (no recursion). Invalid or oversized files fail
 * loudly so a broken runbook is noticed rather than silently missing.
 */
export async function loadRunbooks(dir: string): Promise<Runbook[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md").sort();
  if (names.length > MAX_FILES) throw new Error(`Too many runbooks in ${dir}: ${names.length} (limit ${MAX_FILES}).`);

  const runbooks: Runbook[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    if (info.size > MAX_BYTES) throw new Error(`Runbook ${name} is larger than ${MAX_BYTES} bytes.`);
    runbooks.push(parseRunbook(await readFile(path, "utf8"), name.slice(0, -3)));
  }
  const seen = new Set<string>();
  for (const r of runbooks) {
    if (seen.has(r.id)) throw new Error(`Duplicate runbook id "${r.id}".`);
    seen.add(r.id);
  }
  return runbooks;
}

/** Runbooks that apply to each hypothesis, keyed by hypothesis id. Hypotheses without any are omitted. */
export function matchRunbooks(hypotheses: Hypothesis[], runbooks: Runbook[]): Map<string, Runbook[]> {
  const out = new Map<string, Runbook[]>();
  for (const h of hypotheses) {
    const matching = runbooks.filter((r) => r.hypotheses.includes(h.id));
    if (matching.length > 0) out.set(h.id, matching);
  }
  return out;
}
