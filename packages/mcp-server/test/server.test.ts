import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EvidenceSchema, TimelineSchema, type Connector, type InvestigationScope } from "@kube-triage/core";
import { createServer } from "../src/index.js";

const NOW = new Date("2026-01-01T11:00:00Z");

function evidence() {
  return EvidenceSchema.parse({
    id: "k1",
    source: "kubernetes",
    kind: "k8s.pod.container-terminated",
    observedAt: "2026-01-01T10:20:00Z",
    severity: "critical",
    summary: "Container app in checkout-abc was OOMKilled (exit code 137)",
    subject: { kind: "Pod", name: "checkout-abc", namespace: "shop" },
    tags: ["oom-killed"],
  });
}

function spy(name: string, collect: (scope: InvestigationScope) => Promise<ReturnType<typeof evidence>[]>) {
  const scopes: InvestigationScope[] = [];
  const connector: Connector = {
    name,
    collect: async (scope) => {
      scopes.push(scope);
      return collect(scope);
    },
  };
  return { connector, scopes };
}

async function connect(connectors: Connector[]) {
  const server = createServer({ connectors, now: () => NOW });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text: string }[];
  return content.map((c) => c.text).join("\n");
}

describe("kube-triage MCP server", () => {
  it("lists exactly one read-only tool", async () => {
    const client = await connect([spy("kubernetes", async () => []).connector]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["investigate"]);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
    expect(tools[0]?.annotations?.destructiveHint).toBe(false);
  });

  it("returns the timeline with likely causes for a valid scope", async () => {
    const k = spy("kubernetes", async () => [evidence()]);
    const client = await connect([k.connector]);
    const result = await client.callTool({ name: "investigate", arguments: { namespace: "shop", service: "checkout", since: "1h" } });
    expect(result.isError).toBeFalsy();
    const timeline = TimelineSchema.parse(JSON.parse(text(result)));
    expect(timeline.entries).toHaveLength(1);
    expect(timeline.hypotheses[0]?.title).toMatch(/memory/i);
    expect(k.scopes[0]).toMatchObject({
      namespace: "shop",
      service: "checkout",
      from: "2026-01-01T10:00:00.000Z",
      to: "2026-01-01T11:00:00.000Z",
    });
  });

  it("defaults the window to 30 minutes", async () => {
    const k = spy("kubernetes", async () => []);
    const client = await connect([k.connector]);
    await client.callTool({ name: "investigate", arguments: { namespace: "shop" } });
    expect(k.scopes[0]?.from).toBe("2026-01-01T10:30:00.000Z");
  });

  it.each([
    [{ namespace: "Shop; DROP" }],
    [{ namespace: 'a"}or{x="1' }],
    [{ namespace: "shop", service: "../etc" }],
    [{ namespace: "shop", since: "soon" }],
    [{ namespace: "shop", since: "8d" }],
    [{ namespace: "shop", since: "0m" }],
  ])("rejects invalid input %j without calling a connector", async (args) => {
    const k = spy("kubernetes", async () => [evidence()]);
    const client = await connect([k.connector]);
    const result = await client.callTool({ name: "investigate", arguments: args });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("investigate failed");
    expect(k.scopes).toHaveLength(0);
  });

  it("returns a partial timeline, with redacted errors, when a connector fails", async () => {
    const good = spy("kubernetes", async () => [evidence()]);
    const bad = spy("prometheus", async () => {
      throw new Error("query failed: Authorization: Bearer abcdef0123456789abcdef0123456789");
    });
    const client = await connect([good.connector, bad.connector]);
    const result = await client.callTool({ name: "investigate", arguments: { namespace: "shop" } });
    expect(result.isError).toBeFalsy();
    const timeline = TimelineSchema.parse(JSON.parse(text(result)));
    expect(timeline.entries).toHaveLength(1);
    expect(timeline.errors).toHaveLength(1);
    expect(timeline.errors[0]?.source).toBe("prometheus");
    expect(text(result)).not.toContain("abcdef0123456789abcdef0123456789");
  });

  it("redacts secrets in evidence returned to the client", async () => {
    const leaky = spy("kubernetes", async () => [
      EvidenceSchema.parse({
        ...evidence(),
        id: "k2",
        summary: "env dump password=hunter2hunter2 token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
        data: { password: "hunter2hunter2" },
      }),
    ]);
    const client = await connect([leaky.connector]);
    const result = await client.callTool({ name: "investigate", arguments: { namespace: "shop" } });
    expect(text(result)).not.toContain("hunter2hunter2");
    expect(text(result)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});
