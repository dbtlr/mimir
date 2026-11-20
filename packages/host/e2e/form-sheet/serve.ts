import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

const HARNESS = fileURLToPath(new URL('.', import.meta.url));
const WORKSPACE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

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
    logLevel: 'error',
    plugins: [react(), tailwindcss()],
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
