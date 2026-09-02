import { eq } from "drizzle-orm";
import { db, sslSettingsTable } from "@workspace/db";
import { decryptSecret } from "./secret-crypto";

export async function getSslSettings() {
  const [settings] = await db.select().from(sslSettingsTable).where(eq(sslSettingsTable.id, "default")).limit(1);
  return settings ?? null;
}

export async function getActiveTlsCredentials(): Promise<{ key: string; cert: string; ca?: string } | null> {
  const settings = await getSslSettings();
  if (!settings?.forceHttps || !settings.certificatePem) return null;
  const key = decryptSecret(settings.privateKeyPemEncrypted);
  if (!key) return null;
  return { key, cert: settings.certificatePem, ...(settings.chainPem ? { ca: settings.chainPem } : {}) };
}