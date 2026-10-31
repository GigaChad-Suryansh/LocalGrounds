import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, CONTENT_SECURITY_POLICY, type RunningServer } from "../src/server";

let dir: string;
let server: RunningServer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lg-static-"));
  const root = join(dir, "dist");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(root, "assets", "app-abc123.js"), "console.log(1)");
  writeFileSync(join(root, "style.css"), "body{}");
  writeFileSync(join(dir, "secret.txt"), "TOP SECRET");
  server = await startServer({ port: 0, host: "127.0.0.1", staticDir: root });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Raw request so the path reaches the server exactly as written (fetch would normalise `..`). */
function raw(path: string, method = "GET"): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("serving the built web app", () => {
  it("serves index.html at / with security headers and no caching", async () => {
    const r = await raw("/");
    expect(r.status).toBe(200);
    expect(r.body).toContain("<title>app</title>");
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect(String(r.headers["permissions-policy"])).toContain("geolocation=(self)");
  });

  it("serves hashed assets as long-lived and typed correctly", async () => {
    const js = await raw("/assets/app-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.headers["cache-control"]).toContain("immutable");
    expect((await raw("/style.css")).headers["content-type"]).toBe("text/css; charset=utf-8");
  });

  it("falls back to the app for client-side routes but 404s missing files", async () => {
    expect((await raw("/join/ABCDE")).body).toContain("<title>app</title>");
    expect((await raw("/assets/missing.js")).status).toBe(404);
    expect((await raw("/nope.png")).status).toBe(404);
  });

  it("refuses path traversal, encoded or not, and never serves files outside the web root", async () => {
    for (const path of ["/%2e%2e/secret.txt", "/..%2fsecret.txt", "/assets/..%2f..%2fsecret.txt", "/%2e%2e%2fsecret.txt"]) {
      const r = await raw(path);
      expect(r.body, path).not.toContain("TOP SECRET");
      expect([403, 404], path).toContain(r.status);
    }
    expect((await raw("/%00")).status).toBe(400);
    expect((await raw("/%E0%A4%A")).status).toBe(400); // malformed escape
  });

  it("answers HEAD without a body and ignores other methods", async () => {
    const head = await raw("/", "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect((await raw("/", "POST")).status).toBe(404);
  });

  it("keeps the API routes working next to the app", async () => {
    expect((await raw("/healthz")).body).toBe("ok");
    expect((await raw("/ws")).status).toBe(426);
  });
});
