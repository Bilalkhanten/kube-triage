import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { investigate, parseDuration, redactSecrets, runbookRefs, type Connector, type Runbook } from "@kube-triage/core";

/** Longest look-back window one tool call may request. Keeps Prometheus range queries bounded. */
export const MAX_SINCE_MS = 7 * 86_400_000;
export const DEFAULT_SINCE = "30m";
/** What is enabled when nothing is configured: the one tool that has always existed. */
export const DEFAULT_TOOLS = ["investigate"];

export interface ToolPermissions {
  /** Tool names to enable, or "all". Default: only `investigate`. */
  enable?: string[] | "all";
  /** Tool names to remove from whatever is enabled. */
  disable?: string[];
}

export interface ServerDeps {
  connectors: Connector[];
  /** When given, results list matching runbooks and the runbook tools become available. */
  runbooks?: Runbook[];
  /** Which tools exist. A tool that is not enabled is not registered, so it cannot be listed or called. */
  tools?: ToolPermissions;
  now(): Date;
  name?: string;
  version?: string;
}

const MAX_ERROR_LENGTH = 500;

function toolError(tool: string, error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactSecrets(raw).slice(0, MAX_ERROR_LENGTH);
  return { isError: true as const, content: [{ type: "text" as const, text: `${tool} failed: ${message}` }] };
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

/** The tool name for a connector's evidence, for example "github-deploys" becomes "evidence_github_deploys". */
export function evidenceToolName(connectorName: string): string {
  return `evidence_${connectorName.replace(/-/g, "_")}`;
}

const scopeShape = {
  namespace: z.string().describe("Kubernetes namespace (DNS-1123 label)"),
  service: z.string().optional().describe("Limit to one service (pod name prefix or app label)"),
  since: z.string().optional().describe(`How far back to look, e.g. 30m, 2h, 1d. Default ${DEFAULT_SINCE}, max 7d`),
};

interface ScopeArgs {
  namespace: string;
  service?: string | undefined;
  since?: string | undefined;
}

/**
 * Builds the MCP server. Every tool only reads: it runs read-only connectors and returns what they
 * found. Which tools exist is decided by `deps.tools`; by default that is `investigate` alone.
 * Input is validated by the core scope schema before any connector runs.
 */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: deps.name ?? "kube-triage", version: deps.version ?? "0.0.0" });

  async function run(connectors: Connector[], args: ScopeArgs, signal: AbortSignal) {
    const windowMs = parseDuration(args.since ?? DEFAULT_SINCE);
    if (windowMs > MAX_SINCE_MS) throw new Error("`since` must be at most 7d.");
    const now = deps.now();
    const timeline = await investigate(
      {
        namespace: args.namespace,
        ...(args.service ? { service: args.service } : {}),
        from: new Date(now.getTime() - windowMs).toISOString(),
        to: now.toISOString(),
      },
      connectors,
      { now, signal },
    );
    return deps.runbooks ? { ...timeline, runbooks: runbookRefs(timeline.hypotheses, deps.runbooks) } : timeline;
  }

  // Every tool that could exist, by name. Registration happens only for the enabled ones.
  const candidates = new Map<string, () => void>();

  candidates.set("investigate", () =>
    server.registerTool(
      "investigate",
      {
        title: "Investigate a namespace or service",
        description:
          "Read-only. Collects evidence from every configured source for a namespace (optionally one service), " +
          "orders it into a timeline and lists likely causes that cite their evidence. Never changes the cluster.",
        inputSchema: scopeShape,
        annotations: { ...READ_ONLY, openWorldHint: true },
      },
      async (args, extra) => {
        try {
          return json(await run(deps.connectors, args, extra.signal));
        } catch (error) {
          return toolError("investigate", error);
        }
      },
    ),
  );

  for (const connector of deps.connectors) {
    const name = evidenceToolName(connector.name);
    candidates.set(name, () =>
      server.registerTool(
        name,
        {
          title: `Evidence from ${connector.name} only`,
          description: `Read-only. Collects evidence from the "${connector.name}" source alone, as a timeline with the likely causes that evidence supports.`,
          inputSchema: scopeShape,
          annotations: { ...READ_ONLY, openWorldHint: true },
        },
        async (args, extra) => {
          try {
            return json(await run([connector], args, extra.signal));
          } catch (error) {
            return toolError(name, error);
          }
        },
      ),
    );
  }

  const runbooks = deps.runbooks;
  if (runbooks) {
    candidates.set("list_runbooks", () =>
      server.registerTool(
        "list_runbooks",
        {
          title: "List runbooks",
          description: "Read-only. Lists the available runbooks and the likely causes each one helps with.",
          inputSchema: {},
          annotations: { ...READ_ONLY, openWorldHint: false },
        },
        async () => json(runbooks.map((r) => ({ id: r.id, title: r.title, hypotheses: r.hypotheses }))),
      ),
    );
    candidates.set("get_runbook", () =>
      server.registerTool(
        "get_runbook",
        {
          title: "Read a runbook",
          description: "Read-only. Returns one runbook as Markdown. It is guidance for a person; nothing in it is run.",
          inputSchema: { id: z.string().describe("Runbook id, as listed by list_runbooks or returned with a likely cause") },
          annotations: { ...READ_ONLY, openWorldHint: false },
        },
        async ({ id }) => {
          const runbook = runbooks.find((r) => r.id === id);
          return runbook ? json(runbook) : toolError("get_runbook", new Error(`No runbook with id "${id}".`));
        },
      ),
    );
  }

  for (const name of enabledTools(deps.tools, [...candidates.keys()])) candidates.get(name)?.();
  return server;
}

/**
 * Works out which tools to enable. Unknown names are an error rather than being ignored, so a typo
 * cannot silently leave a tool on (or off).
 */
export function enabledTools(permissions: ToolPermissions | undefined, available: string[]): string[] {
  const unknown = (names: string[]) => names.filter((n) => !available.includes(n));
  const enable = permissions?.enable ?? DEFAULT_TOOLS;
  const disable = permissions?.disable ?? [];

  const bad = [...(enable === "all" ? [] : unknown(enable)), ...unknown(disable)];
  if (bad.length > 0) {
    throw new Error(`Unknown tool name(s): ${[...new Set(bad)].join(", ")}. Available: ${available.join(", ")}.`);
  }
  const wanted = enable === "all" ? available : available.filter((n) => enable.includes(n));
  const result = wanted.filter((n) => !disable.includes(n));
  if (result.length === 0) throw new Error("No tools are enabled.");
  return result;
}
