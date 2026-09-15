import http from "node:http";
import express from "express";
import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/nemesys";
const { default: router } = await import("./index");

async function request(method: string, path: string): Promise<number> {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  const server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind.");
    return await new Promise<number>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: address.port,
        path,
        method,
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("administrator route authorization", () => {
  it("returns 401 before touching protected route groups without a session", async () => {
    const protectedRoutes = [
      ["GET", "/api/auth/me"],
      ["POST", "/api/auth/password"],
      ["GET", "/api/admin/backup"],
      ["POST", "/api/admin/restore"],
      ["GET", "/api/users"],
      ["POST", "/api/users"],
      ["PATCH", "/api/users/admin-1"],
      ["DELETE", "/api/users/admin-1"],
      ["GET", "/api/settings/adfs"],
      ["PUT", "/api/settings/adfs"],
      ["GET", "/api/settings/ldap"],
      ["PUT", "/api/settings/ldap"],
      ["POST", "/api/settings/ldap/directory/sync"],
      ["GET", "/api/settings/ldap/directory/status"],
      ["GET", "/api/settings/ldap/directory/groups"],
      ["GET", "/api/settings/ldap/directory/computers"],
      ["POST", "/api/settings/ldap/test"],
      ["GET", "/api/settings/ssl"],
      ["PUT", "/api/settings/ssl"],
      ["GET", "/api/dashboard"],
      ["GET", "/api/clients"],
      ["DELETE", "/api/clients/inactive"],
      ["POST", "/api/clients/client-1/revoke"],
      ["POST", "/api/clients/client-1/reactivate"],
      ["GET", "/api/clients/client-1/sync-config"],
      ["GET", "/api/software"],
      ["POST", "/api/software"],
      ["PATCH", "/api/software/policy-1"],
      ["DELETE", "/api/software/policy-1"],
      ["GET", "/api/audit"],
      ["GET", "/api/settings"],
      ["PATCH", "/api/settings"],
      ["POST", "/api/settings/api-key/rotate"],
      ["POST", "/api/settings/api-key"],
      ["GET", "/api/settings/api-key"],
      ["POST", "/api/settings/api-key/reveal"],
      ["GET", "/api/settings/api-key/audit"],
    ] as const;

    for (const [method, path] of protectedRoutes) {
      await expect(request(method, path), `${method} ${path}`).resolves.toBe(401);
    }
  });
});