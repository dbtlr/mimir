import { QueryClient } from '@tanstack/react-query';

import { POLL_MS } from './queries';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The persisted cache's lifetime: the persister's `maxAge` and every query's `gcTime`. */
export const CACHE_MAX_AGE_MS = 7 * DAY_MS;

/** The console's query client: polling is how it sees writes made elsewhere. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // must not undercut the persister's maxAge, or restored cache is GC'd
        gcTime: CACHE_MAX_AGE_MS,
        // Polling is the liveness model; intervals pause while the tab is
        // hidden (refetchIntervalInBackground stays false) and refetch fires
        // on focus/reconnect — the auto-heal after an offline stretch.
        refetchInterval: POLL_MS,
        retry: 1,
        staleTime: 5_000,
      },
    },
  });
}
