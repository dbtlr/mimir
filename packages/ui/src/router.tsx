import {
  createRootRoute,
  createRoute,
  createRouter,
  stripSearchParams,
} from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';

import { ArtifactsPage } from './routes/artifacts';
import { OverviewPage } from './routes/overview';
import { ProjectPage } from './routes/project';
import { Shell } from './routes/shell';
import { TasksPage } from './routes/tasks';

/**
 * Navigation (ADR 0013 §3): URLs name scopes — `/` the overview, `/p/KEY` a
 * project; everything else is a lens parameter. `view` picks the project
 * lens (board is primary); `node` addresses the detail drawer on either
 * scope. Typed search params carry that contract in the type system.
 */
export type ProjectLens = 'board' | 'tree';

export type OverviewSearch = {
  node?: string;
};

export type ProjectSearch = {
  view: ProjectLens;
  node?: string;
};

const rootRoute = createRootRoute({ component: Shell });

export const overviewRoute = createRoute({
  component: OverviewPage,
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): OverviewSearch =>
    typeof search.node === 'string' ? { node: search.node } : {},
});

export const projectRoute = createRoute({
  component: ProjectPage,
  getParentRoute: () => rootRoute,
  path: '/p/$key',
  search: {
    // board is the primary lens — keep the default out of the URL
    middlewares: [stripSearchParams<ProjectSearch>({ view: 'board' })],
  },
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput): ProjectSearch => {
    const view: ProjectLens = search.view === 'tree' ? 'tree' : 'board';
    return typeof search.node === 'string' ? { node: search.node, view } : { view };
  },
});

export type ArtifactsSearch = {
  project?: string;
  tag?: string;
  q?: string;
  since?: string;
  before?: string;
  a?: string;
  from?: string;
};

export const artifactsRoute = createRoute({
  component: ArtifactsPage,
  getParentRoute: () => rootRoute,
  path: '/artifacts',
  validateSearch: (search: Record<string, unknown>): ArtifactsSearch => {
    const out: ArtifactsSearch = {};
    for (const k of ['project', 'tag', 'q', 'since', 'before', 'a', 'from'] as const) {
      const v = search[k];
      if (typeof v === 'string' && v !== '') {
        out[k] = v;
      }
    }
    return out;
  },
});

export type TasksSearch = {
  project?: string;
  status?: string;
  q?: string;
  /** The node opened in the drawer overlay (same param the board uses). */
  node?: string;
};

export const tasksRoute = createRoute({
  component: TasksPage,
  getParentRoute: () => rootRoute,
  path: '/tasks',
  validateSearch: (search: Record<string, unknown>): TasksSearch => {
    const out: TasksSearch = {};
    for (const k of ['project', 'status', 'q', 'node'] as const) {
      const v = search[k];
      if (typeof v === 'string' && v !== '') {
        out[k] = v;
      }
    }
    return out;
  },
});

const routeTree = rootRoute.addChildren([overviewRoute, projectRoute, artifactsRoute, tasksRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  // Must stay an `interface` — module augmentation merges into the library's
  // `Register` interface; a `type` alias can't (and would be a duplicate id).
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface Register {
    router: typeof router;
  }
}
