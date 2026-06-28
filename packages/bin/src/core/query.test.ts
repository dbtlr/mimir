import { describe, expect, test } from 'bun:test';

import type { QueryRow } from './query';
import { compileFilters, parseFilterToken } from './query';
import { expectMimirError } from './testing';

const row = (values: Record<string, string | null>, tags: string[] = []): QueryRow => ({
  values,
  tags,
});

describe('parseFilterToken (structural validation)', () => {
  test('splits FIELD:VALUE and accepts bare FIELD for has/missing', () => {
    expect(parseFilterToken('eq', 'priority:p1')).toEqual({
      op: 'eq',
      field: 'priority',
      value: 'p1',
    });
    expect(parseFilterToken('missing', 'size')).toEqual({
      op: 'missing',
      field: 'size',
      value: null,
    });
    // a colon in the value survives (timestamps)
    expect(parseFilterToken('before', 'created_at:2026-06-10T13:00:00Z').value).toBe(
      '2026-06-10T13:00:00Z',
    );
  });

  test('unknown field and wrong-type operators are hard validation errors', async () => {
    await expectMimirError('validation', async () => parseFilterToken('eq', 'bogus:x'));
    await expectMimirError('validation', async () => parseFilterToken('before', 'priority:p1'));
    await expectMimirError('validation', async () => parseFilterToken('eq', 'created_at:x'));
    await expectMimirError('validation', async () => parseFilterToken('eq', ':novalue'));
  });
});

describe('compileFilters (value faults → warnings)', () => {
  test('an enum miss compiles to a warning with expected values', () => {
    const { warnings, test: run } = compileFilters([{ op: 'eq', field: 'priority', value: 'p9' }]);
    expect(warnings).toEqual([
      {
        code: 'no_match_value',
        field: 'priority',
        value: 'p9',
        message: 'p9 is not a priority',
        expected: ['p0', 'p1', 'p2', 'p3'],
      },
    ]);
    expect(run(row({ priority: 'p1' }))).toBe(false);
  });

  test('an unparseable date compiles to a warning', () => {
    const { warnings } = compileFilters([{ op: 'before', field: 'created_at', value: 'notadate' }]);
    expect(warnings[0]?.code).toBe('no_match_value');
    expect(warnings[0]?.expected).toEqual(['YYYY-MM-DD', 'ISO-8601 timestamp']);
  });
});

describe('filter evaluation', () => {
  test('eq / not-eq / in / not-in over scalars', () => {
    const eq = compileFilters([{ op: 'eq', field: 'priority', value: 'p1' }]).test;
    expect(eq(row({ priority: 'p1' }))).toBe(true);
    expect(eq(row({ priority: 'p2' }))).toBe(false);
    expect(eq(row({ priority: null }))).toBe(false);

    const notEq = compileFilters([{ op: 'not-eq', field: 'priority', value: 'p1' }]).test;
    expect(notEq(row({ priority: null }))).toBe(true); // null ≠ p1

    const anyOf = compileFilters([{ op: 'in', field: 'priority', value: 'p0,p1' }]).test;
    expect(anyOf(row({ priority: 'p1' }))).toBe(true);
    expect(anyOf(row({ priority: 'p3' }))).toBe(false);

    const noneOf = compileFilters([{ op: 'not-in', field: 'priority', value: 'p0,p1' }]).test;
    expect(noneOf(row({ priority: 'p3' }))).toBe(true);
    expect(noneOf(row({ priority: null }))).toBe(true);
  });

  test('has / missing over scalars and the tag pseudo-field', () => {
    const has = compileFilters([{ op: 'has', field: 'size', value: null }]).test;
    expect(has(row({ size: 'small' }))).toBe(true);
    expect(has(row({ size: null }))).toBe(false);

    const untagged = compileFilters([{ op: 'missing', field: 'tag', value: null }]).test;
    expect(untagged(row({}, []))).toBe(true);
    expect(untagged(row({}, ['x']))).toBe(false);
  });

  test('tag semantics: eq=contains, in=any, not-in=none', () => {
    const contains = compileFilters([{ op: 'eq', field: 'tag', value: 'spec' }]).test;
    expect(contains(row({}, ['spec', 'v2']))).toBe(true);
    expect(contains(row({}, ['v2']))).toBe(false);

    const any = compileFilters([{ op: 'in', field: 'tag', value: 'spec,plan' }]).test;
    expect(any(row({}, ['plan']))).toBe(true);

    const none = compileFilters([{ op: 'not-in', field: 'tag', value: 'spec,plan' }]).test;
    expect(none(row({}, ['other']))).toBe(true);
    expect(none(row({}, ['plan']))).toBe(false);
  });

  test('date ops: day windows for date-only values, inclusive not-variants', () => {
    const at = (ts: string) => row({ created_at: ts });
    const day = '2026-06-10';
    const inDay = `${day}T12:00:00.000Z`;
    const dayBefore = '2026-06-09T23:59:59.999Z';
    const dayAfter = '2026-06-11T00:00:00.000Z';

    const before = compileFilters([{ op: 'before', field: 'created_at', value: day }]).test;
    expect(before(at(dayBefore))).toBe(true);
    expect(before(at(inDay))).toBe(false);

    const on = compileFilters([{ op: 'on', field: 'created_at', value: day }]).test;
    expect(on(at(inDay))).toBe(true);
    expect(on(at(dayBefore))).toBe(false);
    expect(on(at(dayAfter))).toBe(false);

    const after = compileFilters([{ op: 'after', field: 'created_at', value: day }]).test;
    expect(after(at(dayAfter))).toBe(true);
    expect(after(at(inDay))).toBe(false);

    const notBefore = compileFilters([{ op: 'not-before', field: 'created_at', value: day }]).test;
    expect(notBefore(at(inDay))).toBe(true); // inclusive lower bound
    expect(notBefore(at(dayBefore))).toBe(false);

    const notAfter = compileFilters([{ op: 'not-after', field: 'created_at', value: day }]).test;
    expect(notAfter(at(inDay))).toBe(true); // inclusive upper bound
    expect(notAfter(at(dayAfter))).toBe(false);

    // a null date never matches any date op
    expect(on(row({ created_at: null }))).toBe(false);
  });

  test('filters AND-compose', () => {
    const both = compileFilters([
      { op: 'eq', field: 'priority', value: 'p1' },
      { op: 'has', field: 'size', value: null },
    ]).test;
    expect(both(row({ priority: 'p1', size: 'small' }))).toBe(true);
    expect(both(row({ priority: 'p1', size: null }))).toBe(false);
  });
});
