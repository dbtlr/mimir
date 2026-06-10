import {
  HOLD_VALUES,
  LIFECYCLE_VALUES,
  NODE_TYPE_VALUES,
  PRIORITY_VALUES,
  SIZE_VALUES,
  STATUS_WORD_VALUES,
} from "../contract/enums";
import type { FieldFilter, QueryOp, ValueWarning } from "../contract/query";
import { validation } from "./errors";

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

type FieldKind = "enum" | "string" | "date" | "tag";

interface FieldSpec {
  kind: FieldKind;
  values?: readonly string[];
}

export const QUERY_FIELDS: Record<string, FieldSpec> = {
  id: { kind: "string" },
  type: { kind: "enum", values: NODE_TYPE_VALUES },
  title: { kind: "string" },
  status: { kind: "enum", values: STATUS_WORD_VALUES },
  parent: { kind: "string" },
  description: { kind: "string" },
  priority: { kind: "enum", values: PRIORITY_VALUES },
  size: { kind: "enum", values: SIZE_VALUES },
  lifecycle: { kind: "enum", values: LIFECYCLE_VALUES },
  hold: { kind: "enum", values: HOLD_VALUES },
  hold_reason: { kind: "string" },
  target: { kind: "string" },
  external_ref: { kind: "string" },
  created_at: { kind: "date" },
  updated_at: { kind: "date" },
  completed_at: { kind: "date" },
  tag: { kind: "tag" },
};

const DATE_OPS: readonly QueryOp[] = ["before", "on", "after", "not-before", "not-after"];
const EQUALITY_OPS: readonly QueryOp[] = ["eq", "not-eq", "in", "not-in"];

/**
 * Parse one `FIELD:VALUE` token (bare `FIELD` for has/missing) into a
 * {@link FieldFilter}, validating the structure: the field must exist and the
 * operator must fit its type. Throws `validation` — the CLI rethrows as usage.
 */
export function parseFilterToken(op: QueryOp, token: string): FieldFilter {
  const bare = op === "has" || op === "missing";
  let field = token;
  let value: string | null = null;
  if (!bare) {
    const split = token.indexOf(":");
    if (split <= 0) {
      throw validation(`--${op} expects FIELD:VALUE, got "${token}"`);
    }
    field = token.slice(0, split);
    value = token.slice(split + 1);
  }
  const spec = QUERY_FIELDS[field];
  if (spec === undefined) {
    throw validation(`unknown field ${field}`, `fields: ${Object.keys(QUERY_FIELDS).join(", ")}`);
  }
  if (DATE_OPS.includes(op) && spec.kind !== "date") {
    throw validation(`--${op} applies to date fields, and ${field} is not one`);
  }
  if (EQUALITY_OPS.includes(op) && spec.kind === "date") {
    throw validation(
      `--${op} does not apply to date field ${field}`,
      "use --on / --before / --after",
    );
  }
  return { op, field, value };
}

/** A row under filter evaluation — external-name scalar values + the tag set. */
export interface QueryRow {
  values: Record<string, string | null>;
  tags: readonly string[];
}

export interface CompiledFilters {
  /** Value faults — when non-empty the whole selection is an empty set. */
  warnings: ValueWarning[];
  /** Field names the evaluator reads — lets callers skip costly extraction (id/parent rendering, tag loads). */
  needed: ReadonlySet<string>;
  test: (row: QueryRow) => boolean;
}

interface DateBounds {
  /** Inclusive lower bound (ms). */
  start: number;
  /** Exclusive upper bound (ms). */
  end: number;
}

/** A date value: `YYYY-MM-DD` (a day window) or a full ISO timestamp (an instant). */
function parseDateValue(value: string): DateBounds | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const start = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isNaN(start)) return null;
    return { start, end: start + 24 * 60 * 60 * 1000 };
  }
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) return null;
  return { start: instant, end: instant + 1 };
}

function warn(field: string, value: string, message: string, expected: string[]): ValueWarning {
  return { code: "no_match_value", field, value, message, expected };
}

const splitCsv = (csv: string): string[] =>
  csv
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

type RowTest = (row: QueryRow) => boolean;

function compileOne(filter: FieldFilter, warnings: ValueWarning[]): RowTest {
  const spec = QUERY_FIELDS[filter.field];
  if (spec === undefined) {
    throw validation(`unknown field ${filter.field}`);
  }
  const { op, field } = filter;
  const value = filter.value ?? "";

  if (op === "has" || op === "missing") {
    const has: RowTest =
      spec.kind === "tag"
        ? (row) => row.tags.length > 0
        : (row) => row.values[field] != null && row.values[field] !== "";
    return op === "has" ? has : (row) => !has(row);
  }

  if (spec.kind === "date") {
    const bounds = parseDateValue(value);
    if (bounds === null) {
      warnings.push(
        warn(field, value, `${value} is not a date`, ["YYYY-MM-DD", "ISO-8601 timestamp"]),
      );
      return () => false;
    }
    const at = (row: QueryRow): number | null => {
      const raw = row.values[field];
      if (raw == null) return null;
      const ms = Date.parse(raw);
      return Number.isNaN(ms) ? null : ms;
    };
    const tests: Record<string, (ms: number) => boolean> = {
      before: (ms) => ms < bounds.start,
      after: (ms) => ms >= bounds.end,
      on: (ms) => ms >= bounds.start && ms < bounds.end,
      "not-before": (ms) => ms >= bounds.start,
      "not-after": (ms) => ms < bounds.end,
    };
    const test = tests[op];
    if (test === undefined) {
      throw validation(`--${op} does not apply to date field ${field}`);
    }
    return (row) => {
      const ms = at(row);
      return ms !== null && test(ms);
    };
  }

  // Equality family over enum / string / tag.
  const candidates = op === "in" || op === "not-in" ? splitCsv(value) : [value];
  if (spec.kind === "enum") {
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
    spec.kind === "tag"
      ? (row) => row.tags.some((t) => wanted.has(t))
      : (row) => {
          const raw = row.values[field];
          return raw != null && wanted.has(raw);
        };
  return op === "eq" || op === "in" ? matches : (row) => !matches(row);
}

/** Compile filters to a conjunctive row test + any value warnings (which force an empty set). */
export function compileFilters(filters: readonly FieldFilter[]): CompiledFilters {
  const warnings: ValueWarning[] = [];
  const tests = filters.map((f) => compileOne(f, warnings));
  const needed = new Set(filters.map((f) => f.field));
  return {
    warnings,
    needed,
    test: (row) => tests.every((t) => t(row)),
  };
}
