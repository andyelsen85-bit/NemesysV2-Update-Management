import type { Request } from "express";
import { eq } from "drizzle-orm";
import { adfsSettingsTable, db } from "@workspace/db";
import { decryptSecret } from "./secret-crypto";
import {
  adfsSettingsDto,
  buildEffectiveAdfsSettings,
  validatePemCertificate,
  validateRedirectUri,
  type EffectiveAdfsSettings,
} from "./adfs-helpers";

export { adfsSettingsDto, validatePemCertificate, validateRedirectUri };
export type { EffectiveAdfsSettings };

const SETTINGS_ID = "default";

export async function getAdfsSettings(): Promise<EffectiveAdfsSettings> {
  const [row] = await db.select().from(adfsSettingsTable).where(eq(adfsSettingsTable.id, SETTINGS_ID)).limit(1);
  const configuredCa = row?.caCertificateCleared
    ? null
    : row?.caCertificatePem ?? process.env.ADFS_CA_CERT_PEM ?? null;
  if (configuredCa && !validatePemCertificate(configuredCa)) {
    throw new Error("The configured AD FS CA certificate is not valid PEM certificate material.");
  }
  return buildEffectiveAdfsSettings(row, process.env, row?.clientSecretEncrypted
    ? decryptSecret(row.clientSecretEncrypted)
    : null);
}

export function adfsRedirectUri(req: Request, settings: EffectiveAdfsSettings): string {
  void req;
  if (!settings.redirectUri?.trim()) {
    throw new Error("An explicit AD FS redirect URI is required.");
  }
  return validateRedirectUri(settings.redirectUri) as string;
}

export function isAdfsConfigured(settings: EffectiveAdfsSettings): boolean {
  if (!settings.enabled || !settings.issuer || !settings.clientId || !settings.redirectUri) return false;
  try {
    adfsRedirectUri({} as Request, settings);
    return true;
  } catch {
    return false;
  }
}