import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import { apiGet } from './client';
import type {
  Collection,
  WireAnnotation,
  WireArtifactDetail,
  WireArtifactSummary,
  WireDoctorFacet,
  WireHealth,
  WireNode,
  WireReviewReport,
  WireScratchpadRow,
  WireSearchHit,
  WireSeed,
  WireTreeNode,
  WireWorkReport,
} from './types';

/**
 * Every read the console makes, as shared `queryOptions`. Polling is the
 * liveness model (ADR 0013 — websockets deferred): ~10s while the document is
 * visible; TanStack Query pauses interval refetches while hidden and refetches
 * on reconnect/focus by default.
 */
export const POLL_MS = 10_000;

/** The footer's stale-binary check (MMR-260): the daemon's build + store schema. */
export const healthQuery = queryOptions({
  queryFn: () => apiGet<WireHealth>('/api/health'),
  queryKey: ['health'],
});

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

/** Every active project with its rollup distribution riding along. */
export const projectsQuery = queryOptions({
  queryFn: () => apiGet<Collection<WireNode>>('/api/projects'),
  queryKey: ['projects'],
});

/**
 * The archived shelf (MMR-125): frozen projects behind the `?status=archived`
 * door (ADR 0015), under the review page's project list. Keyed under
 * `['projects']` so every write's invalidation refreshes the shelf.
 */
export const archivedProjectsQuery = queryOptions({
  queryFn: () => apiGet<Collection<WireNode>>('/api/projects?status=archived'),
  queryKey: ['projects', 'archived'],
});

/**
 * The review page (MMR-477): what needs the operator across every active
 * project, plus the project list. Its own key root, listed in the write keys,
 * so every write refreshes it; the top-bar alert reads the same entry. `tz` is
 * required by the server (it places the Shipped days), so the browser's zone is
 * part of the key, as on the work page.
 */
export const reviewQuery = () => {
  const zone = browserTimeZone();
  return queryOptions({
    queryFn: () => apiGet<WireReviewReport>(`/api/review?tz=${encodeURIComponent(zone)}`),
    queryKey: ['review', zone],
  });
};

/**
 * Ready leaf tasks, portfolio-wide — the actionable count behind a picker row
 * (MMR-82). Leaf tasks, not the project rollup's `ready`
 * bucket, which counts direct children and skews with tree depth.
 */
export const readyQuery = queryOptions({
  queryFn: () => apiGet<Collection<WireNode>>('/api/nodes?type=task&status=ready'),
  queryKey: ['nodes', 'ready'],
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

/** The whole project hierarchy, nested, rank-ordered: the work page's Structure. */
export const treeQuery = (key: string) =>
  queryOptions({
    queryFn: () => apiGet<WireTreeNode>(`/api/projects/${encodeURIComponent(key)}/tree`),
    queryKey: ['tree', key],
  });

/** One project record (status word + distribution for the work page header). */
export const projectQuery = (key: string) =>
  queryOptions({
    queryFn: () => apiGet<WireNode>(`/api/projects/${encodeURIComponent(key)}`),
    queryKey: ['project', key],
  });

/** The full node record (deps, tags, verdicts, artifact titles) its page reads. */
export const nodeQuery = (id: string) =>
  queryOptions({
    queryFn: () => apiGet<WireNode>(`/api/nodes/${encodeURIComponent(id)}`),
    queryKey: ['node', id],
  });

/** One board's active Scratchpads, each with the work it is anchored to. */
export const scratchpadsQuery = (key: string) =>
  queryOptions({
    queryFn: () =>
      apiGet<Collection<WireScratchpadRow>>(`/api/scratchpads?project=${encodeURIComponent(key)}`),
    queryKey: ['scratchpads', key],
  });

/** The node's freeform annotations (their own sub-resource), for its timeline. */
export const annotationsQuery = (id: string) =>
  queryOptions({
    queryFn: () =>
      apiGet<Collection<WireAnnotation>>(`/api/nodes/${encodeURIComponent(id)}/annotations`),
    queryKey: ['node', id, 'annotations'],
  });

/** What a work page is scoped to: a project's key, or a container's node id. */
export type WorkTarget = { kind: 'project'; key: string } | { kind: 'container'; id: string };

/**
 * The work page's sections (MMR-469) for a project or a container's subtree.
 * `tz` is required by the server — it decides where the Shipped days begin and
 * end — and the browser's zone is the one the page reads them in, so the zone is
 * part of the key: a report cached under another zone is never regrouped. Keyed under
 * `project`/`node` so every write's invalidation refreshes it.
 */
export const workQuery = (target: WorkTarget) => {
  const zone = browserTimeZone();
  const tz = encodeURIComponent(zone);
  return target.kind === 'project'
    ? queryOptions({
        queryFn: () =>
          apiGet<WireWorkReport>(`/api/projects/${encodeURIComponent(target.key)}/work?tz=${tz}`),
        queryKey: ['projects', 'work', target.key, zone],
      })
    : queryOptions({
        queryFn: () =>
          apiGet<WireWorkReport>(`/api/nodes/${encodeURIComponent(target.id)}/work?tz=${tz}`),
        queryKey: ['nodes', 'work', target.id, zone],
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

/** This browser's IANA timezone — the calendar a bare date is read against.
 * `UTC` is the fallback for a runtime that reports none; the server refuses a
 * bare date with no zone rather than guessing one. */
export function browserTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

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
 * Key roots (`queryKey[0]`) of every infinite query. The persister's restore
 * guard (see persist.ts `sanitizePersistedClient`) drops a persisted entry
 * under one of these whose cached data isn't infinite-shaped
 * (`{ pages, pageParams }`) — a legacy flat-collection payload from before the
 * query became infinite, or any shape drift a missed persister-buster bump let
 * through. Add an infinite query's root here when you add the query.
 */
export const INFINITE_QUERY_KEY_ROOTS: ReadonlySet<string> = new Set(['artifacts']);

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

/**
 * Key roots of the queries kept out of the persisted offline snapshot: passing
 * questions, not board state. A restored entry would also take the client's
 * week-long `gcTime`, so it would outlive every reload.
 */
export const UNPERSISTED_QUERY_KEY_ROOTS: ReadonlySet<string> = new Set(['search']);

/**
 * Cross-record search (MMR-447) for the jump palette. `project` ranks the
 * current project first and resolves a bare suffix there. A search is a
 * passing question, not board state: it is not polled, is never persisted,
 * and leaves the cache a minute after the palette stops asking.
 */
export const searchQuery = (q: string, project?: string) =>
  queryOptions({
    gcTime: 60_000,
    queryFn: () => {
      const p = new URLSearchParams({ q });
      if (project !== undefined && project !== '') {
        p.set('project', project);
      }
      return apiGet<Collection<WireSearchHit>>(`/api/search?${p.toString()}`);
    },
    queryKey: ['search', project ?? 'all', q],
    refetchInterval: false,
  });
