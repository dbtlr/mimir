import { describe, expect, test } from 'bun:test';

import { parseJson, parsePort } from './index';
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

describe('parsePort', () => {
  test('accepts an integer in 1–65535', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
    expect(parsePort('64747')).toBe(64747);
  });

  test('rejects 0, negatives, out-of-range, and non-numeric input', () => {
    expect(parsePort('0')).toBeNull();
    expect(parsePort('-1')).toBeNull();
    expect(parsePort('65536')).toBeNull();
    expect(parsePort('70000')).toBeNull();
    expect(parsePort('nope')).toBeNull();
    expect(parsePort('64.5')).toBeNull();
    expect(parsePort('')).toBeNull();
  });
});
