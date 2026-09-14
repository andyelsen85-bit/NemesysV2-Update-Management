import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

export const CSRF_COOKIE = "nemesys_csrf";
export const CSRF_HEADER = "x-csrf-token";

export function ensureCsrfCookie(req: Request, res: Response): string {
  const existing = req.cookies?.[CSRF_COOKIE];
  if (typeof existing === "string" && existing.length >= 32) return existing;
  const token = randomBytes(32).toString("base64url");
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: "lax",
    secure: req.secure,
    maxAge: 12 * 60 * 60 * 1000,
    path: "/",
  });
  return token;
}

export function csrfMatches(req: Request): boolean {
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get(CSRF_HEADER);
  if (typeof cookie !== "string" || typeof header !== "string") return false;
  const left = Buffer.from(cookie);
  const right = Buffer.from(header);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function requireCsrf(req: Request, res: Response): boolean {
  if (!csrfMatches(req)) {
    res.status(403).json({ error: "A valid CSRF token is required." });
    return false;
  }
  return true;
}