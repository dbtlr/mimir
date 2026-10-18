import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import { apiGet } from './client';
import { browserTimeZone } from './queries';
import type {
  Collection,
  WireArtifactDetail,
  WireArtifactSummary,
  WireDoctorFacet,
  WireNode,
  WireSeed,
} from './types';

/* The browsers' reads: task lists, seeds, artifacts, and record health. */

/**
 * The persisted shape version of this module's reads. Bump it in the same
 * change that alters a persisted read's key or data shape here; it is part of
 * the persister's buster (lib/persist.ts), so a bump drops every snapshot
 * written in the old shape instead of restoring it into the new code.
 */
export const BROWSE_CACHE_VERSION = 1;

/**
 * The record-health facet (MMR-185): `mimir doctor` findings, optionally scoped
 * to one project. Unscoped feeds the panel's every-project view; the `key` form
 * feeds the project header chip and the scoped panel. Read-only
 * — no write ever invalidates it, so it rides the poll like every other read.
 */
export const doctorQuery = (project?: string) =>
  queryOptions({
    queryFn: () =>
      apiGet<WireDoctorFacet>(
        project !== undefined && project !== ''
          ? `/api/doctor?project=${encodeURIComponent(project)}`
          : '/api/doctor',
      ),
    queryKey: ['doctor', project ?? 'all'],
  });

export type TaskFilters = {
  project?: string;
  status?: string;
  q?: string;
  /** Ask for each row's one-line preview (`col=lede`, MMR-454) — the browser
   * shows it; a picker that only needs titles leaves it off. */
  lede?: boolean;
};

/** The `type=task` list params shared by the picker's and the browser's reads. */
function taskParams(f: TaskFilters): URLSearchParams {
  const p = new URLSearchParams({ type: 'task' });
  if (f.lede === true) {
    p.set('col', 'lede');
  }
  if (f.project !== undefined && f.project !== '') {
    p.set('project', f.project);
  }
  if (f.status !== undefined && f.status !== '') {
    p.set('status', f.status);
  }
  if (f.q !== undefined && f.q !== '') {
    p.set('q', f.q);
  }
  return p;
}

/** One task the dependency picker offers, as `tasksQuery` answers it. */
export type DepCandidate = WireNode;

/** A task-list read with filter + search (MMR-78) — the dependency picker's lookup. */
export const tasksQuery = (f: TaskFilters) =>
  queryOptions({
    queryFn: () => apiGet<Collection<WireNode>>(`/api/nodes?${taskParams(f).toString()}`),
    queryKey: ['nodes', 'tasks', f],
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
  const limit = f.status === 'terminal' ? FINISHED_PAGE_SIZE * windows : undefined;
  return queryOptions({
    placeholderData: (previous, previousQuery) =>
      JSON.stringify(previousQuery?.queryKey[2]) === JSON.stringify(f) ? previous : undefined,
    queryFn: () => {
      const p = taskParams(f);
      if (limit !== undefined) {
        p.set('limit', String(limit));
      }
      return apiGet<Collection<WireNode>>(`/api/nodes?${p.toString()}`);
    },
    queryKey: ['nodes', 'tasks-browser', f, limit],
  });
};

/** The artifact-browser filter set; every field is optional and composes AND.
 * The two date filters are bare `YYYY-MM-DD` calendar days, inclusive at both
 * edges — the days the person at the browser means (ADR 0029). */
export type ArtifactFilters = {
  project?: string;
  tag?: string;
  q?: string;
  atOrAfter?: string;
  atOrBefore?: string;
};

/** The date filters' wire spelling — the shared field-qualified date ops. */
const DATE_PARAMS = [
  ['atOrAfter', 'at-or-after'],
  ['atOrBefore', 'at-or-before'],
] as const;

/** Build the `/api/artifacts` query string from set filters (empty → ""). */
export function artifactParams(f: ArtifactFilters): string {
  const p = new URLSearchParams();
  for (const [key, value] of [
    ['project', f.project],
    ['tag', f.tag],
    ['q', f.q],
  ] as const) {
    if (value !== undefined && value !== '') {
      p.set(key, value);
    }
  }
  let dated = false;
  for (const [key, param] of DATE_PARAMS) {
    const value = f[key];
    if (value !== undefined && value !== '') {
      p.set(param, `created_at:${value}`);
      dated = true;
    }
  }
  if (dated) {
    p.set('tz', browserTimeZone());
  }
  return p.toString();
}

/** The artifact list's window size — one fetched page of the newest-first feed. */
export const ARTIFACT_PAGE_SIZE = 100;

/**
 * Portfolio artifact search — re-runs as filters change. Windowed (the list
 * footer's "scroll for more"): each page asks for an explicit limit/offset
 * slice, and the next offset is however many rows are already on screen,
 * until the envelope's `total` is reached.
 */
export const artifactsQuery = (f: ArtifactFilters) =>
  infiniteQueryOptions({
    getNextPageParam: (last: Collection<WireArtifactSummary>, pages) => {
      const fetched = pages.reduce((n, page) => n + page.items.length, 0);
      return fetched < last.total && last.items.length > 0 ? fetched : undefined;
    },
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(artifactParams(f));
      p.set('limit', String(ARTIFACT_PAGE_SIZE));
      if (pageParam > 0) {
        p.set('offset', String(pageParam));
      }
      return apiGet<Collection<WireArtifactSummary>>(`/api/artifacts?${p.toString()}`);
    },
    queryKey: ['artifacts', f],
  });

/** One artifact with its body — the reader's source. */
export const artifactQuery = (id: string) =>
  queryOptions({
    queryFn: () => apiGet<WireArtifactDetail>(`/api/artifacts/${encodeURIComponent(id)}`),
    queryKey: ['artifact', id],
  });

/** The seeds-queue filter set (MMR-247) — `project` narrows to one board (or all). */
export type SeedFilters = {
  project?: string;
};

/**
 * The grooming queue (MMR-247): every seed across every lane. `status=all`
 * so the SETTLED lane's terminal rows arrive alongside the live ones (the
 * default `live` would drop them); `project=all` spans every board unless a
 * filter narrows it. The server serves `lane` per row, so grouping derives
 * nothing (MMR-245). Keyed under `['seeds', 'list', …]` so a write's
 * `['seeds']` invalidation refreshes it.
 */
export const seedsQuery = (f: SeedFilters = {}) =>
  queryOptions({
    queryFn: () => {
      const p = new URLSearchParams({ status: 'all' });
      p.set('project', f.project !== undefined && f.project !== '' ? f.project : 'all');
      return apiGet<Collection<WireSeed>>(`/api/seeds?${p.toString()}`);
    },
    queryKey: ['seeds', 'list', f],
  });

/** One seed with its body prose — the seed page's detail source (content read). */
export const seedQuery = (id: string) =>
  queryOptions({
    queryFn: () => apiGet<WireSeed>(`/api/seeds/${encodeURIComponent(id)}`),
    queryKey: ['seeds', 'detail', id],
  });

/**
 * The tasks on any board that name a seed as their upstream (MMR-451): the
 * requester's own work waiting on the seed, for the seed page's outcome list.
 */
export const upstreamTasksQuery = (seedId: string) =>
  queryOptions({
    queryFn: () => {
      const p = new URLSearchParams({ type: 'task' });
      p.set('status', 'all');
      p.set('eq', `upstream:${seedId}`);
      return apiGet<Collection<WireNode>>(`/api/nodes?${p.toString()}`);
    },
    queryKey: ['nodes', 'upstream', seedId],
  });
