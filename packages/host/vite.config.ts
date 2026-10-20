import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig, domSetup, testReact } from '@dbtlr/tooling';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { searchForWorkspaceRoot } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { WELL_900 } from './src/lib/theme-colors.ts';

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
 * The PWA layer is app-shell only — precache the shell so the installed app
 * always opens; data freshness is TanStack Query's job, never the service
 * worker's.
 */
// VitePWA is a plugin factory, despite its third-party name.
// oxlint-disable-next-line new-cap
const pwaPlugins = VitePWA({
  injectRegister: null,
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
  outDir: '.output/public',
  registerType: 'prompt',
  workbox: {
    // Keep these explicit: brace expansion is dependency-sensitive and a
    // failed expansion silently reduced the cache to includeAssets only.
    globPatterns: ['**/*.css', '**/*.html', '**/*.js', '**/*.woff2'],
    // Server routes (the /api tombstone included) are never the app shell.
    navigateFallback: '/_shell.html',
    navigateFallbackDenylist: [/^\/(api|auth|trpc|_serverFn|health)([/?]|$)/],
  },
});
// Start writes the shell after individual environment bundles close. Defer
// Workbox to buildApp so it hashes the final shell, not an incomplete build.
for (const plugin of pwaPlugins) {
  if (plugin.name === 'vite-plugin-pwa:build') {
    plugin.closeBundle = undefined;
  }
}

export default defineConfig({
  define: {
    MIMIR_BUILD_VERSION: JSON.stringify(process.env.MIMIR_BUILD_VERSION ?? binVersion),
  },
  plugins: [
    ...(process.env.VITEST === 'true'
      ? []
      : [
          tanstackStart({
            router: { entry: './start-router.tsx', routesDirectory: './start-routes' },
            spa: { enabled: true },
          }),
          nitro({
            plugins: ['./src/server/lifecycle.ts'],
            preset: 'bun',
            // Missing chunks must not inherit the console's HTML fallback or
            // Nitro's immutable asset cache policy.
            publicAssets: [
              { baseURL: '/assets', dir: '.output/public/assets', fallthrough: false },
            ],
          }),
        ]),
    react(),
    tailwindcss(),
    domSetup(),
    ...pwaPlugins,
    {
      buildApp: {
        async handler(builder) {
          await pwaPlugins[0]?.api?.generateSW();
          // Nitro indexes public files while bundling. Refresh that index after
          // Start's shell and Workbox's worker have been written.
          const server = builder.environments.nitro;
          if (server === undefined) {
            throw new Error('Nitro build environment is missing');
          }
          await builder.build(server);
        },
        order: 'post',
      },
      enforce: 'post',
      name: 'pwa-after-start-shell',
    },
  ],
  server: {
    cors: false,
    // Start and Nitro load absolute server entries from workspace dependencies.
    fs: { allow: [searchForWorkspaceRoot(fileURLToPath(new URL('.', import.meta.url)))] },
  },
  // The driver also requires this parser from CommonJS in Start's server bundle.
  ssr: {
    noExternal: ['pg-connection-string'],
    optimizeDeps: { include: ['pg-connection-string'] },
  },
  // Lint/fmt are centralized in the root vite.config; this member carries only
  // build + test. The jsdom test env comes from @dbtlr/tooling's testReact().
  test: {
    ...testReact({ setupFiles: ['./src/test/setup.ts'] }),
    exclude: [
      '**/node_modules/**',
      '**/e2e/**',
      '**/scripts/**',
      '**/src/server/**',
      '**/.output/**',
    ],
  },
});
