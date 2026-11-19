// Spawns the built MCP server over stdio and asserts that tools/list returns only `investigate`.
// Runs without a cluster: Kubernetes is disabled and a dummy Prometheus URL is never queried.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/bin.js", import.meta.url).pathname],
  env: { PATH: process.env.PATH ?? "", KUBE_TRIAGE_NO_KUBERNETES: "1", PROMETHEUS_URL: "http://127.0.0.1:9" },
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();
const names = tools.map((t) => t.name);
if (names.length !== 1 || names[0] !== "investigate") {
  console.error(`unexpected tools: ${JSON.stringify(names)}`);
  process.exit(1);
}
console.log(`ok: ${names.join(", ")}`);
