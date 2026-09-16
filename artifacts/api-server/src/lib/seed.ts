import { db } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  adfsIdentityMappingsTable,
  adminUsersTable,
  ldapSettingsTable,
  serverSettingsTable,
  sslSettingsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { hashPassword, verifyPassword } from "../routes/auth";

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

  let generatedFallbackPassword = false;
  await db.transaction(async (transaction) => {
    let [currentSettings] = await transaction.select({
      adminUsername: serverSettingsTable.adminUsername,
      adminPasswordHash: serverSettingsTable.adminPasswordHash,
    }).from(serverSettingsTable)
      .where(eq(serverSettingsTable.id, "default"))
      .for("update")
      .limit(1);
    if (!currentSettings?.adminPasswordHash) {
      const password = process.env.NEMESYS_ADMIN_PASSWORD ?? "change-me-now";
      const username = process.env.NEMESYS_ADMIN_USERNAME ?? "admin";
      const passwordHash = await hashPassword(password);
      [currentSettings] = await transaction.update(serverSettingsTable)
        .set({
          adminUsername: username,
          adminPasswordHash: passwordHash,
        })
        .where(eq(serverSettingsTable.id, "default"))
        .returning({
          adminUsername: serverSettingsTable.adminUsername,
          adminPasswordHash: serverSettingsTable.adminPasswordHash,
        });
      generatedFallbackPassword = !process.env.NEMESYS_ADMIN_PASSWORD;
    }
    if (currentSettings?.adminUsername && currentSettings.adminPasswordHash) {
      const [existingLocalAccount] = await transaction.select({
        passwordHash: adminUsersTable.passwordHash,
        mustChangePassword: adminUsersTable.mustChangePassword,
      }).from(adminUsersTable)
        .where(eq(adminUsersTable.username, currentSettings.adminUsername))
        .for("update")
        .limit(1);
      const fallbackPasswordInUse = await verifyPassword(
        "change-me-now",
        currentSettings.adminPasswordHash,
      );
      const [localAccount] = await transaction.insert(adminUsersTable).values({
        id: "local-admin",
        username: currentSettings.adminUsername,
        displayName: "Local administrator",
        source: "local",
        passwordHash: currentSettings.adminPasswordHash,
        mustChangePassword: fallbackPasswordInUse,
      }).onConflictDoUpdate({
        target: adminUsersTable.username,
        set: {
          displayName: "Local administrator",
          email: "",
          source: "local",
          directoryDn: null,
          passwordHash: currentSettings.adminPasswordHash,
          mustChangePassword: Boolean(existingLocalAccount?.mustChangePassword || fallbackPasswordInUse),
          isActive: true,
          updatedAt: new Date(),
        },
      }).returning({ id: adminUsersTable.id });
      if (localAccount) {
        await transaction.delete(adfsIdentityMappingsTable)
          .where(eq(adfsIdentityMappingsTable.adminUserId, localAccount.id));
      }
    }
  });
  if (generatedFallbackPassword) {
    logger.warn("NEMESYS_ADMIN_PASSWORD is not set; replace the local bootstrap password before production use");
  }

  logger.info("NemesysV2 default settings are ready");
}