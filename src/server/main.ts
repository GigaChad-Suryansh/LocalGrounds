import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./server";

const port = Number(process.env.PORT ?? 8080);
const builtApp = fileURLToPath(new URL("../../web/dist", import.meta.url));
const staticDir = process.env.STATIC_DIR ?? (existsSync(builtApp) ? builtApp : undefined);

const list = (v: string | undefined): string[] => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

startServer({
  port,
  host: process.env.HOST ?? "0.0.0.0",
  ...(staticDir ? { staticDir } : {}),
  extraImgSrc: list(process.env.EXTRA_IMG_SRC),
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),
  trustProxy: process.env.TRUST_PROXY === "1",
  ...(process.env.MAX_CONNECTIONS_PER_IP ? { maxConnectionsPerIp: Number(process.env.MAX_CONNECTIONS_PER_IP) } : {}),
}).then((server) => {
  console.log(
    `LocalGrounds listening on :${server.port} (ws /ws, health /healthz, ` +
      `${staticDir ? `web app from ${staticDir}` : "no web app built: run npm run web:build"})`,
  );
  // One line a minute so a host's log view shows load. Never includes names or locations.
  setInterval(() => console.log(JSON.stringify({ at: new Date().toISOString(), ...server.service.stats() })), 60_000).unref();
  const stop = () => {
    console.log("Shutting down...");
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
});
