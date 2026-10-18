import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { CACHE_MAX_AGE_MS, createQueryClient } from './api/query-client';
import { PERSIST_BUSTER, persister, shouldPersistQuery } from './lib/persist';

/** Own the query cache per mounted console, including after Start hydration. */
export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        // Bump PERSIST_BUSTER whenever a persisted query changes shape (see its rule).
        buster: PERSIST_BUSTER,
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
