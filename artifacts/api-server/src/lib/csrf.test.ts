import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { csrfMatches, requireCsrf } from "./csrf";

function requestWith(headers: Record<string, string>, cookie?: string): Request {
  return {
    cookies: cookie ? { nemesys_csrf: cookie } : {},
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe("CSRF protection", () => {
  it("accepts a matching double-submit token", () => {
    const req = requestWith({ "x-csrf-token": "same-token" }, "same-token");
    expect(csrfMatches(req)).toBe(true);
  });

  it("rejects a missing or mismatched token", () => {
    const req = requestWith({ "x-csrf-token": "different-token" }, "same-token");
    expect(csrfMatches(req)).toBe(false);
    const response = {
      status: (status: number) => {
        expect(status).toBe(403);
        return response;
      },
      json: (body: unknown) => {
        expect(body).toEqual({ error: "A valid CSRF token is required." });
      },
    } as unknown as Response;
    expect(requireCsrf(req, response)).toBe(false);
  });
});