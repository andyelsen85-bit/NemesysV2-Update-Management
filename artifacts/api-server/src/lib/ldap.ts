import { eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import ldap from "ldapjs";
import { db, directoryCacheStatusTable, directoryComputerGroupsTable, directoryComputersTable, directoryGroupsTable, ldapSettingsTable, softwarePolicyTargetGroupsTable } from "@workspace/db";
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

type DirectoryEntry = { dn: string; values: Record<string, unknown[]> };
function canonicalDn(value: string): string { return value.trim().toLowerCase(); }
export function normalizeComputerHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "").split(".")[0]!.replace(/\$$/, "");
}
function directoryId(value: unknown, dn: string): string {
  if (Buffer.isBuffer(value) && value.length === 16) return `guid-${value.toString("hex")}`;
  const text = value == null ? "" : String(value).trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return `guid-${text.toLowerCase()}`;
  return `dn-${createHash("sha256").update(canonicalDn(dn)).digest("hex")}`;
}
function textValues(entry: DirectoryEntry, attribute: string): string[] {
  return (entry.values[attribute.toLowerCase()] ?? [])
    .filter((value) => !Buffer.isBuffer(value))
    .map(String);
}
function firstText(entry: DirectoryEntry, attribute: string): string {
  return textValues(entry, attribute)[0] ?? "";
}
function parseDirectoryEntry(entry: unknown): DirectoryEntry {
  const raw = entry as {
    objectName?: string;
    dn?: string;
    pojo?: { attributes?: Array<{ type?: string; values?: unknown[]; buffers?: Buffer[] }> };
    attributes?: Array<{ type?: string; values?: unknown[]; buffers?: Buffer[] }>;
  };
  const values: Record<string, unknown[]> = {};
  for (const attributes of [raw.pojo?.attributes, raw.attributes]) for (const attribute of attributes ?? []) {
    if (!attribute.type) continue;
    const type = attribute.type.toLowerCase();
    values[type] = (type === "objectguid" || type === "objectsid") && attribute.buffers?.length
      ? attribute.buffers
      : attribute.values ?? [];
  }
  return { dn: String(raw.objectName ?? raw.dn ?? ""), values };
}
async function searchDirectory(client: ldap.Client, base: string, filter: string, attributes: string[]): Promise<DirectoryEntry[]> {
  return new Promise((resolve, reject) => client.search(base, {
    filter,
    scope: "sub",
    attributes,
    paged: { pageSize: 500, pagePause: false },
  }, (error, result) => {
    if (error) return reject(error);
    const rows: DirectoryEntry[] = [];
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    result.on("searchEntry", (entry) => rows.push(parseDirectoryEntry(entry)));
    result.on("error", (searchError) => finish(() => reject(searchError)));
    result.on("end", () => finish(() => resolve(rows)));
  }));
}

function primaryGroupSidKey(objectSid: unknown, primaryGroupId: number): string | null {
  if (!Buffer.isBuffer(objectSid) || objectSid.length < 12 || !Number.isInteger(primaryGroupId) || primaryGroupId < 0 || primaryGroupId > 0xffffffff) return null;
  const primarySid = Buffer.from(objectSid);
  primarySid.writeUInt32LE(primaryGroupId, primarySid.length - 4);
  return primarySid.toString("hex");
}

/** Refreshes the durable directory cache. LDAP is never consulted by client sync. */
async function performDirectoryCacheSync(): Promise<void> {
  const settings = await getLdapSettings();
  const attemptedAt = new Date();
  if (!settings?.enabled || !settings.url || !settings.baseDn || !settings.computerBaseDn) {
    await db.insert(directoryCacheStatusTable).values({ id: "default", lastAttemptAt: attemptedAt, lastError: "LDAP directory targeting is not configured or enabled." })
      .onConflictDoUpdate({ target: directoryCacheStatusTable.id, set: { lastAttemptAt: attemptedAt, lastError: "LDAP directory targeting is not configured or enabled." } });
    throw new Error("LDAP directory targeting is not configured or enabled.");
  }
  const client = createClient(settings);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('nemesys-directory-cache-sync'))`);
      if (settings.bindDn) await bind(client, settings.bindDn, decryptSecret(settings.bindPasswordEncrypted) ?? "");
      const computers = await searchDirectory(
        client,
        settings.computerBaseDn,
        "(&(objectCategory=computer)(objectClass=computer))",
        ["sAMAccountName", "dNSHostName", "distinguishedName", "objectGUID", "objectSid", "primaryGroupID", "userAccountControl", "memberOf"],
      );
      const groups = await searchDirectory(
        client,
        settings.baseDn,
        "(objectCategory=group)",
        ["cn", "sAMAccountName", "distinguishedName", "objectGUID", "objectSid", "memberOf"],
      );
      const mappedGroups = groups.map((entry) => {
        const dn = firstText(entry, "distinguishedName") || entry.dn;
        return {
          id: directoryId(entry.values["objectguid"]?.[0], dn),
          name: firstText(entry, "cn") || firstText(entry, "sAMAccountName") || dn,
          samAccountName: firstText(entry, "sAMAccountName"),
          distinguishedName: dn,
          sidKey: Buffer.isBuffer(entry.values["objectsid"]?.[0]) ? entry.values["objectsid"][0].toString("hex") : null,
          parents: textValues(entry, "memberOf"),
        };
      });
      const groupsByDn = new Map(mappedGroups.map((group) => [canonicalDn(group.distinguishedName), group]));
      const groupsBySid = new Map(mappedGroups.filter((group) => group.sidKey).map((group) => [group.sidKey, group]));
      const groupAncestors = (directDns: string[], primarySidKey: string | null) => {
        const found = new Set<string>();
        const visitGroup = (group: typeof mappedGroups[number] | undefined) => {
          if (!group || found.has(group.id)) return;
          found.add(group.id);
          group.parents.forEach((dn) => visitGroup(groupsByDn.get(canonicalDn(dn))));
        };
        directDns.forEach((dn) => visitGroup(groupsByDn.get(canonicalDn(dn))));
        if (primarySidKey) visitGroup(groupsBySid.get(primarySidKey));
        return [...found];
      };
      const mappedComputers = computers.map((entry) => {
        const dn = firstText(entry, "distinguishedName") || entry.dn;
        const sam = firstText(entry, "sAMAccountName");
        const dns = firstText(entry, "dNSHostName");
        const hostname = normalizeComputerHostname(dns || sam);
        const uac = Number(firstText(entry, "userAccountControl") || 0);
        const primarySid = primaryGroupSidKey(
          entry.values["objectsid"]?.[0],
          Number(firstText(entry, "primaryGroupID")),
        );
        return {
          id: directoryId(entry.values["objectguid"]?.[0], dn),
          hostname,
          samAccountName: sam,
          dnsHostName: dns,
          distinguishedName: dn,
          enabled: (uac & 2) === 0,
          groups: groupAncestors(textValues(entry, "memberOf"), primarySid),
        };
      }).filter((computer) => computer.hostname);
      await tx.delete(directoryComputerGroupsTable);
      await tx.delete(directoryComputersTable);
      await tx.update(directoryGroupsTable).set({ active: false });
      for (const group of mappedGroups) await tx.insert(directoryGroupsTable).values({ ...group, active: true, syncedAt: attemptedAt }).onConflictDoUpdate({ target: directoryGroupsTable.id, set: { name: group.name, samAccountName: group.samAccountName, distinguishedName: group.distinguishedName, active: true, syncedAt: attemptedAt } });
      for (const computer of mappedComputers) {
        await tx.insert(directoryComputersTable).values({ id: computer.id, hostname: computer.hostname, samAccountName: computer.samAccountName, dnsHostName: computer.dnsHostName, distinguishedName: computer.distinguishedName, enabled: computer.enabled, syncedAt: attemptedAt });
        if (computer.groups.length) await tx.insert(directoryComputerGroupsTable).values(computer.groups.map((groupId) => ({ computerId: computer.id, groupId })));
      }
      // Stale groups referenced by policies deliberately remain, making targeted policies fail closed.
      const completedAt = new Date();
      await tx.insert(directoryCacheStatusTable).values({ id: "default", lastAttemptAt: attemptedAt, lastSuccessfulSyncAt: completedAt, lastError: null }).onConflictDoUpdate({ target: directoryCacheStatusTable.id, set: { lastAttemptAt: attemptedAt, lastSuccessfulSyncAt: completedAt, lastError: null } });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "LDAP directory sync failed.";
    await db.insert(directoryCacheStatusTable).values({ id: "default", lastAttemptAt: attemptedAt, lastError: message }).onConflictDoUpdate({ target: directoryCacheStatusTable.id, set: { lastAttemptAt: attemptedAt, lastError: message } });
    throw error;
  } finally { try { client.unbind(); } catch { /* best effort */ } }
}

let activeDirectorySync: Promise<void> | null = null;
export function syncDirectoryCache(): Promise<void> {
  if (activeDirectorySync) return activeDirectorySync;
  activeDirectorySync = performDirectoryCacheSync().finally(() => {
    activeDirectorySync = null;
  });
  return activeDirectorySync;
}

let scheduler: NodeJS.Timeout | undefined;
export function startDirectoryAutoSyncScheduler(): void {
  if (scheduler) return;
  scheduler = setInterval(() => { void (async () => {
    const settings = await getLdapSettings();
    const [status] = await db.select().from(directoryCacheStatusTable).where(eq(directoryCacheStatusTable.id, "default")).limit(1);
    const due = !status?.lastSuccessfulSyncAt || Date.now() - status.lastSuccessfulSyncAt.getTime() >= (settings?.directorySyncIntervalMinutes ?? 60) * 60_000;
    if (settings?.directoryAutoSyncEnabled && due) {
      try { await syncDirectoryCache(); } catch { /* status is persisted */ }
    }
  })(); }, 60_000);
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