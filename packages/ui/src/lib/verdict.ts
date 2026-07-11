import type { WireAnnotation, WireHistoryEntry } from '../api/types';

/**
 * The verdict-block summary (MMR-262) — the latest annotation authored at/after
 * the most recent submit-into-review transition. This is the single source for
 * both the dossier and quick-view verdict blocks; the wire's generic `summary`
 * field is an unrelated board-card lede (MMR-162), not this. No summary text is
 * fabricated when neither a submit transition nor a post-submit annotation exists.
 */
export function verdictSummary(
  history: readonly WireHistoryEntry[] | undefined,
  annotations: readonly WireAnnotation[] | undefined,
): string | undefined {
  const lastSubmit = (history ?? []).findLast(
    (e) => e.kind === 'lifecycle' && e.to === 'under_review',
  );
  if (lastSubmit === undefined) {
    return undefined;
  }
  const submittedAt = Date.parse(lastSubmit.at);
  const latest = (annotations ?? [])
    .filter((a) => Date.parse(a.created_at) >= submittedAt)
    .toSorted((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .at(-1);
  return latest?.content;
}
