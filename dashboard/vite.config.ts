// `vitest/config` re-exports vite's defineConfig with the `test` key typed.
// Importing it from "vite" type-errors on `test`, and a separate
// vitest.config.ts would duplicate the `@` alias — which is the kind of
// two-copies-of-one-fact that drifts.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const DEV_HUB = process.env.TRAINWATCH_DEV_HUB ?? "https://killerx8143.tail1f999f.ts.net";

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
  test: {
    // `scripts/sw-routing.test.mjs` is a `node:test` file that loads the
    // service worker into a `node:vm` sandbox. vitest would collect it by
    // filename and fail on the unfamiliar runner, so the two suites are kept
    // apart — `npm test` runs both in sequence.
    include: ["src/**/*.test.ts"],
  },
  server: {
    port: 5173,
    // The hub moved to the TUF, so `127.0.0.1:8730` is nothing now — and a
    // dead proxy target does not present as an error: `whoami` fails, the
    // client resolves its boot state as "open", and the dashboard shows the
    // no-accounts banner over a box that has an account. Development against a
    // hub that appears unenrolled is development against the wrong posture.
    //
    // Override with TRAINWATCH_DEV_HUB to point at a local hub again.
    proxy: {
      "/api": { target: DEV_HUB, changeOrigin: true, secure: false },
      "/healthz": { target: DEV_HUB, changeOrigin: true, secure: false },
    },
  },
});
