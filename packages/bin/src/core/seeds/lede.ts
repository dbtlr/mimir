/**
 * The seed lede (MMR-263) — a bounded, read-time projection of a seed's
 * `## Seed Description` prose. Nothing is stored: the list path batch-reads the
 * body section for live seeds and derives the lede here, single-sourced so every
 * transport (CLI queue, triage report, HTTP list wire → console preview) shows
 * the same preview (the derive-don't-store spine, ADR 0021).
 */

/** The lede character budget — the RETURNED lede never exceeds this many
 * characters, trailing ellipsis included (a truncation reserves one character
 * for it). A budget in characters (not lines) keeps the derivation
 * transport-neutral; the console applies its own 2-line CSS clamp on top.
 * Chosen minimal-but-legible: two console lines of body prose. */
export const SEED_LEDE_BUDGET = 240;

/**
 * Derive the bounded lede from a seed's description prose. Whitespace runs
 * (including newlines) collapse to single spaces so the lede is one clean flowed
 * string; an empty/whitespace-only or absent description yields `null` (no lede).
 * Longer prose is cut at the last word boundary that keeps the result — trailing
 * ellipsis included — within {@link SEED_LEDE_BUDGET}.
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
  // Reserve one character for the ellipsis so the returned string stays ≤ budget.
  const slice = flattened.slice(0, SEED_LEDE_BUDGET - 1);
  const lastSpace = slice.lastIndexOf(' ');
  // No space to cut on → hard cut, code-point-safe: a UTF-16 cut landing
  // mid-surrogate-pair would leave a lone high surrogate at the boundary (not a
  // valid string), so back off one unit when the last unit is a high surrogate.
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : trimLoneSurrogate(slice);
  return `${cut.trimEnd()}…`;
}

/** A high surrogate at the end of the string — the head of a pair the cut split. */
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/** Drop a trailing lone high surrogate — the tail of a pair the budget cut split. */
function trimLoneSurrogate(text: string): string {
  return TRAILING_HIGH_SURROGATE.test(text) ? text.slice(0, -1) : text;
}
