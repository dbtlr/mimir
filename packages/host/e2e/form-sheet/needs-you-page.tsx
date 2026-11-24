import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { useEffect } from 'react';

import { reviewQuery } from '../../src/api/view-queries';
import { PreviewRoomProvider } from '../../src/components/patterns/feed/preview-room';
import { NeedsYouPage } from '../../src/routes/needs-you';
import { ShellColumns } from '../../src/routes/shell';
import { blocked, decision, question, report, stopped } from '../../src/test/needs-you-fixtures';

/** The rows, in their first queue order. */
const ROWS = [
  stopped('FLT-d2', { reason: 'Stopped by its time cap after 4 hours.' }),
  question('MMR-731'),
  decision('FLT-q1', { delivery: 'FLT-d2' }),
  decision('FLT-q2', { delivery: 'FLT-d2' }),
  blocked('MMR-688'),
  question('LM-640'),
  decision('MMR-q41', {}),
  blocked('LM-571'),
];

const rowId = (row: (typeof ROWS)[number]) => {
  if (row.kind === 'task') {
    return row.task.id;
  }
  return row.kind === 'decision' ? row.decision.id : row.delivery.id;
};

const NAMES = { FLT: 'Fleet', LM: 'Loom CLI', MMR: 'Mimir' };

/** Seven cards in three projects, enough to scroll a phone's page under the bar. */
const REPORT = report(ROWS, { names: NAMES });

/** `&late`: the review read lands after the page mounts, as on a cold load. */
const late = new URLSearchParams(globalThis.location.search).has('late');

/** How long the `&late` read takes to land. */
const LATE_MS = 300;

/**
 * A cache that holds the review read and never asks the host for it again.
 * Under `&late` it starts the read itself, from the fixture, so the page's
 * mount joins that fetch and stays pending until it lands. (A query default's
 * `queryFn` would not serve: `reviewQuery()` names its own, which wins.)
 */
function seededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (late) {
    void client.prefetchQuery({
      queryFn: async () => {
        const { promise, resolve } = Promise.withResolvers<typeof REPORT>();
        globalThis.setTimeout(() => {
          resolve(REPORT);
        }, LATE_MS);
        return promise;
      },
      queryKey: reviewQuery().queryKey,
    });
  } else {
    client.setQueryData(reviewQuery().queryKey, REPORT);
  }
  return client;
}

const client = seededClient();

/**
 * The event a check dispatches on `window`, its `detail` the row ids in a new
 * queue order, to replace the review read with them, as a refetch would.
 */
const REORDER_EVENT = 'needs-you-reorder';

/** The shell's frame around the routed page: its columns, and a stand-in for the version footer strip. */
const root = createRootRoute({
  component: () => (
    <PreviewRoomProvider>
      <div className="flex h-dvh flex-col overflow-hidden">
        <ShellColumns sidebar={undefined}>
          <Outlet />
          <footer className="border-t border-line px-3 py-1 text-center text-tag text-ink-dim">
            v0.0.0
          </footer>
        </ShellColumns>
      </div>
    </PreviewRoomProvider>
  ),
});

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ['/needs-you'] }),
  routeTree: root.addChildren([
    createRoute({ component: NeedsYouPage, getParentRoute: () => root, path: '/needs-you' }),
    createRoute({
      component: () => <main>Focus queue</main>,
      getParentRoute: () => root,
      path: '/',
    }),
  ]),
});

/**
 * The Needs you page over a seeded review read, in the shell's frame, under a
 * memory router (e2e/needs-you-page.test.ts).
 */
export function NeedsYouPageHarness() {
  useEffect(() => {
    const reorder = (event: Event) => {
      const ids: unknown = event instanceof CustomEvent ? event.detail : undefined;
      const order = Array.isArray(ids) ? ids : [];
      const rows = order.flatMap((id) => ROWS.filter((row) => rowId(row) === id));
      client.setQueryData(reviewQuery().queryKey, report(rows, { names: NAMES }));
    };
    globalThis.addEventListener(REORDER_EVENT, reorder);
    return () => {
      globalThis.removeEventListener(REORDER_EVENT, reorder);
    };
  }, []);
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
