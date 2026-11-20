import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvidenceSchema, parseRunbook, type Connector } from "@kube-triage/core";
import { ApiKeyAuthenticator, buildApp, generateKey } from "../src/index.js";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers.js";

const NOW = new Date("2026-01-01T11:00:00Z");

const oomConnector: Connector = {
  name: "kubernetes",
  collect: async () => [
    EvidenceSchema.parse({
      id: "k1",
      source: "kubernetes",
      kind: "k8s.pod.container-terminated",
      observedAt: "2026-01-01T10:40:00Z",
      severity: "critical",
      summary: "Container app in checkout-abc was OOMKilled, password=hunter2",
      subject: { kind: "Pod", name: "checkout-abc", namespace: "shop" },
      tags: ["oom-killed"],
    }),
  ],
};
const failingConnector: Connector = {
  name: "prometheus",
  collect: async () => {
    throw new Error("connection refused, token=abc123");
  },
};

describe.skipIf(!DATABASE_URL)("HTTP API", () => {
  let t: TestDb;
  let app: FastifyInstance;
  let connectors: Connector[] = [oomConnector];
  const viewer = generateKey();
  const investigator = generateKey();
  const admin = generateKey();
  const as = (key: { token: string }) => ({ authorization: `Bearer ${key.token}` });

  beforeAll(async () => {
    t = await createTestDb();
    app = buildApp({
      db: t.db,
      authenticator: new ApiKeyAuthenticator([
        { id: "dashboard", sha256: viewer.sha256, role: "viewer" },
        { id: "oncall", sha256: investigator.sha256, role: "investigator" },
        { id: "ops", sha256: admin.sha256, role: "admin" },
      ]),
      connectors: () => connectors,
      now: () => NOW,
    });
  });
  afterAll(async () => {
    await app.close();
    await t.drop();
  });

  const investigate = (body: unknown, key = investigator) =>
    app.inject({ method: "POST", url: "/v1/investigations", headers: as(key), payload: body as object });
  const auditActions = async () =>
    ((await app.inject({ method: "GET", url: "/v1/audit", headers: as(admin) })).json().entries as Array<{ action: string; actor: string; outcome: string; target: string | null }>);

  it("serves a health check without authentication", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
  });

  it("rejects missing and wrong keys with 401, and audits the attempt without the key", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/incidents" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/incidents", headers: { authorization: "Bearer kt_wrong" } })).statusCode).toBe(401);
    const entries = await auditActions();
    const denied = entries.filter((e) => e.action === "auth.denied");
    expect(denied.length).toBeGreaterThanOrEqual(2);
    expect(denied[0]).toMatchObject({ actor: "anonymous", outcome: "denied", target: "GET /v1/incidents" });
    expect(JSON.stringify(entries)).not.toContain("kt_wrong");
  });

  it("forbids a viewer from investigating, and audits it under their id", async () => {
    const res = await investigate({ namespace: "shop" }, viewer);
    expect(res.statusCode).toBe(403);
    expect((await auditActions()).find((e) => e.action === "auth.forbidden")).toMatchObject({ actor: "dashboard", outcome: "denied" });
  });

  it("forbids non-admins from reading the audit log", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/audit", headers: as(investigator) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/audit/verify", headers: as(viewer) })).statusCode).toBe(403);
  });

  let incidentId = "";

  it("runs an investigation, stores the incident, and returns it with redacted evidence", async () => {
    const res = await investigate({ namespace: "shop", service: "checkout", since: "1h" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    incidentId = body.id;
    expect(body).toMatchObject({ namespace: "shop", service: "checkout", status: "open", severity: "critical", createdBy: "oncall" });
    expect(body.title).toBe("Container is running out of memory (shop/checkout)");
    expect(body.windowFrom).toBe("2026-01-01T10:00:00.000Z");
    expect(body.timeline.hypotheses[0].id).toBe("oom-killed");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("points at runbooks when configured, matched at read time, and at none otherwise", async () => {
    // Without runbooks configured the field is present and empty.
    expect((await app.inject({ method: "GET", url: `/v1/incidents/${incidentId}`, headers: as(viewer) })).json().runbooks).toEqual([]);

    const oom = parseRunbook("---\ntitle: Container is running out of memory\nhypotheses: oom-killed\n---\nSteps here", "oom-killed");
    const withBooks = buildApp({
      db: t.db,
      authenticator: new ApiKeyAuthenticator([{ id: "dashboard", sha256: viewer.sha256, role: "viewer" }, { id: "oncall", sha256: investigator.sha256, role: "investigator" }]),
      connectors: () => [oomConnector],
      runbooks: [oom],
      now: () => NOW,
    });
    // The incident created earlier gains the pointer, because it is matched when read.
    const read = await withBooks.inject({ method: "GET", url: `/v1/incidents/${incidentId}`, headers: as(viewer) });
    expect(read.json().runbooks).toEqual([{ hypothesisId: "oom-killed", id: "oom-killed", title: "Container is running out of memory" }]);
    expect(read.body).not.toContain("Steps here"); // references only
    const created = await withBooks.inject({ method: "POST", url: "/v1/investigations", headers: as(investigator), payload: { namespace: "shop" } });
    expect(created.json().runbooks).toHaveLength(1);
    await withBooks.close();
  });

  it("lists and fetches incidents for a viewer", async () => {
    const list = (await app.inject({ method: "GET", url: "/v1/incidents", headers: as(viewer) })).json();
    expect(list.incidents.map((i: { id: string }) => i.id)).toContain(incidentId);
    expect(list.incidents[0].timeline).toBeUndefined(); // summaries stay small

    const one = await app.inject({ method: "GET", url: `/v1/incidents/${incidentId}`, headers: as(viewer) });
    expect(one.json().timeline.entries).toHaveLength(1);

    const filtered = (await app.inject({ method: "GET", url: "/v1/incidents?namespace=other", headers: as(viewer) })).json();
    expect(filtered.incidents).toEqual([]);
  });

  it("returns 404 for an unknown incident and 400 for a malformed id", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/incidents/3f6c1c0e-8d1e-4b64-9d0a-111111111111", headers: as(viewer) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/incidents/not-a-uuid", headers: as(viewer) })).statusCode).toBe(400);
  });

  it("validates investigation input", async () => {
    for (const bad of [{}, { namespace: 'x"} or vector(1) #' }, { namespace: "shop", since: "soon" }, { namespace: "shop", since: "30d" }, { namespace: "shop", service: "Bad_Name" }]) {
      const res = await investigate(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error).toBe("invalid_request");
    }
  });

  it("returns 503 when no connector is configured", async () => {
    connectors = [];
    expect((await investigate({ namespace: "shop" })).statusCode).toBe(503);
    connectors = [oomConnector];
  });

  it("stores a partial timeline, with the connector error redacted, when one connector fails", async () => {
    connectors = [oomConnector, failingConnector];
    const body = (await investigate({ namespace: "shop" })).json();
    connectors = [oomConnector];
    expect(body.timeline.errors).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("abc123");
    expect(body.timeline.entries).toHaveLength(1);
  });

  it("updates an incident's status, but only for investigators", async () => {
    expect((await app.inject({ method: "PATCH", url: `/v1/incidents/${incidentId}`, headers: as(viewer), payload: { status: "resolved" } })).statusCode).toBe(403);
    const ok = await app.inject({ method: "PATCH", url: `/v1/incidents/${incidentId}`, headers: as(investigator), payload: { status: "resolved" } });
    expect(ok.json().status).toBe("resolved");
    expect((await app.inject({ method: "PATCH", url: `/v1/incidents/${incidentId}`, headers: as(investigator), payload: { status: "bogus" } })).statusCode).toBe(400);
  });

  it("writes investigations and updates to the audit log, and the chain verifies", async () => {
    const actions = (await auditActions()).map((e) => e.action);
    expect(actions).toContain("investigation.create");
    expect(actions).toContain("incident.update");
    expect(actions).toContain("audit.read");
    const verify = await app.inject({ method: "GET", url: "/v1/audit/verify", headers: as(admin) });
    expect(verify.json()).toMatchObject({ ok: true });
    expect(verify.json().count).toBeGreaterThan(5);
  });

  it("does not leak internal error details", async () => {
    // A connector failure is a partial timeline, not a 500. Break the DB path instead:
    const broken = buildApp({
      db: { ...t.db, insert: () => { throw new Error("db password=hunter2 exploded"); } } as never,
      authenticator: new ApiKeyAuthenticator([{ id: "oncall", sha256: investigator.sha256, role: "investigator" }]),
      connectors: () => [oomConnector],
      now: () => NOW,
    });
    // The audit write for the denial path uses t.db; this request is allowed, so it reaches insert.
    const res = await broken.inject({ method: "POST", url: "/v1/investigations", headers: as(investigator), payload: { namespace: "shop" } });
    await broken.close();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
  });
});
