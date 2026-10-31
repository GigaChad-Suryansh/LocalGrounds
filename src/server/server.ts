import { createServer, type Server } from "node:http";
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
}

export interface RunningServer {
  port: number;
  service: RoomService;
  close(): Promise<void>;
}

const MAX_PAYLOAD_BYTES = 8 * 1024;
const MAX_MESSAGES_PER_SECOND = 20;
const HEARTBEAT_MS = 15_000;

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const service = opts.service ?? new RoomService(opts.serviceOptions);

  const serveStatic = opts.staticDir ? createStaticHandler(opts.staticDir) : null;

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

  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: MAX_PAYLOAD_BYTES });
  const alive = new WeakSet<WebSocket>();

  wss.on("connection", (ws: WebSocket) => {
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
