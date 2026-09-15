import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  clearLoginFailures,
  loginLockout,
  recordLoginFailure,
} from "./login-security";

function request(ip: string): Request {
  return { ip } as Request;
}

describe("progressive login lockout", () => {
  it("allows normal attempts and progressively locks repeated failures", () => {
    const req = request("192.0.2.10");
    clearLoginFailures(req, "lockout-test");
    expect(loginLockout(req, "lockout-test")).toBe(0);
    for (let index = 0; index < 4; index += 1) {
      recordLoginFailure(req, "lockout-test");
      expect(loginLockout(req, "lockout-test")).toBe(0);
    }
    recordLoginFailure(req, "lockout-test");
    expect(loginLockout(req, "lockout-test")).toBeGreaterThan(0);
    clearLoginFailures(req, "lockout-test");
    expect(loginLockout(req, "lockout-test")).toBe(0);
  });
});