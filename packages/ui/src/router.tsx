import type { SeedKind } from '@mimir/contract';
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  stripSearchParams,
} from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';

import { BAND_MODES } from './lib/bands';
import type { BandMode } from './lib/bands';
import {
  artifactIdOf,
  artifactLink,
  artifactPath,
  bareIdRedirect,
  seedIdOf,
  seedLink,
  seedPath,
} from './lib/record-url';
import { isSeedKind } from './lib/seed-lanes';
import { ArtifactPage } from './routes/artifact';
import { ArtifactsPage } from './routes/artifacts';
import { BoardPage } from './routes/board';
import { DoctorPage } from './routes/doctor';
import { NodePage } from './routes/node';
import { NotFoundPage } from './routes/not-found';
import { OverviewPage } from './routes/overview';
import { ProjectPage } from './routes/project';
import { SeedPage } from './routes/seed';
import { SeedsPage } from './routes/seeds';
import { Shell } from './routes/shell';
import { TasksPage } from './routes/tasks';

/**
 * Navigation (ADR 0013 §3 and its v0.23 refinement): URLs name scopes, views,
 * and records — `/` the overview, `/p/KEY` the project's page, `/p/KEY/board`
 * its board, `/p/KEY/417` a work node's page, `/p/KEY/s41` a seed's page,
 * `/p/KEY/a219` an artifact's page. On the board, `view` picks the
 * lens (board or tree) until the work page retires the tree (MMR-439). Typed
 * search params carry that contract in the type system.
 */
export type BoardLens = 'board' | 'tree';

const isBandMode = (value: unknown): value is BandMode =>
  typeof value === 'string' && (BAND_MODES as readonly string[]).includes(value);

export type BoardSearch = {
  view: BoardLens;
  /** The board's swimlane grouping (MMR-221) — addressable, `phase` defaulted-out. */
  bands: BandMode;
};

const rootRoute = createRootRoute({ component: Shell });

export const overviewRoute = createRoute({
  component: OverviewPage,
  getParentRoute: () => rootRoute,
  path: '/',
});

/**
 * One record, one URL: a lowercase key (`/p/mmr`, `/p/mmr/417`) moves to its
 * canonical spelling, keeping the rest of the path and the search.
 */
function canonicalKey(key: string, to: '/p/$key' | '/p/$key/board' | '/p/$key/$seq') {
  const canonical = key.toUpperCase();
  if (canonical !== key) {
    // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect contract
    throw redirect({
      params: (prev: Record<string, string>) => ({ ...prev, key: canonical }),
      replace: true,
      search: true,
      to,
    });
  }
}

/** A project's own page: what it is, where it is headed, and what it holds. */
export const projectRoute = createRoute({
  beforeLoad: ({ params }) => {
    canonicalKey(params.key, '/p/$key');
  },
  component: ProjectPage,
  getParentRoute: () => rootRoute,
  path: '/p/$key',
});

/** A project's board — a view of the project, beside its records (v0.23 refinement). */
export const boardRoute = createRoute({
  beforeLoad: ({ params }) => {
    canonicalKey(params.key, '/p/$key/board');
  },
  component: BoardPage,
  getParentRoute: () => rootRoute,
  path: '/p/$key/board',
  search: {
    // board is the primary lens and phase the primary grouping — keep both defaults
    // out of the URL, so a clean `/p/KEY/board` is the canonical board.
    middlewares: [stripSearchParams<BoardSearch>({ bands: 'phase', view: 'board' })],
  },
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput): BoardSearch => {
    const view: BoardLens = search.view === 'tree' ? 'tree' : 'board';
    const bands: BandMode = isBandMode(search.bands) ? search.bands : 'phase';
    return { bands, view };
  },
});

/** A work node's page: the node id split at its hyphen (`MMR-417` → `/p/MMR/417`). */
export const nodeRoute = createRoute({
  beforeLoad: ({ params }) => {
    canonicalKey(params.key, '/p/$key/$seq');
  },
  component: NodePage,
  getParentRoute: () => rootRoute,
  path: '/p/$key/$seq',
});

/**
 * The canonical id a lettered record path names (`S41`, `s041` → `MMR-s41`),
 * or undefined when the key or suffix is off the grammar and the page shows
 * not-found.
 */
function lettered(key: string, letter: 's' | 'a', seq: string): string | undefined {
  const bare = seq.replace(/^0+(?=\d)/, '');
  return letter === 's' ? seedIdOf(key, bare) : artifactIdOf(key, bare);
}

/**
 * A seed's page: the seed id split at its hyphen (`MMR-s41` → `/p/MMR/s41`).
 * The route matches `S41` and `s041` too, so any spelling but the seed's own
 * moves to it, keeping the search.
 */
export const seedRoute = createRoute({
  beforeLoad: ({ params, location }) => {
    const id = lettered(params.key, 's', params.seq);
    if (id !== undefined && location.pathname !== seedPath(id)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect contract
      throw redirect({ ...seedLink(id), replace: true, search: true });
    }
  },
  component: SeedPage,
  getParentRoute: () => rootRoute,
  path: '/p/$key/s{$seq}',
});

/**
 * An artifact's page: the artifact id split at its hyphen (`MMR-a219` →
 * `/p/MMR/a219`). Like the seed route, any other spelling moves to it.
 */
export const artifactRoute = createRoute({
  beforeLoad: ({ params, location }) => {
    const id = lettered(params.key, 'a', params.seq);
    if (id !== undefined && location.pathname !== artifactPath(id)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect contract
      throw redirect({ ...artifactLink(id), replace: true, search: true });
    }
  },
  component: ArtifactPage,
  getParentRoute: () => rootRoute,
  path: '/p/$key/a{$seq}',
});

/**
 * Every unmatched path. A bare ID or project key (`/MMR-417`, `/mmr`)
 * redirects to its page by grammar alone; anything else is not found.
 */
const notFoundRoute = createRoute({
  beforeLoad: ({ params }) => {
    const target = bareIdRedirect(params._splat ?? '');
    if (target !== undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect contract
      throw redirect({ ...target, replace: true });
    }
  },
  component: NotFoundPage,
  getParentRoute: () => rootRoute,
  path: '$',
});

export type ArtifactsSearch = {
  project?: string;
  tag?: string;
  q?: string;
  atOrAfter?: string;
  atOrBefore?: string;
};

export const artifactsRoute = createRoute({
  component: ArtifactsPage,
  getParentRoute: () => rootRoute,
  path: '/artifacts',
  validateSearch: (search: Record<string, unknown>): ArtifactsSearch => {
    const out: ArtifactsSearch = {};
    for (const k of ['project', 'tag', 'q', 'atOrAfter', 'atOrBefore'] as const) {
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
  /** How the browser groups its rows; absent = by status (the default). */
  group?: 'project';
};

export const tasksRoute = createRoute({
  component: TasksPage,
  getParentRoute: () => rootRoute,
  path: '/tasks',
  validateSearch: (search: Record<string, unknown>): TasksSearch => {
    const out: TasksSearch = {};
    for (const k of ['project', 'status', 'q'] as const) {
      const v = search[k];
      if (typeof v === 'string' && v !== '') {
        out[k] = v;
      }
    }
    // `status` grouping is the default and stays out of the URL; any other value drops.
    if (search.group === 'project') {
      out.group = 'project';
    }
    return out;
  },
});

export type DoctorSearch = {
  /** The project the panel scopes to (`all`/absent = every board) — the deep-link
   * the project-header damage chip carries. */
  project?: string;
};

export const doctorRoute = createRoute({
  component: DoctorPage,
  getParentRoute: () => rootRoute,
  path: '/doctor',
  validateSearch: (search: Record<string, unknown>): DoctorSearch =>
    typeof search.project === 'string' && search.project !== '' ? { project: search.project } : {},
});

export type SeedsSearch = {
  /** The filter to one project's board (`all`/absent = every board). */
  project?: string;
  /** Client-side text filter over id, title, and lede. */
  q?: string;
  /** Client-side kind filter. */
  kind?: SeedKind;
};

export const seedsRoute = createRoute({
  component: SeedsPage,
  getParentRoute: () => rootRoute,
  path: '/seeds',
  validateSearch: (search: Record<string, unknown>): SeedsSearch => {
    const out: SeedsSearch = {};
    for (const k of ['project', 'q'] as const) {
      const v = search[k];
      if (typeof v === 'string' && v !== '') {
        out[k] = v;
      }
    }
    // Router search is merged over the raw params, so an invalid kind must be
    // overwritten with an explicit `undefined`, not just left out.
    out.kind = isSeedKind(search.kind) ? search.kind : undefined;
    return out;
  },
});

/**
 * The Meridian kit showcase — a dev-only foundation surface. The whole branch
 * (route + its lazy `import()`) lives inside the `import.meta.env.DEV` guard, so
 * the build folds it to `false` and drops the dynamic import: no kit chunk, no
 * showcase code, and no `/kit` route reach the prod bundle.
 */
const devRoutes = import.meta.env.DEV
  ? [
      createRoute({ getParentRoute: () => rootRoute, path: '/kit' }).lazy(
        async () => (await import('./routes/kit')).Route,
      ),
    ]
  : [];

const routeTree = rootRoute.addChildren([
  overviewRoute,
  projectRoute,
  boardRoute,
  nodeRoute,
  seedRoute,
  artifactRoute,
  artifactsRoute,
  seedsRoute,
  tasksRoute,
  doctorRoute,
  ...devRoutes,
  notFoundRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  // Must stay an `interface` — module augmentation merges into the library's
  // `Register` interface; a `type` alias can't (and would be a duplicate id).
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface Register {
    router: typeof router;
  }
}
