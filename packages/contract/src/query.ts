import { TASK_STATUS_WORD_VALUES } from './enums';

/**
 * The selection & filter vocabulary (MMR-33) — query surface v2. Three
 * orthogonal pieces, AND-composed, no OR (`in` covers within-field any-of):
 *
 * - `--status` picks the **universe**: one closed status word, or a union
 *   (`live` — the default, `terminal`, `all`).
 * - `--is` / `--not-is` select by **verdict** — the derived predicates that
 *   aren't statuses (`stale`, `blocking`, `orphaned`).
 * - **Field operators** filter within the universe — Norn's dogfooded `find`
 *   dialect, ported verbatim. Queryable fields = the projection's bare
 *   fields (no second vocabulary); `tag` is a multi-valued pseudo-field.
 */

/**
 * The `--status` universe vocabulary: the closed task-reachable words + the
 * three unions, plus `archived` — the door to the hidden shelf (ADR 0015):
 * `list --status archived` lists the archived *projects*, the sole opt-in that
 * surfaces what default reads hide.
 */
export const STATUS_SELECTOR_VALUES = [
  ...TASK_STATUS_WORD_VALUES,
  'live',
  'terminal',
  'all',
  'archived',
] as const;
export type StatusSelector = (typeof STATUS_SELECTOR_VALUES)[number];

/** The verdict vocabulary — derived predicates selectable via `--is` / `--not-is`. */
export const VERDICT_VALUES = ['stale', 'blocking', 'orphaned'] as const;
export type Verdict = (typeof VERDICT_VALUES)[number];

/** A verdict selection — `--is stale` / `--not-is blocking`; repeatable, AND-ed. */
export type VerdictSelector = {
  verdict: Verdict;
  negate: boolean;
};

/**
 * The date-operator vocabulary (ADR 0029) — the ONE grammar every date-bearing
 * resource speaks: nodes' three timestamps, an artifact's `created_at`, a seed's
 * `created_at`. `on` takes a bare calendar date; the other four take a bare date
 * or an explicitly zoned timestamp. Bare dates resolve through the caller's IANA
 * timezone, so the window is that caller's calendar day.
 */
export const DATE_OP_VALUES = ['before', 'on', 'after', 'at-or-before', 'at-or-after'] as const;
export type DateOp = (typeof DATE_OP_VALUES)[number];

/** The field-operator vocabulary (Norn `find` dialect) + the date ops. */
export const QUERY_OP_VALUES = [
  'eq',
  'not-eq',
  'in',
  'not-in',
  'has',
  'missing',
  ...DATE_OP_VALUES,
] as const;
export type QueryOp = (typeof QUERY_OP_VALUES)[number];

/** One parsed field filter — `value` is the raw text (csv for `in`), null for has/missing. */
export type FieldFilter = {
  op: QueryOp;
  field: string;
  value: string | null;
};

/**
 * A value fault — a well-formed request that can't match anything (enum miss,
 * unparseable date). Not an error: the result is an empty set + this warning
 * (zod-style `expected` correction info); the *caller* decides whether its
 * own drift is an error. Structural faults (unknown field, operator-type
 * mismatch) stay hard errors.
 */
export type ValueWarning = {
  code: 'no_match_value';
  field: string;
  value: string;
  message: string;
  expected: string[];
};
