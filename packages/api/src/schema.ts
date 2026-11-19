import type { Timeline } from "@kube-triage/core";
import { bigserial, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Mirrors migrations/0000_init.sql. An integration test keeps the two honest. */
export const incidents = pgTable("incidents", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
  namespace: text("namespace").notNull(),
  service: text("service"),
  windowFrom: timestamp("window_from", { withTimezone: true, mode: "date" }).notNull(),
  windowTo: timestamp("window_to", { withTimezone: true, mode: "date" }).notNull(),
  status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
  severity: text("severity", { enum: ["none", "info", "warning", "critical"] }).notNull(),
  title: text("title").notNull(),
  timeline: jsonb("timeline").$type<Timeline>().notNull(),
});

export const auditLog = pgTable("audit_log", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
  actor: text("actor").notNull(),
  role: text("role").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  outcome: text("outcome", { enum: ["success", "denied", "error"] }).notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
});

export type IncidentRow = typeof incidents.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
