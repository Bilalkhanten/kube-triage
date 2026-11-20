import { investigate, parseDuration, redactSecrets, runbookRefs, type Connector, type Runbook, type Severity, type Timeline } from "@kube-triage/core";
import { and, desc, eq, lt } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { AuditLog } from "./audit.js";
import { hasRole, type ApiKeyAuthenticator, type Principal, type Role } from "./auth.js";
import type { Db } from "./db.js";
import { incidents, type IncidentRow } from "./schema.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AppDeps {
  db: Db;
  authenticator: ApiKeyAuthenticator;
  /** Called per investigation, so connectors can be rebuilt from fresh configuration. */
  connectors: () => Connector[];
  /** Runbooks to point at. Matched when an incident is read, so updated runbooks apply to old incidents too. */
  runbooks?: Runbook[];
  now?: () => Date;
  logger?: boolean;
}

const MAX_WINDOW_MS = 7 * 86_400_000;
const dnsLabel = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);

const InvestigateBody = z.object({
  namespace: dnsLabel,
  service: dnsLabel.optional(),
  since: z.string().default("30m"),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.iso.datetime({ offset: true }).optional(),
  namespace: dnsLabel.optional(),
});

const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  beforeSeq: z.coerce.number().int().positive().optional(),
});

const StatusBody = z.object({ status: z.enum(["open", "resolved"]) });
const IdParam = z.object({ id: z.uuid() });

const SEVERITY_ORDER: Severity[] = ["info", "warning", "critical"];

function maxSeverity(timeline: Timeline): IncidentRow["severity"] {
  let best = -1;
  for (const e of timeline.entries) best = Math.max(best, SEVERITY_ORDER.indexOf(e.severity));
  return best < 0 ? "none" : (SEVERITY_ORDER[best] as Severity);
}

function titleFor(timeline: Timeline): string {
  const target = timeline.scope.service ? `${timeline.scope.namespace}/${timeline.scope.service}` : timeline.scope.namespace;
  const top = timeline.hypotheses[0];
  if (top) return `${top.title} (${target})`;
  return timeline.entries.length > 0 ? `${timeline.entries.length} observations in ${target}` : `No problems found in ${target}`;
}

function summary(row: IncidentRow) {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    namespace: row.namespace,
    service: row.service,
    status: row.status,
    severity: row.severity,
    title: row.title,
  };
}

function detail(row: IncidentRow, runbooks: Runbook[] = []) {
  return {
    ...summary(row),
    windowFrom: row.windowFrom.toISOString(),
    windowTo: row.windowTo.toISOString(),
    timeline: row.timeline,
    runbooks: runbookRefs(row.timeline.hypotheses, runbooks),
  };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const now = deps.now ?? (() => new Date());
  const audit = new AuditLog(deps.db, now);
  const app = Fastify({
    logger: deps.logger ? { redact: ["req.headers.authorization"] } : false,
    bodyLimit: 16 * 1024,
  });

  // Never echo internal error text to clients; log it (redacted) instead.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid_request", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: "bad_request" });
    request.log.error({ err: redactSecrets(error instanceof Error ? error.message : String(error)) }, "unhandled error");
    return reply.code(500).send({ error: "internal" });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  async function denied(request: FastifyRequest, reply: FastifyReply, code: 401 | 403, action: string) {
    await audit.record({
      actor: request.principal?.id ?? "anonymous",
      role: request.principal?.role ?? "none",
      action,
      target: `${request.method} ${request.routeOptions.url ?? request.url}`,
      outcome: "denied",
    });
    return reply.code(code).send({ error: code === 401 ? "unauthorized" : "forbidden" });
  }

  /** Authenticates, then requires at least `role`. Failures are written to the audit log. */
  const guard =
    (role: Role) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
      const principal = deps.authenticator.authenticate(request.headers.authorization);
      if (!principal) return denied(request, reply, 401, "auth.denied");
      request.principal = principal;
      if (!hasRole(principal.role, role)) return denied(request, reply, 403, "auth.forbidden");
    };

  app.get("/v1/incidents", { preHandler: guard("viewer") }, async (request) => {
    const q = ListQuery.parse(request.query);
    const where = and(q.before ? lt(incidents.createdAt, new Date(q.before)) : undefined, q.namespace ? eq(incidents.namespace, q.namespace) : undefined);
    const rows = await deps.db.select().from(incidents).where(where).orderBy(desc(incidents.createdAt), desc(incidents.id)).limit(q.limit);
    return { incidents: rows.map(summary) };
  });

  app.get("/v1/incidents/:id", { preHandler: guard("viewer") }, async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const [row] = await deps.db.select().from(incidents).where(eq(incidents.id, id)).limit(1);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return detail(row, deps.runbooks);
  });

  app.post("/v1/investigations", { preHandler: guard("investigator") }, async (request, reply) => {
    const principal = request.principal as Principal;
    const body = InvestigateBody.parse(request.body);
    let windowMs: number;
    try {
      windowMs = parseDuration(body.since);
    } catch (e) {
      return reply.code(400).send({ error: "invalid_request", issues: [{ path: "since", message: (e as Error).message }] });
    }
    if (windowMs > MAX_WINDOW_MS) {
      return reply.code(400).send({ error: "invalid_request", issues: [{ path: "since", message: "at most 7d" }] });
    }
    const connectors = deps.connectors();
    if (connectors.length === 0) return reply.code(503).send({ error: "no_connectors" });

    const to = now();
    const target = body.service ? `${body.namespace}/${body.service}` : body.namespace;
    const timeline = await investigate(
      { namespace: body.namespace, ...(body.service ? { service: body.service } : {}), from: new Date(to.getTime() - windowMs).toISOString(), to: to.toISOString() },
      connectors,
      { now: to },
    );

    const [row] = await deps.db
      .insert(incidents)
      .values({
        createdBy: principal.id,
        namespace: body.namespace,
        service: body.service ?? null,
        windowFrom: new Date(timeline.scope.from),
        windowTo: new Date(timeline.scope.to),
        severity: maxSeverity(timeline),
        title: titleFor(timeline),
        timeline,
      })
      .returning();
    const incident = row as IncidentRow;
    await audit.record({
      actor: principal.id,
      role: principal.role,
      action: "investigation.create",
      target,
      outcome: "success",
      detail: { incidentId: incident.id, severity: incident.severity, connectorErrors: timeline.errors.length },
    });
    return reply.code(201).send(detail(incident, deps.runbooks));
  });

  app.patch("/v1/incidents/:id", { preHandler: guard("investigator") }, async (request, reply) => {
    const principal = request.principal as Principal;
    const { id } = IdParam.parse(request.params);
    const { status } = StatusBody.parse(request.body);
    const [row] = await deps.db.update(incidents).set({ status }).where(eq(incidents.id, id)).returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await audit.record({ actor: principal.id, role: principal.role, action: "incident.update", target: id, outcome: "success", detail: { status } });
    return detail(row, deps.runbooks);
  });

  app.get("/v1/audit", { preHandler: guard("admin") }, async (request) => {
    const principal = request.principal as Principal;
    const q = AuditQuery.parse(request.query);
    await audit.record({ actor: principal.id, role: principal.role, action: "audit.read", outcome: "success" });
    const rows = await audit.list({ limit: q.limit, ...(q.beforeSeq ? { beforeSeq: q.beforeSeq } : {}) });
    return { entries: rows.map((r) => ({ ...r, at: r.at.toISOString() })) };
  });

  app.get("/v1/audit/verify", { preHandler: guard("admin") }, async (request) => {
    const principal = request.principal as Principal;
    const result = await audit.verify();
    await audit.record({ actor: principal.id, role: principal.role, action: "audit.verify", outcome: result.ok ? "success" : "error", detail: { ok: result.ok } });
    return result;
  });

  return app;
}
