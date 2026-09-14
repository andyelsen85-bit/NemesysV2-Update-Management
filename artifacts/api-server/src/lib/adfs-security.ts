import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ADFS_STATE_COOKIE = "nemesys_adfs_state";
export const ADFS_LOGIN_PREFERENCE_COOKIE = "nemesys_login_method";
const STATE_TTL_SECONDS = 10 * 60;

export interface AdfsState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
}

function sessionSecret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is required for AD FS state protection.");
  return value;
}

function sign(value: string): string {
  return createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

export function encodeAdfsState(state: Omit<AdfsState, "expiresAt">, now = Math.floor(Date.now() / 1000)): string {
  const payload = Buffer.from(JSON.stringify({ ...state, expiresAt: now + STATE_TTL_SECONDS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeAdfsState(value: string | undefined, now = Math.floor(Date.now() / 1000)): AdfsState | null {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = value.slice(0, separator);
  const provided = Buffer.from(value.slice(separator + 1), "base64url");
  const expected = Buffer.from(sign(payload), "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<AdfsState>;
    const expiresAt = decoded.expiresAt;
    if (
      typeof decoded.state !== "string" ||
      typeof decoded.nonce !== "string" ||
      typeof decoded.codeVerifier !== "string" ||
      typeof decoded.returnTo !== "string" ||
      !Number.isSafeInteger(expiresAt) ||
      (expiresAt as number) < now
    ) return null;
    return decoded as AdfsState;
  } catch {
    return null;
  }
}

export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Accept only an application-relative URL. Fragments are preserved because
 * they are part of a browser deep link even though they are not sent to us.
 */
export function safeLocalReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048) return "/";
  if (/[\\\u0000-\u001f\u007f]/.test(value) || value.startsWith("//") || !value.startsWith("/")) return "/";
  try {
    const decodedValue = decodeURIComponent(value);
    if (/[\\\u0000-\u001f\u007f]/.test(decodedValue) || decodedValue.startsWith("//")) return "/";
    const parsed = new URL(value, "https://nemesys.invalid");
    if (parsed.origin !== "https://nemesys.invalid" || parsed.pathname.startsWith("//")) return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  } catch {
    return "/";
  }
}

export function sameSecret(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}