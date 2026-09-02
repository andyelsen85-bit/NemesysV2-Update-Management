import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { and, count, desc, eq, gte } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  auditEntriesTable,
  clientsTable,
  serverSettingsTable,
  softwarePoliciesTable,
} from "@workspace/db";
import type { SoftwarePolicy as DbSoftwarePolicy } from "@workspace/db";
import { decryptSecret, encryptSecret } from "../lib/secret-crypto";
import { requireAdmin } from "./auth";
import {
  CreateSoftwareBody,
  CreateSoftwareResponse,
  GetDashboardResponse,
  GetServerSettingsResponse,
  GetSyncConfigQueryParams,
  GetSyncConfigResponse,
  ListAuditEntriesQueryParams,
  ListAuditEntriesResponse,
  ListClientsResponse,
  ListSoftwareResponse,
  RevokeClientParams,
  RevokeClientResponse,
  RotateClientApiKeyResponse,
  GetClientApiKeyResponse,
  SubmitSyncReportBody,
  SubmitSyncReportResponse,
  UpdateServerSettingsBody,
  UpdateServerSettingsResponse,
  UpdateSoftwareBody,
  UpdateSoftwareParams,
  UpdateSoftwareResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function getDefaultSettings() {
  const [settings] = await db.select().from(serverSettingsTable).where(eq(serverSettingsTable.id, "default")).limit(1);
  return settings;
}

async function requireClientApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const settings = await getDefaultSettings();
  if (!settings?.clientApiKeyHash) {
    res.status(503).json({ error: "Client API key is not configured" });
    return;
  }
  const provided = req.header("x-nemesys-api-key");
  if (!provided) {
    res.status(401).json({ error: "Client API key is required" });
    return;
  }
  const expected = Buffer.from(settings.clientApiKeyHash, "hex");
  const actual = createHash("sha256").update(provided).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    res.status(401).json({ error: "Client API key is invalid" });
    return;
  }
  next();
}

async function requireHostnameForClient(clientId: string, req: Request, res: Response): Promise<boolean> {
  const hostname = req.header("x-nemesys-hostname")?.trim();
  if (!hostname) {
    res.status(400).json({ error: "X-Nemesys-Hostname header is required" });
    return false;
  }
  const [client] = await db.select({ id: clientsTable.id }).from(clientsTable).where(and(eq(clientsTable.id, clientId), eq(clientsTable.hostname, hostname))).limit(1);
  if (!client) {
    res.status(403).json({ error: "Client hostname does not match the enrolled client" });
    return false;
  }
  return true;
}

function toApiPolicy(policy: DbSoftwarePolicy) {
  const exeChecks = policy.exeChecks.length > 0
    ? policy.exeChecks
    : policy.executable
      ? [{ executable: policy.executable, targetVersion: policy.targetVersion }]
      : [];
  const iniChecks = policy.iniChecks.length > 0
    ? policy.iniChecks
    : policy.iniRules.map((rule) => ({ filePath: "", ...rule }));
  return { ...policy, supervisedExecutables: policy.supervisedExecutables ?? [], exeChecks, iniChecks };
}

router.get("/dashboard", requireAdmin, async (_req, res): Promise<void> => {
  const [clientCount] = await db.select({ value: count() }).from(clientsTable);
  const [onlineCount] = await db.select({ value: count() }).from(clientsTable).where(eq(clientsTable.status, "online"));
  const [softwareCount] = await db.select({ value: count() }).from(softwarePoliciesTable).where(eq(softwarePoliciesTable.enabled, true));
  const [todayCount] = await db.select({ value: count() }).from(auditEntriesTable).where(gte(auditEntriesTable.timestamp, new Date(new Date().setHours(0, 0, 0, 0))));
  const [latest] = await db.select({ timestamp: auditEntriesTable.timestamp }).from(auditEntriesTable).orderBy(desc(auditEntriesTable.timestamp)).limit(1);

  res.json(GetDashboardResponse.parse({
    totalClients: Number(clientCount.value),
    onlineClients: Number(onlineCount.value),
    protectedSoftware: Number(softwareCount.value),
    syncsToday: Number(todayCount.value),
    latestSync: latest?.timestamp ?? null,
  }));
});

router.get("/clients", requireAdmin, async (_req, res): Promise<void> => {
  const clients = await db.select().from(clientsTable).orderBy(desc(clientsTable.lastSync));
  res.json(ListClientsResponse.parse(clients));
});

router.post("/clients/:id/revoke", requireAdmin, async (req, res): Promise<void> => {
  const params = RevokeClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [client] = await db
    .update(clientsTable)
    .set({ status: "revoked", certificateStatus: "revoked" })
    .where(eq(clientsTable.id, params.data.id))
    .returning();
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }
  res.json(RevokeClientResponse.parse(client));
});

async function sendSyncConfig(clientId: string, res: Response): Promise<void> {
  const settings = await getDefaultSettings();
  if (!settings) {
    res.status(404).json({ error: "Server settings not found" });
    return;
  }
  const [client] = await db.select({ id: clientsTable.id }).from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }
  const policies = await db.select().from(softwarePoliciesTable).where(eq(softwarePoliciesTable.enabled, true));
  const applicationUpdateMode = policies.some((policy) => policy.updateMode);
  const shortestApplicationTimeout = policies
    .filter((policy) => policy.updateMode)
    .reduce((shortest, policy) => Math.min(shortest, policy.updateModeCloseTimeoutSeconds), settings.updateModeCloseTimeoutSeconds);
  res.json(GetSyncConfigResponse.parse({
    clientId,
    syncIntervalSeconds: settings.syncIntervalSeconds,
    configVersion: `${settings.updateMode ? "update" : "normal"}-${settings.syncIntervalSeconds}-${settings.normalCloseTimeoutSeconds}-${settings.updateModeCloseTimeoutSeconds}`,
    updateMode: applicationUpdateMode,
    normalCloseTimeoutSeconds: settings.normalCloseTimeoutSeconds,
    closeOnStartTimeoutSeconds: applicationUpdateMode ? shortestApplicationTimeout : settings.normalCloseTimeoutSeconds,
    policies: policies.map(toApiPolicy),
  }));
}

router.get("/clients/:id/sync-config", requireAdmin, async (req, res): Promise<void> => {
  const params = RevokeClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await sendSyncConfig(params.data.id, res);
});

router.get("/software", requireAdmin, async (_req, res): Promise<void> => {
  const policies = await db.select().from(softwarePoliciesTable).orderBy(desc(softwarePoliciesTable.lastUpdated));
  res.json(ListSoftwareResponse.parse(policies.map(toApiPolicy)));
});

router.post("/software", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateSoftwareBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const exeChecks = parsed.data.exeChecks ?? (parsed.data.executable && parsed.data.targetVersion
    ? [{ executable: parsed.data.executable, targetVersion: parsed.data.targetVersion }]
    : []);
  const iniChecks = parsed.data.iniChecks ?? (parsed.data.iniRules ?? []).map((rule) => ({ filePath: "", ...rule }));
  const [policy] = await db.insert(softwarePoliciesTable).values({
    id: `policy-${crypto.randomUUID()}`,
    name: parsed.data.name,
    executable: parsed.data.executable ?? exeChecks[0]?.executable ?? "-",
    targetVersion: parsed.data.targetVersion ?? exeChecks[0]?.targetVersion ?? "-",
    ruleType: parsed.data.ruleType,
    supervisedExecutables: parsed.data.supervisedExecutables ?? [],
    exeChecks,
    iniChecks,
    iniRules: parsed.data.iniRules ?? iniChecks.map(({ filePath: _filePath, ...rule }) => rule),
    graceSeconds: parsed.data.graceSeconds,
    updateMode: parsed.data.updateMode ?? false,
    updateModeCloseTimeoutSeconds: parsed.data.updateModeCloseTimeoutSeconds ?? 8,
    enabled: parsed.data.enabled,
  }).returning();
  res.status(201).json(CreateSoftwareResponse.parse(toApiPolicy(policy)));
});

router.patch("/software/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateSoftwareParams.safeParse(req.params);
  const parsed = UpdateSoftwareBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const exeChecks = parsed.data.exeChecks ?? (parsed.data.executable && parsed.data.targetVersion
    ? [{ executable: parsed.data.executable, targetVersion: parsed.data.targetVersion }]
    : []);
  const iniChecks = parsed.data.iniChecks ?? (parsed.data.iniRules ?? []).map((rule) => ({ filePath: "", ...rule }));
  const [policy] = await db
    .update(softwarePoliciesTable)
    .set({
      name: parsed.data.name,
      executable: parsed.data.executable ?? exeChecks[0]?.executable ?? "-",
      targetVersion: parsed.data.targetVersion ?? exeChecks[0]?.targetVersion ?? "-",
      ruleType: parsed.data.ruleType,
      supervisedExecutables: parsed.data.supervisedExecutables ?? [],
      exeChecks,
      iniChecks,
      iniRules: parsed.data.iniRules ?? iniChecks.map(({ filePath: _filePath, ...rule }) => rule),
      graceSeconds: parsed.data.graceSeconds,
      updateMode: parsed.data.updateMode ?? false,
      updateModeCloseTimeoutSeconds: parsed.data.updateModeCloseTimeoutSeconds ?? 8,
      enabled: parsed.data.enabled,
      lastUpdated: new Date(),
    })
    .where(eq(softwarePoliciesTable.id, params.data.id))
    .returning();
  if (!policy) {
    res.status(404).json({ error: "Software policy not found" });
    return;
  }
  res.json(UpdateSoftwareResponse.parse(toApiPolicy(policy)));
});

router.get("/audit", requireAdmin, async (req, res): Promise<void> => {
  const parsed = ListAuditEntriesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const entries = await db.select().from(auditEntriesTable).orderBy(desc(auditEntriesTable.timestamp)).limit(parsed.data.limit ?? 50);
  res.json(ListAuditEntriesResponse.parse(entries));
});

router.get("/settings", requireAdmin, async (_req, res): Promise<void> => {
  const settings = await getDefaultSettings();
  if (!settings) {
    res.status(404).json({ error: "Server settings not found" });
    return;
  }
  res.json(GetServerSettingsResponse.parse({
    syncIntervalSeconds: settings.syncIntervalSeconds,
    syncPort: settings.syncPort,
    adminHttpsEnabled: settings.adminHttpsEnabled,
    apiKeyConfigured: Boolean(settings.clientApiKeyHash),
    apiKeyLastRotatedAt: settings.apiKeyLastRotatedAt,
    updateMode: settings.updateMode,
    normalCloseTimeoutSeconds: settings.normalCloseTimeoutSeconds,
    updateModeCloseTimeoutSeconds: settings.updateModeCloseTimeoutSeconds,
  }));
});

router.patch("/settings", requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpdateServerSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [settings] = await db.update(serverSettingsTable).set(parsed.data).where(eq(serverSettingsTable.id, "default")).returning();
  if (!settings) {
    res.status(404).json({ error: "Server settings not found" });
    return;
  }
  res.json(UpdateServerSettingsResponse.parse({
    syncIntervalSeconds: settings.syncIntervalSeconds,
    syncPort: settings.syncPort,
    adminHttpsEnabled: settings.adminHttpsEnabled,
    apiKeyConfigured: Boolean(settings.clientApiKeyHash),
    apiKeyLastRotatedAt: settings.apiKeyLastRotatedAt,
    updateMode: settings.updateMode,
    normalCloseTimeoutSeconds: settings.normalCloseTimeoutSeconds,
    updateModeCloseTimeoutSeconds: settings.updateModeCloseTimeoutSeconds,
  }));
});

router.post("/settings/api-key/rotate", requireAdmin, async (_req, res): Promise<void> => {
  const apiKey = `nk_live_${randomBytes(24).toString("hex")}`;
  const rotatedAt = new Date();
  const [settings] = await db
    .update(serverSettingsTable)
    .set({
      clientApiKeyHash: createHash("sha256").update(apiKey).digest("hex"),
      clientApiKeyEncrypted: encryptSecret(apiKey),
      apiKeyLastRotatedAt: rotatedAt,
    })
    .where(eq(serverSettingsTable.id, "default"))
    .returning();
  if (!settings) {
    res.status(404).json({ error: "Server settings not found" });
    return;
  }
  res.json(RotateClientApiKeyResponse.parse({
    apiKey,
    maskedApiKey: `${apiKey.slice(0, 11)}••••••••${apiKey.slice(-4)}`,
    rotatedAt,
  }));
});

router.post("/settings/api-key", requireAdmin, async (req, res): Promise<void> => {
  const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
  if (apiKey.length < 16 || apiKey.length > 256) {
    res.status(400).json({ error: "API key must be between 16 and 256 characters." });
    return;
  }
  const rotatedAt = new Date();
  const [settings] = await db.update(serverSettingsTable)
    .set({
      clientApiKeyHash: createHash("sha256").update(apiKey).digest("hex"),
      clientApiKeyEncrypted: encryptSecret(apiKey),
      apiKeyLastRotatedAt: rotatedAt,
    })
    .where(eq(serverSettingsTable.id, "default"))
    .returning();
  if (!settings) {
    res.status(404).json({ error: "Server settings not found" });
    return;
  }
  res.json(RotateClientApiKeyResponse.parse({
    apiKey,
    maskedApiKey: `${apiKey.slice(0, 6)}••••••••${apiKey.slice(-4)}`,
    rotatedAt,
  }));
});

router.get("/settings/api-key", requireAdmin, async (_req, res): Promise<void> => {
  const settings = await getDefaultSettings();
  if (!settings) {
    res.status(404).json({ error: "Server settings not found" });
    return;
  }
  const apiKey = decryptSecret(settings.clientApiKeyEncrypted);
  res.json(GetClientApiKeyResponse.parse({
    apiKey,
    maskedApiKey: apiKey ? `${apiKey.slice(0, 11)}••••••••${apiKey.slice(-4)}` : null,
    configured: Boolean(settings.clientApiKeyHash),
    recoverable: Boolean(apiKey),
    rotatedAt: settings.apiKeyLastRotatedAt,
  }));
});

router.get("/sync/config", requireClientApiKey, async (req, res): Promise<void> => {
  const parsed = GetSyncConfigQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!await requireHostnameForClient(parsed.data.clientId, req, res)) return;
  await sendSyncConfig(parsed.data.clientId, res);
});

router.post("/sync/enroll", requireClientApiKey, async (req, res): Promise<void> => {
  const hostname = req.header("x-nemesys-hostname")?.trim();
  if (!hostname) {
    res.status(400).json({ error: "X-Nemesys-Hostname header is required" });
    return;
  }
  const address = req.body?.address;
  if (address !== undefined && typeof address !== "string") {
    res.status(400).json({ error: "address must be a string" });
    return;
  }
  const id = `host-${createHash("sha256").update(hostname.toLowerCase()).digest("hex").slice(0, 16)}`;
  const now = new Date();
  const [client] = await db
    .insert(clientsTable)
    .values({
      id,
      name: hostname,
      hostname,
      address: address ?? req.ip ?? "unknown",
      status: "online",
      lastSync: now,
      syncVersion: "1.0.0",
      certificateStatus: "valid",
    })
    .onConflictDoUpdate({
      target: clientsTable.id,
      set: {
        name: hostname,
        hostname,
        address: address ?? req.ip ?? "unknown",
        status: "online",
        lastSync: now,
      },
    })
    .returning();
  res.json(client);
});

router.post("/sync/report", requireClientApiKey, async (req, res): Promise<void> => {
  const parsed = SubmitSyncReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!await requireHostnameForClient(parsed.data.clientId, req, res)) return;
  const now = new Date();
  const [entry] = await db.insert(auditEntriesTable).values({
    id: `audit-${crypto.randomUUID()}`,
    ...parsed.data,
    timestamp: now,
  }).returning();
  await db.update(clientsTable).set({ lastSync: now, status: "online" }).where(eq(clientsTable.id, parsed.data.clientId));
  res.status(201).json(SubmitSyncReportResponse.parse(entry));
});

export default router;