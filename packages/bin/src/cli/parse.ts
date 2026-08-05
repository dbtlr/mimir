/**
 * Shared parse helpers for flag values used by both read commands (run.ts) and
 * write-verb handlers (mutations.ts). Extracted to avoid a run ↔ mutations
 * import cycle: run.ts imports handlers from mutations.ts, so mutations.ts must
 * not import from run.ts.
 */

import { PRIORITY_VALUES, SIZE_VALUES } from '@mimir/contract';
import type { Priority, Size } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import {
  MimirError,
  dateFilterWindows,
  parseDateFilterTokens,
  requireTimeZone,
  systemTimeZone,
} from '../core';
import type { DateFilter } from '../core';
import { usage } from './errors';

/** Re-raise a core refusal as a CLI usage error (exit 2), hint intact. */
function asUsage(error: unknown): never {
  if (error instanceof MimirError) {
    throw usage(error.message, error.hint);
  }
  throw error;
}

/**
 * The caller's IANA timezone (ADR 0029): the explicit `--tz` override, else the
 * invoking system's own zone. The CLI therefore always has one, so a bare
 * `YYYY-MM-DD` always means the operator's calendar day — never UTC's.
 */
export function callerTimeZone(explicit: string | undefined): string {
  try {
    return requireTimeZone(explicit) ?? systemTimeZone();
  } catch (error) {
    return asUsage(error);
  }
}

/**
 * The date filters of a single-date-field feed (artifacts, seeds) — the same
 * `--on` / `--before` / `--after` / `--at-or-before` / `--at-or-after FIELD:VALUE`
 * grammar `list` and `next` speak, parsed by the shared core so no transport
 * carries a second date dialect (ADR 0029).
 */
export function parseDateFilters(
  values: Record<string, unknown>,
  field: string,
  zone: string,
): DateFilter[] {
  try {
    const filters = parseDateFilterTokens((op) => {
      const tokens = values[op];
      return Array.isArray(tokens) ? tokens.filter((t) => typeof t === 'string') : [];
    }, field);
    // Resolve now and throw the window away: a bad date must be refused before
    // the verb opens a store (MMR-39), and resolution is storage-free.
    dateFilterWindows(filters, zone);
    return filters;
  } catch (error) {
    return asUsage(error);
  }
}

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
