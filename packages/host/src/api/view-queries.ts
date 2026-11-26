import type { ConsoleOutput } from '@mimir/contract';
import { queryOptions } from '@tanstack/react-query';

import { deliveryPage, phaseDeliveries, nodeWork, projectWork, review } from './fns/views';
import { browserTimeZone } from './queries';

/*
 * The composite page reads: Home's review report and the work pages. Each goes
 * through its server function and answers the Engine's own output, with `Date`
 * instants.
 */

/**
 * The persisted shape version of this module's reads. Bump it in the same
 * change that alters a persisted read's key or data shape here; it is part of
 * the persister's buster (lib/persist.ts), so a bump drops every snapshot
 * written in the old shape instead of restoring it into the new code.
 */
export const VIEW_CACHE_VERSION = 7;

/** Home's review report, as the Engine returns it. */
export type ReviewReport = ConsoleOutput<'review'>;

/** A work page's report, as the Engine returns it. */
export type WorkReport = ConsoleOutput<'projectWork'>;

/** One row of the needs-you set (a stopped delivery, a decision, or a task), on a work page or in a review group. */
export type NeedsYouMember = WorkReport['needsYou'][number];
export type NeedsYouTask = Extract<NeedsYouMember, { kind: 'task' }>;
export function needsYouId(row: NeedsYouMember): string {
  switch (row.kind) {
    case 'task': {
      return row.task.id;
    }
    case 'decision': {
      return row.decision.id;
    }
    case 'delivery': {
      return row.delivery.id;
    }
    default: {
      const unexpected: never = row;
      return unexpected;
    }
  }
}
export function needsYouTitle(row: NeedsYouMember): string {
  switch (row.kind) {
    case 'task': {
      return row.task.title;
    }
    case 'decision': {
      return row.decision.question;
    }
    case 'delivery': {
      return row.delivery.title;
    }
    default: {
      const unexpected: never = row;
      return unexpected;
    }
  }
}
export function needsYouLabel(row: NeedsYouMember): string {
  switch (row.kind) {
    case 'task': {
      return row.reason === 'blocked' ? 'Blocked · yours' : 'Needs answers';
    }
    case 'decision': {
      return row.decision.class;
    }
    case 'delivery': {
      return 'Stopped';
    }
    default: {
      const unexpected: never = row;
      return unexpected;
    }
  }
}

/** One task in flight: queued, in progress, or under review. */
export type NowTask = WorkReport['now'][number];

/** One task on the frontier (runnable, next to unlock, or to groom). */
export type FrontierTask = WorkReport['frontier']['runnable'][number];

/** One blocked task waiting on someone else. */
export type WaitingTask = WorkReport['frontier']['waitingOnOthers'][number];

/** One task that finished inside the shipped window. */
export type ShippedTask = WorkReport['shipped'][number];

/**
 * Home's review report (MMR-477): what needs the operator across every active
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

/** One read for the delivery dossier; node invalidation also refreshes member status. */
export const deliveryPageQuery = (id: string) =>
  queryOptions({
    queryFn: () => deliveryPage({ data: { id } }),
    queryKey: ['nodes', 'delivery', id],
  });
export const phaseDeliveriesQuery = (id: string) =>
  queryOptions({
    queryFn: () => phaseDeliveries({ data: { id } }),
    queryKey: ['nodes', 'deliveries', id],
  });
