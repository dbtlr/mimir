import type { FacetName } from '@mimir/contract';
import { queryOptions } from '@tanstack/react-query';

import { consoleSearch, projects, tree } from './fns/shell';
import { fetchHealth } from './health';

/*
 * The shell's reads (MMR-537): the host's health, the project lists, the
 * sidebar tree, and the jump palette's search. Each Engine read
 * goes through its server function and answers the Engine's own output, with
 * `Date` instants. Health is the host's own `/health` route, not an Engine
 * method.
 */

/**
 * The persisted shape version of this module's reads. Bump it in the same
 * change that alters a persisted read's key or data shape here; it is part of
 * the persister's buster (lib/persist.ts), so a bump drops every snapshot
 * written in the old shape instead of restoring it into the new code.
 */
export const SHELL_CACHE_VERSION = 1;

/**
 * The footer's stale-binary check (MMR-260): the host's build + store schema.
 * A console that mounts always asks the host, since a snapshot another tab
 * persisted a moment ago says nothing about the host this bundle now runs
 * against. The snapshot still answers while the host is unreachable.
 */
export const healthQuery = queryOptions({
  queryFn: fetchHealth,
  queryKey: ['health'],
  refetchOnMount: 'always',
});

/** The list's projection: the rollup and the tags. */
const PROJECT_LIST_FACETS: FacetName[] = ['distribution', 'tags'];

/** Every active project with its rollup distribution riding along. */
export const projectsQuery = queryOptions({
  queryFn: () => projects({ data: { facets: PROJECT_LIST_FACETS, status: 'active' } }),
  queryKey: ['projects'],
});

/**
 * The archived shelf adds the leaf counts (MMR-105) and the artifact tally
 * (MMR-125) for its count line. Only this list asks for them: the active list
 * is polled by surfaces that read neither.
 */
const ARCHIVED_LIST_FACETS: FacetName[] = [...PROJECT_LIST_FACETS, 'leafCounts', 'artifactCount'];

/**
 * The archived projects (MMR-125): frozen projects behind the archived door
 * (ADR 0015), which the switcher folds away and an archived project's page
 * reads to offer Unarchive. Keyed under `['projects']` so every write's
 * invalidation refreshes them.
 */
export const archivedProjectsQuery = queryOptions({
  queryFn: () => projects({ data: { facets: ARCHIVED_LIST_FACETS, status: 'archived' } }),
  queryKey: ['projects', 'archived'],
});

/** The whole project hierarchy, nested, rank-ordered: the sidebar outline and the pickers. */
export const treeQuery = (key: string) =>
  queryOptions({
    queryFn: () => tree({ data: { id: key } }),
    queryKey: ['tree', key],
  });

/**
 * Cross-record search (MMR-447) for the jump palette, across every project.
 * `project` ranks the current project first and resolves a bare suffix there.
 * A search is a passing question, not board state: it is not polled, is never
 * persisted, and leaves the cache a minute after the palette stops asking.
 */
export const searchQuery = (q: string, project?: string) =>
  queryOptions({
    gcTime: 60_000,
    queryFn: () =>
      consoleSearch({
        data: { query: q, ...(project !== undefined && project !== '' ? { project } : {}) },
      }),
    queryKey: ['search', project ?? 'all', q],
    refetchInterval: false,
  });
