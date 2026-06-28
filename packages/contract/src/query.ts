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

/** The `--status` universe vocabulary: the closed task-reachable words + the three unions. */
export const STATUS_SELECTOR_VALUES = [
  ...TASK_STATUS_WORD_VALUES,
  'live',
  'terminal',
  'all',
] as const;
export type StatusSelector = (typeof STATUS_SELECTOR_VALUES)[number];

/** The verdict vocabulary — derived predicates selectable via `--is` / `--not-is`. */
export const VERDICT_VALUES = ['stale', 'blocking', 'orphaned'] as const;
export type Verdict = (typeof VERDICT_VALUES)[number];

/** A verdict selection — `--is stale` / `--not-is blocking`; repeatable, AND-ed. */
export interface VerdictSelector {
  verdict: Verdict;
  negate: boolean;
}

/** The field-operator vocabulary (Norn `find` dialect). */
export const QUERY_OP_VALUES = [
  'eq',
  'not-eq',
  'in',
  'not-in',
  'has',
  'missing',
  'before',
  'on',
  'after',
  'not-before',
  'not-after',
] as const;
export type QueryOp = (typeof QUERY_OP_VALUES)[number];

/** One parsed field filter — `value` is the raw text (csv for `in`), null for has/missing. */
export interface FieldFilter {
  op: QueryOp;
  field: string;
  value: string | null;
}

/**
 * A value fault — a well-formed request that can't match anything (enum miss,
 * unparseable date). Not an error: the result is an empty set + this warning
 * (zod-style `expected` correction info); the *caller* decides whether its
 * own drift is an error. Structural faults (unknown field, operator-type
 * mismatch) stay hard errors.
 */
export interface ValueWarning {
  code: 'no_match_value';
  field: string;
  value: string;
  message: string;
  expected: string[];
}
