/** What makes a value fail as a decision's `option_details` (ADR 0043, MMR-705 refinement). */
export type OptionDetailsFault = 'not-a-list' | 'length' | 'entry' | 'no-detail';

/** Whether a details list carries no detail at all, which the store keeps as null. */
export function carriesNoDetail(details: readonly unknown[]): boolean {
  return details.every((detail) => detail === null);
}

/**
 * Why `details` is not an option_details list for `optionCount` options, or
 * null when it is: a list as long as the options, each entry null or nonblank
 * text. A stored list must also carry a detail; `allowAllNull` admits a list
 * of nulls, as `decide` does before it stores null.
 */
export function optionDetailsFault(
  details: unknown,
  optionCount: number,
  { allowAllNull }: { allowAllNull: boolean },
): OptionDetailsFault | null {
  if (!Array.isArray(details)) {
    return 'not-a-list';
  }
  if (details.length !== optionCount) {
    return 'length';
  }
  if (
    !details.every(
      (detail) => detail === null || (typeof detail === 'string' && detail.trim() !== ''),
    )
  ) {
    return 'entry';
  }
  if (!allowAllNull && carriesNoDetail(details)) {
    return 'no-detail';
  }
  return null;
}
