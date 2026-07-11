import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import { apiGet } from './client';
import type {
  Collection,
  WireAnnotation,
  WireArtifactDetail,
  WireArtifactSummary,
  WireHealth,
  WireNode,
  WireTreeNode,
} from './types';

/**
 * Every read the console makes, as shared `queryOptions`. Polling is the
 * liveness model (ADR 0013 — websockets deferred): ~10s while the document is
 * visible; TanStack Query pauses interval refetches while hidden and refetches
 * on reconnect/focus by default.
 */
export const POLL_MS = 10_000;

/** The footer's stale-binary check (MMR-260): the daemon's build + vault schema. */
export const healthQuery = queryOptions({
  queryFn: () => apiGet<WireHealth>('/api/health'),
  queryKey: ['health'],
});

/** Overview: every project with its rollup distribution riding along. */
export const projectsQuery = queryOptions({
  queryFn: () => apiGet<Collection<WireNode>>('/api/projects'),
  queryKey: ['projects'],
});

/**
 * The archived shelf (MMR-125): frozen projects behind the `?status=archived`
 * door (ADR 0015). Feeds both the archived shelf and the Overview header's
 * `· {m} archived` clause (MMR-230). Keyed under `['projects']` so every
 * write's invalidation refreshes the shelf alongside the live lanes.
 */
export const archivedProjectsQuery = queryOptions({
  queryFn: () => apiGet<Collection<WireNode>>('/api/projects?status=archived'),
  queryKey: ['projects', 'archived'],
});

/** Attention: tasks awaiting the operator's review, portfolio-wide (MMR-103). */
export const underReviewQuery = queryOptions({
  queryFn: () => apiGet<Collection<WireNode>>('/api/nodes?type=task&status=under_review'),
  queryKey: ['nodes', 'attention', 'under_review'],
});

/** Attention strip: externally blocked tasks, portfolio-wide. */
export const blockedQuery = queryOptions({
  queryFn: () => apiGet<Collection<WireNode>>('/api/nodes?type=task&status=blocked'),
  queryKey: ['nodes', 'attention', 'blocked'],
});

/** Attention strip: tasks the stale verdict flags, portfolio-wide. */
export const staleQuery = queryOptions({
  queryFn: () => apiGet<Collection<WireNode>>('/api/nodes?type=task&is=stale'),
  queryKey: ['nodes', 'attention', 'stale'],
});

/**
 * Ready leaf tasks, portfolio-wide — the actionable count behind a project card
 * and a picker row (MMR-82). Leaf tasks, not the project rollup's `ready`
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
};

/**
 * The all-time task census (MMR-228): every task, ever, across all projects —
 * fetched at `limit=1` because only the envelope's `total` is consumed (the
 * tasks-browser header's "{n} across {m} projects" count).
 */
export const taskCensusQuery = queryOptions({
  queryFn: () => apiGet<Collection<WireNode>>('/api/nodes?type=task&status=all&limit=1'),
  queryKey: ['nodes', 'tasks', 'census'],
});

/** The `/tasks` browser read (MMR-78): portfolio task list with filter + search. */
export const tasksQuery = (f: TaskFilters) =>
  queryOptions({
    queryFn: () => {
      const p = new URLSearchParams({ type: 'task' });
      if (f.project !== undefined && f.project !== '') {
        p.set('project', f.project);
      }
      if (f.status !== undefined && f.status !== '') {
        p.set('status', f.status);
      }
      if (f.q !== undefined && f.q !== '') {
        p.set('q', f.q);
      }
      return apiGet<Collection<WireNode>>(`/api/nodes?${p.toString()}`);
    },
    queryKey: ['nodes', 'tasks', f],
  });

/**
 * The board's live half: every non-terminal task in the project, in rank
 * order — the API's array order IS rank (ADR 0007), so the Ready column
 * renders items exactly as received.
 */
export const boardLiveQuery = (key: string) =>
  queryOptions({
    queryFn: () =>
      apiGet<Collection<WireNode>>(
        `/api/nodes?project=${encodeURIComponent(key)}&type=task&status=live`,
      ),
    queryKey: ['board', key, 'live'],
  });

/** The board's Done column source: completed tasks, newest completion first. */
export const boardDoneQuery = (key: string) =>
  queryOptions({
    queryFn: () =>
      apiGet<Collection<WireNode>>(
        `/api/nodes?project=${encodeURIComponent(key)}&type=task&status=done&limit=200`,
      ),
    queryKey: ['board', key, 'done'],
  });

/** The tree lens: the whole project hierarchy, nested, rank-ordered. */
export const treeQuery = (key: string) =>
  queryOptions({
    queryFn: () => apiGet<WireTreeNode>(`/api/projects/${encodeURIComponent(key)}/tree`),
    queryKey: ['tree', key],
  });

/** One project record (status word + distribution for the board header). */
export const projectQuery = (key: string) =>
  queryOptions({
    queryFn: () => apiGet<WireNode>(`/api/projects/${encodeURIComponent(key)}`),
    queryKey: ['project', key],
  });

/** Drawer: the full node record (deps, tags, verdicts, artifact titles). */
export const nodeQuery = (id: string) =>
  queryOptions({
    queryFn: () => apiGet<WireNode>(`/api/nodes/${encodeURIComponent(id)}`),
    queryKey: ['node', id],
  });

/** Drawer: the node's freeform annotations (their own sub-resource). */
export const annotationsQuery = (id: string) =>
  queryOptions({
    queryFn: () =>
      apiGet<Collection<WireAnnotation>>(`/api/nodes/${encodeURIComponent(id)}/annotations`),
    queryKey: ['node', id, 'annotations'],
  });

/** The artifact-browser filter set; every field is optional and composes AND. */
export type ArtifactFilters = {
  project?: string;
  tag?: string;
  q?: string;
  since?: string;
  before?: string;
};

/** Build the `/api/artifacts` query string from set filters (empty → ""). */
export function artifactParams(f: ArtifactFilters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== '') {
      p.set(k, v);
    }
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
