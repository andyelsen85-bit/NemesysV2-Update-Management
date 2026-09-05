import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { and, count, countDistinct, desc, eq, gte, ne, sql } from "drizzle-orm";
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
  DeleteSoftwareParams,
  GetDashboardResponse,
  GetServerSettingsResponse,
  GetSyncConfigQueryParams,
  GetSyncConfigResponse,
  ListAuditEntriesQueryParams,
  ListAuditEntriesResponse,
  ListClientsResponse,
  ListSoftwareResponse,
  ReactivateClientParams,
  ReactivateClientResponse,
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
type ComparisonOperator = "<" | "<=" | "=" | ">=" | ">";

function normalizeExeChecks<T extends {
  executable: string;
  targetVersion: string;
  installCommand?: string;
  comparisonOperator?: ComparisonOperator;
}>(checks: T[]) {
  return checks.map((check) => ({ ...check, comparisonOperator: check.comparisonOperator ?? "=" as const }));
}

function normalizeIniChecks<T extends {
  filePath: string;
  section: string;
  key: string;
  expectedValue: string;
  comparisonOperator?: ComparisonOperator;
}>(checks: T[]) {
  return checks.map((check) => ({ ...check, comparisonOperator: check.comparisonOperator ?? "=" as const }));
}

function isRelationalOperator(operator: ComparisonOperator): boolean {
  return operator !== "=";
}

function isDottedNumericVersion(value: string): boolean {
  return /^\d+(?:\.\d+)*$/.test(value);
}

function hasInvalidRelationalCheck(
  exeChecks: Array<{ comparisonOperator: ComparisonOperator; targetVersion: string }>,
  iniChecks: Array<{ comparisonOperator: ComparisonOperator; expectedValue: string }>,
): boolean {
  return exeChecks.some((check) =>
    isRelationalOperator(check.comparisonOperator) && !isDottedNumericVersion(check.targetVersion)
  ) || iniChecks.some((check) =>
    isRelationalOperator(check.comparisonOperator) && !isDottedNumericVersion(check.expectedValue)
  );
}

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
  const [client] = await db
    .select({ id: clientsTable.id, status: clientsTable.status, certificateStatus: clientsTable.certificateStatus })
    .from(clientsTable)
    .where(and(eq(clientsTable.id, clientId), eq(clientsTable.hostname, hostname)))
    .limit(1);
  if (!client) {
    res.status(403).json({ error: "Client hostname does not match the enrolled client" });
    return false;
  }
  if (client.status === "revoked" || client.certificateStatus === "revoked") {
    res.status(403).json({ error: "Client access is revoked" });
    return false;
  }
  return true;
}

function toApiPolicy(policy: DbSoftwarePolicy) {
  const exeChecks = normalizeExeChecks(policy.exeChecks.length > 0
    ? policy.exeChecks
    : policy.ruleType !== "ini" &&
      policy.executable &&
      policy.executable !== "-" &&
      policy.targetVersion &&
      policy.targetVersion !== "-"
      ? [{ executable: policy.executable, targetVersion: policy.targetVersion }]
      : []);
  const iniChecks = normalizeIniChecks(policy.iniChecks.length > 0
    ? policy.iniChecks
    : policy.iniRules.map((rule) => ({ filePath: "", ...rule })));
  return { ...policy, supervisedExecutables: policy.supervisedExecutables ?? [], exeChecks, iniChecks };
}

router.get("/dashboard", requireAdmin, async (_req, res): Promise<void> => {
  const [clientCount] = await db.select({ value: count() }).from(clientsTable);
  const [onlineCount] = await db.select({ value: count() }).from(clientsTable).where(eq(clientsTable.status, "online"));
  const [softwareCount] = await db.select({ value: count() }).from(softwarePoliciesTable).where(eq(softwarePoliciesTable.enabled, true));
  const [todayCount] = await db.select({ value: countDistinct(auditEntriesTable.clientId) }).from(auditEntriesTable).where(gte(auditEntriesTable.timestamp, new Date(new Date().setHours(0, 0, 0, 0))));
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

router.post("/clients/:id/reactivate", requireAdmin, async (req, res): Promise<void> => {
  const params = ReactivateClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [client] = await db
    .update(clientsTable)
    .set({ status: "stale", certificateStatus: "valid" })
    .where(eq(clientsTable.id, params.data.id))
    .returning();
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }
  res.json(ReactivateClientResponse.parse(client));
});

function matchesEtag(header: string | undefined, etag: string): boolean {
  return header?.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === etag || normalized === `W/${etag}`;
  }) ?? false;
}

async function sendSyncConfig(clientId: string, req: Request, res: Response, recordClientPoll = false): Promise<void> {
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
  const syncIntervalSeconds = applicationUpdateMode ? 30 : 300;
  const etag = `"${createHash("sha256").update(JSON.stringify({
    syncConfigFormat: 3,
    syncIntervalSeconds,
    updateMode: applicationUpdateMode,
    policies: policies.map((policy) => ({
      ...toApiPolicy(policy),
      lastUpdated: policy.lastUpdated.toISOString(),
    })),
  })).digest("hex")}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "private, no-cache");
  const notModified = recordClientPoll && matchesEtag(req.header("if-none-match"), etag);
  if (notModified) {
    if (recordClientPoll) {
      const [updatedClient] = await db.update(clientsTable)
        .set({ lastPoll: new Date(), status: "online" })
        .where(and(
          eq(clientsTable.id, clientId),
          ne(clientsTable.status, "revoked"),
          ne(clientsTable.certificateStatus, "revoked"),
        ))
        .returning({ id: clientsTable.id });
      if (!updatedClient) {
        res.status(403).json({ error: "Client access is revoked" });
        return;
      }
    }
    res.status(304).end();
    return;
  }
  const config = GetSyncConfigResponse.parse({
    clientId,
    syncIntervalSeconds,
    configVersion: etag.slice(1, -1),
    updateMode: applicationUpdateMode,
    policies: policies.map(toApiPolicy),
  });
  if (recordClientPoll) {
    const now = new Date();
    const [updatedClient] = await db.update(clientsTable)
      .set({ lastPoll: now, lastSuccessfulSync: now, status: "online" })
      .where(and(
        eq(clientsTable.id, clientId),
        ne(clientsTable.status, "revoked"),
        ne(clientsTable.certificateStatus, "revoked"),
      ))
      .returning({ id: clientsTable.id });
    if (!updatedClient) {
      res.status(403).json({ error: "Client access is revoked" });
      return;
    }
  }
  res.json(config);
}

router.get("/clients/:id/sync-config", requireAdmin, async (req, res): Promise<void> => {
  const params = RevokeClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  await sendSyncConfig(params.data.id, req, res);
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

  const exeChecks = normalizeExeChecks(parsed.data.exeChecks ?? (parsed.data.executable && parsed.data.targetVersion
    ? [{ executable: parsed.data.executable, targetVersion: parsed.data.targetVersion }]
    : []));
  const iniChecks = normalizeIniChecks(parsed.data.iniChecks ?? (parsed.data.iniRules ?? []).map((rule) => ({ filePath: "", ...rule })));
  if (hasInvalidRelationalCheck(exeChecks, iniChecks)) {
    res.status(400).json({ error: "Relational comparison values must contain only numeric version components separated by dots." });
    return;
  }
  const [policy] = await db.insert(softwarePoliciesTable).values({
    id: `policy-${crypto.randomUUID()}`,
    name: parsed.data.name,
    executable: parsed.data.executable ?? exeChecks[0]?.executable ?? "-",
    targetVersion: parsed.data.targetVersion ?? exeChecks[0]?.targetVersion ?? "-",
    ruleType: parsed.data.ruleType,
    supervisedExecutables: parsed.data.supervisedExecutables ?? [],
    exeChecks,
    iniChecks,
    iniRules: parsed.data.iniRules ?? iniChecks.map(({ filePath: _filePath, comparisonOperator: _comparisonOperator, ...rule }) => rule),
    normalCloseTimeoutSeconds: parsed.data.normalCloseTimeoutSeconds,
    updateMode: parsed.data.updateMode ?? false,
    updateModeCloseTimeoutSeconds: parsed.data.updateModeCloseTimeoutSeconds ?? 8,
    allowPostpone: parsed.data.allowPostpone ?? false,
    launchOnExitUpdateMode: parsed.data.launchOnExitUpdateMode ?? false,
    launchExecutablePath: parsed.data.launchExecutablePath ?? "",
    launchArguments: parsed.data.launchArguments ?? "",
    updateModeCycleId: `cycle-${crypto.randomUUID()}`,
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

  const exeChecks = normalizeExeChecks(parsed.data.exeChecks ?? (parsed.data.executable && parsed.data.targetVersion
    ? [{ executable: parsed.data.executable, targetVersion: parsed.data.targetVersion }]
    : []));
  const iniChecks = normalizeIniChecks(parsed.data.iniChecks ?? (parsed.data.iniRules ?? []).map((rule) => ({ filePath: "", ...rule })));
  if (hasInvalidRelationalCheck(exeChecks, iniChecks)) {
    res.status(400).json({ error: "Relational comparison values must contain only numeric version components separated by dots." });
    return;
  }
  const policy = await db.transaction(async (transaction) => {
    const [current] = await transaction
      .select()
      .from(softwarePoliciesTable)
      .where(eq(softwarePoliciesTable.id, params.data.id))
      .for("update")
      .limit(1);
    if (!current) return null;

    const nextEnabled = parsed.data.enabled;
    const nextUpdateMode = parsed.data.updateMode ?? false;
    const [updated] = await transaction
      .update(softwarePoliciesTable)
      .set({
        name: parsed.data.name,
        executable: parsed.data.executable ?? exeChecks[0]?.executable ?? "-",
        targetVersion: parsed.data.targetVersion ?? exeChecks[0]?.targetVersion ?? "-",
        ruleType: parsed.data.ruleType,
        supervisedExecutables: parsed.data.supervisedExecutables ?? [],
        exeChecks,
        iniChecks,
        iniRules: parsed.data.iniRules ?? iniChecks.map(({ filePath: _filePath, comparisonOperator: _comparisonOperator, ...rule }) => rule),
        normalCloseTimeoutSeconds: parsed.data.normalCloseTimeoutSeconds,
        updateMode: nextUpdateMode,
        updateModeCloseTimeoutSeconds: parsed.data.updateModeCloseTimeoutSeconds ?? 8,
        allowPostpone: parsed.data.allowPostpone ?? false,
        launchOnExitUpdateMode: parsed.data.launchOnExitUpdateMode ?? false,
        launchExecutablePath: parsed.data.launchExecutablePath ?? "",
        launchArguments: parsed.data.launchArguments ?? "",
        updateModeCycleId: nextEnabled && nextUpdateMode && (!current.enabled || !current.updateMode)
          ? `cycle-${crypto.randomUUID()}`
          : current.updateModeCycleId,
        enabled: nextEnabled,
        lastUpdated: new Date(),
      })
      .where(eq(softwarePoliciesTable.id, params.data.id))
      .returning();
    return updated ?? null;
  });
  if (!policy) {
    res.status(404).json({ error: "Software policy not found" });
    return;
  }
  res.json(UpdateSoftwareResponse.parse(toApiPolicy(policy)));
});

router.delete("/software/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteSoftwareParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db.delete(softwarePoliciesTable).where(eq(softwarePoliciesTable.id, params.data.id)).returning();
  if (!deleted) {
    res.status(404).json({ error: "Software policy not found" });
    return;
  }
  res.sendStatus(204);
});

router.get("/audit", requireAdmin, async (req, res): Promise<void> => {
  const parsed = ListAuditEntriesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const entries = await db
    .selectDistinctOn([auditEntriesTable.clientId])
    .from(auditEntriesTable)
    .orderBy(auditEntriesTable.clientId, desc(auditEntriesTable.timestamp), desc(auditEntriesTable.id));
  entries.sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime());
  res.json(ListAuditEntriesResponse.parse(entries.slice(0, parsed.data.limit ?? 50)));
});

router.get("/settings", requireAdmin, async (_req, res): Promise<void> => {
  const settings = await getDefaultSettings();
  if (!settings) {
    res.status(404).json({ error: "Server settings not found" });
    return;
  }
  res.json(GetServerSettingsResponse.parse({
    syncPort: settings.syncPort,
    adminHttpsEnabled: settings.adminHttpsEnabled,
    desiredClientVersion: settings.desiredClientVersion,
    apiKeyConfigured: Boolean(settings.clientApiKeyHash),
    apiKeyLastRotatedAt: settings.apiKeyLastRotatedAt,
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
    syncPort: settings.syncPort,
    adminHttpsEnabled: settings.adminHttpsEnabled,
    desiredClientVersion: settings.desiredClientVersion,
    apiKeyConfigured: Boolean(settings.clientApiKeyHash),
    apiKeyLastRotatedAt: settings.apiKeyLastRotatedAt,
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
  await sendSyncConfig(parsed.data.clientId, req, res, true);
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
  const clientVersion = req.body?.clientVersion;
  if (clientVersion !== undefined && (typeof clientVersion !== "string" || !isDottedNumericVersion(clientVersion))) {
    res.status(400).json({ error: "clientVersion must be a dotted numeric version" });
    return;
  }
  const id = `host-${createHash("sha256").update(hostname.toLowerCase()).digest("hex").slice(0, 16)}`;
  const now = new Date();
  const [existingClient] = await db
    .select({ status: clientsTable.status, certificateStatus: clientsTable.certificateStatus })
    .from(clientsTable)
    .where(eq(clientsTable.id, id))
    .limit(1);
  if (existingClient?.status === "revoked" || existingClient?.certificateStatus === "revoked") {
    res.status(403).json({ error: "Client access is revoked" });
    return;
  }
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
      installedVersion: clientVersion ?? null,
      certificateStatus: "valid",
    })
    .onConflictDoUpdate({
      target: clientsTable.id,
      set: {
        name: hostname,
        hostname,
        address: address ?? req.ip ?? "unknown",
        installedVersion: clientVersion ?? undefined,
        lastSync: now,
      },
    })
    .returning();
  if (client.status === "revoked" || client.certificateStatus === "revoked") {
    res.status(403).json({ error: "Client access is revoked" });
    return;
  }
  res.json(client);
});

router.post("/sync/report", requireClientApiKey, async (req, res): Promise<void> => {
  const parsed = SubmitSyncReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!await requireHostnameForClient(parsed.data.clientId, req, res)) return;
  const entry = await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${parsed.data.clientId}))`,
    );
    const reportTimestamp = new Date();
    const [updatedClient] = await transaction.update(clientsTable)
      .set({
        lastSync: reportTimestamp,
        status: "online",
        installedVersion: parsed.data.clientVersion,
      })
      .where(and(
        eq(clientsTable.id, parsed.data.clientId),
        ne(clientsTable.status, "revoked"),
        ne(clientsTable.certificateStatus, "revoked"),
      ))
      .returning({ id: clientsTable.id });
    if (!updatedClient) return null;

    await transaction
      .delete(auditEntriesTable)
      .where(eq(auditEntriesTable.clientId, parsed.data.clientId));
    const [latestEntry] = await transaction.insert(auditEntriesTable).values({
      id: `audit-${crypto.randomUUID()}`,
      ...parsed.data,
      timestamp: reportTimestamp,
    }).returning();
    return latestEntry;
  });
  if (!entry) {
    res.status(403).json({ error: "Client access is revoked" });
    return;
  }
  res.json(SubmitSyncReportResponse.parse(entry));
});

export default router;