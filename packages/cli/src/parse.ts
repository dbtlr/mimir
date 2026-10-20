/**
 * The value grammar of the query flags. Loom parses the words; these read the
 * values and refuse a bad one as a Mimir usage error (exit 2), in the old CLI's
 * words, before the Engine is asked.
 */
import {
  FACET_NAMES,
  PRIORITY_VALUES,
  PROJECT_STATUS_SELECTOR_VALUES,
  QUERY_OP_VALUES,
  SEED_KIND_VALUES,
  SEED_STATUS_SELECTOR_VALUES,
  SIZE_VALUES,
  STATUS_SELECTOR_VALUES,
  VERDICT_VALUES,
} from '@mimir/contract';
import type {
  DateOp,
  FacetName,
  FieldFilter,
  Priority,
  ProjectStatusSelector,
  QueryOp,
  SeedKind,
  SeedStatusSelector,
  Size,
  StatusSelector,
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
export function parseFacets(cols: readonly string[], verb: 'next' | 'list' | 'get'): FacetName[] {
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

/** A seed kind from the closed set; `undefined` stays absent. */
export function parseSeedKind(value: string): SeedKind;
export function parseSeedKind(value: string | undefined): SeedKind | undefined;
export function parseSeedKind(value: string | undefined): SeedKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isMember(value, SEED_KIND_VALUES)) {
    throw usage(`invalid kind: ${value} (expected ${SEED_KIND_VALUES.join('|')})`);
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

/** The `list --status` universe: a status word, `live`, or `all`. */
export function parseStatus(value: string | undefined): StatusSelector | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isMember(value, STATUS_SELECTOR_VALUES)) {
    // `archived` was the project shelf's door before `projects` existed; name the verb that owns it.
    throw usage(
      `invalid status: ${value} (expected ${STATUS_SELECTOR_VALUES.join('|')})`,
      value === 'archived'
        ? "archived projects are listed by 'mimir projects --status archived'"
        : undefined,
    );
  }
  return value;
}

/** The `projects --status` shelf: active (the default), archived, or all. */
export function parseProjectStatus(value: string | undefined): ProjectStatusSelector {
  if (value === undefined) {
    return 'active';
  }
  if (!isMember(value, PROJECT_STATUS_SELECTOR_VALUES)) {
    throw usage(`invalid status: ${value} (expected ${PROJECT_STATUS_SELECTOR_VALUES.join('|')})`);
  }
  return value;
}

/** The seed queue `--status`: a lifecycle word, `live`, or `all`; absent means the Engine's default. */
export function parseSeedStatus(value: string | undefined): SeedStatusSelector | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isMember(value, SEED_STATUS_SELECTOR_VALUES)) {
    throw usage(`invalid status: ${value} (expected ${SEED_STATUS_SELECTOR_VALUES.join('|')})`);
  }
  return value;
}

/** The seed queue `--sort`: age order, `asc` being oldest-first. */
export function parseSeedSort(value: string | undefined): 'asc' | 'desc' | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== 'asc' && value !== 'desc') {
    throw usage(`invalid sort: ${value} (expected asc|desc)`);
  }
  return value;
}

/** The artifact feed's paging cursor: a whole count of rows to skip. */
export function parseOffset(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) {
    throw usage(`invalid offset: ${value}`, 'offset is a whole count of rows to skip (0 or more)');
  }
  return n;
}

/** The search cap: a whole number from 1 to the Engine's maximum. */
export function parseSearchLimit(value: string | undefined, max: number): number | undefined {
  const limit = parseLimit(value);
  if (limit !== undefined && (limit < 1 || limit > max)) {
    throw usage(
      `invalid limit: ${String(limit)}`,
      `limit is a whole number from 1 to ${String(max)}`,
    );
  }
  return limit;
}

/**
 * The date filters of a feed with one date field (artifacts, seeds), refused as
 * usage when a token is malformed or a date unreadable.
 */
export function parseDateFeed(
  grammar: Grammar,
  tokens: Readonly<Record<DateOp, readonly string[]>>,
  field: string,
  zone: string,
): ReturnType<Grammar['dateFilters']> {
  try {
    return grammar.dateFilters(tokens, field, zone);
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

/**
 * The reason a verb records: the words before `--` and the words after it,
 * joined by single spaces. After `--` Loom stops reading options, so a reason
 * that begins with a dash (`park MMR-3 -- -1 day`) survives as text.
 */
export function reasonWords(words: readonly string[], afterDashes: readonly string[]): string {
  return [...words, ...afterDashes].join(' ');
}
