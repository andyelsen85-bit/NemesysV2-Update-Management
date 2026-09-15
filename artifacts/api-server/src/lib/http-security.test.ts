import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  createCorsMiddleware,
  csrfProtection,
} from "./http-security";

function runCors(origin: string | undefined): Promise<Map<string, string>> {
  const headers = new Map<string, string>();
  const middleware = createCorsMiddleware(new Set(["https://allowed.example"]));
  const request = {
    headers: origin ? { origin } : {},
    method: "GET",
  } as unknown as Request;
  const response = {
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
  } as unknown as Response;

  return new Promise((resolve, reject) => {
    try {
      middleware(request, response, () => resolve(headers));
    } catch (error) {
      reject(error);
    }
  });
}

function runCsrf(
  method: string,
  path: string,
  session: Request["session"] | undefined,
): { status?: number; body?: unknown; nextCalled: boolean } {
  let status: number | undefined;
  let body: unknown;
  let nextCalled = false;
  const req = {
    method,
    path,
    session,
    cookies: {},
    get: () => undefined,
  } as unknown as Request;
  const response = {
    status(value: number) {
      status = value;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
  } as unknown as Response;

  csrfProtection(req, response, vi.fn(() => {
    nextCalled = true;
  }));
  return { status, body, nextCalled };
}

describe("HTTP security middleware", () => {
  it("only emits CORS allow headers for configured origins", async () => {
    const untrusted = await runCors("https://untrusted.example");
    expect(untrusted.has("access-control-allow-origin")).toBe(false);

    const allowed = await runCors("https://allowed.example");
    expect(allowed.get("access-control-allow-origin")).toBe("https://allowed.example");
    expect(allowed.get("access-control-allow-credentials")).toBe("true");
  });

  it("requires CSRF for every authenticated unsafe administrator route group", () => {
    const administrator = { adminUsername: "administrator" } as Request["session"];
    const protectedRoutes = [
      "/api/auth/password",
      "/api/users",
      "/api/clients/host-1/revoke",
      "/api/software",
      "/api/settings",
      "/api/settings/adfs",
      "/api/settings/ldap",
      "/api/settings/ldap/directory/sync",
      "/api/settings/ldap/test",
      "/api/admin/backup",
    ];

    for (const path of protectedRoutes) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const result = runCsrf(method, path, administrator);
        expect(result.status, `${method} ${path}`).toBe(403);
        expect(result.nextCalled, `${method} ${path}`).toBe(false);
      }
    }
  });

  it("leaves login and API-key sync requests exempt, while keeping AD FS callback GET safe", () => {
    const administrator = { adminUsername: "administrator" } as Request["session"];
    expect(runCsrf("POST", "/api/auth/login", administrator).nextCalled).toBe(true);
    expect(runCsrf("POST", "/api/sync/report", administrator).nextCalled).toBe(true);
    expect(runCsrf("GET", "/api/auth/adfs/callback", administrator).nextCalled).toBe(true);
  });
});