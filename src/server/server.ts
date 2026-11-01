import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMessage, type ServerMessage } from "./protocol";
import { RoomService, type Connection, type ServiceOptions } from "./rooms";
import { createStaticHandler } from "./static";

export interface ServerOptions {
  port: number;
  host?: string;
  /** Directory of the built web app to serve (omit to run the API only). */
  staticDir?: string;
  /** Milliseconds between game ticks / snapshot pushes. */
  tickMs?: number;
  service?: RoomService;
  serviceOptions?: ServiceOptions;
  /** Extra image hosts for the CSP (custom map tile providers). */
  extraImgSrc?: readonly string[];
  /** Max simultaneous WebSocket connections from one address. */
  maxConnectionsPerIp?: number;
  /**
   * Browser origins allowed to open a WebSocket besides the page's own host
   * (e.g. https://play.example.com). Requests with a foreign Origin are refused.
   */
  allowedOrigins?: readonly string[];
  /** Read the client address from X-Forwarded-For (set this behind a proxy such as Fly.io or Render). */
  trustProxy?: boolean;
}

/** Decide whether a browser WebSocket handshake may proceed. No Origin (a non-browser client) is fine. */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[] = [],
): boolean {
  if (!origin) return true;
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export interface RunningServer {
  port: number;
  service: RoomService;
  close(): Promise<void>;
}

const MAX_PAYLOAD_BYTES = 8 * 1024;
const MAX_MESSAGES_PER_SECOND = 20;
const HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 30;

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const service = opts.service ?? new RoomService(opts.serviceOptions);

  const serveStatic = opts.staticDir ? createStaticHandler(opts.staticDir, { extraImgSrc: opts.extraImgSrc ?? [] }) : null;

  const http: Server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url?.startsWith("/ws")) {
      res.writeHead(426, { "content-type": "text/plain" });
      res.end("WebSocket upgrade required");
      return;
    }
    if (serveStatic?.(req, res)) return;
    res.writeHead(404);
    res.end();
  });

  const perIp = new Map<string, number>();
  const maxPerIp = opts.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
  const clientIp = (req: IncomingMessage): string => {
    if (opts.trustProxy) {
      const fwd = req.headers["x-forwarded-for"];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  const wss = new WebSocketServer({
    server: http,
    path: "/ws",
    maxPayload: MAX_PAYLOAD_BYTES,
    verifyClient: (info, done) => {
      if (!originAllowed(info.origin || undefined, info.req.headers.host, opts.allowedOrigins))
        return done(false, 403, "Origin not allowed");
      if ((perIp.get(clientIp(info.req)) ?? 0) >= maxPerIp) return done(false, 429, "Too many connections");
      done(true);
    },
  });
  const alive = new WeakSet<WebSocket>();

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const ip = clientIp(req);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    ws.once("close", () => {
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    });
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));

    const conn: Connection = {
      send(msg: ServerMessage) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close() {
        ws.close(1000, "closed");
      },
    };

    // Simple token bucket: a misbehaving client is disconnected, not served.
    let bucket = MAX_MESSAGES_PER_SECOND;
    let lastRefill = Date.now();

    ws.on("message", (data, isBinary) => {
      const t = Date.now();
      bucket = Math.min(
        MAX_MESSAGES_PER_SECOND,
        bucket + ((t - lastRefill) / 1000) * MAX_MESSAGES_PER_SECOND,
      );
      lastRefill = t;
      if (bucket < 1) {
        ws.close(1008, "rate limit");
        return;
      }
      bucket -= 1;

      if (isBinary) {
        conn.send({ t: "error", code: "bad_message", message: "Text messages only." });
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        conn.send({ t: "error", code: "bad_message", message: "Invalid JSON." });
        return;
      }
      const parsed = parseClientMessage(json);
      if (!parsed.ok) {
        conn.send({ t: "error", code: "bad_message", message: parsed.message });
        return;
      }
      service.handle(conn, parsed.msg);
    });

    ws.on("close", () => service.disconnect(conn));
    ws.on("error", () => service.disconnect(conn));
  });

  const tick = setInterval(() => service.tick(), opts.tickMs ?? 1000);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host, () => {
      const port = (http.address() as AddressInfo).port;
      resolve({
        port,
        service,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(tick);
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => http.close(() => done()));
          }),
      });
    });
  });
}
