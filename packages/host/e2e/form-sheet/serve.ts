import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { VERSION } from '@mimir/cli/src/version.ts';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import type { Plugin } from 'vite';

const HARNESS = fileURLToPath(new URL('.', import.meta.url));
const WORKSPACE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

const PWA_REGISTER = 'virtual:pwa-register';

/** A server-function module (`src/api/fns`), which imports the host's server code. */
const SERVER_FNS = /\/src\/api\/fns\/[^/]+\.ts$/u;

/** The names a module exports as values: `export const x` and `export (async) function x`. */
const VALUE_EXPORT = /^export (?:const|(?:async )?function) (\w+)/gmu;

/**
 * Stands in for the host beneath the console, so a page can import a
 * component that reads it (the shell's sidebar and alert): each server
 * function becomes one that fails, and the PWA plugin's registration module,
 * which the router's imports reach, does nothing. The page seeds the reads
 * it needs into its query cache.
 */
function noHost(): Plugin {
  return {
    async load(id) {
      if (id === `\0${PWA_REGISTER}`) {
        return 'export function registerSW() { return () => Promise.resolve(); }';
      }
      if (!SERVER_FNS.test(id)) {
        return undefined;
      }
      const source = await readFile(id, 'utf8');
      return [...source.matchAll(VALUE_EXPORT)]
        .map(
          ([, name]) =>
            `export const ${name} = () => Promise.reject(new Error('the harness has no host'));`,
        )
        .join('\n');
    },
    name: 'harness-no-host',
    resolveId(source) {
      return source === PWA_REGISTER ? `\0${PWA_REGISTER}` : undefined;
    },
  };
}

/** A running harness: its origin, and how to stop it. */
export type Harness = { origin: string; close: () => Promise<void> };

/**
 * Serves the Form sheet harness (this directory) from a Vite dev server on a
 * free port, with the console's own Tailwind build, so a check runs the real
 * forms in Chromium.
 */
export async function serveHarness(): Promise<Harness> {
  const server = await createServer({
    configFile: false,
    // The console's build stamp (vite.config.ts), which the version footer reads.
    define: { MIMIR_BUILD_VERSION: JSON.stringify(VERSION) },
    logLevel: 'error',
    // The server functions are stubbed (noHost), so nothing loads the Start
    // runtime; pre-bundling it would follow its server entry and fail.
    optimizeDeps: { exclude: ['@tanstack/react-start'] },
    plugins: [react(), tailwindcss(), noHost()],
    root: HARNESS,
    // The harness imports the console's sources and the workspace's packages.
    server: { fs: { allow: [WORKSPACE_ROOT] }, host: '127.0.0.1' },
  });
  await server.listen(0);
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    await server.close();
    throw new Error('the harness server has no port');
  }
  return {
    close: () => server.close(),
    origin: `http://127.0.0.1:${String(address.port)}/`,
  };
}
