import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { adminUsersTable, db, serverSettingsTable } from "@workspace/db";
import { authenticateLdap } from "../lib/ldap";
import { ADFS_LOGIN_PREFERENCE_COOKIE } from "../lib/adfs-security";
import {
  destroyApplicationSession,
  getAdminSessionGeneration,
  SESSION_COOKIE,
  absoluteSessionTimeoutSeconds,
} from "../lib/session";
import {
  clearDistributedLoginFailures,
  recordDistributedLoginFailure,
  requireDistributedLoginAvailable,
  loginRateLimiter,
} from "../lib/login-security";

const scrypt = promisify(scryptCallback);
const router: IRouter = Router();
export { SESSION_COOKIE };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [, salt, expectedHex] = encoded.split("$");
  if (!salt || !expectedHex) return false;
  const actual = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function setApplicationSession(
  req: Request,
  _res: Response,
  username: string,
  source: "local" | "ldap" | "adfs" = "local",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((error) => error ? reject(error) : resolve());
  });
  req.session.adminUsername = username;
  req.session.adminAuthSource = source;
  req.session.createdAt = Date.now();
  req.session.adminSessionGeneration = await getAdminSessionGeneration();
  await new Promise<void>((resolve, reject) => {
    req.session.save((error) => error ? reject(error) : resolve());
  });
}

export function getSessionUsername(req: Request): string | null {
  if (
    !req.session
    || typeof req.session.adminUsername !== "string"
    || (req.session.createdAt !== undefined
      && Date.now() - req.session.createdAt > absoluteSessionTimeoutSeconds() * 1000)
  ) return null;
  return req.session.adminUsername;
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionUsername = req.session?.adminUsername;
    const createdAt = req.session?.createdAt;
    if (typeof sessionUsername === "string"
      && createdAt
      && Date.now() - createdAt > absoluteSessionTimeoutSeconds() * 1000) {
      await destroyApplicationSession(req);
      res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
      res.status(401).json({ error: "Administrator session has expired" });
      return;
    }
    const username = getSessionUsername(req);
    if (!username) {
      if (req.session?.adminUsername) {
        await destroyApplicationSession(req);
        res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
      }
      res.status(401).json({ error: "Administrator authentication is required" });
      return;
    }
    const [settings] = await db.select({
      adminUsername: serverSettingsTable.adminUsername,
    }).from(serverSettingsTable).where(eq(serverSettingsTable.id, "default")).limit(1);
    if (Number(req.session.adminSessionGeneration ?? -1) !== await getAdminSessionGeneration()) {
      await destroyApplicationSession(req);
      res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
      res.status(401).json({ error: "Administrator session has been revoked" });
      return;
    }
    const source = req.session.adminAuthSource;
    const isLocalAdmin = username === settings?.adminUsername && (source === "local" || !source);
    if (!isLocalAdmin) {
      const [directoryUser] = await db.select({ isActive: adminUsersTable.isActive })
        .from(adminUsersTable)
        .where(eq(adminUsersTable.username, username))
        .limit(1);
      if (!directoryUser?.isActive) {
        await destroyApplicationSession(req);
        res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
        res.status(401).json({ error: "Administrator account is inactive" });
        return;
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}

router.post("/login", loginRateLimiter(), async (req, res): Promise<void> => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }
  if (!await requireDistributedLoginAvailable(req, res, username)) return;

  const [settings] = await db.select({
    adminUsername: serverSettingsTable.adminUsername,
    adminPasswordHash: serverSettingsTable.adminPasswordHash,
  }).from(serverSettingsTable).where(eq(serverSettingsTable.id, "default")).limit(1);
  const localMatch = Boolean(settings?.adminPasswordHash && settings.adminUsername === username && await verifyPassword(password, settings.adminPasswordHash));
  if (!localMatch) {
    const [ldapUser] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.username, username)).limit(1);
    if (!ldapUser?.isActive) {
      await recordDistributedLoginFailure(req, username);
      res.status(401).json({ error: "Invalid administrator credentials" });
      return;
    }
    const ldapResult = await authenticateLdap(username, password);
    if (!ldapResult.user) {
      await recordDistributedLoginFailure(req, username);
      res.status(401).json({ error: "Invalid administrator credentials" });
      return;
    }
    await db.update(adminUsersTable).set({
      displayName: ldapResult.user.displayName,
      email: ldapResult.user.email,
      directoryDn: ldapResult.user.directoryDn,
      updatedAt: new Date(),
    }).where(eq(adminUsersTable.id, ldapUser.id));
    await clearDistributedLoginFailures(req, username);
    await setApplicationSession(req, res, username, "ldap");
  } else {
    await clearDistributedLoginFailures(req, username);
    await setApplicationSession(req, res, username, "local");
  }

  res.clearCookie(ADFS_LOGIN_PREFERENCE_COOKIE, { sameSite: "lax", path: "/" });
  res.json({ username });
});

router.get("/me", async (req, res): Promise<void> => {
  let passed = false;
  let failure: unknown;
  await requireAdmin(req, res, (error?: unknown) => {
    if (error) failure = error;
    else passed = true;
  });
  if (failure) throw failure;
  if (passed) res.json({ username: getSessionUsername(req) });
});

router.post("/password", requireAdmin, async (req, res): Promise<void> => {
  const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
  const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
  if (!currentPassword || newPassword.length < 8) {
    res.status(400).json({ error: "Current password is required and the new password must be at least 8 characters." });
    return;
  }
  const username = getSessionUsername(req);
  const [settings] = await db.select({
    adminUsername: serverSettingsTable.adminUsername,
    adminPasswordHash: serverSettingsTable.adminPasswordHash,
  }).from(serverSettingsTable).where(eq(serverSettingsTable.id, "default")).limit(1);
  if (!username || username !== settings?.adminUsername) {
    res.status(403).json({ error: "Only the local administrator account can change this password." });
    return;
  }
  if (!settings.adminPasswordHash || !await verifyPassword(currentPassword, settings.adminPasswordHash)) {
    res.status(401).json({ error: "Current password is invalid" });
    return;
  }
  await db.update(serverSettingsTable)
    .set({ adminPasswordHash: await hashPassword(newPassword) })
    .where(eq(serverSettingsTable.id, "default"));
  res.json({ username: settings.adminUsername });
});

router.post("/logout", async (req, res): Promise<void> => {
  await destroyApplicationSession(req);
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
  res.clearCookie(ADFS_LOGIN_PREFERENCE_COOKIE, { sameSite: "lax", path: "/" });
  res.status(204).end();
});

export default router;