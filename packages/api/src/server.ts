#!/usr/bin/env node
import { createDefaultRegistry } from "@kube-triage/connectors";
import { loadRunbooks } from "@kube-triage/core";
import { buildApp } from "./app.js";
import { ApiKeyAuthenticator } from "./auth.js";
import { createDb, migrate } from "./db.js";

async function main(): Promise<void> {
  const env = process.env;
  const databaseUrl = env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is not set.");
  const authenticator = ApiKeyAuthenticator.fromEnv(env);

  const handle = createDb(databaseUrl);
  const applied = await migrate(handle.pool);
  if (applied.length > 0) process.stdout.write(`applied migrations: ${applied.join(", ")}\n`);

  // Connectors come from the environment (and the pod's read-only service account), never from requests.
  const registry = createDefaultRegistry();
  const runbookDir = env["KUBE_TRIAGE_RUNBOOKS"];
  const runbooks = runbookDir ? await loadRunbooks(runbookDir) : undefined;
  const app = buildApp({ db: handle.db, authenticator, connectors: () => registry.connectorsFromEnv(env), ...(runbooks ? { runbooks } : {}), logger: true });

  const shutdown = async () => {
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Loopback by default. The Helm chart opts in to 0.0.0.0 explicitly.
  await app.listen({ host: env["HOST"] ?? "127.0.0.1", port: Number(env["PORT"] ?? 8080) });
}

main().catch((error: unknown) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
