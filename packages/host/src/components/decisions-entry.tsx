import { Link } from '@tanstack/react-router';

import type { ReviewReport } from '../api/view-queries';
import { cn } from '../lib/cn';
import { deliveryLink } from '../lib/record-url';
import { markState, useOpenerPath } from '../lib/walkthrough-mark';

type NeedsYouRows = ReviewReport['needsYou'][number]['rows'];

/** The decisions an entry opens: a delivery's, or a project's that name no delivery. */
export type EntrySet = { kind: 'delivery'; id: string } | { kind: 'project'; key: string };

/** One entry a project group shows: its set and the decision rows the set holds in the group. */
export type GroupEntry = { set: EntrySet; count: number };

/** An entry's text link: the attention hue, with the 44px touch target on a phone. */
const ENTRY_CLASS =
  'rounded-sm font-semibold text-attention-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent max-md:inline-flex max-md:min-h-11 max-md:items-center';

/**
 * The entries of one project group (ADR 0019, MMR-704 refinement): one per
 * delivery with a decision row, in the needs-you order of each delivery's
 * first decision row, then one for the rows that name no delivery.
 */
export function groupEntries(rows: NeedsYouRows, projectKey: string): GroupEntry[] {
  const deliveries = new Map<string, number>();
  let loose = 0;
  for (const row of rows) {
    if (row.kind !== 'decision') {
      continue;
    }
    const { delivery } = row.decision;
    if (delivery === null) {
      loose += 1;
    } else {
      deliveries.set(delivery, (deliveries.get(delivery) ?? 0) + 1);
    }
  }
  return [
    ...[...deliveries].map(([id, count]) => ({ count, set: { id, kind: 'delivery' as const } })),
    ...(loose > 0 ? [{ count: loose, set: { key: projectKey, kind: 'project' as const } }] : []),
  ];
}

/** "Review 3 decisions" or "Review 1 decision", then `suffix`. */
export function entryLabel(count: number, suffix = ''): string {
  return `Review ${String(count)} ${count === 1 ? 'decision' : 'decisions'}${suffix}`;
}

/** A group entry's label: on its delivery, or without one. */
export function groupEntryLabel(entry: GroupEntry): string {
  return entryLabel(
    entry.count,
    entry.set.kind === 'delivery' ? ` on ${entry.set.id}` : ' without a delivery',
  );
}

/**
 * A link that opens a set's walkthrough as a new history entry, marked with
 * the page it was on so Close and the link back return there.
 */
export function DecisionsEntry({
  set,
  children,
  className,
}: {
  set: EntrySet;
  children: string;
  className?: string;
}) {
  const state = markState(useOpenerPath());
  const classes = cn(ENTRY_CLASS, className);
  return set.kind === 'delivery' ? (
    <Link
      {...deliveryLink(set.id)}
      search={{ mode: 'decisions' }}
      state={state}
      className={classes}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/p/$key"
      params={{ key: set.key }}
      search={{ mode: 'decisions' }}
      state={state}
      className={classes}
    >
      {children}
    </Link>
  );
}
