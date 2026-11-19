import { describe, expect, it } from "vitest";
import type { InvestigationScope } from "@kube-triage/core";
import { GitHubDeploymentsClient, GitHubDeploysConnector, assertReadOnlyGitHubPath } from "../src/index.js";
import { expectConnectorContract } from "./contract.js";

const scope: InvestigationScope = { namespace: "shop", from: "2026-01-01T10:00:00Z", to: "2026-01-01T11:00:00Z" };

const deployments = [
  { id: 3, sha: "c0ffee1234567890", ref: "main", environment: "production", description: "release 42", created_at: "2026-01-01T10:15:00Z", creator: { login: "bilal" } },
  { id: 2, sha: "abcdef1234567890", ref: "main", environment: "staging", description: null, created_at: "2026-01-01T10:30:00Z", creator: null },
  { id: 1, sha: "0123456789abcdef", ref: "main", environment: "production", description: null, created_at: "2025-12-31T09:00:00Z", creator: null },
];

interface Call {
  method: string | undefined;
  path: string;
  search: URLSearchParams;
  headers: Headers;
}

function fakeGitHub(statusByDeployment: Record<number, string> = { 3: "success", 2: "failure" }) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input.toString());
    calls.push({ method: init?.method, path: url.pathname, search: url.searchParams, headers: new Headers(init?.headers) });
    const json = (b: unknown) => new Response(JSON.stringify(b));
    if (url.pathname.endsWith("/deployments")) {
      const env = url.searchParams.get("environment");
      return json(env ? deployments.filter((d) => d.environment === env) : deployments);
    }
    const id = Number(/deployments\/(\d+)\/statuses/.exec(url.pathname)?.[1]);
    const state = statusByDeployment[id];
    return json(state ? [{ state, description: null, created_at: "2026-01-01T10:16:00Z" }] : []);
  };
  return { fetchImpl, calls };
}

describe("GitHubDeploysConnector", () => {
  it("satisfies the connector contract", async () => {
    const { fetchImpl } = fakeGitHub();
    await expectConnectorContract(new GitHubDeploysConnector({ repo: "acme/shop", fetch: fetchImpl }), scope);
  });

  it("reports deployments inside the window only, tagged as deploys", async () => {
    const { fetchImpl } = fakeGitHub();
    const evidence = await new GitHubDeploysConnector({ repo: "acme/shop", fetch: fetchImpl }).collect(scope);
    expect(evidence.map((e) => e.id).sort()).toEqual(["github-deploys:deployment:2", "github-deploys:deployment:3"]);
    const prod = evidence.find((e) => e.id.endsWith(":3"));
    expect(prod?.tags).toEqual(["deploy"]);
    expect(prod?.summary).toBe("Deployed main (c0ffee1) to production by bilal: success");
    expect(prod?.severity).toBe("info");
    expect(prod?.observedAt).toBe("2026-01-01T10:15:00.000Z");
  });

  it("marks failed deployments as warnings and tolerates deployments without a status", async () => {
    const { fetchImpl } = fakeGitHub({ 2: "failure" });
    const evidence = await new GitHubDeploysConnector({ repo: "acme/shop", fetch: fetchImpl }).collect(scope);
    expect(evidence.find((e) => e.id.endsWith(":2"))?.severity).toBe("warning");
    expect(evidence.find((e) => e.id.endsWith(":3"))?.summary).toContain(": pending");
  });

  it("filters by environment", async () => {
    const { fetchImpl, calls } = fakeGitHub();
    const evidence = await new GitHubDeploysConnector({ repo: "acme/shop", environment: "production", fetch: fetchImpl }).collect(scope);
    expect(evidence.map((e) => e.id)).toEqual(["github-deploys:deployment:3"]);
    expect(calls[0]?.search.get("environment")).toBe("production");
  });

  it("only sends GET requests to allowlisted endpoints, with the token only in the header", async () => {
    const { fetchImpl, calls } = fakeGitHub();
    await new GitHubDeploysConnector({ repo: "acme/shop", token: "ghp_secrettoken", fetch: fetchImpl }).collect(scope);
    for (const c of calls) {
      expect(c.method).toBe("GET");
      expect(() => assertReadOnlyGitHubPath(c.path)).not.toThrow();
      expect(c.headers.get("authorization")).toBe("Bearer ghp_secrettoken");
      expect(c.search.toString()).not.toContain("ghp_secrettoken");
    }
  });
});

describe("GitHubDeploymentsClient", () => {
  it("rejects paths outside the allowlist", () => {
    for (const bad of ["/repos/acme/shop/git/refs", "/repos/acme/shop/deployments/1", "/user", "/repos/acme/shop/deployments/x/statuses"]) {
      expect(() => assertReadOnlyGitHubPath(bad)).toThrow(/non-allowlisted/);
    }
  });

  it("validates the repository name", () => {
    expect(() => new GitHubDeploymentsClient({ repo: "nope" })).toThrow(/Invalid repository/);
    expect(() => new GitHubDeploymentsClient({ repo: "a/b/c" })).toThrow(/Invalid repository/);
    expect(() => new GitHubDeploymentsClient({ repo: "../../x/y" })).toThrow(/Invalid repository/);
  });

  it("surfaces HTTP errors and malformed bodies", async () => {
    const http = new GitHubDeploymentsClient({ repo: "a/b", fetch: async () => new Response("no", { status: 403 }) });
    await expect(http.listDeployments({})).rejects.toThrow(/HTTP 403/);
    const bad = new GitHubDeploymentsClient({ repo: "a/b", fetch: async () => new Response(JSON.stringify([{ nope: 1 }])) });
    await expect(bad.listDeployments({})).rejects.toThrow();
  });
});
