import { createReadStream, statSync, type Stats } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/** Map tiles come from OpenStreetMap; fonts from Google Fonts; everything else is same-origin. */
/** Tile hosts the built-in map presets use; add your own with EXTRA_IMG_SRC. */
const TILE_HOSTS = [
  "https://tile.openstreetmap.org",
  "https://*.tile.openstreetmap.org",
  "https://server.arcgisonline.com",
  "https://services.arcgisonline.com",
  "https://api.maptiler.com",
  "https://tiles.stadiamaps.com",
];

export function buildContentSecurityPolicy(extraImgSrc: readonly string[] = []): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    `img-src 'self' data: ${[...TILE_HOSTS, ...extraImgSrc].join(" ")}`,
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const CONTENT_SECURITY_POLICY = buildContentSecurityPolicy();

const tryStat = (p: string): Stats | null => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

function end(res: ServerResponse, status: number): true {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(status === 404 ? "Not found" : "");
  return true;
}

/**
 * Serves a built single-page app. Returns true when it handled the request.
 * Unknown extension-less paths fall back to index.html (client-side routing);
 * missing files with an extension are real 404s. Path traversal is refused.
 */
export function createStaticHandler(rootDir: string, opts: { extraImgSrc?: readonly string[] } = {}) {
  const csp = buildContentSecurityPolicy(opts.extraImgSrc);
  const root = resolve(rootDir);

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      return end(res, 400);
    }
    if (pathname.includes("\0")) return end(res, 400);

    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) return end(res, 403);

    let st = tryStat(file);
    if (st?.isDirectory()) {
      file = join(file, "index.html");
      st = tryStat(file);
    }
    if (!st?.isFile()) {
      if (extname(pathname)) return end(res, 404);
      file = join(root, "index.html");
      st = tryStat(file);
      if (!st?.isFile()) return end(res, 404);
    }

    const ext = extname(file).toLowerCase();
    const isAsset = file.startsWith(join(root, "assets") + sep);
    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "content-length": st.size,
      "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "permissions-policy": "geolocation=(self), camera=(), microphone=()",
      "content-security-policy": csp,
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
    return true;
  };
}
