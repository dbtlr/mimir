import { assertPostgresAccess } from '@mimir/core';
import { DEV_PORT } from '@mimir/helpers';

import { hostConfig } from '../src/server/config';

// Keep development off the live console origin, including its PWA cache.
delete process.env.TSS_PRERENDERING;
process.env.MIMIR_PORT ??= String(DEV_PORT);
const config = await hostConfig();
if (config.store.url !== undefined) {
  assertPostgresAccess(config.store.url);
}
const vite = new URL('../node_modules/vite/bin/vite.js', import.meta.url);
process.argv = [
  process.execPath,
  vite.pathname,
  '--strictPort',
  '--port',
  String(config.port),
  ...process.argv.slice(2),
];
await import(vite.href);
