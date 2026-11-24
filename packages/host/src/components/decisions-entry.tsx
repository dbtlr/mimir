import { Link } from '@tanstack/react-router';

import { cn } from '../lib/cn';
import { deliveryLink } from '../lib/record-url';
import { RETURN_TARGET_ATTRIBUTE, markState, useOpenerPath } from '../lib/walkthrough-mark';

/** The decisions an entry opens: a delivery's, or a project's that name no delivery. */
export type EntrySet = { kind: 'delivery'; id: string } | { kind: 'project'; key: string };

/** An entry for a set: its set and the decision rows the set holds. */
export type GroupEntry = { set: EntrySet; count: number };

/** An entry's text link: the attention hue, with the 44px touch target on a phone. */
const ENTRY_CLASS =
  'rounded-sm font-semibold text-attention-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent max-md:inline-flex max-md:min-h-11 max-md:items-center';

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

/** The name of a set's entry on a page, which focus returns to (ADR 0019, MMR-714 refinement). */
export function entryName(set: EntrySet): string {
  return set.kind === 'delivery' ? `delivery:${set.id}` : `project:${set.key}`;
}

/**
 * A link that opens a set's walkthrough as a new history entry, marked with
 * the page it was on and the control that takes focus back, so Close and the
 * link back return there and focus it again.
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
  const own = entryName(set);
  const state = markState({ entry: own, opener: useOpenerPath() });
  const classes = cn(ENTRY_CLASS, className);
  const named = { [RETURN_TARGET_ATTRIBUTE]: own };
  return set.kind === 'delivery' ? (
    <Link
      {...deliveryLink(set.id)}
      search={{ mode: 'decisions' }}
      state={state}
      className={classes}
      {...named}
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
      {...named}
    >
      {children}
    </Link>
  );
}
