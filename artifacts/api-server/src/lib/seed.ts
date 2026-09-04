import { db } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  ldapSettingsTable,
  serverSettingsTable,
  sslSettingsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { hashPassword } from "../routes/auth";

export async function ensureSeedData(): Promise<void> {
  await db
    .insert(serverSettingsTable)
    .values({
      id: "default",
      syncPort: 443,
      adminHttpsEnabled: true,
      adminUsername: process.env.NEMESYS_ADMIN_USERNAME ?? "admin",
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

  logger.info("NemesysV2 default settings are ready");
}