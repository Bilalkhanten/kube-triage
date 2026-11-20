import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseRunbook, type Connector, type InvestigationScope, type Runbook } from "@kube-triage/core";
import { createServer, enabledTools, evidenceToolName, toolPermissionsFromEnv, type ToolPermissions } from "../src/index.js";

const NOW = new Date("2026-01-01T11:00:00Z");

function spy(name: string) {
  const scopes: InvestigationScope[] = [];
  const connector: Connector = { name, collect: async (s) => (scopes.push(s), []) };
  return { connector, scopes };
}

const oom: Runbook = parseRunbook("---\ntitle: Container is running out of memory\nhypotheses: oom-killed\n---\n# Steps\n\nCheck the limit.", "oom-killed");

async function connect(connectors: Connector[], tools?: ToolPermissions, runbooks?: Runbook[]) {
  const server = createServer({ connectors, ...(tools ? { tools } : {}), ...(runbooks ? { runbooks } : {}), now: () => NOW });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[]).map((c) => c.text).join("\n");

describe("per-tool permissions", () => {
  const k = () => spy("kubernetes");
  const p = () => spy("prometheus");

  it("enables only investigate by default", async () => {
    expect(await names(await connect([k().connector, p().connector]))).toEqual(["investigate"]);
  });

  it("enables everything that applies with 'all'", async () => {
    const client = await connect([k().connector, spy("github-deploys").connector], { enable: "all" }, [oom]);
    expect(await names(client)).toEqual(["evidence_github_deploys", "evidence_kubernetes", "get_runbook", "investigate", "list_runbooks"]);
  });

  it("enables exactly the named tools", async () => {
    const client = await connect([k().connector, p().connector], { enable: ["evidence_prometheus", "investigate"] });
    expect(await names(client)).toEqual(["evidence_prometheus", "investigate"]);
  });

  it("removes disabled tools, even from 'all' and even investigate", async () => {
    expect(await names(await connect([k().connector, p().connector], { enable: "all", disable: ["evidence_kubernetes"] }))).toEqual(["evidence_prometheus", "investigate"]);
    expect(await names(await connect([k().connector], { enable: ["investigate", "evidence_kubernetes"], disable: ["investigate"] }))).toEqual(["evidence_kubernetes"]);
  });

  it("makes a disabled tool impossible to call, not just hidden", async () => {
    const kube = k();
    const client = await connect([kube.connector, p().connector], { enable: ["investigate"] });
    let outcome: "rejected" | "error-result" | "called" = "called";
    try {
      const r = await client.callTool({ name: "evidence_kubernetes", arguments: { namespace: "shop" } });
      if (r.isError) outcome = "error-result";
    } catch {
      outcome = "rejected";
    }
    expect(outcome).not.toBe("called");
    expect(kube.scopes).toHaveLength(0);
  });

  it("refuses unknown tool names instead of ignoring them", () => {
    expect(() => createServer({ connectors: [spy("kubernetes").connector], tools: { enable: ["investigat"] }, now: () => NOW })).toThrow(/Unknown tool name\(s\): investigat/);
    expect(() => createServer({ connectors: [spy("kubernetes").connector], tools: { disable: ["evidence_loki"] }, now: () => NOW })).toThrow(/evidence_loki/);
    // Runbook tools only exist when runbooks are configured.
    expect(() => createServer({ connectors: [spy("kubernetes").connector], tools: { enable: ["get_runbook"] }, now: () => NOW })).toThrow(/Unknown tool name/);
  });

  it("refuses to start with nothing enabled", () => {
    expect(() => enabledTools({ enable: ["investigate"], disable: ["investigate"] }, ["investigate"])).toThrow(/No tools are enabled/);
  });

  it("marks every tool read-only", async () => {
    const client = await connect([k().connector], { enable: "all" }, [oom]);
    for (const tool of (await client.listTools()).tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
  });
});

describe("evidence tools", () => {
  it("run only their own connector", async () => {
    const kube = spy("kubernetes");
    const prom = spy("prometheus");
    const client = await connect([kube.connector, prom.connector], { enable: "all" });
    const result = await client.callTool({ name: "evidence_prometheus", arguments: { namespace: "shop", since: "1h" } });
    expect(result.isError).toBeFalsy();
    expect(prom.scopes).toHaveLength(1);
    expect(kube.scopes).toHaveLength(0);
    expect(prom.scopes[0]).toMatchObject({ namespace: "shop", from: "2026-01-01T10:00:00.000Z" });
  });

  it("validate input before reading anything", async () => {
    const kube = spy("kubernetes");
    const client = await connect([kube.connector], { enable: "all" });
    for (const args of [{ namespace: 'x"} or {y="1' }, { namespace: "shop", since: "9d" }, { namespace: "shop", service: "../etc" }]) {
      const r = await client.callTool({ name: "evidence_kubernetes", arguments: args });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("evidence_kubernetes failed");
    }
    expect(kube.scopes).toHaveLength(0);
  });

  it("are named from the connector, with hyphens made safe", () => {
    expect(evidenceToolName("github-deploys")).toBe("evidence_github_deploys");
    expect(evidenceToolName("loki")).toBe("evidence_loki");
  });
});

describe("runbook tools", () => {
  it("list runbooks without their bodies and return one by id", async () => {
    const client = await connect([spy("kubernetes").connector], { enable: ["list_runbooks", "get_runbook"] }, [oom]);
    const list = JSON.parse(text(await client.callTool({ name: "list_runbooks", arguments: {} })));
    expect(list).toEqual([{ id: "oom-killed", title: "Container is running out of memory", hypotheses: ["oom-killed"] }]);
    expect(JSON.stringify(list)).not.toContain("Check the limit");

    const one = JSON.parse(text(await client.callTool({ name: "get_runbook", arguments: { id: "oom-killed" } })));
    expect(one.body).toContain("Check the limit.");
  });

  it("report an unknown id as an error, never reading from disk", async () => {
    const client = await connect([spy("kubernetes").connector], { enable: ["get_runbook"] }, [oom]);
    for (const id of ["nope", "../../etc/passwd", ""]) {
      const r = await client.callTool({ name: "get_runbook", arguments: { id } });
      expect(r.isError, id).toBe(true);
    }
  });
});

describe("toolPermissionsFromEnv", () => {
  it("parses lists, 'all' and blanks", () => {
    expect(toolPermissionsFromEnv({})).toEqual({ disable: [] });
    expect(toolPermissionsFromEnv({ KUBE_TRIAGE_MCP_TOOLS: "all" })).toEqual({ enable: "all", disable: [] });
    expect(toolPermissionsFromEnv({ KUBE_TRIAGE_MCP_TOOLS: " investigate , evidence_loki ,", KUBE_TRIAGE_MCP_DISABLE: "evidence_loki" })).toEqual({
      enable: ["investigate", "evidence_loki"],
      disable: ["evidence_loki"],
    });
  });
});
