import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, serverSettingsTable } from "@workspace/db";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "nemesys_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const router: IRouter = Router();

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

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for administrator sessions.");
  return secret;
}

function createSession(username: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${username}.${expiresAt}`;
  const signature = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function getSessionUsername(req: Request): string | null {
  const value = req.cookies?.[SESSION_COOKIE];
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [username, expiresText, signature] = parts;
  const expiresAt = Number(expiresText);
  if (!username || !Number.isSafeInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return null;
  const expected = createHmac("sha256", sessionSecret()).update(`${username}.${expiresText}`).digest();
  const actual = Buffer.from(signature, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? username : null;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  try {
    const username = getSessionUsername(req);
    if (!username) {
      res.status(401).json({ error: "Administrator authentication is required" });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

router.post("/login", async (req, res): Promise<void> => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }

  const [settings] = await db.select({
    adminUsername: serverSettingsTable.adminUsername,
    adminPasswordHash: serverSettingsTable.adminPasswordHash,
  }).from(serverSettingsTable).where(eq(serverSettingsTable.id, "default")).limit(1);
  if (!settings?.adminPasswordHash || settings.adminUsername !== username || !await verifyPassword(password, settings.adminPasswordHash)) {
    res.status(401).json({ error: "Invalid administrator credentials" });
    return;
  }

  res.cookie(SESSION_COOKIE, createSession(username), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/",
  });
  res.json({ username });
});

router.get("/me", (req, res): void => {
  try {
    const username = getSessionUsername(req);
    if (!username) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    res.json({ username });
  } catch {
    res.status(503).json({ error: "Session configuration is unavailable" });
  }
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
  if (!username || !settings?.adminPasswordHash || !await verifyPassword(currentPassword, settings.adminPasswordHash)) {
    res.status(401).json({ error: "Current password is invalid" });
    return;
  }
  await db.update(serverSettingsTable)
    .set({ adminPasswordHash: await hashPassword(newPassword) })
    .where(eq(serverSettingsTable.id, "default"));
  res.json({ username: settings.adminUsername });
});

router.post("/logout", (_req, res): void => {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
  res.status(204).end();
});

export default router;