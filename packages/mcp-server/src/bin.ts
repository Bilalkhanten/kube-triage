#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildConnectorsFromEnv } from "./connectors.js";
import { createServer } from "./server.js";

// stdout carries the protocol, so diagnostics go to stderr only.
const connectors = buildConnectorsFromEnv(process.env);
if (connectors.length === 0) {
  process.stderr.write("error: nothing to investigate: enable Kubernetes or set PROMETHEUS_URL.\n");
  process.exit(1);
}
await createServer({ connectors, now: () => new Date() }).connect(new StdioServerTransport());
