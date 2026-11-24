import { STATUS_SELECTOR_VALUES } from '@mimir/contract';
import type {
  EngineInput,
  EngineOutput,
  FacetName,
  StatusSelector,
  StatusWord,
} from '@mimir/contract';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import {
  artifacts,
  consoleOpenTasks,
  consoleUpstreamTasks,
  doctor,
  getArtifact,
  getSeed,
  list,
  seeds,
} from './fns/browse';
import { browserTimeZone } from './queries';

/*
 * The browsers' reads (MMR-540): task lists, seeds, artifacts, and record
 * health. Each Engine read goes through its server function in fns/browse.ts
 * and answers the Engine's own output, with `Date` instants. The browsers are
 * project-scoped, so every list names the path's project. Record health is the
 * host's own facet, not an Engine method.
 */

/**
 * The persisted shape version of this module's reads. Bump it in the same
 * change that alters a persisted read's key or data shape here; it is part of
 * the persister's buster (lib/persist.ts), so a bump drops every snapshot
 * written in the old shape instead of restoring it into the new code.
 */
export const BROWSE_CACHE_VERSION = 2;

/** A seed as the Engine reads it. */
export type EngineSeed = EngineOutput<'getSeed'>;

/** One row of the artifact browser. */
export type ArtifactSummary = EngineOutput<'artifacts'>['items'][number];

/** One artifact with its body, as the reader shows it. */
export type ArtifactRecord = EngineOutput<'getArtifact'>;

/**
 * The record-health facet (MMR-185): `mimir doctor` findings, optionally scoped
 * to one project. Unscoped feeds the panel's every-project view; the `key` form
 * feeds the project header chip and the scoped panel. Read-only
 * — no write ever invalidates it, so it rides the poll like every other read.
 */
export const doctorQuery = (project?: string) =>
  queryOptions({
    queryFn: () => doctor({ data: project !== undefined && project !== '' ? { project } : {} }),
    queryKey: ['doctor', project ?? 'all'],
  });

export type TaskFilters = {
  project: string;
  status?: string;
  q?: string;
  /** Ask for each row's one-line preview (MMR-454). */
  lede?: boolean;
  /** Field filters, AND-composed: a preset's date window, the Filter sheet's any-of lists (MMR-724). */
  filters?: NonNullable<EngineInput<'list'>['filters']>;
  /** Verdicts the rows must hold: going cold's `stale` (MMR-724). */
  verdicts?: NonNullable<EngineInput<'list'>['verdicts']>;
  /** The browser's zone, sent with a date filter so its bare dates are the browser's days (ADR 0029). */
  timeZone?: string;
};

/**
 * A `status` value's selectors: one selector or a comma-separated union
 * (MMR-228). Undefined when any token is not a selector, since one bad token
 * voids the whole selection, as it always has.
 */
export function statusSelection(status: string): StatusSelector[] | undefined {
  const selectors: StatusSelector[] = [];
  for (const token of status.split(',').map((t) => t.trim())) {
    if (token === '') {
      continue;
    }
    const selector = STATUS_SELECTOR_VALUES.find((value) => value === token);
    if (selector === undefined) {
      return undefined;
    }
    if (!selectors.includes(selector)) {
      selectors.push(selector);
    }
  }
  return selectors.length > 0 ? selectors : undefined;
}

/** A task list as the Engine answers it. */
export type TaskSet = EngineOutput<'list'>;

/** The answer to a selection no task can match. */
const NO_TASKS: TaskSet = { items: [], returned: 0, startsAt: 0, total: 0 };

/** Where a browser row lives, and its preview when the view shows one. */
const browserFacets = (lede: boolean | undefined): FacetName[] =>
  lede === true ? ['home', 'lede'] : ['home'];

/** One task the dependency picker offers: its id, title, and status. */
export type DepCandidate = { id: string; title: string; status: StatusWord };

/**
 * The dependency picker's lookup (MMR-78): the open tasks on any board whose id
 * or title holds `q`. The host filters before it answers, so an old open task
 * is never crowded out by newer records of other kinds. A passing question:
 * never polled or persisted.
 */
export const tasksQuery = ({ q }: { q: string }) =>
  queryOptions({
    gcTime: 60_000,
    queryFn: async (): Promise<DepCandidate[]> => {
      const open = await consoleOpenTasks({ data: { q } });
      return open.items.map((task) => ({ id: task.id, status: task.status, title: task.title }));
    },
    queryKey: ['search', 'dep-candidates', q],
    refetchInterval: false,
  });

/**
 * The tasks browser's Finished window (MMR-460): the newest this many finished
 * tasks load first and each "Show more" asks for this many more, so history
 * growth costs neither the request, the server's lede reads, nor the
 * persisted cache.
 */
export const FINISHED_PAGE_SIZE = 50;

/**
 * The `/tasks` browser read (MMR-78, MMR-454, MMR-460). A `terminal` selection
 * asks for the newest `FINISHED_PAGE_SIZE * windows` rows; "Show more" grows
 * `windows` and refetches that larger prefix, so a task that finishes or
 * reopens between loads can never skip or repeat a row the way offset paging
 * would. Every other view sends no limit. While the larger prefix loads the
 * previous rows stay (same filters only — a filter change must not show the
 * old selection). Keyed under `nodes`, so every write invalidates it.
 */
export const tasksBrowserQuery = (f: TaskFilters, windows = 1) => {
  const limit = isFinishedSelection(f.status) ? FINISHED_PAGE_SIZE * windows : undefined;
  return queryOptions({
    placeholderData: (previous, previousQuery) =>
      JSON.stringify(previousQuery?.queryKey[2]) === JSON.stringify(f) ? previous : undefined,
    queryFn: async () => {
      const input = listInput(f);
      if (input === undefined) {
        return NO_TASKS;
      }
      if (limit !== undefined) {
        input.limit = limit;
      }
      return list({ data: input });
    },
    queryKey: ['nodes', 'tasks-browser', f, limit],
  });
};

/**
 * Whether a `status` value selects finished tasks only (`terminal`, `done`,
 * `abandoned`, or a union of them): the views that grow by window (MMR-460).
 */
export function isFinishedSelection(status: string | undefined): boolean {
  const selectors = status === undefined ? undefined : statusSelection(status);
  return (
    selectors !== undefined &&
    selectors.every((s) => s === 'terminal' || s === 'done' || s === 'abandoned')
  );
}

/** The `list` input for a filter set, or undefined when its status names no selector. */
function listInput(f: TaskFilters): EngineInput<'list'> | undefined {
  const input: EngineInput<'list'> = { facets: browserFacets(f.lede), project: f.project };
  if (f.status !== undefined && f.status !== '') {
    const status = statusSelection(f.status);
    if (status === undefined) {
      return undefined;
    }
    input.status = status.length === 1 ? status[0] : status;
  }
  if (f.q !== undefined && f.q !== '') {
    input.q = f.q;
  }
  if (f.filters !== undefined) {
    input.filters = f.filters;
  }
  if (f.verdicts !== undefined) {
    input.verdicts = f.verdicts;
  }
  if (f.timeZone !== undefined) {
    input.timeZone = f.timeZone;
  }
  return input;
}

/**
 * How many tasks a filter set holds, for the Filter sheet's "Show N tasks"
 * (MMR-724): the same read with no rows (`limit: 0`), so only its `total`
 * travels. A passing question: never polled or persisted, and kept for a
 * minute so stepping back to an earlier choice answers at once.
 */
export const tasksCountQuery = (f: TaskFilters) =>
  queryOptions({
    gcTime: 60_000,
    queryFn: async () => {
      const input = listInput({ ...f, lede: false });
      if (input === undefined) {
        return 0;
      }
      return (await list({ data: { ...input, limit: 0 } })).total;
    },
    queryKey: ['search', 'tasks-count', f],
    refetchInterval: false,
  });

/** The artifact-browser filter set; every field but the project is optional and composes AND.
 * The two date filters are bare `YYYY-MM-DD` calendar days, inclusive at both
 * edges — the days the person at the browser means (ADR 0029). */
export type ArtifactFilters = {
  project: string;
  tag?: string;
  q?: string;
  atOrAfter?: string;
  atOrBefore?: string;
};

/** The date filters' operators — the shared field-qualified date ops. */
const DATE_OPS = [
  ['atOrAfter', 'at-or-after'],
  ['atOrBefore', 'at-or-before'],
] as const;

/** The `artifacts` input for a filter set: only the set filters, and the zone when a date is set. */
export function artifactInput(f: ArtifactFilters): EngineInput<'artifacts'> {
  const input: EngineInput<'artifacts'> = { project: f.project };
  if (f.tag !== undefined && f.tag !== '') {
    input.tag = f.tag;
  }
  if (f.q !== undefined && f.q !== '') {
    input.q = f.q;
  }
  const dates = DATE_OPS.flatMap(([key, op]) => {
    const value = f[key];
    return value !== undefined && value !== '' ? [{ field: 'created_at', op, value }] : [];
  });
  if (dates.length > 0) {
    input.dates = dates;
    input.timeZone = browserTimeZone();
  }
  return input;
}

/** The artifact list's window size — one fetched page of the newest-first feed. */
export const ARTIFACT_PAGE_SIZE = 100;

/**
 * A project's artifact search — re-runs as filters change. Windowed (the list
 * footer's "scroll for more"): each page asks for an explicit limit/offset
 * slice, and the next offset is however many rows are already on screen,
 * until the set's `total` is reached.
 */
export const artifactsQuery = (f: ArtifactFilters) =>
  infiniteQueryOptions({
    getNextPageParam: (last: EngineOutput<'artifacts'>, pages) => {
      const fetched = pages.reduce((n, page) => n + page.items.length, 0);
      return fetched < last.total && last.items.length > 0 ? fetched : undefined;
    },
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      artifacts({
        data: {
          ...artifactInput(f),
          limit: ARTIFACT_PAGE_SIZE,
          ...(pageParam > 0 ? { offset: pageParam } : {}),
        },
      }),
    queryKey: ['artifacts', f],
  });

/** One artifact with its body — the reader's source. */
export const artifactQuery = (id: string) =>
  queryOptions({
    queryFn: () => getArtifact({ data: { content: true, id } }),
    queryKey: ['artifact', id],
  });

/** The seeds-queue filter set (MMR-247): the board the queue lists. */
export type SeedFilters = {
  project: string;
};

/**
 * The grooming queue (MMR-247): every seed on the board across every lane.
 * `status: 'all'` so the SETTLED lane's terminal rows arrive alongside the
 * live ones (the default `live` would drop them). Keyed under
 * `['seeds', 'list', …]` so a write's `['seeds']` invalidation refreshes it.
 */
export const seedsQuery = (f: SeedFilters) =>
  queryOptions({
    queryFn: () => seeds({ data: { project: f.project, status: 'all' } }),
    queryKey: ['seeds', 'list', f],
  });

/** One seed with its body prose — the seed page's detail source (content read). */
export const seedQuery = (id: string) =>
  queryOptions({
    queryFn: () => getSeed({ data: { content: true, id } }),
    queryKey: ['seeds', 'detail', id],
  });

/**
 * The tasks on any board that name a seed as their upstream (MMR-451): the
 * requester's own work waiting on the seed, for the seed page's outcome list.
 */
export const upstreamTasksQuery = (seedId: string) =>
  queryOptions({
    queryFn: () => consoleUpstreamTasks({ data: { seed: seedId } }),
    queryKey: ['nodes', 'upstream', seedId],
  });

/**
 * The tags on the tasks a status selector holds, most used first, for the
 * Filter sheet's Tag field (MMR-724). Read only while the sheet is open. The
 * live set is bounded, where the whole history is not, so finished work
 * offers the tags of its newest window (`FINISHED_PAGE_SIZE`), the rows its
 * view loads first. Keyed under `nodes`, so a tag write refreshes it.
 */
export const taskTagsQuery = (project: string, status: string) =>
  queryOptions({
    queryFn: async () => {
      const selection = listInput({ project, status });
      if (selection === undefined) {
        return [];
      }
      const window = isFinishedSelection(status) ? { limit: FINISHED_PAGE_SIZE } : {};
      const tasks = await list({ data: { ...selection, ...window, facets: ['tags'] } });
      const uses = new Map<string, number>();
      for (const task of tasks.items) {
        for (const { tag } of task.tags ?? []) {
          uses.set(tag, (uses.get(tag) ?? 0) + 1);
        }
      }
      return [...uses.entries()]
        .toSorted(([a, an], [b, bn]) => bn - an || a.localeCompare(b))
        .map(([tag]) => tag);
    },
    queryKey: ['nodes', 'task-tags', project, status],
  });
