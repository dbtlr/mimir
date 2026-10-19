import { acceptedHosts } from '@mimir/core';
import { definePlugin } from 'nitro';

import { hostConfig } from './config';
import { guardEveryRoute, hostGuard } from './guard';
import { closeHost, hostRuntime } from './runtime';

/** Share one readiness and guard snapshot across every dispatched route. */
async function startHost() {
  // Prerendering uses a private preview listener and needs no deployment settings.
  if (process.env.TSS_PRERENDERING === 'true') {
    return hostGuard([]);
  }
  try {
    await hostRuntime();
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
  // Nitro serves public files before Start, so guard before either dispatches.
  app.fetch = guardEveryRoute(app.fetch, startHost());
  app.hooks.hook('close', closeHost);
});
