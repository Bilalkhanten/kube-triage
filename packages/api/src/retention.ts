import { lt } from "drizzle-orm";
import type { AuditLog } from "./audit.js";
import type { Db } from "./db.js";
import { incidents } from "./schema.js";

/**
 * Deletes incidents created before `olderThan`. The audit log is never touched: it is
 * append-only, and the purge itself is recorded in it.
 */
export async function purgeIncidents(db: Db, audit: AuditLog, olderThan: Date): Promise<number> {
  const removed = await db.delete(incidents).where(lt(incidents.createdAt, olderThan)).returning({ id: incidents.id });
  await audit.record({
    actor: "system",
    role: "system",
    action: "retention.purge",
    outcome: "success",
    detail: { removed: removed.length, olderThan: olderThan.toISOString() },
  });
  return removed.length;
}
