import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { investigate, parseDuration, redactSecrets, type Connector } from "@kube-triage/core";

/** Longest look-back window one tool call may request. Keeps Prometheus range queries bounded. */
export const MAX_SINCE_MS = 7 * 86_400_000;
export const DEFAULT_SINCE = "30m";

export interface ServerDeps {
  connectors: Connector[];
  now(): Date;
  name?: string;
  version?: string;
}

const MAX_ERROR_LENGTH = 500;

function toolError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactSecrets(raw).slice(0, MAX_ERROR_LENGTH);
  return { isError: true as const, content: [{ type: "text" as const, text: `investigate failed: ${message}` }] };
}

/**
 * Builds the MCP server. It has exactly one tool, `investigate`, which only reads: it runs the
 * connectors it was given (which are read-only) and returns the same timeline as the CLI's
 * `--json` output. Input is validated by the core scope schema before any connector runs.
 */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: deps.name ?? "kube-triage", version: deps.version ?? "0.0.0" });

  server.registerTool(
    "investigate",
    {
      title: "Investigate a namespace or service",
      description:
        "Read-only. Collects Kubernetes and Prometheus evidence for a namespace (optionally one service), " +
        "orders it into a timeline and lists likely causes that cite their evidence. Never changes the cluster.",
      inputSchema: {
        namespace: z.string().describe("Kubernetes namespace (DNS-1123 label)"),
        service: z.string().optional().describe("Limit to one service (pod name prefix or app label)"),
        since: z.string().optional().describe(`How far back to look, e.g. 30m, 2h, 1d. Default ${DEFAULT_SINCE}, max 7d`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ namespace, service, since }, extra) => {
      try {
        const windowMs = parseDuration(since ?? DEFAULT_SINCE);
        if (windowMs > MAX_SINCE_MS) throw new Error("`since` must be at most 7d.");
        const now = deps.now();
        const timeline = await investigate(
          {
            namespace,
            ...(service ? { service } : {}),
            from: new Date(now.getTime() - windowMs).toISOString(),
            to: now.toISOString(),
          },
          deps.connectors,
          { now, signal: extra.signal },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(timeline, null, 2) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
