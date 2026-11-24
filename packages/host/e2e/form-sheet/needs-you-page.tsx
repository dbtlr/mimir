import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

import { reviewQuery } from '../../src/api/view-queries';
import { PreviewRoomProvider } from '../../src/components/patterns/feed/preview-room';
import { NeedsYouPage } from '../../src/routes/needs-you';
import { ShellColumns } from '../../src/routes/shell';
import { blocked, decision, question, report, stopped } from '../../src/test/needs-you-fixtures';

/** Seven cards in three projects, enough to scroll a phone's page under the bar. */
const REPORT = report(
  [
    stopped('FLT-d2', { reason: 'Stopped by its time cap after 4 hours.' }),
    question('MMR-731'),
    decision('FLT-q1', { delivery: 'FLT-d2' }),
    decision('FLT-q2', { delivery: 'FLT-d2' }),
    blocked('MMR-688'),
    question('LM-640'),
    decision('MMR-q41', {}),
    blocked('LM-571'),
  ],
  { names: { FLT: 'Fleet', LM: 'Loom CLI', MMR: 'Mimir' } },
);

/** A cache that holds the review read and never asks the host for it again. */
function seededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(reviewQuery().queryKey, REPORT);
  return client;
}

const client = seededClient();

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
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
