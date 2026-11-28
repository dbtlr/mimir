import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

import { pendingPairingsQuery } from '../../src/api/device-queries';
import { archivedProjectsQuery, projectsQuery, treeQuery } from '../../src/api/shell-queries';
import { reviewQuery } from '../../src/api/view-queries';
import { AttentionAlert } from '../../src/components/attention-alert';
import { JumpPaletteProvider } from '../../src/components/jump-palette';
import { ProjectDrawer, ProjectSidebar } from '../../src/components/project-sidebar';
import { SeedCaptureProvider } from '../../src/components/seed-capture';
import { IconButton } from '../../src/components/ui/icon-button';
import { MoreIcon, SearchIcon } from '../../src/components/ui/icons';
import type { SidebarContext } from '../../src/lib/project-sidebar';
import { engineProject, engineTree } from '../../src/test/engine-fixtures';
import { engineReview, needsYouRow, stripRow } from '../../src/test/views-fixtures';

const MMR = { key: 'MMR', name: 'Mimir' };

/** One block waiting on the operator: the alert's smallest pill, a one-digit count. */
const BLOCK = needsYouRow({ id: 'MMR-52', status: 'blocked' }, 'blocked');

/**
 * A project with every kind of sidebar row: an open initiative, and a
 * finished initiative, so the finished fold shows (ADR 0013, MMR-730
 * refinement). Their phases stay off the project's level.
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
  client.setQueryData(pendingPairingsQuery.queryKey, []);
  return client;
}

/**
 * The sidebar's context and the page it frames, from `?context=`: a project
 * (the default), All projects, or Settings.
 */
const FRAMES = {
  all: { context: { kind: 'all' }, path: '/' },
  project: { context: { key: 'MMR', kind: 'project' }, path: '/p/MMR' },
  settings: { context: { kind: 'settings' }, path: '/settings/devices' },
} satisfies Record<string, { context: SidebarContext; path: string }>;
const contextParam = new URLSearchParams(globalThis.location.search).get('context');
const FRAME =
  contextParam === 'all' || contextParam === 'settings' ? FRAMES[contextParam] : FRAMES.project;

/**
 * The shell's top bar around the controls the checks measure: the project
 * menu, then the alert between stand-ins for Jump to… and More, as the shell
 * places them, so a check can see whether the alert reaches into them.
 */
function TopBar() {
  return (
    <header className="flex items-center gap-2 border-b border-line bg-well-950 px-4 pt-2 pb-2 max-lg:px-2 max-md:gap-1">
      <ProjectDrawer context={FRAME.context} />
      <div className="ml-auto flex items-center gap-1">
        <IconButton aria-label="Jump to…">
          <SearchIcon />
        </IconButton>
        <AttentionAlert />
        <IconButton aria-label="More">
          <MoreIcon />
        </IconButton>
      </div>
    </header>
  );
}

const client = seededClient();

const root = createRootRoute({
  // The sidebar and the drawer open with Jump to, which needs the shell's palette.
  component: () => (
    <SeedCaptureProvider>
      <JumpPaletteProvider>
        <TopBar />
        {/* The desktop sidebar, drawn at every width so a check can measure it from `lg` up. */}
        <div className="flex">
          <ProjectSidebar context={FRAME.context} />
          <Outlet />
        </div>
      </JumpPaletteProvider>
    </SeedCaptureProvider>
  ),
});

const router = createRouter({
  history: createMemoryHistory({ initialEntries: [FRAME.path] }),
  routeTree: root.addChildren(
    ['/', '/p/$key', '/settings/devices'].map((path) =>
      createRoute({ component: () => <main />, getParentRoute: () => root, path }),
    ),
  ),
});

/**
 * The needs-you alert and the sidebar, as a drawer and beside the page, over
 * seeded reads, under a memory router at the framed page, for the touch-target checks
 * (e2e/touch-targets.test.ts).
 */
export function TouchTargetsPage() {
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
