// App entry, not a vitest test body.
// oxlint-disable vitest/require-hook
// side-effect import: global stylesheet
// oxlint-disable-next-line import/no-unassigned-import
import './styles.css';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';

import { POLL_MS } from './api/queries';
import { persister, shouldPersistQuery } from './lib/persist';
import { router } from './router';

// App-shell service worker (ADR 0013 §5) — the installed app always opens.
registerSW({ immediate: true });

const DAY_MS = 24 * 60 * 60 * 1000;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // must outlive the persister's maxAge so restored cache isn't GC'd
      gcTime: 7 * DAY_MS,
      // Polling is the liveness model; intervals pause while the tab is
      // hidden (refetchIntervalInBackground stays false) and refetch fires
      // on focus/reconnect — the auto-heal after an offline stretch.
      refetchInterval: POLL_MS,
      retry: 1,
      staleTime: 5_000,
    },
  },
});

const root = document.getElementById('root');
if (root === null) {
  throw new Error('no #root element');
}

createRoot(root).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        buster: 'mimir-ui-v1',
        // see shouldPersistQuery — the default would erase the offline
        // cache exactly as the server dies
        dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
        maxAge: 7 * DAY_MS,
        persister,
      }}
    >
      <RouterProvider router={router} />
    </PersistQueryClientProvider>
  </StrictMode>,
);
