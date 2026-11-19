import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditLog, stableStringify } from "../src/index.js";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers.js";

describe("stableStringify", () => {
  it("is independent of key order and drops undefined", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { y: 1, x: 2 }] } })).toBe(stableStringify({ a: { c: [3, { x: 2, y: 1 }], d: 2 }, b: 1 }));
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});

describe.skipIf(!DATABASE_URL)("audit log", () => {
  let t: TestDb;
  let audit: AuditLog;
  beforeAll(async () => {
    t = await createTestDb();
    audit = new AuditLog(t.db);
  });
  afterAll(async () => {
    await t.drop();
  });

  const entry = (n: number) => ({ actor: "ops", role: "admin", action: `action-${n}`, target: `t${n}`, outcome: "success" as const, detail: { n } });

  it("is valid when empty", async () => {
    expect(await audit.verify()).toEqual({ ok: true, count: 0 });
  });

  it("chains each row to the previous one", async () => {
    const a = await audit.record(entry(1));
    const b = await audit.record(entry(2));
    expect(a.prevHash).toBe("");
    expect(b.prevHash).toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await audit.verify()).toEqual({ ok: true, count: 2 });
  });

  it("lists newest first", async () => {
    const rows = await audit.list({ limit: 10 });
    expect(rows.map((r) => r.action)).toEqual(["action-2", "action-1"]);
    expect((await audit.list({ beforeSeq: rows[0]!.seq })).map((r) => r.action)).toEqual(["action-1"]);
  });

  it("refuses UPDATE, DELETE and TRUNCATE at the database", async () => {
    await expect(t.pool.query("update audit_log set actor = 'someone-else'")).rejects.toThrow(/append-only/);
    await expect(t.pool.query("delete from audit_log")).rejects.toThrow(/append-only/);
    await expect(t.pool.query("truncate audit_log")).rejects.toThrow(/append-only/);
    expect((await audit.list()).length).toBe(2);
  });

  it("keeps a valid chain under concurrent writers", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => audit.record(entry(100 + i))));
    expect(await audit.verify()).toEqual({ ok: true, count: 27 });
  });

  it("detects an edit made behind the triggers' back", async () => {
    const client = await t.pool.connect();
    try {
      // Only someone who can disable triggers (a superuser or the table owner) could do this.
      await client.query("alter table audit_log disable trigger audit_log_no_update_delete");
      await client.query("update audit_log set actor = 'mallory' where seq = (select min(seq) from audit_log)");
      await client.query("alter table audit_log enable trigger audit_log_no_update_delete");
    } finally {
      client.release();
    }
    const result = await audit.verify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not match its hash/);
  });

  it("detects a row removed from the middle", async () => {
    const t2 = await createTestDb();
    try {
      const log = new AuditLog(t2.db);
      for (let i = 1; i <= 4; i++) await log.record(entry(i));
      await t2.pool.query("alter table audit_log disable trigger audit_log_no_update_delete");
      await t2.pool.query("delete from audit_log where seq = 2");
      await t2.pool.query("alter table audit_log enable trigger audit_log_no_update_delete");
      const result = await log.verify();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/previous hash/);
    } finally {
      await t2.drop();
    }
  });
});
