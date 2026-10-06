import { readFileSync } from 'node:fs';

import { defineConfig, domSetup, testReact } from '@dbtlr/tooling';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

import { DEV_PORT, parsePort } from '../helpers/src/ports.ts';
import { injectThemeColorMeta, WELL_900 } from './src/lib/theme-colors.ts';

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
 * The dev loop's API (MMR-426): `vite dev` forwards `/api` to a running
 * from-source `mimir serve`, so the console stays same-origin and the daemon
 * grants no CORS. The port follows the daemon's own knob — `MIMIR_PORT`, else
 * its dev default.
 */
const devApi = `http://127.0.0.1:${String(parsePort(process.env.MIMIR_PORT ?? '') ?? DEV_PORT)}`;

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
    domSetup(),
    // VitePWA is a plugin factory, not a constructor (third-party naming)
    // oxlint-disable-next-line new-cap
    VitePWA({
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
      registerType: 'prompt',
      workbox: {
        // Keep these explicit: brace expansion is dependency-sensitive and a
        // failed expansion silently reduced the cache to includeAssets only.
        globPatterns: ['**/*.css', '**/*.html', '**/*.js', '**/*.woff2'],
        // The API is never the app shell — let /api/* hit the network/server.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
    // The meta theme-color is a pre-hydration fallback (useTheme reconciles it
    // on mount, MMR-254) — inject it here so it still has one source.
    { name: 'meta-theme-color', transformIndexHtml: injectThemeColorMeta },
  ],
  // No CORS on the dev server either: Vite's default admits every localhost
  // origin, which would reopen the proxied API to other loopback pages. The
  // proxy must keep the browser's Host (the string shorthand rewrites it to the
  // target), or the daemon reads every console write as cross-origin.
  server: { cors: false, proxy: { '/api': { changeOrigin: false, target: devApi } } },
  // Lint/fmt are centralized in the root vite.config; this member carries only
  // build + test. The jsdom test env comes from @dbtlr/tooling's testReact().
  test: testReact({ setupFiles: ['./src/test/setup.ts'] }),
});
