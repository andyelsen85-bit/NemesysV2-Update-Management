import { describe, expect, it } from "vitest";
import {
  hashPassword,
  localLoginMustChangePassword,
  isLocalAuthSource,
  passwordChangeSessionState,
  shouldBlockForPasswordChange,
  verifyPassword,
} from "./auth";

describe("forced password-change authentication helpers", () => {
  it("blocks every administrator route except the recovery-safe routes", () => {
    expect(shouldBlockForPasswordChange("/dashboard")).toBe(true);
    expect(shouldBlockForPasswordChange("/settings")).toBe(true);
    expect(shouldBlockForPasswordChange("/me")).toBe(false);
    expect(shouldBlockForPasswordChange("/password")).toBe(false);
  });

  it("propagates the local account flag into session-visible state", () => {
    expect(localLoginMustChangePassword(true, true)).toBe(true);
    expect(localLoginMustChangePassword(false, true)).toBe(false);
    expect(localLoginMustChangePassword(true, false)).toBe(false);
    expect(passwordChangeSessionState(true)).toEqual({ mustChangePassword: true });
    expect(passwordChangeSessionState(false)).toEqual({ mustChangePassword: false });
  });

  it("only exposes forced-change state to local-auth sessions", () => {
    expect(isLocalAuthSource("local")).toBe(true);
    expect(isLocalAuthSource("ldap")).toBe(false);
    expect(isLocalAuthSource("adfs")).toBe(false);
    expect(isLocalAuthSource(undefined)).toBe(false);
  });

  it("verifies the bootstrap password without storing plaintext", async () => {
    const hash = await hashPassword("change-me-now");
    expect(await verifyPassword("change-me-now", hash)).toBe(true);
    expect(await verifyPassword("different-password", hash)).toBe(false);
  });

  it("clears the session-visible flag after a successful password change", () => {
    const session = { mustChangePassword: true };
    Object.assign(session, passwordChangeSessionState(false));
    expect(session.mustChangePassword).toBe(false);
  });
});