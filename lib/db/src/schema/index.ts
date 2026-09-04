import { boolean, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const clientsTable = pgTable("nemesys_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  hostname: text("hostname").notNull(),
  address: text("address").notNull(),
  status: text("status").notNull().default("stale"),
  lastSync: timestamp("last_sync", { withTimezone: true }),
  lastPoll: timestamp("last_poll", { withTimezone: true }),
  lastSuccessfulSync: timestamp("last_successful_sync", { withTimezone: true }),
  syncVersion: text("sync_version").notNull().default("1.0.0"),
  installedVersion: text("installed_version"),
  certificateStatus: text("certificate_status").notNull().default("valid"),
});

export const softwarePoliciesTable = pgTable("nemesys_software_policies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  executable: text("executable").notNull(),
  targetVersion: text("target_version").notNull(),
  ruleType: text("rule_type").notNull(),
  supervisedExecutables: jsonb("supervised_executables").$type<string[]>().notNull().default([]),
  exeChecks: jsonb("exe_checks").$type<Array<{ executable: string; comparisonOperator?: "<" | "<=" | "=" | ">=" | ">"; targetVersion: string; installCommand?: string }>>().notNull().default([]),
  iniChecks: jsonb("ini_checks").$type<Array<{ filePath: string; section: string; key: string; comparisonOperator?: "<" | "<=" | "=" | ">=" | ">"; expectedValue: string }>>().notNull().default([]),
  iniRules: jsonb("ini_rules").$type<Array<{ section: string; key: string; expectedValue: string }>>().notNull().default([]),
  normalCloseTimeoutSeconds: integer("normal_close_timeout_seconds").notNull().default(30),
  updateMode: boolean("update_mode").notNull().default(false),
  updateModeCloseTimeoutSeconds: integer("update_mode_close_timeout_seconds").notNull().default(8),
  allowPostpone: boolean("allow_postpone").notNull().default(false),
  launchOnExitUpdateMode: boolean("launch_on_exit_update_mode").notNull().default(false),
  launchExecutablePath: text("launch_executable_path").notNull().default(""),
  launchArguments: text("launch_arguments").notNull().default(""),
  updateModeCycleId: text("update_mode_cycle_id").notNull().default("initial"),
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
}, (table) => ({
  clientIdUnique: unique("nemesys_audit_entries_client_id_unique").on(table.clientId),
}));

export const serverSettingsTable = pgTable("nemesys_server_settings", {
  id: text("id").primaryKey(),
  syncPort: integer("sync_port").notNull().default(443),
  adminHttpsEnabled: boolean("admin_https_enabled").notNull().default(true),
  desiredClientVersion: text("desired_client_version").notNull().default("1.0.0"),
  adminUsername: text("admin_username").notNull().default("admin"),
  adminPasswordHash: text("admin_password_hash"),
  clientApiKeyHash: text("client_api_key_hash"),
  clientApiKeyEncrypted: text("client_api_key_encrypted"),
  apiKeyLastRotatedAt: timestamp("api_key_last_rotated_at", { withTimezone: true }),
});

export const adminUsersTable = pgTable("nemesys_admin_users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  displayName: text("display_name").notNull(),
  email: text("email").notNull().default(""),
  source: text("source").notNull().default("ldap"),
  directoryDn: text("directory_dn"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  usernameUnique: unique().on(table.username),
}));

export const ldapSettingsTable = pgTable("nemesys_ldap_settings", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  url: text("url").notNull().default(""),
  bindDn: text("bind_dn").notNull().default(""),
  bindPasswordEncrypted: text("bind_password_encrypted"),
  baseDn: text("base_dn").notNull().default(""),
  userFilter: text("user_filter").notNull().default("(&(objectClass=person)(sAMAccountName={{username}}))"),
  usernameAttribute: text("username_attribute").notNull().default("sAMAccountName"),
  displayNameAttribute: text("display_name_attribute").notNull().default("displayName"),
  emailAttribute: text("email_attribute").notNull().default("mail"),
  verifyTlsCertificate: boolean("verify_tls_certificate").notNull().default(true),
  caCertificatePem: text("ca_certificate_pem"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sslSettingsTable = pgTable("nemesys_ssl_settings", {
  id: text("id").primaryKey(),
  certificatePem: text("certificate_pem"),
  privateKeyPemEncrypted: text("private_key_pem_encrypted"),
  chainPem: text("chain_pem"),
  certificateFingerprint: text("certificate_fingerprint"),
  certificateSubject: text("certificate_subject"),
  certificateExpiresAt: timestamp("certificate_expires_at", { withTimezone: true }),
  forceHttps: boolean("force_https").notNull().default(false),
  hstsEnabled: boolean("hsts_enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertClientSchema = createInsertSchema(clientsTable);
export const insertSoftwarePolicySchema = createInsertSchema(softwarePoliciesTable);
export const insertAuditEntrySchema = createInsertSchema(auditEntriesTable);
export const insertServerSettingsSchema = createInsertSchema(serverSettingsTable);

export type Client = typeof clientsTable.$inferSelect;
export type SoftwarePolicy = typeof softwarePoliciesTable.$inferSelect;
export type AuditEntry = typeof auditEntriesTable.$inferSelect;
export type ServerSettings = typeof serverSettingsTable.$inferSelect;
export type AdminUser = typeof adminUsersTable.$inferSelect;
export type LdapSettings = typeof ldapSettingsTable.$inferSelect;
export type SslSettings = typeof sslSettingsTable.$inferSelect;
export type InsertClient = z.infer<typeof insertClientSchema>;
export type InsertSoftwarePolicy = z.infer<typeof insertSoftwarePolicySchema>;
export type InsertAuditEntry = z.infer<typeof insertAuditEntrySchema>;
export type InsertServerSettings = z.infer<typeof insertServerSettingsSchema>;