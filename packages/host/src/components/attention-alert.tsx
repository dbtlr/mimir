import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';

import { reviewQuery } from '../api/view-queries';
import { useAppBadge } from '../lib/app-badge';

// On a phone the pill sits among 44px icon buttons, so it takes their scale:
// 34px tall with a 14px count (MMR-715). Its tap target is theirs too: an
// overlay reaches 5px above and below the drawn pill, to 44 (DESIGN.md, Sizes;
// MMR-754). Even a one-digit pill draws about 45 wide.
const PILL =
  'relative inline-flex items-center gap-1.5 rounded-full whitespace-nowrap bg-attention/12 px-[11px] py-[5px] text-tag font-semibold text-attention-foreground inset-ring inset-ring-attention/24 transition-colors hover:bg-attention/16 focus-visible:outline-2 focus-visible:outline-accent max-md:mx-1 max-md:h-[34px] max-md:gap-2 max-md:px-3 max-md:py-0 max-md:text-label max-md:after:absolute max-md:after:inset-x-0 max-md:after:-inset-y-[5px]';

/** The pill's face: a violet dot, the count, and on a desktop the words. */
function PillFace({ count, words }: { count: number; words: string }) {
  return (
    <>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-attention max-md:size-2" />
      {count}
      {/* A phone's top bar has room for the count alone; the label keeps the words. */}
      <span aria-hidden className="max-md:hidden">
        {words}
      </span>
    </>
  );
}

/** The Needs you page, which the alert opens (ADR 0013, MMR-723 refinement). */
const NEEDS_YOU_PAGE = '/needs-you';

/**
 * The top-bar alert (ADR 0019, MMR-476 refinement; ADR 0013, MMR-723
 * refinement): the count of members of the needs-you set waiting on the
 * operator across projects, as a violet pill that links to the Needs you page
 * at every width. It reads Home's own review query, so its count is the items
 * count Home's Needs you head shows. Triage (seeds, going cold, findings)
 * stops no agent and never lights it. Absent at zero, and until the review
 * read lands. On the Needs you page it is the current page, and activating it
 * there changes nothing: the URL stays, so an open preview stays open.
 */
export function AttentionAlert() {
  const review = useQuery(reviewQuery());
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // When this console mounted: the badge takes only reads that land after it.
  const [mountedAt] = useState(() => Date.now());

  const report = review.data;
  const count = report?.queue.length ?? 0;
  // The installed app's icon carries the same count as the pill (MMR-710),
  // from this session's reads only: a persisted report may predate a push
  // that has since moved the icon. The persister restores after mount, so
  // only data read since mount counts, not isFetchedAfterMount; a failed
  // refetch keeps the last read's time and so never re-syncs.
  const freshRead = review.dataUpdatedAt >= mountedAt;
  useAppBadge(freshRead ? { count, readAt: review.dataUpdatedAt } : undefined);
  if (report === undefined || count === 0) {
    return null;
  }
  const label = `${String(count)} ${count === 1 ? 'needs' : 'need'} you`;
  const words = count === 1 ? 'needs you' : 'need you';
  return (
    <Link
      to={NEEDS_YOU_PAGE}
      aria-label={label}
      aria-current={pathname === NEEDS_YOU_PAGE ? 'page' : undefined}
      className={PILL}
    >
      <PillFace count={count} words={words} />
    </Link>
  );
}
