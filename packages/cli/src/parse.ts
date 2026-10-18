/**
 * The value grammar of the query flags. Loom parses the words; these read the
 * values and refuse a bad one as a Mimir usage error (exit 2), in the old CLI's
 * words, before the Engine is asked.
 */
import {
  FACET_NAMES,
  PRIORITY_VALUES,
  QUERY_OP_VALUES,
  SIZE_VALUES,
  VERDICT_VALUES,
} from '@mimir/contract';
import type {
  FacetName,
  FieldFilter,
  Priority,
  QueryOp,
  Size,
  VerdictSelector,
} from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import { asUsage, MimirUsageError } from './failures';
import type { Grammar } from './ports';

const usage = (message: string, hint?: string): MimirUsageError =>
  new MimirUsageError(message, hint);

/** The bare columns every record shows; naming one in `--col` treats it as a projection. */
const BASE_COLUMN_NAMES = [
  'id',
  'type',
  'title',
  'status',
  'parent',
  'summary',
  'priority',
  'size',
  'lifecycle',
  'hold',
  'target',
  'created',
  'updated',
  'completed',
] as const;

/**
 * The `--col` facets, comma-separated or repeated. `content` is the artifact
 * body and a node simply has none; `lede` is a list column, refused on `get`.
 */
export function parseFacets(cols: readonly string[], verb: 'next' | 'get'): FacetName[] {
  const facets: FacetName[] = [];
  for (const raw of cols.flatMap((c) => c.split(','))) {
    const col = raw.trim();
    if (col === '' || col === 'content') {
      continue;
    }
    if (col.startsWith('.')) {
      throw usage(`columns are flat now: --col ${col.slice(1)} (the dot prefix was dropped)`);
    }
    if (!isMember(col, FACET_NAMES)) {
      if (isMember(col, BASE_COLUMN_NAMES)) {
        throw usage(
          `--col adds optional columns; '${col}' is always shown`,
          `optional columns: ${[...FACET_NAMES, 'content'].join(', ')}`,
        );
      }
      throw usage(`unknown column: ${col}`, `columns: ${[...FACET_NAMES, 'content'].join(', ')}`);
    }
    if (col === 'lede' && verb === 'get') {
      throw usage(
        "'lede' is a list column; 'get' shows the full record",
        "try 'mimir list --col lede' or 'mimir next --col lede'",
      );
    }
    facets.push(col);
  }
  return facets;
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

/** A size by exact name or an unambiguous case-insensitive prefix, so `m` is `medium`. */
export function parseSize(value: string | undefined): Size | undefined {
  if (value === undefined) {
    return undefined;
  }
  const lower = value.toLowerCase();
  const hits = lower === '' ? [] : SIZE_VALUES.filter((size) => size.startsWith(lower));
  const [only] = hits.length === 1 ? hits : [];
  const size = isMember(lower, SIZE_VALUES) ? lower : only;
  if (size === undefined) {
    throw usage(`invalid size: ${value} (expected ${SIZE_VALUES.join('|')})`);
  }
  return size;
}

export function parseVerdicts(is: readonly string[], notIs: readonly string[]): VerdictSelector[] {
  const out: VerdictSelector[] = [];
  const take = (tokens: readonly string[], negate: boolean): void => {
    for (const token of tokens) {
      if (!isMember(token, VERDICT_VALUES)) {
        throw usage(`invalid verdict: ${token} (expected ${VERDICT_VALUES.join('|')})`);
      }
      out.push({ negate, verdict: token });
    }
  };
  take(is, false);
  take(notIs, true);
  return out;
}

/** A whole-token decimal row count: `-n 2x` and `-n 2.5` are refused, not truncated. */
export function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) {
    throw usage(`invalid limit: ${value}`, 'limit is a whole number of rows (0 or more)');
  }
  return n;
}

/** The caller's zone: an explicit `--tz`, validated, else `fallback` (the system's). */
export function parseZone(
  grammar: Grammar,
  explicit: string | undefined,
  fallback: string,
): string {
  try {
    return grammar.timeZone(explicit) ?? fallback;
  } catch (error) {
    return asUsage(error);
  }
}

/** The `FIELD:VALUE` filters of every query-op flag, in op order, with their dates checked. */
export function parseFilters(
  grammar: Grammar,
  tokens: Readonly<Record<QueryOp, readonly string[]>>,
  zone: string,
): FieldFilter[] {
  try {
    const filters = QUERY_OP_VALUES.flatMap((op) =>
      tokens[op].map((token) => grammar.filterToken(op, token)),
    );
    grammar.assertDates(filters, zone);
    return filters;
  } catch (error) {
    return asUsage(error);
  }
}
