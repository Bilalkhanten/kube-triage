#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadRunbooks } from "@kube-triage/core";
import { buildConnectorsFromEnv } from "./connectors.js";
import { createServer } from "./server.js";

// stdout carries the protocol, so diagnostics go to stderr only.
const connectors = buildConnectorsFromEnv(process.env);
if (connectors.length === 0) {
  process.stderr.write("error: nothing to investigate: enable Kubernetes or set PROMETHEUS_URL.\n");
  process.exit(1);
}
const runbookDir = process.env["KUBE_TRIAGE_RUNBOOKS"];
const runbooks = runbookDir ? await loadRunbooks(runbookDir) : undefined;
await createServer({ connectors, ...(runbooks ? { runbooks } : {}), now: () => new Date() }).connect(new StdioServerTransport());
