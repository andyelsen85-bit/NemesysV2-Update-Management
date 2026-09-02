import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db, sslSettingsTable } from "@workspace/db";
import { decryptSecret } from "./secret-crypto";

const SETTINGS_ID = "default";

export function usesProxyTlsTermination(): boolean {
  return process.env["TLS_TERMINATION"] === "proxy";
}

function tlsDirectory(): string {
  return process.env["TLS_CERT_DIR"] || "/var/lib/nemesys/tls";
}

async function atomicWrite(path: string, contents: string, mode: number): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { mode });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, path);
}

export async function getSslSettings() {
  const [settings] = await db.select().from(sslSettingsTable).where(eq(sslSettingsTable.id, SETTINGS_ID)).limit(1);
  return settings ?? null;
}

export async function getActiveTlsCredentials(): Promise<{ key: string; cert: string; ca?: string } | null> {
  if (usesProxyTlsTermination()) return null;
  const settings = await getSslSettings();
  if (!settings?.forceHttps || !settings.certificatePem) return null;
  const key = decryptSecret(settings.privateKeyPemEncrypted);
  if (!key) return null;
  return { key, cert: settings.certificatePem, ...(settings.chainPem ? { ca: settings.chainPem } : {}) };
}

/**
 * The web sidecar owns the public TLS listener. Keep its persisted certificate
 * files in sync with the encrypted source of truth in PostgreSQL.
 */
export async function materializeTlsCredentials(settings?: typeof sslSettingsTable.$inferSelect | null): Promise<void> {
  if (!usesProxyTlsTermination()) return;
  const active = settings === undefined ? await getSslSettings() : settings;
  if (!active?.certificatePem || !active.privateKeyPemEncrypted) return;
  const key = decryptSecret(active.privateKeyPemEncrypted);
  if (!key) throw new Error("The stored TLS private key could not be decrypted.");

  const directory = tlsDirectory();
  await mkdir(directory, { recursive: true, mode: 0o770 });
  // Write the key first. The Nginx watcher validates the pair and only reloads
  // after the subsequently replaced certificate matches it.
  await atomicWrite(join(directory, "private-key.pem"), key, 0o640);
  const fullChain = [active.certificatePem.trim(), active.chainPem?.trim()].filter(Boolean).join("\n") + "\n";
  await atomicWrite(join(directory, "certificate.pem"), fullChain, 0o644);
}