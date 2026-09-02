import { db } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  auditEntriesTable,
  clientsTable,
  ldapSettingsTable,
  serverSettingsTable,
  sslSettingsTable,
  softwarePoliciesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { hashPassword } from "../routes/auth";

export async function ensureSeedData(): Promise<void> {
  await db
    .insert(serverSettingsTable)
    .values({
      id: "default",
      syncIntervalSeconds: 300,
      syncPort: 443,
      adminHttpsEnabled: true,
      adminUsername: process.env.NEMESYS_ADMIN_USERNAME ?? "admin",
      updateMode: false,
      normalCloseTimeoutSeconds: 30,
      updateModeCloseTimeoutSeconds: 8,
    })
    .onConflictDoNothing();

  await db.insert(ldapSettingsTable).values({
    id: "default",
    enabled: false,
    url: "",
    bindDn: "",
    baseDn: "",
  }).onConflictDoNothing();
  await db.insert(sslSettingsTable).values({
    id: "default",
    forceHttps: false,
    hstsEnabled: false,
  }).onConflictDoNothing();

  await db
    .insert(clientsTable)
    .values([
      {
        id: "poste-lyon-01",
        name: "Poste Lyon 01",
        hostname: "POSTE-LYON-01",
        address: "10.24.8.41",
        status: "online",
        lastSync: new Date(Date.now() - 2 * 60 * 1000),
        syncVersion: "2.4.1",
        certificateStatus: "valid",
      },
      {
        id: "poste-paris-07",
        name: "Poste Paris 07",
        hostname: "POSTE-PARIS-07",
        address: "10.24.8.87",
        status: "stale",
        lastSync: new Date(Date.now() - 38 * 60 * 1000),
        syncVersion: "2.4.0",
        certificateStatus: "expiring",
      },
      {
        id: "poste-nantes-02",
        name: "Poste Nantes 02",
        hostname: "POSTE-NANTES-02",
        address: "10.24.9.12",
        status: "online",
        lastSync: new Date(Date.now() - 6 * 60 * 1000),
        syncVersion: "2.4.1",
        certificateStatus: "valid",
      },
    ])
    .onConflictDoNothing();

  const [settings] = await db.select({ adminPasswordHash: serverSettingsTable.adminPasswordHash })
    .from(serverSettingsTable)
    .where(eq(serverSettingsTable.id, "default"))
    .limit(1);
  if (!settings?.adminPasswordHash) {
    const password = process.env.NEMESYS_ADMIN_PASSWORD ?? "change-me-now";
    await db.update(serverSettingsTable)
      .set({
        adminUsername: process.env.NEMESYS_ADMIN_USERNAME ?? "admin",
        adminPasswordHash: await hashPassword(password),
      })
      .where(eq(serverSettingsTable.id, "default"));
    if (!process.env.NEMESYS_ADMIN_PASSWORD) {
      logger.warn("NEMESYS_ADMIN_PASSWORD is not set; replace the local bootstrap password before production use");
    }
  }

  await db
    .insert(softwarePoliciesTable)
    .values([
      {
        id: "pen-soins",
        name: "PEN-SOINS",
        executable: "PenSoins.exe",
        targetVersion: "454",
        ruleType: "ini",
        iniRules: [
          { section: "Poste", key: "Version", expectedValue: "454" },
          { section: "Poste", key: "VersMedSyst", expectedValue: "418" },
        ],
        graceSeconds: 45,
        enabled: true,
      },
      {
        id: "dx-launch",
        name: "DX Launch",
        executable: "DxLaunch.exe",
        targetVersion: "9.2021.6.5",
        ruleType: "file-version",
        iniRules: [],
        graceSeconds: 30,
        enabled: true,
      },
      {
        id: "med-syst",
        name: "MedSyst",
        executable: "MedSyst.exe",
        targetVersion: "5.5.4.5",
        ruleType: "file-version",
        iniRules: [],
        graceSeconds: 60,
        enabled: false,
      },
    ])
    .onConflictDoNothing();

  const existingAudit = await db.select({ id: auditEntriesTable.id }).from(auditEntriesTable).limit(1);
  if (existingAudit.length === 0) {
    await db.insert(auditEntriesTable).values([
      {
        id: "audit-lyon-01",
        clientId: "poste-lyon-01",
        clientName: "Poste Lyon 01",
        timestamp: new Date(Date.now() - 2 * 60 * 1000),
        result: "warning",
        applications: [
          { softwareId: "pen-soins", softwareName: "PEN-SOINS", observedVersion: "453", expectedVersion: "454", compliant: false },
          { softwareId: "dx-launch", softwareName: "DX Launch", observedVersion: "9.2021.6.5", expectedVersion: "9.2021.6.5", compliant: true },
        ],
      },
      {
        id: "audit-nantes-02",
        clientId: "poste-nantes-02",
        clientName: "Poste Nantes 02",
        timestamp: new Date(Date.now() - 6 * 60 * 1000),
        result: "success",
        applications: [
          { softwareId: "pen-soins", softwareName: "PEN-SOINS", observedVersion: "454", expectedVersion: "454", compliant: true },
          { softwareId: "dx-launch", softwareName: "DX Launch", observedVersion: "9.2021.6.5", expectedVersion: "9.2021.6.5", compliant: true },
        ],
      },
    ]);
  }

  logger.info("NemesysV2 sample data is ready");
}