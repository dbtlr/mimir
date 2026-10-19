import type { HistoryEntry, NodeAnnotation } from './timeline';

/**
 * The verdict-block summary (MMR-262) — the latest annotation authored at/after
 * the most recent submit-into-review transition. This is the single source for
 * the task page's verdict block; the wire's generic `summary`
 * field is an unrelated list-row lede (MMR-162), not this. No summary text is
 * fabricated when neither a submit transition nor a post-submit annotation exists.
 */
export function verdictSummary(
  history: readonly HistoryEntry[] | undefined,
  annotations: readonly NodeAnnotation[] | undefined,
): string | undefined {
  const lastSubmit = (history ?? []).findLast(
    (e) => e.kind === 'lifecycle' && e.to === 'under_review',
  );
  if (lastSubmit === undefined) {
    return undefined;
  }
  const submittedAt = lastSubmit.at.getTime();
  const latest = (annotations ?? [])
    .filter((a) => a.createdAt.getTime() >= submittedAt)
    .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .at(-1);
  return latest?.content;
}
