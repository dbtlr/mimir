import { describe, expect, test } from 'bun:test';

import { z } from 'zod';

import { parseJson } from './json';

describe('parseJson', () => {
  test('typed-cast form returns the parsed value', () => {
    const x = parseJson<{ a: number }>('{"a":1}');
    expect(x.a).toBe(1);
  });

  test('validated form returns the validated value', () => {
    const schema = z.object({ a: z.number() });
    expect(parseJson('{"a":1}', schema)).toEqual({ a: 1 });
  });

  test('validated form throws on a schema mismatch', () => {
    const schema = z.object({ a: z.number() });
    expect(() => parseJson('{"a":"nope"}', schema)).toThrow(/parseJson/);
  });

  test('propagates JSON syntax errors', () => {
    expect(() => parseJson('{bad')).toThrow();
  });
});
