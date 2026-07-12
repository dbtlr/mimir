/**
 * The seed lede (MMR-263) — a bounded, read-time projection of a seed's
 * `## Seed Description` prose. Nothing is stored: the list path batch-reads the
 * body section for live seeds and derives the lede here, single-sourced so every
 * transport (CLI queue, triage report, HTTP list wire → console preview) shows
 * the same preview (the derive-don't-store spine, ADR 0021).
 */

/** The lede character budget — the extracted preview is truncated to this many
 * characters at a word boundary. A budget in characters (not lines) keeps the
 * derivation transport-neutral; the console applies its own 2-line CSS clamp on
 * top. Chosen minimal-but-legible: two console lines of body prose. */
export const SEED_LEDE_BUDGET = 240;

/**
 * Derive the bounded lede from a seed's description prose. Whitespace runs
 * (including newlines) collapse to single spaces so the lede is one clean flowed
 * string; an empty/whitespace-only or absent description yields `null` (no lede).
 * Prose longer than {@link SEED_LEDE_BUDGET} is cut at the last word boundary at
 * or before the budget and marked with a trailing ellipsis.
 */
export function deriveLede(description: string | null): string | null {
  if (description === null) {
    return null;
  }
  const flattened = description.replace(/\s+/g, ' ').trim();
  if (flattened === '') {
    return null;
  }
  if (flattened.length <= SEED_LEDE_BUDGET) {
    return flattened;
  }
  const slice = flattened.slice(0, SEED_LEDE_BUDGET);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}
