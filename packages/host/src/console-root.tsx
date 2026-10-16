import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { CACHE_MAX_AGE_MS, createQueryClient } from './api/query-client';
import { persister, shouldPersistQuery } from './lib/persist';

/** Own the query cache per mounted console, including after Start hydration. */
export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  return (
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
      {children}
    </PersistQueryClientProvider>
  );
}
