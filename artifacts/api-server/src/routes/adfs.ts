import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { and, eq } from "drizzle-orm";
import {
  adminUsersTable,
  adfsIdentityMappingsTable,
  db,
} from "@workspace/db";
import {
  adfsRedirectUri,
  getAdfsSettings,
  isAdfsConfigured,
} from "../lib/adfs-config";
import {
  createAuthorizationRequest,
  redeemAuthorizationCode,
} from "../lib/adfs-oidc";
import {
  ADFS_LOGIN_PREFERENCE_COOKIE,
  ADFS_STATE_COOKIE,
  decodeAdfsState,
  encodeAdfsState,
  safeLocalReturnTo,
  sameSecret,
} from "../lib/adfs-security";
import { matchExistingAdfsAdmin } from "../lib/adfs-helpers";
import { setApplicationSession } from "./auth";

const router: IRouter = Router();

function errorRedirect(returnTo: string, code: string): string {
  const target = new URL(safeLocalReturnTo(returnTo), "https://nemesys.invalid");
  target.searchParams.set("adfsError", code);
  return `${target.pathname}${target.search}${target.hash}`;
}

function secureCookie(req: Request): boolean {
  return req.secure || process.env.NODE_ENV === "production";
}

export async function resolveAdfsAdmin(
  issuer: string,
  subject: string,
  claims: Record<string, unknown>,
  usernameClaim: string,
  emailClaim: string,
  displayNameClaim: string,
) {
  const [mapped] = await db.select().from(adfsIdentityMappingsTable)
    .where(and(eq(adfsIdentityMappingsTable.issuer, issuer), eq(adfsIdentityMappingsTable.subject, subject)))
    .limit(1);
  if (mapped) {
    const [user] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.id, mapped.adminUserId)).limit(1);
    if (!user?.isActive) throw new Error("The mapped administrator account is inactive.");
    return user;
  }

  const users = await db.select().from(adminUsersTable);
  const user = matchExistingAdfsAdmin(users, claims, usernameClaim, emailClaim);

  try {
    await db.insert(adfsIdentityMappingsTable).values({
      id: randomUUID(),
      issuer,
      subject,
      adminUserId: user.id,
    });
  } catch {
    const [existing] = await db.select().from(adfsIdentityMappingsTable)
      .where(and(eq(adfsIdentityMappingsTable.issuer, issuer), eq(adfsIdentityMappingsTable.subject, subject)))
      .limit(1);
    if (!existing || existing.adminUserId !== user.id) {
      throw new Error("The AD FS identity mapping changed while signing in.");
    }
  }
  // Claims are only used for matching and are deliberately not copied into logs.
  void displayNameClaim;
  return user;
}

router.get("/adfs/config", async (_req, res): Promise<void> => {
  const settings = await getAdfsSettings();
  res.json({
    enabled: settings.enabled,
    configured: isAdfsConfigured(settings),
    displayName: settings.displayName,
  });
});

router.get("/adfs/start", async (req, res): Promise<void> => {
  const settings = await getAdfsSettings();
  if (!isAdfsConfigured(settings)) {
    res.status(404).json({ error: "AD FS authentication is not configured." });
    return;
  }
  const returnTo = safeLocalReturnTo(req.query.returnTo);
  try {
    const redirectUri = adfsRedirectUri(req, settings);
    const request = await createAuthorizationRequest(settings, redirectUri);
    res.cookie(ADFS_STATE_COOKIE, encodeAdfsState({
      state: request.state,
      nonce: request.nonce,
      codeVerifier: request.codeVerifier,
      returnTo,
    }), {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookie(req),
      maxAge: 10 * 60 * 1000,
      path: "/",
    });
    res.redirect(302, request.url.toString());
  } catch (error) {
    req.log.warn({ errorType: error instanceof Error ? error.name : "UnknownError" }, "AD FS authorization could not start");
    res.redirect(302, errorRedirect(returnTo, "unavailable"));
  }
});

router.get("/adfs/callback", async (req, res): Promise<void> => {
  const stateCookie = req.cookies?.[ADFS_STATE_COOKIE] as string | undefined;
  const state = decodeAdfsState(stateCookie);
  const queryState = typeof req.query.state === "string" ? req.query.state : undefined;
  res.clearCookie(ADFS_STATE_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
  if (!state || !sameSecret(state.state, queryState)) {
    req.log.warn("AD FS callback state validation failed");
    res.redirect(302, errorRedirect("/", "validation"));
    return;
  }
  if (typeof req.query.error === "string") {
    req.log.info({ errorCode: req.query.error }, "AD FS sign-in was declined");
    res.redirect(302, errorRedirect(state.returnTo, "cancelled"));
    return;
  }
  const settings = await getAdfsSettings();
  if (!isAdfsConfigured(settings)) {
    res.redirect(302, errorRedirect(state.returnTo, "configuration"));
    return;
  }
  try {
    const protocol = String(req.headers["x-forwarded-proto"] ?? (req.secure ? "https" : "http")).split(",")[0].trim();
    const callbackUrl = new URL(req.originalUrl, `${protocol}://${req.get("host")}`);
    const tokens = await redeemAuthorizationCode(
      settings,
      callbackUrl,
      adfsRedirectUri(req, settings),
      state.state,
      state.nonce,
      state.codeVerifier,
    );
    const claims = tokens.claims() as Record<string, unknown> | undefined;
    const subject = claims && typeof claims.sub === "string" ? claims.sub : "";
    const issuer = claims && typeof claims.iss === "string" ? claims.iss : settings.issuer;
    if (!claims || !subject || !issuer) throw new Error("AD FS did not provide a valid identity.");
    const user = await resolveAdfsAdmin(
      issuer,
      subject,
      claims,
      settings.usernameClaim,
      settings.emailClaim,
      settings.displayNameClaim,
    );
    setApplicationSession(req, res, user.username);
    res.cookie(ADFS_LOGIN_PREFERENCE_COOKIE, "adfs", {
      httpOnly: false,
      sameSite: "lax",
      secure: secureCookie(req),
      maxAge: 365 * 24 * 60 * 60 * 1000,
      path: "/",
    });
    res.redirect(302, safeLocalReturnTo(state.returnTo));
  } catch (error) {
    req.log.warn({ errorType: error instanceof Error ? error.name : "UnknownError" }, "AD FS callback failed");
    res.redirect(302, errorRedirect(state.returnTo, "failed"));
  }
});

export default router;