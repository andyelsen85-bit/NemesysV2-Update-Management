import { Router, type IRouter } from "express";
import { count, desc, eq, gte } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  auditEntriesTable,
  clientsTable,
  serverSettingsTable,
  softwarePoliciesTable,
} from "@workspace/db";
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
  SubmitSyncReportBody,
  SubmitSyncReportResponse,
  UpdateServerSettingsBody,
  UpdateServerSettingsResponse,
  UpdateSoftwareBody,
  UpdateSoftwareParams,
  UpdateSoftwareResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard", async (_req, res): Promise<void> => {
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

router.get("/clients", async (_req, res): Promise<void> => {
  const clients = await db.select().from(clientsTable).orderBy(desc(clientsTable.lastSync));
  res.json(ListClientsResponse.parse(clients));
});

router.post("/clients/:id/revoke", async (req, res): Promise<void> => {
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

router.get("/software", async (_req, res): Promise<void> => {
  const policies = await db.select().from(softwarePoliciesTable).orderBy(desc(softwarePoliciesTable.lastUpdated));
  res.json(ListSoftwareResponse.parse(policies));
});

router.post("/software", async (req, res): Promise<void> => {
  const parsed = CreateSoftwareBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [policy] = await db.insert(softwarePoliciesTable).values({
    id: `policy-${crypto.randomUUID()}`,
    ...parsed.data,
    iniRules: parsed.data.iniRules ?? [],
  }).returning();
  res.status(201).json(CreateSoftwareResponse.parse(policy));
});

router.patch("/software/:id", async (req, res): Promise<void> => {
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

  const [policy] = await db
    .update(softwarePoliciesTable)
    .set({ ...parsed.data, iniRules: parsed.data.iniRules ?? [], lastUpdated: new Date() })
    .where(eq(softwarePoliciesTable.id, params.data.id))
    .returning();
  if (!policy) {
    res.status(404).json({ error: "Software policy not found" });
    return;
  }
  res.json(UpdateSoftwareResponse.parse(policy));
});

router.get("/audit", async (req, res): Promise<void> => {
  const parsed = ListAuditEntriesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const entries = await db.select().from(auditEntriesTable).orderBy(desc(auditEntriesTable.timestamp)).limit(parsed.data.limit ?? 50);
  res.json(ListAuditEntriesResponse.parse(entries));
});

router.get("/settings", async (_req, res): Promise<void> => {
  const [settings] = await db.select().from(serverSettingsTable).where(eq(serverSettingsTable.id, "default")).limit(1);
  res.json(GetServerSettingsResponse.parse(settings));
});

router.patch("/settings", async (req, res): Promise<void> => {
  const parsed = UpdateServerSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [settings] = await db.update(serverSettingsTable).set(parsed.data).where(eq(serverSettingsTable.id, "default")).returning();
  res.json(UpdateServerSettingsResponse.parse(settings));
});

router.get("/sync/config", async (req, res): Promise<void> => {
  const parsed = GetSyncConfigQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [settings] = await db.select().from(serverSettingsTable).where(eq(serverSettingsTable.id, "default")).limit(1);
  const policies = await db.select().from(softwarePoliciesTable).where(eq(softwarePoliciesTable.enabled, true));
  res.json(GetSyncConfigResponse.parse({
    clientId: parsed.data.clientId,
    syncIntervalSeconds: settings.syncIntervalSeconds,
    configVersion: settings.syncIntervalSeconds.toString(),
    policies,
  }));
});

router.post("/sync/report", async (req, res): Promise<void> => {
  const parsed = SubmitSyncReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
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