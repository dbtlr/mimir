import type { BlockOwner, Hold } from '@mimir/contract';

/**
 * The block owner rules (ADR 0001, MMR-438), pure and shared by every path that
 * decides an owner: the `block` verb, the read normalization, the transfer
 * import, and (as literal SQL) migration `0003_block_owner`.
 *
 * The owner is meaningful only while the hold is `blocked`. A task that names an
 * upstream seed asked another board for help, so its default owner is `others`;
 * without one, the operator is the one who has to clear it.
 */

/** The owner a `blocked` task gets when none is stated: `others` iff it has an upstream. */
export function defaultBlockOwner(upstream: string | null): BlockOwner {
  return upstream === null ? 'you' : 'others';
}

/**
 * The owner a row reads as. Empty unless the hold is `blocked`; a blocked row
 * with no stored owner (written by a binary older than the column, or imported
 * from an older document) derives it by {@link defaultBlockOwner}.
 */
export function readBlockOwner(
  hold: Hold | null,
  stored: BlockOwner | null | undefined,
  upstream: string | null,
): BlockOwner | null {
  if (hold !== 'blocked') {
    return null;
  }
  return stored ?? defaultBlockOwner(upstream);
}
