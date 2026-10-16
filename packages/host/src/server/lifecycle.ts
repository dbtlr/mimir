import { definePlugin } from 'nitro';

import { closeHost, hostRuntime } from './runtime';

async function startHost() {
  try {
    await hostRuntime();
  } catch (error) {
    console.error('host: cannot open a writable SQLite store under MIMIR_DATA_DIR', error);
    process.exit(1);
  }
}

export default definePlugin((app) => {
  // A build prerenders only the document; it must never create or read a store.
  if (process.env.TSS_PRERENDERING === 'true') {
    return;
  }
  // Nitro does not await async plugins. Gate every response on the open and
  // terminate explicitly rather than leave a listener with a rejected store.
  const ready = startHost();
  const fetch = app.fetch;
  app.fetch = async (...args: Parameters<typeof fetch>) => {
    await ready;
    return fetch(...args);
  };
  app.hooks.hook('close', closeHost);
});
