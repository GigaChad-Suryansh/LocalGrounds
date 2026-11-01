import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { originAllowed, startServer, type RunningServer } from "../src/server";
import { tileSpec } from "../web/src/map/tiles";
import { buildContentSecurityPolicy } from "../src/server/static";

let server: RunningServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const open = (url: string, headers: Record<string, string> = {}) =>
  new Promise<{ ok: boolean; status?: number; ws?: WebSocket }>((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve({ ok: true, ws }));
    ws.once("unexpected-response", (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.once("error", () => resolve({ ok: false }));
  });

describe("origin check", () => {
  it("accepts same-host browsers, listed origins and non-browser clients; refuses others", () => {
    expect(originAllowed(undefined, "play.example.com")).toBe(true);
    expect(originAllowed("https://play.example.com", "play.example.com")).toBe(true);
    expect(originAllowed("https://evil.example.net", "play.example.com")).toBe(false);
    expect(originAllowed("https://app.example.org", "play.example.com", ["https://app.example.org"])).toBe(true);
    expect(originAllowed("not a url", "play.example.com")).toBe(false);
  });

  it("refuses a WebSocket handshake from a foreign origin", async () => {
    server = await startServer({ port: 0, host: "127.0.0.1" });
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const bad = await open(url, { origin: "https://evil.example.net" });
    expect(bad).toMatchObject({ ok: false, status: 403 });
    const good = await open(url, { origin: `http://127.0.0.1:${server.port}` });
    expect(good.ok).toBe(true);
    good.ws?.close();
  });
});

describe("per-address connection limit", () => {
  it("refuses connections beyond the limit and frees the slot when one closes", async () => {
    server = await startServer({ port: 0, host: "127.0.0.1", maxConnectionsPerIp: 2 });
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const a = await open(url);
    const b = await open(url);
    expect(a.ok && b.ok).toBe(true);
    expect(await open(url)).toMatchObject({ ok: false, status: 429 });
    a.ws?.close();
    await new Promise((r) => setTimeout(r, 100));
    const c = await open(url);
    expect(c.ok).toBe(true);
    b.ws?.close();
    c.ws?.close();
  });

  it("counts clients by X-Forwarded-For only when told to trust the proxy", async () => {
    server = await startServer({ port: 0, host: "127.0.0.1", maxConnectionsPerIp: 1, trustProxy: true });
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const a = await open(url, { "x-forwarded-for": "203.0.113.5" });
    const b = await open(url, { "x-forwarded-for": "203.0.113.6" }); // a different real client
    const c = await open(url, { "x-forwarded-for": "203.0.113.5" });
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, false]);
    a.ws?.close();
    b.ws?.close();
  });
});

describe("map tiles", () => {
  it("defaults to satellite imagery with labels", () => {
    const t = tileSpec({});
    expect(t.kind).toBe("satellite");
    expect(t.url).toContain("World_Imagery");
    expect(t.labelsUrl).toContain("World_Boundaries_and_Places");
    expect(t.attribution).toContain("Esri");
  });

  it("can switch to streets, hide labels, or use a custom keyed provider", () => {
    expect(tileSpec({ VITE_TILE_STYLE: "streets" }).url).toContain("openstreetmap");
    expect(tileSpec({ VITE_TILE_LABELS: "off" }).labelsUrl).toBeNull();
    const custom = tileSpec({ VITE_TILE_URL: "https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}", VITE_TILE_KEY: "a b" });
    expect(custom.url).toBe("https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=a%20b");
    expect(custom.labelsUrl).toBeNull();
  });

  it("allows the tile hosts in the CSP, plus any extra host", () => {
    const csp = buildContentSecurityPolicy(["https://tiles.example.com"]);
    expect(csp).toContain("https://server.arcgisonline.com");
    expect(csp).toContain("https://tiles.example.com");
    expect(csp).toContain("script-src 'self'");
  });
});
