import { describe, expect, test } from 'bun:test';

import { parseJson } from './index';
import type { StandardSchemaV1 } from './index';

/** A hand-rolled Standard Schema, so the test stays dependency-free like the package. */
const numberSchema: StandardSchemaV1<number> = {
  '~standard': {
    validate: (v) =>
      typeof v === 'number' ? { value: v } : { issues: [{ message: 'expected a number' }] },
    vendor: 'test',
    version: 1,
  },
};

describe('parseJson', () => {
  test('typed-cast form returns the parsed value', () => {
    const x = parseJson<{ a: number }>('{"a":1}');
    expect(x.a).toBe(1);
  });

  test('validated form returns the validated value', () => {
    expect(parseJson('42', numberSchema)).toBe(42);
  });

  test('validated form throws on a schema mismatch', () => {
    expect(() => parseJson('"nope"', numberSchema)).toThrow(/parseJson: expected a number/);
  });

  test('propagates JSON syntax errors', () => {
    expect(() => parseJson('{bad')).toThrow();
  });
});
