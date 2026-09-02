import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const clientsTable = pgTable("nemesys_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  hostname: text("hostname").notNull(),
  address: text("address").notNull(),
  status: text("status").notNull().default("stale"),
  lastSync: timestamp("last_sync", { withTimezone: true }),
  syncVersion: text("sync_version").notNull().default("1.0.0"),
  certificateStatus: text("certificate_status").notNull().default("valid"),
});

export const softwarePoliciesTable = pgTable("nemesys_software_policies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  executable: text("executable").notNull(),
  targetVersion: text("target_version").notNull(),
  ruleType: text("rule_type").notNull(),
  iniRules: jsonb("ini_rules").$type<Array<{ section: string; key: string; expectedValue: string }>>().notNull().default([]),
  graceSeconds: integer("grace_seconds").notNull().default(30),
  enabled: boolean("enabled").notNull().default(true),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
});

export const auditEntriesTable = pgTable("nemesys_audit_entries", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  clientName: text("client_name").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  result: text("result").notNull(),
  applications: jsonb("applications").$type<Array<{
    softwareId: string;
    softwareName: string;
    observedVersion: string;
    expectedVersion: string;
    compliant: boolean;
  }>>().notNull().default([]),
});

export const serverSettingsTable = pgTable("nemesys_server_settings", {
  id: text("id").primaryKey(),
  syncIntervalSeconds: integer("sync_interval_seconds").notNull().default(300),
  syncPort: integer("sync_port").notNull().default(5187),
  adminHttpsEnabled: boolean("admin_https_enabled").notNull().default(true),
  mtlsRequired: boolean("mtls_required").notNull().default(true),
});

export const insertClientSchema = createInsertSchema(clientsTable);
export const insertSoftwarePolicySchema = createInsertSchema(softwarePoliciesTable);
export const insertAuditEntrySchema = createInsertSchema(auditEntriesTable);
export const insertServerSettingsSchema = createInsertSchema(serverSettingsTable);

export type Client = typeof clientsTable.$inferSelect;
export type SoftwarePolicy = typeof softwarePoliciesTable.$inferSelect;
export type AuditEntry = typeof auditEntriesTable.$inferSelect;
export type ServerSettings = typeof serverSettingsTable.$inferSelect;
export type InsertClient = z.infer<typeof insertClientSchema>;
export type InsertSoftwarePolicy = z.infer<typeof insertSoftwarePolicySchema>;
export type InsertAuditEntry = z.infer<typeof insertAuditEntrySchema>;
export type InsertServerSettings = z.infer<typeof insertServerSettingsSchema>;