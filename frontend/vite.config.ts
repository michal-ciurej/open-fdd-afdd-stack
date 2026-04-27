import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import type { IncomingMessage } from "http";

const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:8000";

const apiRoutes = [
  "/api",
  "/ai",
  "/sites",
  "/equipment",
  "/points",
  "/timeseries",
  "/faults",
  "/run-fdd",
  "/download",
  "/capabilities",
  "/config",
  "/data-model",
  "/entities",
  "/jobs",
  "/bacnet",
  "/niagara",
  "/analytics",
  "/energy-calculations",
  "/health",
  "/docs",
  "/redoc",
  "/openapi.json",
  "/rules",
];

/** React routes whose path starts with `/data-model` but are not API paths under `/data-model/*`. */
const DATA_MODEL_SPA_ROUTE_PREFIXES = ["/data-model-engineering", "/data-model-testing"] as const;

/** Serve the SPA for browser navigation; proxy only fetch/XHR to the API. */
function spaBypass(req: IncomingMessage) {
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (
    DATA_MODEL_SPA_ROUTE_PREFIXES.some(
      (p) => path === p || path.startsWith(`${p}/`),
    )
  ) {
    return "/index.html";
  }
  if (req.headers.accept?.includes("text/html")) {
    return "/index.html";
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["localhost", ".local"],
    proxy: {
      ...Object.fromEntries(
        apiRoutes.map((r) => [r, { target: apiTarget, bypass: spaBypass }]),
      ),
      "/ws": { target: apiTarget, ws: true },
    },
  },
});
