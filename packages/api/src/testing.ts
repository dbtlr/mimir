import type { Store } from '@mimir/core';
import type { Server } from 'bun';

import { createApiHandler } from './api';
import type { ApiOptions } from './api';

/**
 * Serve the API handler on an ephemeral loopback port, so a test drives it
 * with real `fetch` requests. The caller stops the returned server.
 */
export function serveApi(store: Store, opts: ApiOptions): Server<undefined> {
  return Bun.serve({ fetch: createApiHandler(store, opts), hostname: '127.0.0.1', port: 0 });
}
