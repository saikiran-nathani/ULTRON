import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    // Built straight into the Python package so the training box never needs
    // Node. This directory is committed; CI fails if it goes stale.
    outDir: path.resolve(__dirname, "../src/trainwatch/server/static"),
    emptyOutDir: true,
    // The iPad may load this over cellular through Tailscale — keep it small
    // and in one chunk rather than paying extra round-trips.
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8730", changeOrigin: true },
      "/healthz": { target: "http://127.0.0.1:8730", changeOrigin: true },
    },
  },
});
