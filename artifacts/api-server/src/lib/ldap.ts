import { eq } from "drizzle-orm";
import ldap from "ldapjs";
import { db, ldapSettingsTable } from "@workspace/db";
import { decryptSecret } from "./secret-crypto";

export type LdapUser = {
  username: string;
  displayName: string;
  email: string;
  directoryDn: string;
};

export type LdapDiagnostic = {
  success: boolean;
  stage: "config" | "connect" | "service-bind" | "search" | "user-bind" | "ok";
  message: string;
  details?: string;
};

export async function getLdapSettings() {
  const [settings] = await db.select().from(ldapSettingsTable).where(eq(ldapSettingsTable.id, "default")).limit(1);
  return settings ?? null;
}

function filterEscape(value: string): string {
  return value.replace(/[\0()*\\]/g, (character) => `\\${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function readEntry(entry: unknown, settings: NonNullable<Awaited<ReturnType<typeof getLdapSettings>>>): LdapUser {
  const raw = entry as {
    objectName?: string;
    pojo?: { objectName?: string; attributes?: Array<{ type?: string; values?: unknown[] }> };
    attributes?: Array<{ type?: string; values?: unknown[] }>;
    object?: Record<string, unknown>;
  };
  const values: Record<string, string> = {};
  for (const attributes of [raw.pojo?.attributes, raw.attributes]) {
    for (const attribute of attributes ?? []) {
      const value = attribute.values?.[0];
      if (attribute.type && value !== undefined) values[attribute.type.toLowerCase()] = String(value);
    }
  }
  for (const [key, value] of Object.entries(raw.object ?? {})) {
    if (values[key.toLowerCase()] !== undefined || value == null) continue;
    values[key.toLowerCase()] = Array.isArray(value) ? String(value[0] ?? "") : String(value);
  }
  const pick = (attribute: string, fallback: string) => values[attribute.toLowerCase()]?.trim() || values[fallback.toLowerCase()]?.trim() || "";
  const directoryDn = raw.objectName ?? (raw as { dn?: string }).dn ?? "";
  return {
    username: pick(settings.usernameAttribute, "uid"),
    displayName: pick(settings.displayNameAttribute, "cn") || pick(settings.usernameAttribute, "uid"),
    email: pick(settings.emailAttribute, "mail"),
    directoryDn: String(directoryDn),
  };
}

function createClient(settings: NonNullable<Awaited<ReturnType<typeof getLdapSettings>>>) {
  const isLdaps = settings.url.toLowerCase().startsWith("ldaps:");
  return ldap.createClient({
    url: settings.url,
    timeout: 5000,
    connectTimeout: 5000,
    tlsOptions: isLdaps
      ? { rejectUnauthorized: settings.verifyTlsCertificate, ...(settings.caCertificatePem ? { ca: [settings.caCertificatePem] } : {}) }
      : undefined,
  });
}

async function bind(client: ldap.Client, dn: string, password: string): Promise<void> {
  await new Promise<void>((resolve, reject) => client.bind(dn, password, (error) => error ? reject(error) : resolve()));
}

async function findUser(client: ldap.Client, settings: NonNullable<Awaited<ReturnType<typeof getLdapSettings>>>, username: string): Promise<LdapUser> {
  const filter = settings.userFilter.replaceAll("{{username}}", filterEscape(username));
  return await new Promise<LdapUser>((resolve, reject) => {
    client.search(settings.baseDn, { filter, scope: "sub", attributes: [settings.usernameAttribute, settings.displayNameAttribute, settings.emailAttribute] }, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      let found: LdapUser | null = null;
      result.on("searchEntry", (entry) => { found = readEntry(entry, settings); });
      result.on("error", reject);
      result.on("end", () => found ? resolve(found) : reject(new Error("LDAP user was not found.")));
    });
  });
}

export async function authenticateLdap(username: string, password: string): Promise<{ user?: LdapUser; diagnostic: LdapDiagnostic }> {
  const settings = await getLdapSettings();
  if (!settings?.enabled || !settings.url || !settings.baseDn) {
    return { diagnostic: { success: false, stage: "config", message: "LDAP is not configured or enabled." } };
  }
  const client = createClient(settings);
  try {
    if (settings.bindDn) {
      await bind(client, settings.bindDn, decryptSecret(settings.bindPasswordEncrypted) ?? "");
    }
    const user = await findUser(client, settings, username);
    await bind(client, user.directoryDn, password);
    return { user, diagnostic: { success: true, stage: "ok", message: "LDAP authentication succeeded." } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "LDAP request failed.";
    const stage = message.includes("not found") ? "search" : settings.bindDn ? "user-bind" : "connect";
    return { diagnostic: { success: false, stage, message, details: message } };
  } finally {
    try { client.unbind(); } catch { /* best effort */ }
  }
}

export async function lookupLdapUser(username: string): Promise<{ user?: LdapUser; diagnostic: LdapDiagnostic }> {
  const settings = await getLdapSettings();
  if (!settings?.enabled || !settings.url || !settings.baseDn) {
    return { diagnostic: { success: false, stage: "config", message: "LDAP is not configured or enabled." } };
  }
  const client = createClient(settings);
  try {
    if (settings.bindDn) await bind(client, settings.bindDn, decryptSecret(settings.bindPasswordEncrypted) ?? "");
    const user = await findUser(client, settings, username);
    return { user, diagnostic: { success: true, stage: "ok", message: "LDAP user found." } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "LDAP request failed.";
    return { diagnostic: { success: false, stage: message.includes("not found") ? "search" : "service-bind", message, details: message } };
  } finally {
    try { client.unbind(); } catch { /* best effort */ }
  }
}

export async function testLdapConnection(username: string, password: string): Promise<LdapDiagnostic> {
  return (await authenticateLdap(username, password)).diagnostic;
}