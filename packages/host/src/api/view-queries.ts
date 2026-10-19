import type { ConsoleOutput } from '@mimir/contract';
import { queryOptions } from '@tanstack/react-query';

import { nodeWork, projectWork, review } from './fns/views';
import { browserTimeZone } from './queries';

/*
 * The composite page reads: the review page and the work pages. Each goes
 * through its server function and answers the Engine's own output, with `Date`
 * instants.
 */

/**
 * The persisted shape version of this module's reads. Bump it in the same
 * change that alters a persisted read's key or data shape here; it is part of
 * the persister's buster (lib/persist.ts), so a bump drops every snapshot
 * written in the old shape instead of restoring it into the new code.
 */
export const VIEW_CACHE_VERSION = 2;

/** The review page's report, as the Engine returns it. */
export type ReviewReport = ConsoleOutput<'review'>;

/** A work page's report, as the Engine returns it. */
export type WorkReport = ConsoleOutput<'projectWork'>;

/** One task that needs the operator, on a work page or in a review decision group. */
export type NeedsYouTask = WorkReport['needsYou'][number];

/** One task in progress. */
export type NowTask = WorkReport['now'][number];

/** One task on the frontier (runnable, next to unlock, or to groom). */
export type FrontierTask = WorkReport['frontier']['runnable'][number];

/** One blocked task waiting on someone else. */
export type WaitingTask = WorkReport['frontier']['waitingOnOthers'][number];

/** One task that finished inside the shipped window. */
export type ShippedTask = WorkReport['shipped'][number];

/** One untriaged seed the review page lists. */
export type TriageSeed = ReviewReport['triage'][number]['seeds'][number];

/**
 * The review page (MMR-477): what needs the operator across every active
 * project, plus the project list. Its own key root, listed in the write keys,
 * so every write refreshes it; the top-bar alert reads the same entry. The
 * Engine requires the zone (it places the Shipped days), so the browser's zone
 * is part of the key, as on the work page.
 */
export const reviewQuery = () => {
  const zone = browserTimeZone();
  return queryOptions({
    queryFn: () => review({ data: { timeZone: zone } }),
    queryKey: ['review', zone],
  });
};

/** What a work page is scoped to: a project's key, or a container's node id. */
export type WorkTarget = { kind: 'project'; key: string } | { kind: 'container'; id: string };

/**
 * The work page's sections (MMR-469) for a project or a container's subtree.
 * The zone decides where the Shipped days begin and end, and the browser's zone
 * is the one the page reads them in, so it is part of the key: a report cached
 * under another zone is never regrouped. Keyed under `project`/`node` so every
 * write's invalidation refreshes it.
 */
export const workQuery = (target: WorkTarget) => {
  const zone = browserTimeZone();
  return target.kind === 'project'
    ? queryOptions({
        queryFn: () => projectWork({ data: { project: target.key, timeZone: zone } }),
        queryKey: ['projects', 'work', target.key, zone],
      })
    : queryOptions({
        queryFn: () => nodeWork({ data: { id: target.id, timeZone: zone } }),
        queryKey: ['nodes', 'work', target.id, zone],
      });
};
