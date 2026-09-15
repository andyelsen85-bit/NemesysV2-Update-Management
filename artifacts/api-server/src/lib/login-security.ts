import type { Request, RequestHandler, Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const BUCKET_CLEANUP_AGE = "1 day";

function keyFor(req: Request, identifier: string, namespace: string): string {
  return `${namespace}:${req.ip ?? "unknown"}:${identifier.trim().toLowerCase()}`;
}

async function boundedCleanup(): Promise<void> {
  await db.execute(sql`
    DELETE FROM public.nemesys_security_buckets
    WHERE ctid IN (
      SELECT ctid FROM public.nemesys_security_buckets
      WHERE updated_at < now() - ${sql.raw(`interval '${BUCKET_CLEANUP_AGE}'`)}
      LIMIT 100
    )
  `);
}

async function distributedRateLimit(
  req: Request,
  namespace: string,
  identifier: string,
  windowMs: number,
  limit: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const key = keyFor(req, identifier, namespace);
  const result = await db.execute(sql`
    INSERT INTO public.nemesys_security_buckets
      (bucket_key, bucket_kind, failure_count, window_started_at, updated_at)
    VALUES (${key}, ${namespace}, 1, now(), now())
    ON CONFLICT (bucket_key) DO UPDATE SET
      failure_count = CASE
        WHEN nemesys_security_buckets.window_started_at <= now() - (${windowMs} * interval '1 millisecond') THEN 1
        ELSE nemesys_security_buckets.failure_count + 1
      END,
      window_started_at = CASE
        WHEN nemesys_security_buckets.window_started_at <= now() - (${windowMs} * interval '1 millisecond') THEN now()
        ELSE nemesys_security_buckets.window_started_at
      END,
      updated_at = now()
    RETURNING failure_count, window_started_at
  `);
  const row = (result.rows[0] ?? {}) as { failure_count?: number; window_started_at?: string | Date };
  const count = Number(row.failure_count ?? limit + 1);
  const started = new Date(row.window_started_at ?? Date.now()).getTime();
  const retryAfter = Math.max(1, Math.ceil((started + windowMs - Date.now()) / 1000));
  void boundedCleanup().catch(() => undefined);
  return { allowed: count <= limit, retryAfter };
}

function rateLimitHandler(
  namespace: string,
  identifier: (req: Request) => string,
  windowMs: number,
  limit: number,
  message: string,
): RequestHandler {
  return async (req, res, next): Promise<void> => {
    try {
      const result = await distributedRateLimit(req, namespace, identifier(req), windowMs, limit);
      if (!result.allowed) {
        res.setHeader("Retry-After", result.retryAfter);
        res.status(429).json({ error: message });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function loginRateLimiter(): RequestHandler {
  return rateLimitHandler("login-rate", () => "all", LOCKOUT_WINDOW_MS, 30, "Too many login attempts. Please try again later.");
}

export function adfsCallbackRateLimiter(): RequestHandler {
  return rateLimitHandler("adfs-rate", () => "callback", LOCKOUT_WINDOW_MS, 30, "Too many authentication callbacks. Please try again later.");
}

export function adfsStartRateLimiter(): RequestHandler {
  return rateLimitHandler("adfs-start-rate", () => "start", LOCKOUT_WINDOW_MS, 30, "Too many authentication attempts. Please try again later.");
}

export function expensiveMachineRateLimiter(limit: number): RequestHandler {
  return rateLimitHandler("machine-rate", (req) => req.route?.path ?? req.path, 60 * 1000, limit, "Too many client requests. Please try again later.");
}

export async function distributedLoginLockout(req: Request, identifier: string, namespace = "login"): Promise<number> {
  const result = await db.execute(sql`
    SELECT locked_until FROM public.nemesys_security_buckets
    WHERE bucket_key = ${keyFor(req, identifier, namespace)}
      AND locked_until > now()
  `);
  const lockedUntil = result.rows[0]?.locked_until;
  return lockedUntil ? Math.max(0, new Date(lockedUntil as string | Date).getTime() - Date.now()) : 0;
}

export async function requireDistributedLoginAvailable(
  req: Request,
  res: Response,
  identifier: string,
  namespace = "login",
): Promise<boolean> {
  const remaining = await distributedLoginLockout(req, identifier, namespace);
  if (!remaining) return true;
  res.setHeader("Retry-After", Math.ceil(remaining / 1000));
  res.status(429).json({ error: "Too many failed authentication attempts. Please try again later." });
  return false;
}

export async function recordDistributedLoginFailure(req: Request, identifier: string, namespace = "login"): Promise<void> {
  const key = keyFor(req, identifier, namespace);
  await db.execute(sql`
    INSERT INTO public.nemesys_security_buckets
      (bucket_key, bucket_kind, failure_count, window_started_at, locked_until, updated_at)
    VALUES (${key}, ${namespace}, 1, now(), NULL, now())
    ON CONFLICT (bucket_key) DO UPDATE SET
      failure_count = CASE
        WHEN nemesys_security_buckets.updated_at < now() - (${LOCKOUT_WINDOW_MS} * interval '1 millisecond') THEN 1
        ELSE nemesys_security_buckets.failure_count + 1
      END,
      window_started_at = CASE
        WHEN nemesys_security_buckets.updated_at < now() - (${LOCKOUT_WINDOW_MS} * interval '1 millisecond') THEN now()
        ELSE nemesys_security_buckets.window_started_at
      END,
      locked_until = CASE
        WHEN (
          CASE
            WHEN nemesys_security_buckets.updated_at < now() - (${LOCKOUT_WINDOW_MS} * interval '1 millisecond') THEN 1
            ELSE nemesys_security_buckets.failure_count + 1
          END
        ) < 5 THEN NULL
        ELSE now() + (
          LEAST(3600, 30 * power(2, LEAST((
            CASE
              WHEN nemesys_security_buckets.updated_at < now() - (${LOCKOUT_WINDOW_MS} * interval '1 millisecond') THEN 1
              ELSE nemesys_security_buckets.failure_count + 1
            END
          ) - 5, 6))) * interval '1 second'
        )
      END,
      updated_at = now()
  `);
  void boundedCleanup().catch(() => undefined);
}

export async function clearDistributedLoginFailures(req: Request, identifier: string, namespace = "login"): Promise<void> {
  await db.execute(sql`DELETE FROM public.nemesys_security_buckets WHERE bucket_key = ${keyFor(req, identifier, namespace)}`);
}

// Kept as a small compatibility shim for existing unit consumers.  Security
// routes use the distributed functions above exclusively.
type LegacyFailure = { count: number; lockedUntil: number; updatedAt: number };
const legacyFailures = new Map<string, LegacyFailure>();
function legacyKey(req: Request, identifier: string, namespace = "login"): string {
  return keyFor(req, identifier, namespace);
}
export function loginLockout(req: Request, identifier: string, namespace = "login"): number {
  const failure = legacyFailures.get(legacyKey(req, identifier, namespace));
  if (!failure || failure.lockedUntil <= Date.now()) return 0;
  return failure.lockedUntil - Date.now();
}
export function recordLoginFailure(req: Request, identifier: string, namespace = "login"): void {
  const key = legacyKey(req, identifier, namespace);
  const previous = legacyFailures.get(key) ?? { count: 0, lockedUntil: 0, updatedAt: 0 };
  const count = previous.count + 1;
  legacyFailures.set(key, {
    count,
    lockedUntil: Date.now() + (count < 5 ? 0 : Math.min(60 * 60, 30 * 2 ** Math.min(count - 5, 6)) * 1000),
    updatedAt: Date.now(),
  });
}
export function clearLoginFailures(req: Request, identifier: string, namespace = "login"): void {
  legacyFailures.delete(legacyKey(req, identifier, namespace));
}