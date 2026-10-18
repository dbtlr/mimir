import { queryOptions } from '@tanstack/react-query';

import { apiGet } from './client';
import { browserTimeZone } from './queries';
import type { WireReviewReport, WireWorkReport } from './types';

/* The composite page reads: the review page and the work pages. */

/**
 * The persisted shape version of this module's reads. Bump it in the same
 * change that alters a persisted read's key or data shape here; it is part of
 * the persister's buster (lib/persist.ts), so a bump drops every snapshot
 * written in the old shape instead of restoring it into the new code.
 */
export const VIEW_CACHE_VERSION = 1;

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
