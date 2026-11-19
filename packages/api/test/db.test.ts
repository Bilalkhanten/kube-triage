import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, incidents, migrate } from "../src/index.js";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers.js";

describe.skipIf(!DATABASE_URL)("database", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.drop();
  });

  it("applies each migration once", async () => {
    expect(await migrate(t.pool)).toEqual([]);
    const { rows } = await t.pool.query("select name from schema_migrations");
    expect(rows.map((r) => r.name)).toEqual(["0000_init.sql"]);
  });

  it("agrees with the Drizzle schema: rows round-trip through both tables", async () => {
    const timeline = {
      scope: { namespace: "shop", from: "2026-01-01T10:00:00.000Z", to: "2026-01-01T11:00:00.000Z" },
      generatedAt: "2026-01-01T11:00:00.000Z",
      entries: [],
      hypotheses: [],
      errors: [],
    };
    const [incident] = await t.db
      .insert(incidents)
      .values({ createdBy: "k", namespace: "shop", windowFrom: new Date(timeline.scope.from), windowTo: new Date(timeline.scope.to), severity: "none", title: "t", timeline })
      .returning();
    expect(incident?.status).toBe("open");
    expect(incident?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(incident?.timeline.scope.namespace).toBe("shop");

    const [row] = await t.db
      .insert(auditLog)
      .values({ at: new Date(), actor: "k", role: "admin", action: "x", outcome: "success", prevHash: "", hash: "h" })
      .returning();
    expect(row?.seq).toBeGreaterThan(0);
    expect(row?.detail).toEqual({});
  });

  it("enforces its check constraints", async () => {
    await expect(t.pool.query("insert into incidents (created_by, namespace, window_from, window_to, status, severity, title, timeline) values ('k','n',now(),now(),'weird','none','t','{}')")).rejects.toThrow(/check constraint/);
    await expect(t.pool.query("insert into audit_log (at, actor, role, action, outcome, prev_hash, hash) values (now(),'a','r','x','maybe','','h')")).rejects.toThrow(/check constraint/);
  });
});
