import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb, migrate, type DbHandle } from "../src/index.js";

/**
 * Integration tests need a real PostgreSQL. Set DATABASE_URL, for example:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test
 * Each test file gets its own throwaway schema, dropped afterwards.
 */
export const DATABASE_URL = process.env["DATABASE_URL"];

export interface TestDb extends DbHandle {
  schema: string;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  await admin.query(`create schema ${schema}`);
  const handle = createDb(DATABASE_URL, { searchPath: schema });
  await migrate(handle.pool);
  return {
    ...handle,
    schema,
    async drop() {
      await handle.close();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    },
  };
}
