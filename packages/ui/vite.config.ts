import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

/**
 * The console build (ADR 0013): a static SPA whose `dist/` output is embedded
 * in the mimir binary and served by `mimir serve`. The PWA layer is app-shell
 * only — precache the shell so the installed app always opens; data freshness
 * is TanStack Query's job, never the service worker's.
 */
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/mimir.svg", "icons/mimir-maskable.svg"],
      manifest: {
        name: "Mimir",
        short_name: "Mimir",
        description: "Operator console — work state across every project",
        theme_color: "#0a0e16",
        background_color: "#0a0e16",
        display: "standalone",
        icons: [
          { src: "/icons/mimir.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          {
            src: "/icons/mimir-maskable.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,woff2,webmanifest}"],
        // The API is never the app shell — let /api/* hit the network/server.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
