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
import { ProjectPage } from './routes/project';
import { ReviewPage } from './routes/review';
import { SeedPage } from './routes/seed';
import { SeedsPage } from './routes/seeds';
import { Shell } from './routes/shell';
import { TasksPage } from './routes/tasks';

/**
 * Navigation (ADR 0013 §3 and its v0.23 refinement): URLs name scopes, views,
 * and records — `/` the review page, `/p/KEY` the project's page, `/p/KEY/board`
 * its board, `/p/KEY/417` a work node's page, `/p/KEY/s41` a seed's page,
 * `/p/KEY/a219` an artifact's page. The board is an optional view with no
 * lenses (MMR-467 refinement). Typed search params carry that contract in the
 * type system.
 */

const isBandMode = (value: unknown): value is BandMode =>
  typeof value === 'string' && (BAND_MODES as readonly string[]).includes(value);

export type BoardSearch = {
  /** The board's swimlane grouping (MMR-221) — addressable, `phase` defaulted-out. */
  bands: BandMode;
};

const rootRoute = createRootRoute({ component: Shell });

export const reviewRoute = createRoute({
  component: ReviewPage,
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
    // phase is the primary grouping — keep the default out of the URL, so a
    // clean `/p/KEY/board` is the canonical board.
    middlewares: [stripSearchParams<BoardSearch>({ bands: 'phase' })],
  },
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput): BoardSearch => {
    const bands: BandMode = isBandMode(search.bands) ? search.bands : 'phase';
    return { bands };
  },
});

export type NodeSearch = {
  /** A container's selected tab; absent = its work page. Only `timeline` is carried. */
  tab?: 'timeline';
};

/**
 * A work node's page: the node id split at its hyphen (`MMR-417` → `/p/MMR/417`).
 * A container's `?tab=timeline` opens its notes; any other value drops.
 */
export const nodeRoute = createRoute({
  beforeLoad: ({ params }) => {
    canonicalKey(params.key, '/p/$key/$seq');
  },
  component: NodePage,
  getParentRoute: () => rootRoute,
  path: '/p/$key/$seq',
  validateSearch: (search: Record<string, unknown>): NodeSearch => ({
    tab: search.tab === 'timeline' ? 'timeline' : undefined,
  }),
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

/**
 * One URL search value as text: a non-empty string stays, a finite number
 * (the router JSON-parses `?q=2026`) means the text it was typed as, and
 * anything else — including an empty value — is absent. The router lays the
 * validated object over the raw params, so every `validateSearch` assigns each
 * of its keys through this (an explicit `undefined` overwrites the raw value;
 * leaving the key out would let it leak through).
 */
function textParam(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') {
    return value;
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

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
  validateSearch: (search: Record<string, unknown>): ArtifactsSearch => ({
    atOrAfter: textParam(search.atOrAfter),
    atOrBefore: textParam(search.atOrBefore),
    project: textParam(search.project),
    q: textParam(search.q),
    tag: textParam(search.tag),
  }),
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
  validateSearch: (search: Record<string, unknown>): TasksSearch => ({
    // `status` grouping is the default and stays out of the URL; any other value drops.
    group: search.group === 'project' ? 'project' : undefined,
    project: textParam(search.project),
    q: textParam(search.q),
    status: textParam(search.status),
  }),
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
  validateSearch: (search: Record<string, unknown>): SeedsSearch => ({
    kind: isSeedKind(search.kind) ? search.kind : undefined,
    project: textParam(search.project),
    q: textParam(search.q),
  }),
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
  reviewRoute,
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
