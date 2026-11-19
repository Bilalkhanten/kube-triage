import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  pool: pg.Pool;
  db: Db;
  close(): Promise<void>;
}

export function createDb(connectionString: string, options: { searchPath?: string } = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
  });
  return { pool, db: drizzle(pool, { schema }), close: () => pool.end() };
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
// Stops two replicas migrating at once.
const MIGRATION_LOCK = 727_273;

/** Applies each migrations/*.sql file once, in name order, each in its own transaction. */
export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    for (const name of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort()) {
      if (done.has(name)) continue;
      const sql = await readFile(`${dir}/${name}`, "utf8");
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [name]);
        await client.query("commit");
        applied.push(name);
      } catch (error) {
        await client.query("rollback");
        throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
  return applied;
}
