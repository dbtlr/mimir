/**
 * Shared parse helpers for flag values used by both read commands (run.ts) and
 * write-verb handlers (mutations.ts). Extracted to avoid a run ↔ mutations
 * import cycle: run.ts imports handlers from mutations.ts, so mutations.ts must
 * not import from run.ts.
 */

import { PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { Priority, Size } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import { usage } from './errors';

export function parsePriority(value: string | undefined): Priority | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isMember(value, PRIORITY_VALUES)) {
    throw usage(`invalid priority: ${value} (expected ${PRIORITY_VALUES.join('|')})`);
  }
  return value;
}

/**
 * Resolve `input` to a single allowed value by an exact match or an unambiguous
 * (case-insensitive) prefix — so `m` → `medium`. Returns undefined when nothing,
 * or more than one thing, matches (an empty input matches everything → ambiguous).
 */
function byPrefix<T extends string>(input: string, allowed: readonly T[]): T | undefined {
  const v = input.toLowerCase();
  if (isMember(v, allowed)) {
    return v;
  }
  if (v === '') {
    return undefined;
  }
  const hits = allowed.filter((a) => a.startsWith(v));
  return hits.length === 1 ? hits[0] : undefined;
}

export function parseSize(value: string | undefined): Size | undefined {
  if (value === undefined) {
    return undefined;
  }
  // Accept an unambiguous prefix (`m` → medium) — the help already promises
  // `--size <s|m|l>`, and small/medium/large share no initial.
  const size = byPrefix(value, SIZE_VALUES);
  if (size === undefined) {
    throw usage(`invalid size: ${value} (expected ${SIZE_VALUES.join('|')})`);
  }
  return size;
}
