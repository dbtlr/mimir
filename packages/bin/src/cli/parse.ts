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

export function parseSize(value: string | undefined): Size | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isMember(value, SIZE_VALUES)) {
    throw usage(`invalid size: ${value} (expected ${SIZE_VALUES.join('|')})`);
  }
  return value;
}
