import { DATE_OP_VALUES, NODE_TYPE_VALUES, STATUS_WORD_VALUES } from '@mimir/contract';
import type { DateOp, FieldFilter, QueryOp, ValueWarning } from '@mimir/contract';

import { dateFilterWindow, withinWindow } from './dates';
import { validation } from './errors';
import { dataQueryFields } from './field-spec';

/**
 * The field-operator compiler (MMR-33). Structural faults — unknown field,
 * operator on an incompatible type — throw `validation` at parse time (the
 * caller's program is wrong; the CLI maps this to `usage`). Value faults —
 * enum miss, unparseable date — compile to a {@link ValueWarning} and an
 * empty result, never an error.
 *
 * Queryable fields are the projection's bare fields (external snake_case
 * names — no second vocabulary), plus the multi-valued `tag` pseudo-field.
 */

type FieldKind = 'enum' | 'string' | 'date' | 'tag';

type FieldSpec = {
  kind: FieldKind;
  values?: readonly string[];
};

/**
 * The structural (identity/topology) query fields — id, parent, type, the tag
 * pseudo-field, the derived `status` word, and the timestamps. These are NOT in
 * the data-plane field spec (ADR 0025): they are what makes a node a node, or a
 * derived/timestamp value, so they stay bespoke here. `description` is
 * deliberately absent (MMR-162): it is body prose read per node, not a
 * bulk-cheap frontmatter field — the short `summary` lede (a spec field) is the
 * queryable stand-in.
 */
const STRUCTURAL_QUERY_FIELDS: Record<string, FieldSpec> = {
  completed_at: { kind: 'date' },
  created_at: { kind: 'date' },
  id: { kind: 'string' },
  parent: { kind: 'string' },
  status: { kind: 'enum', values: STATUS_WORD_VALUES },
  tag: { kind: 'tag' },
  title: { kind: 'string' },
  type: { kind: 'enum', values: NODE_TYPE_VALUES },
  updated_at: { kind: 'date' },
};

/** Ascending key compare without a nested ternary (canonical alphabetical order). */
function byKey([a]: [string, FieldSpec], [b]: [string, FieldSpec]): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * The queryable field registry (MMR-33): the structural fields above merged with
 * the data-plane fields projected from the field spec (ADR 0025 — priority/size/
 * lifecycle/hold as enums, summary/target/external_ref/upstream/hold_reason as
 * strings; `open_ended` is not queryable and so absent). Alphabetized so the
 * unknown-field hint lists every field in canonical order.
 */
export const QUERY_FIELDS: Record<string, FieldSpec> = Object.fromEntries(
  Object.entries({ ...STRUCTURAL_QUERY_FIELDS, ...dataQueryFields() }).toSorted(byKey),
);

const DATE_OPS: ReadonlySet<QueryOp> = new Set<QueryOp>(DATE_OP_VALUES);
const EQUALITY_OPS: ReadonlySet<QueryOp> = new Set(['eq', 'not-eq', 'in', 'not-in']);

const isDateOp = (op: QueryOp): op is DateOp => DATE_OPS.has(op);

/**
 * Parse one `FIELD:VALUE` token (bare `FIELD` for has/missing) into a
 * {@link FieldFilter}, validating the structure: the field must exist and the
 * operator must fit its type. Throws `validation` — the CLI rethrows as usage.
 */
export function parseFilterToken(op: QueryOp, token: string): FieldFilter {
  const bare = op === 'has' || op === 'missing';
  let field = token;
  let value: string | null = null;
  if (!bare) {
    const split = token.indexOf(':');
    if (split <= 0) {
      throw validation(`--${op} expects FIELD:VALUE, got "${token}"`);
    }
    field = token.slice(0, split);
    value = token.slice(split + 1);
  }
  const spec = QUERY_FIELDS[field];
  if (spec === undefined) {
    throw validation(`unknown field ${field}`, `fields: ${Object.keys(QUERY_FIELDS).join(', ')}`);
  }
  if (DATE_OPS.has(op) && spec.kind !== 'date') {
    throw validation(`--${op} applies to date fields, and ${field} is not one`);
  }
  if (EQUALITY_OPS.has(op) && spec.kind === 'date') {
    throw validation(
      `--${op} does not apply to date field ${field}`,
      `use ${DATE_OP_VALUES.map((dateOp) => `--${dateOp}`).join(' / ')}`,
    );
  }
  return { field, op, value };
}

/**
 * Resolve every date filter now and discard the windows — the pre-flight a
 * transport runs to refuse a bad date BEFORE it opens a store (MMR-39). The
 * resolution itself is idempotent and storage-free, so doing it twice costs
 * nothing and keeps the refusal where the caller's mistake is.
 */
export function assertDateFilters(filters: readonly FieldFilter[], zone?: string): void {
  for (const filter of filters) {
    if (QUERY_FIELDS[filter.field]?.kind === 'date' && isDateOp(filter.op)) {
      dateFilterWindow(filter.op, filter.value ?? '', zone);
    }
  }
}

/** A row under filter evaluation — external-name scalar values + the tag set. */
export type QueryRow = {
  values: Record<string, string | null>;
  tags: readonly string[];
};

export type CompiledFilters = {
  /** Value faults — when non-empty the whole selection is an empty set. */
  warnings: ValueWarning[];
  /** Field names the evaluator reads — lets callers skip costly extraction (id/parent rendering, tag loads). */
  needed: ReadonlySet<string>;
  test: (row: QueryRow) => boolean;
};

function warn(field: string, value: string, message: string, expected: string[]): ValueWarning {
  return { code: 'no_match_value', expected, field, message, value };
}

const splitCsv = (csv: string): string[] =>
  csv
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

type RowTest = (row: QueryRow) => boolean;

function compileOne(
  filter: FieldFilter,
  zone: string | undefined,
  warnings: ValueWarning[],
): RowTest {
  const spec = QUERY_FIELDS[filter.field];
  if (spec === undefined) {
    throw validation(`unknown field ${filter.field}`);
  }
  const { op, field } = filter;
  const value = filter.value ?? '';

  if (op === 'has' || op === 'missing') {
    const has: RowTest =
      spec.kind === 'tag'
        ? (row) => row.tags.length > 0
        : (row) => row.values[field] != null && row.values[field] !== '';
    return op === 'has' ? has : (row) => !has(row);
  }

  if (spec.kind === 'date') {
    if (!isDateOp(op)) {
      throw validation(`--${op} does not apply to date field ${field}`);
    }
    // A malformed or calendar-impossible date is a REFUSAL, not a value warning
    // (ADR 0029): the old path rolled `2026-02-30` into March 2 and answered a
    // question nobody asked. The window itself comes from the shared date core,
    // resolved through the caller's zone.
    const window = dateFilterWindow(op, value, zone);
    return (row) => withinWindow(window, row.values[field]);
  }

  // Equality family over enum / string / tag.
  const candidates = op === 'in' || op === 'not-in' ? splitCsv(value) : [value];
  if (spec.kind === 'enum') {
    const allowed = spec.values ?? [];
    for (const candidate of candidates) {
      if (!allowed.includes(candidate)) {
        warnings.push(warn(field, candidate, `${candidate} is not a ${field}`, [...allowed]));
        return () => false;
      }
    }
  }
  const wanted = new Set(candidates);
  const matches: RowTest =
    spec.kind === 'tag'
      ? (row) => row.tags.some((t) => wanted.has(t))
      : (row) => {
          const raw = row.values[field];
          return raw != null && wanted.has(raw);
        };
  return op === 'eq' || op === 'in' ? matches : (row) => !matches(row);
}

/**
 * Compile filters to a conjunctive row test + any value warnings (which force an
 * empty set). `zone` is the caller's IANA timezone, through which every bare date
 * resolves (ADR 0029); a bare date with no zone is a refusal, not a guess.
 */
export function compileFilters(filters: readonly FieldFilter[], zone?: string): CompiledFilters {
  const warnings: ValueWarning[] = [];
  const tests = filters.map((f) => compileOne(f, zone, warnings));
  const needed = new Set(filters.map((f) => f.field));
  return {
    needed,
    test: (row) => tests.every((t) => t(row)),
    warnings,
  };
}
