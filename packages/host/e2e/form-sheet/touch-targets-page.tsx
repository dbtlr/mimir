import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

import { archivedProjectsQuery, projectsQuery, treeQuery } from '../../src/api/shell-queries';
import { reviewQuery } from '../../src/api/view-queries';
import { AttentionAlert } from '../../src/components/attention-alert';
import { ProjectDrawer, ProjectSidebar } from '../../src/components/project-sidebar';
import { engineProject, engineTree } from '../../src/test/engine-fixtures';
import { engineReview, needsYouRow, stripRow } from '../../src/test/views-fixtures';

const MMR = { key: 'MMR', name: 'Mimir' };

/** One block waiting on the operator: the alert's smallest pill, a one-digit count. */
const BLOCK = needsYouRow({ id: 'MMR-52', status: 'blocked' }, 'blocked');

/**
 * An outline with every kind of row: an open initiative over a phase, and a
 * finished initiative with a phase inside it, so the Finished fold and its
 * disclosure show.
 */
const TREE = engineTree({ id: 'MMR', status: 'in_progress', type: 'project' }, [
  engineTree({ id: 'MMR-1', status: 'in_progress', type: 'initiative' }, [
    engineTree({ id: 'MMR-2', status: 'ready', type: 'phase' }),
  ]),
  engineTree({ id: 'MMR-5', status: 'done', type: 'initiative' }, [
    engineTree({ id: 'MMR-6', status: 'done', type: 'phase' }),
  ]),
]);

/** A cache that holds the shell's reads and never asks the host for them again. */
function seededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    reviewQuery().queryKey,
    engineReview({
      needsYou: [{ project: MMR, rows: [BLOCK] }],
      projects: [stripRow(MMR, { needsYou: 1 })],
      queue: [{ id: BLOCK.task.id, kind: BLOCK.kind }],
    }),
  );
  client.setQueryData(projectsQuery.queryKey, [engineProject({ id: 'MMR', title: 'Mimir' })]);
  client.setQueryData(archivedProjectsQuery.queryKey, []);
  client.setQueryData(treeQuery('MMR').queryKey, TREE);
  return client;
}

/** The project the page is framed in. */
const CONTEXT = { key: 'MMR', kind: 'project' } as const;

/** The shell's top bar, reduced to the two controls the checks measure. */
function TopBar() {
  return (
    <header className="flex items-center gap-2 border-b border-line bg-well-950 px-4 pt-2 pb-2 max-lg:px-2 max-md:gap-1">
      <ProjectDrawer context={CONTEXT} />
      <div className="ml-auto flex items-center gap-1">
        <AttentionAlert />
      </div>
    </header>
  );
}

const client = seededClient();

const root = createRootRoute({
  component: () => (
    <>
      <TopBar />
      {/* The desktop sidebar, drawn at every width so a check can measure it from `lg` up. */}
      <div className="flex">
        <ProjectSidebar context={CONTEXT} />
        <Outlet />
      </div>
    </>
  ),
});

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ['/p/MMR'] }),
  routeTree: root.addChildren([
    createRoute({ component: () => <main />, getParentRoute: () => root, path: '/p/$key' }),
  ]),
});

/**
 * The needs-you alert and the project drawer over seeded reads, under a
 * memory router at a project's page, for the phone touch-target checks
 * (e2e/touch-targets.test.ts).
 */
export function TouchTargetsPage() {
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
