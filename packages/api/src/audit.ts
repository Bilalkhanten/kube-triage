import { createHash } from "node:crypto";
import { and, asc, desc, gt, lt, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { auditLog, type AuditRow } from "./schema.js";

export type AuditOutcome = "success" | "denied" | "error";

export interface AuditEntry {
  actor: string;
  role: string;
  action: string;
  target?: string | undefined;
  outcome: AuditOutcome;
  /** Small, non-secret facts about the event. */
  detail?: Record<string, unknown>;
}

// Serialises writers so the chain has one order.
const AUDIT_LOCK = 727_274;

/** JSON with sorted keys, so the same data always hashes the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function entryHash(prevHash: string, row: Pick<AuditRow, "at" | "actor" | "role" | "action" | "target" | "outcome" | "detail">): string {
  return createHash("sha256")
    .update(stableStringify([prevHash, row.at.toISOString(), row.actor, row.role, row.action, row.target ?? null, row.outcome, row.detail]))
    .digest("hex");
}

export type VerifyResult = { ok: true; count: number } | { ok: false; brokenAtSeq: number; reason: string };

/**
 * Append-only and hash-chained. The database refuses UPDATE, DELETE and TRUNCATE, and each
 * row's hash covers the previous row's hash, so editing history after the fact is detectable.
 * Deleting the newest rows cannot be detected from the table alone: keep the latest hash
 * somewhere else (for example in your log pipeline) if you need that guarantee.
 */
export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(entry: AuditEntry): Promise<AuditRow> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_LOCK})`);
      const [last] = await tx.select({ hash: auditLog.hash }).from(auditLog).orderBy(desc(auditLog.seq)).limit(1);
      const prevHash = last?.hash ?? "";
      const base = {
        at: this.now(),
        actor: entry.actor,
        role: entry.role,
        action: entry.action,
        target: entry.target ?? null,
        outcome: entry.outcome,
        detail: entry.detail ?? {},
      };
      const [row] = await tx
        .insert(auditLog)
        .values({ ...base, prevHash, hash: entryHash(prevHash, base) })
        .returning();
      return row as AuditRow;
    });
  }

  /** Newest first. */
  async list(options: { limit?: number; beforeSeq?: number } = {}): Promise<AuditRow[]> {
    return this.db
      .select()
      .from(auditLog)
      .where(options.beforeSeq ? lt(auditLog.seq, options.beforeSeq) : undefined)
      .orderBy(desc(auditLog.seq))
      .limit(Math.min(options.limit ?? 100, 500));
  }

  async verify(): Promise<VerifyResult> {
    let prevHash = "";
    let afterSeq = 0;
    let count = 0;
    for (;;) {
      const rows = await this.db
        .select()
        .from(auditLog)
        .where(and(gt(auditLog.seq, afterSeq)))
        .orderBy(asc(auditLog.seq))
        .limit(1000);
      if (rows.length === 0) return { ok: true, count };
      for (const row of rows) {
        if (row.prevHash !== prevHash) return { ok: false, brokenAtSeq: row.seq, reason: "previous hash does not match" };
        if (row.hash !== entryHash(prevHash, row)) return { ok: false, brokenAtSeq: row.seq, reason: "row content does not match its hash" };
        prevHash = row.hash;
        afterSeq = row.seq;
        count += 1;
      }
    }
  }
}
