import { healthOf } from '@mimir/core';
import { createFileRoute } from '@tanstack/react-router';

import { BUILD_VERSION } from '../lib/build-version';

export const Route = createFileRoute('/health')({
  server: {
    handlers: {
      GET: () =>
        Response.json(healthOf(BUILD_VERSION), { headers: { 'cache-control': 'no-store' } }),
    },
  },
});
