// App entry, not a vitest test body.
// oxlint-disable vitest/require-hook
// side-effect import: global stylesheet
// oxlint-disable-next-line import/no-unassigned-import
import './styles.css';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { CACHE_MAX_AGE_MS, createQueryClient } from './api/query-client';
import { persister, shouldPersistQuery } from './lib/persist';
import { router } from './router';

const queryClient = createQueryClient();

const root = document.getElementById('root');
if (root === null) {
  throw new Error('no #root element');
}

createRoot(root).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        // Persisted-cache schema version. RULE: ANY change to the persisted
        // shape of a query (its queryKey shape, or its data shape — e.g. a
        // plain query becoming an infinite `{ pages, pageParams }` one) MUST
        // bump this. A stale-shape warm cache restored into the new code
        // crashes the route before app code runs; bumping drops the old cache
        // on restore. See persist.ts for the shape guard behind this.
        buster: 'mimir-ui-v4',
        // see shouldPersistQuery — the default would erase the offline
        // cache exactly as the server dies
        dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
        maxAge: CACHE_MAX_AGE_MS,
        persister,
      }}
    >
      <RouterProvider router={router} />
    </PersistQueryClientProvider>
  </StrictMode>,
);
