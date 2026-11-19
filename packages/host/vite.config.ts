import { fileURLToPath } from 'node:url';

import { defineConfig, domSetup, testReact } from '@dbtlr/tooling';
import { VERSION } from '@mimir/cli/src/version';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { build as viteBuild, searchForWorkspaceRoot } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { WELL_900, WELL_950 } from './src/lib/theme-colors.ts';

const PUSH_WORKER_FILE = 'sw-push.js';

/**
 * Compile the worker's push handlers to one classic script in the public
 * output, for the generated worker to import. It runs before Workbox so the
 * precache lists the file.
 */
async function buildPushWorker(): Promise<void> {
  await viteBuild({
    build: {
      emptyOutDir: false,
      lib: {
        entry: fileURLToPath(new URL('src/sw/push-entry.ts', import.meta.url)),
        fileName: () => PUSH_WORKER_FILE,
        formats: ['iife'],
        name: 'MimirPushWorker',
      },
      outDir: '.output/public',
      sourcemap: false,
    },
    configFile: false,
    publicDir: false,
  });
}

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
    theme_color: WELL_950.dark,
  },
  outDir: '.output/public',
  registerType: 'prompt',
  workbox: {
    // Keep these explicit: brace expansion is dependency-sensitive and a
    // failed expansion silently reduced the cache to includeAssets only.
    globPatterns: ['**/*.css', '**/*.html', '**/*.js', '**/*.woff2'],
    // The push and notificationclick handlers (MMR-710), compiled to the
    // public root by buildPushWorker. importScripts is not a navigation, so
    // navigateFallback never touches it, and the precache keeps it versioned.
    importScripts: [PUSH_WORKER_FILE],
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
    // The bundle-side twin of the binary's release version (MMR-57): the host
    // image's build arg carries the tag's version into `build:ui`, and the
    // release workflow stamps the same tag into packages/cli/package.json
    // before the binary compile, so a tagged build reports one version on both
    // sides. A local, dev, or PR build falls back to the CLI's untagged
    // version, so an un-stamped bundle and CLI sit inside each other's window.
    MIMIR_BUILD_VERSION: JSON.stringify(process.env.MIMIR_BUILD_VERSION ?? VERSION),
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
          await buildPushWorker();
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
  // vmThreads reuses each worker, so jsdom and external modules load once per
  // worker, while each file still gets a fresh jsdom window in its own VM
  // context. vm-globals.ts fills the web-stream globals that context lacks, and
  // global-setup.ts pins the time zone in the main process (CONTRIBUTING.md).
  test: {
    ...testReact({ setupFiles: ['./src/test/vm-globals.ts', './src/test/setup.ts'] }),
    exclude: [
      '**/node_modules/**',
      '**/e2e/**',
      '**/scripts/**',
      '**/src/server/**',
      '**/src/admin/**',
      '**/.output/**',
    ],
    globalSetup: ['./src/test/global-setup.ts'],
    pool: 'vmThreads',
  },
});
