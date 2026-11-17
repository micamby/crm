import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/** Copies src/app-routes.json (the app's top-level routes) into the build, where the server reads it to know which paths get the HTML shell. */
function appRoutes(): Plugin {
  return {
    name: "hlcrm-app-routes",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "app-routes.json", source: readFileSync(fileURLToPath(new URL("./src/app-routes.json", import.meta.url)), "utf8") });
    },
  };
}

/**
 * Development: `pnpm dev` serves the app on :5173 and forwards /v1 and /auth to the API (API_URL,
 * default http://localhost:8787). Start the API with PUBLIC_URL=http://localhost:5173 so its cookies
 * and CSRF origin checks match the page (see README.md).
 */
const api = process.env.API_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss(), appRoutes()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/v1": { target: api }, "/auth": { target: api }, "/openapi.json": { target: api } },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
    // The shell (React, the router, the query cache, dialogs and menus) is about 560 kB, 180 kB gzipped; pages load on demand.
    chunkSizeWarningLimit: 600,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    css: false,
  },
});
