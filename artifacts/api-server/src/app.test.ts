import { describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import app from "./app";

function requestWithForwardedFor(forwardedFor: string): Promise<{ ip: string }> {
  const probe = express();
  // Use the production app's proxy setting so this regression test cannot
  // silently drift from the actual sidecar configuration.
  probe.set("trust proxy", app.get("trust proxy"));
  probe.get("/", (req, res) => res.json({ ip: req.ip }));
  return new Promise((resolve, reject) => {
    const server = probe.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Probe server did not expose a TCP address."));
        return;
      }
      const request = http.request({
        host: "127.0.0.1",
        port: address.port,
        path: "/",
        headers: { "X-Forwarded-For": forwardedFor },
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => {
          server.close((error) => {
            if (error) reject(error);
            else {
              try {
                resolve(JSON.parse(body) as { ip: string });
              } catch (parseError) {
                reject(parseError);
              }
            }
          });
        });
      });
      request.on("error", (error) => {
        server.close();
        reject(error);
      });
      request.end();
    });
  });
}

describe("sidecar proxy identity", () => {
  it("does not allow the leftmost forwarded address to control req.ip", async () => {
    expect(app.get("trust proxy")).toBe(1);
    const result = await requestWithForwardedFor("198.51.100.77, 203.0.113.9");
    expect(result.ip).toBe("203.0.113.9");
    expect(result.ip).not.toBe("198.51.100.77");
  });
});