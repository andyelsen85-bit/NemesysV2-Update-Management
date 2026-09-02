import { createPrivateKey, createPublicKey, X509Certificate, timingSafeEqual } from "node:crypto";
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, ldapSettingsTable, sslSettingsTable } from "@workspace/db";
import { requireAdmin } from "./auth";
import { encryptSecret } from "../lib/secret-crypto";
import { materializeTlsCredentials, usesProxyTlsTermination } from "../lib/ssl";
import { testLdapConnection } from "../lib/ldap";

const router: IRouter = Router();
const SETTINGS_ID = "default";

function ldapDto(row: typeof ldapSettingsTable.$inferSelect | undefined) {
  return {
    enabled: row?.enabled ?? false,
    url: row?.url ?? "",
    bindDn: row?.bindDn ?? "",
    bindPasswordSet: Boolean(row?.bindPasswordEncrypted),
    baseDn: row?.baseDn ?? "",
    userFilter: row?.userFilter ?? "(&(objectClass=person)(sAMAccountName={{username}}))",
    usernameAttribute: row?.usernameAttribute ?? "sAMAccountName",
    displayNameAttribute: row?.displayNameAttribute ?? "displayName",
    emailAttribute: row?.emailAttribute ?? "mail",
    verifyTlsCertificate: row?.verifyTlsCertificate ?? true,
    caCertificateInstalled: Boolean(row?.caCertificatePem),
  };
}

router.get("/settings/ldap", requireAdmin, async (_req, res): Promise<void> => {
  const [row] = await db.select().from(ldapSettingsTable).where(eq(ldapSettingsTable.id, SETTINGS_ID)).limit(1);
  res.json(ldapDto(row));
});

router.put("/settings/ldap", requireAdmin, async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const values = {
    id: SETTINGS_ID,
    enabled: Boolean(body.enabled),
    url: typeof body.url === "string" ? body.url.trim() : "",
    bindDn: typeof body.bindDn === "string" ? body.bindDn.trim() : "",
    baseDn: typeof body.baseDn === "string" ? body.baseDn.trim() : "",
    userFilter: typeof body.userFilter === "string" && body.userFilter.trim() ? body.userFilter.trim() : "(&(objectClass=person)(sAMAccountName={{username}}))",
    usernameAttribute: typeof body.usernameAttribute === "string" && body.usernameAttribute.trim() ? body.usernameAttribute.trim() : "sAMAccountName",
    displayNameAttribute: typeof body.displayNameAttribute === "string" && body.displayNameAttribute.trim() ? body.displayNameAttribute.trim() : "displayName",
    emailAttribute: typeof body.emailAttribute === "string" && body.emailAttribute.trim() ? body.emailAttribute.trim() : "mail",
    verifyTlsCertificate: body.verifyTlsCertificate !== false,
  };
  const [before] = await db.select().from(ldapSettingsTable).where(eq(ldapSettingsTable.id, SETTINGS_ID)).limit(1);
  const bindPassword = typeof body.bindPassword === "string" && body.bindPassword ? encryptSecret(body.bindPassword) : before?.bindPasswordEncrypted ?? null;
  const caCertificatePem = typeof body.caCertificatePem === "string" && body.caCertificatePem.trim()
    ? body.caCertificatePem.trim()
    : body.caCertificatePem === null ? null : before?.caCertificatePem ?? null;
  const [row] = await db.insert(ldapSettingsTable)
    .values({ ...values, bindPasswordEncrypted: bindPassword, caCertificatePem, updatedAt: new Date() })
    .onConflictDoUpdate({ target: ldapSettingsTable.id, set: { ...values, bindPasswordEncrypted: bindPassword, caCertificatePem, updatedAt: new Date() } })
    .returning();
  res.json(ldapDto(row));
});

router.post("/settings/ldap/test", requireAdmin, async (req, res): Promise<void> => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required." });
    return;
  }
  res.json(await testLdapConnection(username, password));
});

function sslDto(row: typeof sslSettingsTable.$inferSelect | undefined) {
  return {
    certificateInstalled: Boolean(row?.certificatePem),
    privateKeyInstalled: Boolean(row?.privateKeyPemEncrypted),
    chainInstalled: Boolean(row?.chainPem),
    certificateFingerprint: row?.certificateFingerprint ?? null,
    certificateSubject: row?.certificateSubject ?? null,
    certificateExpiresAt: row?.certificateExpiresAt ?? null,
    forceHttps: row?.forceHttps ?? false,
    hstsEnabled: row?.hstsEnabled ?? false,
  };
}

router.get("/settings/ssl", requireAdmin, async (_req, res): Promise<void> => {
  const [row] = await db.select().from(sslSettingsTable).where(eq(sslSettingsTable.id, SETTINGS_ID)).limit(1);
  res.json(sslDto(row));
});

router.put("/settings/ssl", requireAdmin, async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const [before] = await db.select().from(sslSettingsTable).where(eq(sslSettingsTable.id, SETTINGS_ID)).limit(1);
  const certificatePem = typeof body.certificatePem === "string" && body.certificatePem.trim() ? body.certificatePem.trim() : before?.certificatePem ?? null;
  const privateKeyPem = typeof body.privateKeyPem === "string" && body.privateKeyPem.trim() ? body.privateKeyPem.trim() : null;
  const chainPem = typeof body.chainPem === "string" && body.chainPem.trim() ? body.chainPem.trim() : body.chainPem === null ? null : before?.chainPem ?? null;
  if (!certificatePem) {
    res.status(400).json({ error: "A PEM certificate is required." });
    return;
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
    if (privateKeyPem) {
      const privateKey = createPrivateKey(privateKeyPem);
      const certPublicKey = certificate.publicKey.export({ type: "spki", format: "der" });
      const keyPublicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
      if (certPublicKey.length !== keyPublicKey.length || !timingSafeEqual(certPublicKey, keyPublicKey)) {
        res.status(400).json({ error: "The private key does not match the uploaded certificate." });
        return;
      }
    } else if (!before?.privateKeyPemEncrypted) {
      res.status(400).json({ error: "A matching PEM private key is required for the first certificate upload." });
      return;
    }
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? `Invalid certificate or private key: ${error.message}` : "Invalid certificate or private key." });
    return;
  }
  const values = {
    id: SETTINGS_ID,
    certificatePem,
    privateKeyPemEncrypted: privateKeyPem ? encryptSecret(privateKeyPem) : before?.privateKeyPemEncrypted ?? null,
    chainPem,
    certificateFingerprint: certificate.fingerprint256,
    certificateSubject: certificate.subject,
    certificateExpiresAt: new Date(certificate.validTo),
    forceHttps: Boolean(body.forceHttps),
    hstsEnabled: Boolean(body.hstsEnabled),
    updatedAt: new Date(),
  };
  if (values.forceHttps && !values.privateKeyPemEncrypted) {
    res.status(400).json({ error: "HTTPS cannot be enabled without a private key." });
    return;
  }
  const [row] = await db.insert(sslSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: sslSettingsTable.id, set: values })
    .returning();
  try {
    await materializeTlsCredentials(row);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? `Certificate was saved but could not be installed for the console: ${error.message}` : "Certificate was saved but could not be installed for the console." });
    return;
  }
  res.json(sslDto(row));
  if (!usesProxyTlsTermination()) {
    setImmediate(() => {
      void import("../runtime-server").then(({ reloadRuntimeServer }) => reloadRuntimeServer()).catch(() => undefined);
    });
  }
});

export default router;