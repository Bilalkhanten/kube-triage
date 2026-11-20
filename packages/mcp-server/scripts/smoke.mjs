// Spawns the built MCP server over stdio and checks which tools it lists.
// Runs without a cluster: Kubernetes is disabled and a dummy Prometheus URL is never queried.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function listTools(extraEnv) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/bin.js", import.meta.url).pathname],
    env: { PATH: process.env.PATH ?? "", KUBE_TRIAGE_NO_KUBERNETES: "1", PROMETHEUS_URL: "http://127.0.0.1:9", ...extraEnv },
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name).sort();
}

function expect(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exit(1);
  }
  console.log(`ok: ${label}: ${actual.join(", ")}`);
}

// By default only `investigate` is enabled.
expect("default", await listTools({}), ["investigate"]);

// Opting in adds the per-source evidence tool and the runbook tools.
const runbooks = new URL("../../../runbooks", import.meta.url).pathname;
expect(
  "all tools",
  await listTools({ KUBE_TRIAGE_MCP_TOOLS: "all", KUBE_TRIAGE_RUNBOOKS: runbooks }),
  ["evidence_prometheus", "get_runbook", "investigate", "list_runbooks"],
);

// A disabled tool is gone.
expect("disabled", await listTools({ KUBE_TRIAGE_MCP_TOOLS: "all", KUBE_TRIAGE_MCP_DISABLE: "investigate" }), ["evidence_prometheus"]);
