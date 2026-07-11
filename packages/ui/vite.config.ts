import { readFileSync } from 'node:fs';

import { vitestReact } from '@dbtlr/tooling/vitest';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
// `vitest/config` (not vite-plus) — it types nested plugin arrays (Plugin[][])
// and the `test` block; vite-plus's defineConfig hits TS2321 excessive-depth here.
import { defineConfig } from 'vitest/config';

import { injectThemeColorMeta, WELL_900 } from './src/lib/theme-colors';

/**
 * The bundle-side twin of `MIMIR_BUILD_VERSION` (packages/bin/src/version.ts,
 * MMR-57): release.yml exports the same env var before both `build:ui` and
 * the binary compile, so a tagged build stamps identical versions on both
 * sides. Absent that (local/dev/PR builds), fall back to the bin package's
 * version — the same fallback `version.ts` uses — so an un-stamped bundle and
 * an un-stamped daemon agree by default instead of reading as permanently stale.
 */
function readVersion(pkgPath: URL): string {
  const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version =
    typeof pkg === 'object' && pkg !== null && 'version' in pkg ? pkg.version : undefined;
  if (typeof version !== 'string') {
    throw new Error(`no "version" string in ${pkgPath.toString()}`);
  }
  return version;
}

const binVersion = readVersion(new URL('../bin/package.json', import.meta.url));

/**
 * The console build (ADR 0013): a static SPA whose `dist/` output is embedded
 * in the mimir binary and served by `mimir serve`. The PWA layer is app-shell
 * only — precache the shell so the installed app always opens; data freshness
 * is TanStack Query's job, never the service worker's.
 */
export default defineConfig({
  define: {
    MIMIR_BUILD_VERSION: JSON.stringify(process.env.MIMIR_BUILD_VERSION ?? binVersion),
  },
  plugins: [
    react(),
    tailwindcss(),
    // VitePWA is a plugin factory, not a constructor (third-party naming)
    // oxlint-disable-next-line new-cap
    VitePWA({
      includeAssets: ['icons/mimir.svg', 'icons/mimir-maskable.svg'],
      manifest: {
        background_color: WELL_900.dark,
        description: 'Operator console — work state across every project',
        display: 'standalone',
        icons: [
          { purpose: 'any', sizes: 'any', src: '/icons/mimir.svg', type: 'image/svg+xml' },
          {
            purpose: 'maskable',
            sizes: 'any',
            src: '/icons/mimir-maskable.svg',
            type: 'image/svg+xml',
          },
        ],
        name: 'Mimir',
        short_name: 'Mimir',
        theme_color: WELL_900.dark,
      },
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2,webmanifest}'],
        // The API is never the app shell — let /api/* hit the network/server.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
    // The meta theme-color is a pre-hydration fallback (useTheme reconciles it
    // on mount, MMR-254) — inject it here so it still has one source.
    { name: 'meta-theme-color', transformIndexHtml: injectThemeColorMeta },
  ],
  // Lint/fmt are centralized in the root vite.config; this member carries only
  // build + test. The jsdom test env comes from @dbtlr/tooling's vitestReact().
  ...vitestReact({ setupFiles: ['./src/test/setup.ts'] }),
});
