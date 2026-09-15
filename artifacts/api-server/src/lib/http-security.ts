import cors from "cors";
import type { NextFunction, Request, Response } from "express";
import { csrfMatches, requireCsrf } from "./csrf";

export function configuredCorsOrigins(): Set<string> {
  return new Set(
    (process.env.CORS_ALLOWED_ORIGINS ?? process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function corsOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): string | false {
  // Requests without an Origin are same-origin/server-to-server traffic and
  // must not receive permissive CORS headers.
  if (!origin || !allowedOrigins.has(origin)) return false;
  return origin;
}

export function createCorsMiddleware(
  allowedOrigins = configuredCorsOrigins(),
): ReturnType<typeof cors> {
  return cors({
    credentials: true,
    origin: (origin, callback) => {
      callback(null, corsOrigin(origin, allowedOrigins));
    },
  });
}

export function csrfProtection(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }

  const path = req.path;
  // Login intentionally remains exempt to preserve its existing login-CSRF
  // behavior. Machine sync routes authenticate with their API key instead of
  // an administrator session and are also exempt.
  if (path === "/api/auth/login" || path.startsWith("/api/sync/")) {
    next();
    return;
  }

  // Only a browser cookie-authenticated operation needs CSRF protection.
  // Unauthenticated requests continue to the route's administrator
  // authorization middleware, which returns 401.
  if (!req.session?.adminUsername || csrfMatches(req)) {
    next();
    return;
  }
  requireCsrf(req, res);
}