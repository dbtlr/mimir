import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { reviewQuery } from '../api/queries';

/**
 * The top-bar alert (ADR 0019, MMR-476 refinement): the count of decisions
 * waiting on the operator across projects, as a violet pill that opens the
 * review page at `/`. It reads the review page's own query, so its count is
 * the page's count. Triage (seeds, going cold, findings) stops no agent and
 * never lights it. Absent at zero, and until the review read lands.
 */
export function AttentionAlert() {
  const review = useQuery(reviewQuery);
  const count = review.data?.queue.length ?? 0;
  if (count === 0) {
    return null;
  }
  const words = count === 1 ? 'needs you' : 'need you';
  return (
    <Link
      to="/"
      aria-label={`${String(count)} ${words}`}
      className="inline-flex items-center gap-1.5 rounded-full whitespace-nowrap bg-attention/12 px-[11px] py-[5px] text-tag font-semibold text-attention-foreground inset-ring inset-ring-attention/24 transition-colors hover:bg-attention/16 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-attention" />
      {count}
      {/* A phone's top bar has room for the count alone; the label keeps the words. */}
      <span aria-hidden className="max-md:hidden">
        {words}
      </span>
    </Link>
  );
}
