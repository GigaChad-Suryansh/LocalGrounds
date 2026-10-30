import { startServer } from "./server";

const port = Number(process.env.PORT ?? 8080);

startServer({ port }).then((server) => {
  console.log(`LocalGrounds server listening on :${server.port} (ws path /ws, health /healthz)`);
  const stop = () => {
    console.log("Shutting down...");
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
});
