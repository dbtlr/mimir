import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';

import type { ArtifactListSearch } from './lib/artifact-list';
import { warmable } from './lib/chunk-warmup';
import {
  deliveryIdOf,
  deliveryLink,
  deliveryPath,
  artifactIdOf,
  artifactLink,
  artifactPath,
  bareIdRedirect,
  canonicalProjectKey,
  seedIdOf,
  seedLink,
  seedPath,
} from './lib/record-url';
import { isSeedShow, seedKinds } from './lib/seed-list';
import type { SeedListSearch } from './lib/seed-list';
import { isTaskPreset, isTaskSort } from './lib/task-list';
import type { TaskListSearch } from './lib/task-list';
import { BrowserRedirect } from './routes/browser-redirect';
import { Shell } from './routes/shell';
import { T3_CALLBACK_REASONS } from './server/t3-states';
import type { T3CallbackReason } from './server/t3-states';

/**
 * Navigation (ADR 0013 §3 and its v0.23 refinement): URLs name scopes, views,
 * and records — `/` Home, `/needs-you` the needs-you set, `/projects` every
 * project, `/p/KEY` the project's page, `/p/KEY/tasks` (and `/seeds`,
 * `/artifacts`) its browsers,
 * `/p/KEY/417` a work node's page, `/p/KEY/s41` a seed's page, `/p/KEY/a219`
 * an artifact's page. The board view is retired (MMR-487). Typed search params
 * carry that contract in the type system.
 */

export const rootRoute = createRootRoute({ component: Shell });

export type ReviewSearch = {
  /** Home's mode; absent = the list. Only `focus`, the focus queue, is carried. */
  mode?: 'focus';
};

/** `/` — Home; `?mode=focus` walks its needs-you set one record at a time (MMR-480). */
export const reviewRoute = createRoute({
  component: lazyRouteComponent(
    warmable(async () => import('./routes/review')),
    'ReviewPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): ReviewSearch => ({
    mode: search.mode === 'focus' ? 'focus' : undefined,
  }),
});

/**
 * `/needs-you` — the needs-you set grouped by project, with Work through all
 * (ADR 0013, MMR-723 refinement). It takes no search parameters.
 */
export const needsYouRoute = createRoute({
  component: lazyRouteComponent(
    warmable(async () => import('./routes/needs-you')),
    'NeedsYouPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/needs-you',
});

/**
 * `/projects` — every project, the ones that need you first, the archived ones
 * folded after them (ADR 0013, MMR-790 refinement). It takes no search
 * parameters.
 */
export const projectsRoute = createRoute({
  component: lazyRouteComponent(
    warmable(async () => import('./routes/projects')),
    'ProjectsPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/projects',
});

/**
 * One record, one URL: a lowercase key (`/p/mmr`, `/p/mmr/417`) moves to its
 * canonical spelling, keeping the rest of the path and the search.
 */
function canonicalKey(
  key: string,
  to: '/p/$key' | '/p/$key/$seq' | '/p/$key/tasks' | '/p/$key/seeds' | '/p/$key/artifacts',
) {
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

export type DecisionsSearch = {
  /** The decisions walkthrough; absent = the page. Only `decisions` is carried (MMR-703). */
  mode?: 'decisions';
};

/** `?mode=decisions` opens the decisions walkthrough over a page; any other `mode` drops. */
const validateDecisionsSearch = (search: Record<string, unknown>): DecisionsSearch => ({
  mode: search.mode === 'decisions' ? 'decisions' : undefined,
});

export type ProjectSearch = DecisionsSearch & {
  /** The project's tab at `/p/KEY`; absent = Work. Only `details` is carried (MMR-726). */
  tab?: 'details';
};

/**
 * A project's own page: what it is, where it is headed, and what it holds.
 * `?tab=details` opens its Details tab; its other tabs besides Work are the
 * browsers below. Any other `tab` drops.
 */
export const projectRoute = createRoute({
  beforeLoad: ({ params }) => {
    canonicalKey(params.key, '/p/$key');
  },
  component: lazyRouteComponent(
    warmable(async () => import('./routes/project')),
    'ProjectPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/p/$key',
  validateSearch: (search: Record<string, unknown>): ProjectSearch => ({
    ...validateDecisionsSearch(search),
    tab: search.tab === 'details' ? 'details' : undefined,
  }),
});

/** The tabs a URL can name on an initiative, a phase, or a task; Work, the first, takes no parameter. */
const NODE_TABS = ['details', 'timeline', 'artifacts'] as const;

export type NodeSearch = {
  /** A container's or task's selected tab; absent = Work (MMR-726, MMR-728). */
  tab?: (typeof NODE_TABS)[number];
};

/**
 * A work node's page: the node id split at its hyphen (`MMR-417` → `/p/MMR/417`).
 * A container's or task's `?tab=details`, `timeline`, or `artifacts` opens
 * that tab; any other value drops.
 */
export const nodeRoute = createRoute({
  beforeLoad: ({ params }) => {
    canonicalKey(params.key, '/p/$key/$seq');
  },
  component: lazyRouteComponent(
    warmable(async () => import('./routes/node')),
    'NodePage',
  ),
  getParentRoute: () => rootRoute,
  path: '/p/$key/$seq',
  validateSearch: (search: Record<string, unknown>): NodeSearch => ({
    tab: NODE_TABS.find((tab) => tab === search.tab),
  }),
});

/**
 * The canonical id a lettered record path names (`S41`, `s041` → `MMR-s41`),
 * or undefined when the key or suffix is off the grammar and the page shows
 * not-found.
 */
function lettered(key: string, letter: 's' | 'a' | 'd', seq: string): string | undefined {
  const bare = seq.replace(/^0+(?=\d)/, '');
  if (letter === 'd') {
    return deliveryIdOf(key, bare);
  }
  return letter === 's' ? seedIdOf(key, bare) : artifactIdOf(key, bare);
}

/**
 * A delivery's page: the delivery id split at its hyphen (`MMR-d3` →
 * `/p/MMR/d3`). Any other spelling (`D003`) moves to it, keeping the search.
 * `?mode=decisions` opens the decisions walkthrough over it.
 */
export const deliveryRoute = createRoute({
  beforeLoad: ({ params, location }) => {
    const id = lettered(params.key, 'd', params.seq);
    if (id !== undefined && location.pathname !== deliveryPath(id)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect contract
      throw redirect({ ...deliveryLink(id), replace: true, search: true });
    }
  },
  component: lazyRouteComponent(
    warmable(async () => import('./routes/delivery')),
    'DeliveryPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/p/$key/d{$seq}',
  validateSearch: validateDecisionsSearch,
});

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
  component: lazyRouteComponent(
    warmable(async () => import('./routes/seed')),
    'SeedPage',
  ),
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
  component: lazyRouteComponent(
    warmable(async () => import('./routes/artifact')),
    'ArtifactPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/p/$key/a{$seq}',
});

/**
 * Every unmatched path. A bare ID or project key (`/MMR-417`, `/mmr`)
 * redirects to its page by grammar alone; anything else is not found.
 */
export const notFoundRoute = createRoute({
  beforeLoad: ({ params }) => {
    const target = bareIdRedirect(params._splat ?? '');
    if (target !== undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect contract
      throw redirect({ ...target, replace: true });
    }
  },
  component: lazyRouteComponent(
    warmable(async () => import('./routes/not-found')),
    'NotFoundPage',
  ),
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

/**
 * The three browsers sit under their project (ADR 0013, MMR-492 refinement):
 * `/p/KEY/tasks`, `/p/KEY/seeds`, `/p/KEY/artifacts`. These are the view
 * segments the record grammar reserves — a record suffix is all digits or
 * `s`/`a` plus digits — and a static segment outranks the `$seq` param, so
 * `/p/KEY/tasks` never reaches a record page. The path names the project, so
 * the search carries filters only.
 */

export type ArtifactsSearch = ArtifactListSearch;

const validateArtifactsSearch = (search: Record<string, unknown>): ArtifactsSearch => ({
  atOrAfter: textParam(search.atOrAfter),
  atOrBefore: textParam(search.atOrBefore),
  q: textParam(search.q),
  tag: textParam(search.tag),
});

export const artifactsRoute = createRoute({
  beforeLoad: ({ params }) => {
    canonicalKey(params.key, '/p/$key/artifacts');
  },
  component: lazyRouteComponent(
    warmable(async () => import('./routes/artifacts')),
    'ArtifactsPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/p/$key/artifacts',
  validateSearch: validateArtifactsSearch,
});

/** A Tasks URL: a preset, any status selector a link carries, the search, and the Filter sheet's fields (MMR-724). */
export type TasksSearch = TaskListSearch;

const validateTasksSearch = (search: Record<string, unknown>): TasksSearch => {
  const show = textParam(search.show);
  const sort = textParam(search.sort);
  return {
    priority: textParam(search.priority),
    q: textParam(search.q),
    show: isTaskPreset(show) ? show : undefined,
    size: textParam(search.size),
    sort: isTaskSort(sort) ? sort : undefined,
    status: textParam(search.status),
    tag: textParam(search.tag),
  };
};

export const tasksRoute = createRoute({
  beforeLoad: ({ params }) => {
    canonicalKey(params.key, '/p/$key/tasks');
  },
  component: lazyRouteComponent(
    warmable(async () => import('./routes/tasks')),
    'TasksPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/p/$key/tasks',
  validateSearch: validateTasksSearch,
});

export type DoctorSearch = {
  /** The project the panel scopes to (`all`/absent = every board) — the deep-link
   * the project-header damage chip carries. */
  project?: string;
};

export const doctorRoute = createRoute({
  component: lazyRouteComponent(
    warmable(async () => import('./routes/doctor')),
    'DoctorPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/doctor',
  validateSearch: (search: Record<string, unknown>): DoctorSearch =>
    typeof search.project === 'string' && search.project !== '' ? { project: search.project } : {},
});

export type PairSearch = {
  /** The pairing code to check, as `mimir pair` prints it in the URL it shows. */
  code?: string;
};

/** `/pair` — approve or deny a device's pairing request by its code (MMR-585). */
export const pairRoute = createRoute({
  component: lazyRouteComponent(
    warmable(async () => import('./routes/pair')),
    'PairPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/pair',
  validateSearch: (search: Record<string, unknown>): PairSearch => ({
    code: textParam(search.code),
  }),
});

/** `/settings` — the index of the console's settings pages (MMR-733). */
export const settingsRoute = createRoute({
  component: lazyRouteComponent(
    warmable(async () => import('./routes/settings')),
    'SettingsIndexPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/settings',
});

/** `/settings/notifications` — this browser's Web Push control and every subscribed browser (MMR-711). */
export const notificationsRoute = createRoute({
  component: lazyRouteComponent(
    warmable(async () => import('./routes/settings-notifications')),
    'NotificationsPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/settings/notifications',
});

/** `/settings/appearance` — Light, Dark, or Match system. */
export const appearanceRoute = createRoute({
  component: lazyRouteComponent(
    warmable(async () => import('./routes/settings-appearance')),
    'AppearancePage',
  ),
  getParentRoute: () => rootRoute,
  path: '/settings/appearance',
});

/** `/settings/devices` — the requests waiting on the operator and the paired devices (MMR-585). */
export const devicesRoute = createRoute({
  component: lazyRouteComponent(
    warmable(async () => import('./routes/settings-devices')),
    'DevicesPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/settings/devices',
});

export type ConnectionsSearch = {
  /** The T3 Connect outcome the callback redirected with (ADR 0040); unknown values are dropped. */
  t3?: T3CallbackReason;
};

/** `/settings/connections` — the T3 Code connection, and where its callback lands. */
export const connectionsRoute = createRoute({
  component: lazyRouteComponent(
    warmable(async () => import('./routes/settings-connections')),
    'ConnectionsPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/settings/connections',
  // Named even when absent: the router keeps a raw parameter a validator leaves out.
  validateSearch: (search: Record<string, unknown>): ConnectionsSearch => ({
    t3: T3_CALLBACK_REASONS.find((known) => known === search.t3),
  }),
});

/** `/settings/about` — host and console versions, the update check, and a way to Record health. */
export const aboutRoute = createRoute({
  component: lazyRouteComponent(
    warmable(async () => import('./routes/settings-about')),
    'AboutPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/settings/about',
});

/**
 * `/devices` moved into Settings (MMR-733). An old link lands on
 * `/settings/devices`, query kept; one carrying a T3 outcome (`t3`) lands on
 * `/settings/connections`, which is where that outcome is shown.
 */
export const legacyDevicesRoute = createRoute({
  beforeLoad: ({ search }) => {
    const t3 = T3_CALLBACK_REASONS.find((known) => known === search.t3);
    if (t3 !== undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect contract
      throw redirect({ replace: true, search: { t3 }, to: '/settings/connections' });
    }
    // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect contract
    throw redirect({ replace: true, search: true, to: '/settings/devices' });
  },
  getParentRoute: () => rootRoute,
  path: '/devices',
  validateSearch: (search: Record<string, unknown>): Record<string, unknown> => search,
});

/** A Seeds URL: a view, the kinds, and the search (MMR-725). */
export type SeedsSearch = SeedListSearch;

const validateSeedsSearch = (search: Record<string, unknown>): SeedsSearch => {
  const show = textParam(search.show);
  const kinds = seedKinds(textParam(search.kind));
  return {
    kind: kinds.length > 0 ? kinds.join(',') : undefined,
    q: textParam(search.q),
    show: isSeedShow(show) ? show : undefined,
  };
};

export const seedsRoute = createRoute({
  beforeLoad: ({ params }) => {
    canonicalKey(params.key, '/p/$key/seeds');
  },
  component: lazyRouteComponent(
    warmable(async () => import('./routes/seeds')),
    'SeedsPage',
  ),
  getParentRoute: () => rootRoute,
  path: '/p/$key/seeds',
  validateSearch: validateSeedsSearch,
});

/**
 * The retired top-level browsers (MMR-495). `/tasks`, `/seeds`, and
 * `/artifacts` are no longer pages: with `?project=KEY` they move to the
 * project's browser keeping every other parameter, and bare they go to the
 * current project's (see {@link BrowserRedirect}). Links written before the
 * move keep working.
 */

/**
 * The project a legacy `?project=` names, in canonical spelling. `all` was the
 * old "every project" value, so it means no project even though it reads as a
 * key; anything else that is not a key is dropped too.
 */
const legacyProjectKey = (value: unknown) => {
  const text = textParam(value);
  return text?.toLowerCase() === 'all' ? undefined : canonicalProjectKey(text);
};

export type LegacyTasksSearch = TasksSearch & { project?: string };
export type LegacySeedsSearch = SeedsSearch & { project?: string };
export type LegacyArtifactsSearch = ArtifactsSearch & { project?: string };

export const legacyTasksRoute = createRoute({
  beforeLoad: ({ search: { project: key, ...search } }) => {
    if (key !== undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect contract
      throw redirect({ params: { key }, replace: true, search, to: '/p/$key/tasks' });
    }
  },
  component: () => <BrowserRedirect view="tasks" search={legacyTasksRoute.useSearch()} />,
  getParentRoute: () => rootRoute,
  path: '/tasks',
  validateSearch: (search: Record<string, unknown>): LegacyTasksSearch => ({
    ...validateTasksSearch(search),
    project: legacyProjectKey(search.project),
  }),
});

export const legacySeedsRoute = createRoute({
  beforeLoad: ({ search: { project: key, ...search } }) => {
    if (key !== undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect contract
      throw redirect({ params: { key }, replace: true, search, to: '/p/$key/seeds' });
    }
  },
  component: () => <BrowserRedirect view="seeds" search={legacySeedsRoute.useSearch()} />,
  getParentRoute: () => rootRoute,
  path: '/seeds',
  validateSearch: (search: Record<string, unknown>): LegacySeedsSearch => ({
    ...validateSeedsSearch(search),
    project: legacyProjectKey(search.project),
  }),
});

export const legacyArtifactsRoute = createRoute({
  beforeLoad: ({ search: { project: key, ...search } }) => {
    if (key !== undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router's redirect contract
      throw redirect({ params: { key }, replace: true, search, to: '/p/$key/artifacts' });
    }
  },
  component: () => <BrowserRedirect view="artifacts" search={legacyArtifactsRoute.useSearch()} />,
  getParentRoute: () => rootRoute,
  path: '/artifacts',
  validateSearch: (search: Record<string, unknown>): LegacyArtifactsSearch => ({
    ...validateArtifactsSearch(search),
    project: legacyProjectKey(search.project),
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

export const consoleRoutes = [
  reviewRoute,
  needsYouRoute,
  projectsRoute,
  projectRoute,
  nodeRoute,
  seedRoute,
  deliveryRoute,
  artifactRoute,
  artifactsRoute,
  seedsRoute,
  tasksRoute,
  legacyArtifactsRoute,
  legacySeedsRoute,
  legacyTasksRoute,
  doctorRoute,
  pairRoute,
  settingsRoute,
  notificationsRoute,
  appearanceRoute,
  devicesRoute,
  connectionsRoute,
  aboutRoute,
  legacyDevicesRoute,
  ...devRoutes,
  notFoundRoute,
] as const;

export const routeTree = rootRoute.addChildren(consoleRoutes);

export const createConsoleRouter = () => createRouter({ routeTree });

declare module '@tanstack/react-router' {
  // Must stay an `interface` — module augmentation merges into the library's
  // `Register` interface; a `type` alias can't (and would be a duplicate id).
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface Register {
    router: ReturnType<typeof createConsoleRouter>;
  }
}
