import { hostGuard } from '@mimir/api';
import { acceptedHosts } from '@mimir/core';
import { definePlugin } from 'nitro';

import { hostConfig } from './config';
import { closeHost, hostRuntime } from './runtime';

/** Share one readiness and guard snapshot across every dispatched route. */
async function startHost() {
  try {
    // Prerendering must remain data-free, but it still uses the network guards.
    if (process.env.TSS_PRERENDERING !== 'true') {
      await hostRuntime();
    }
    return hostGuard(acceptedHosts((await hostConfig()).serve));
  } catch (error) {
    console.error(
      'host: startup refused:',
      error instanceof Error ? error.message : 'store open failed',
    );
    return process.exit(1);
  }
}

export default definePlugin((app) => {
  // Nitro does not await async plugins. Gate every response on the open and
  // terminate explicitly rather than leave a listener with a rejected store.
  const ready = startHost();
  const fetch = app.fetch;
  app.fetch = async (...args: Parameters<typeof fetch>) => {
    const guard = await ready;
    // Nitro serves public files before Start, so guard before either dispatches.
    return guard(args[0]) ?? fetch(...args);
  };
  app.hooks.hook('close', closeHost);
});
