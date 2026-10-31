import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./server";

const port = Number(process.env.PORT ?? 8080);
const builtApp = fileURLToPath(new URL("../../web/dist", import.meta.url));
const staticDir = process.env.STATIC_DIR ?? (existsSync(builtApp) ? builtApp : undefined);

startServer({ port, ...(staticDir ? { staticDir } : {}) }).then((server) => {
  console.log(
    `LocalGrounds listening on :${server.port} (ws /ws, health /healthz, ` +
      `${staticDir ? `web app from ${staticDir}` : "no web app built: run npm run web:build"})`,
  );
  const stop = () => {
    console.log("Shutting down...");
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
});
