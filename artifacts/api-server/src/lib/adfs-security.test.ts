import { beforeEach, describe, expect, it } from "vitest";
import {
  decodeAdfsState,
  encodeAdfsState,
  safeLocalReturnTo,
} from "./adfs-security";

describe("AD FS state protection", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-session-secret";
  });

  it("round trips a signed state and rejects tampering or expiry", () => {
    const state = encodeAdfsState({
      state: "state-value",
      nonce: "nonce-value",
      codeVerifier: "verifier-value",
      returnTo: "/requests/4?tab=history#comments",
    }, 100);
    expect(decodeAdfsState(state, 101)?.returnTo).toBe("/requests/4?tab=history#comments");
    expect(decodeAdfsState(`${state}x`, 101)).toBeNull();
    expect(decodeAdfsState(state, 701)).toBeNull();
  });
});

describe("local AD FS return targets", () => {
  it("preserves valid paths, queries, and fragments", () => {
    expect(safeLocalReturnTo("/changes/123?tab=history#details")).toBe("/changes/123?tab=history#details");
  });

  it.each([
    "https://evil.example/",
    "//evil.example/path",
    "/\\evil.example",
    "/%0d%0aLocation:%20evil",
    "javascript:alert(1)",
    "not-a-path",
  ])("falls back for unsafe target %s", (target) => {
    expect(safeLocalReturnTo(target)).toBe("/");
  });
});