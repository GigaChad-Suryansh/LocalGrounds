import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));
const backend = process.env.LG_BACKEND ?? "localhost:8080";

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/ws": { target: `ws://${backend}`, ws: true },
      "/healthz": `http://${backend}`,
    },
  },
});
