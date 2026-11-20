import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvidenceSchema, type Connector } from "@kube-triage/core";
import { ApiKeyAuthenticator, AuditLog, buildApp, generateKey, incidents, purgeIncidents } from "../src/index.js";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers.js";

const NOW = new Date("2026-01-01T11:00:00Z");
const quiet: Connector = { name: "kubernetes", collect: async () => [] };

describe.skipIf(!DATABASE_URL)("API hardening", () => {
  let t: TestDb;
  const investigator = generateKey();
  const admin = generateKey();
  const as = (k: { token: string }) => ({ authorization: `Bearer ${k.token}` });
  const authenticator = () =>
    new ApiKeyAuthenticator([
      { id: "oncall", sha256: investigator.sha256, role: "investigator" },
      { id: "ops", sha256: admin.sha256, role: "admin" },
    ]);
  const apps: FastifyInstance[] = [];
  const build = (over: Partial<Parameters<typeof buildApp>[0]> = {}) => {
    const app = buildApp({ db: t.db, authenticator: authenticator(), connectors: () => [quiet], now: () => NOW, ...over });
    apps.push(app);
    return app;
  };

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await t.drop();
  });

  const auditRows = async (action?: string) => {
    const rows = await new AuditLog(t.db).list({ limit: 500 });
    return action ? rows.filter((r) => r.action === action) : rows;
  };

  it("rate-limits each key with 429 and Retry-After, and audits only the first rejection", async () => {
    const app = build({ limits: { requestsPerMinute: 3 } });
    const codes: number[] = [];
    let last;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({ method: "GET", url: "/v1/incidents", headers: as(investigator) });
      codes.push(last.statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429, 429]);
    expect(last?.headers["retry-after"]).toBeDefined();
    expect(last?.json()).toEqual({ error: "rate_limited" });
    const limited = (await auditRows("rate.limited")).filter((r) => r.actor === "oncall");
    expect(limited).toHaveLength(1);
    // Another key is unaffected.
    expect((await app.inject({ method: "GET", url: "/v1/audit/head", headers: as(admin) })).statusCode).not.toBe(429);
  });

  it("stops a flood of bad keys from filling the audit log", async () => {
    const before = (await auditRows()).length;
    const app = build({ limits: { anonymousRequestsPerMinute: 5 } });
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await app.inject({ method: "GET", url: "/v1/incidents", headers: { authorization: `Bearer kt_guess${i}` } })).statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(35);
    // 5 denials plus ONE rate.limited entry, not 40.
    expect((await auditRows()).length - before).toBe(6);
  });

  it("caps concurrent investigations and releases the slot afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const slow: Connector = {
      name: "kubernetes",
      collect: async () => {
        started += 1;
        await gate;
        return [EvidenceSchema.parse({ id: "e", source: "kubernetes", kind: "k8s.x", observedAt: "2026-01-01T10:30:00Z", severity: "info", summary: "s", subject: { kind: "Pod", name: "p" }, tags: [] })];
      },
    };
    const app = build({ connectors: () => [slow], limits: { maxConcurrentInvestigations: 1 } });
    const first = app.inject({ method: "POST", url: "/v1/investigations", headers: as(investigator), payload: { namespace: "shop" } });
    while (started === 0) await new Promise((r) => setTimeout(r, 5));

    const second = await app.inject({ method: "POST", url: "/v1/investigations", headers: as(investigator), payload: { namespace: "shop" } });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: "busy" });
    expect(second.headers["retry-after"]).toBe("5");

    release();
    expect((await first).statusCode).toBe(201);
    const third = await app.inject({ method: "POST", url: "/v1/investigations", headers: as(investigator), payload: { namespace: "shop" } });
    expect(third.statusCode).toBe(201);
  });

  it("releases the investigation slot even when the request fails", async () => {
    const app = build({ limits: { maxConcurrentInvestigations: 1 }, db: { ...t.db, insert: () => { throw new Error("boom"); } } as never });
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "POST", url: "/v1/investigations", headers: as(investigator), payload: { namespace: "shop" } });
      expect(res.statusCode).toBe(500); // never 429: the slot was freed each time
    }
  });

  it("exposes the audit head and detects deletion from the end only when an anchor is given", async () => {
    const app = build();
    const log = new AuditLog(t.db);
    for (let i = 0; i < 3; i++) await log.record({ actor: "x", role: "admin", action: `a${i}`, outcome: "success" });
    const head = (await app.inject({ method: "GET", url: "/v1/audit/head", headers: as(admin) })).json();
    expect(head).toMatchObject({ seq: expect.any(Number), hash: expect.stringMatching(/^[0-9a-f]{64}$/) });

    // Anchored verification passes while nothing is wrong.
    const ok = await app.inject({ method: "GET", url: `/v1/audit/verify?anchorSeq=${head.seq}&anchorHash=${head.hash}`, headers: as(admin) });
    expect(ok.json()).toMatchObject({ ok: true });

    // Someone with database ownership removes the newest rows behind the triggers' back.
    const client = await t.pool.connect();
    try {
      await client.query("alter table audit_log disable trigger audit_log_no_update_delete");
      await client.query("delete from audit_log where seq >= $1", [head.seq - 1]);
      await client.query("alter table audit_log enable trigger audit_log_no_update_delete");
    } finally {
      client.release();
    }
    // Without an anchor the shortened chain still looks valid (the documented limit)...
    expect((await app.inject({ method: "GET", url: "/v1/audit/verify", headers: as(admin) })).json()).toMatchObject({ ok: true });
    // ...with the anchor it is caught.
    const caught = await app.inject({ method: "GET", url: `/v1/audit/verify?anchorSeq=${head.seq}&anchorHash=${head.hash}`, headers: as(admin) });
    expect(caught.json()).toMatchObject({ ok: false, reason: expect.stringContaining("anchored entry is missing") });
  });

  it("rejects malformed anchors", async () => {
    const app = build();
    expect((await app.inject({ method: "GET", url: "/v1/audit/verify?anchorSeq=1&anchorHash=zzz", headers: as(admin) })).statusCode).toBe(400);
  });

  it("purges only incidents older than the cutoff, and records the purge without touching the audit log", async () => {
    const mk = (createdAt: Date) =>
      t.db.insert(incidents).values({
        createdAt,
        createdBy: "k",
        namespace: "retention",
        windowFrom: createdAt,
        windowTo: createdAt,
        severity: "none",
        title: "t",
        timeline: { scope: { namespace: "retention", from: createdAt.toISOString(), to: new Date(createdAt.getTime() + 1000).toISOString() }, generatedAt: createdAt.toISOString(), entries: [], hypotheses: [], errors: [] },
      });
    await mk(new Date("2025-01-01T00:00:00Z"));
    await mk(new Date("2025-06-01T00:00:00Z"));
    await mk(new Date("2026-01-01T00:00:00Z"));

    const auditBefore = (await auditRows()).length;
    const removed = await purgeIncidents(t.db, new AuditLog(t.db), new Date("2025-12-01T00:00:00Z"));
    expect(removed).toBe(2);
    const left = await t.pool.query("select count(*)::int as n from incidents where namespace = 'retention'");
    expect(left.rows[0].n).toBe(1);

    const entries = await auditRows("retention.purge");
    expect(entries[0]).toMatchObject({ actor: "system", outcome: "success", detail: { removed: 2 } });
    expect((await auditRows()).length).toBe(auditBefore + 1); // only the purge entry was added
  });
});
