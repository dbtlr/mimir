import { expect, test } from 'bun:test';

import { chunkByWeight, jsonBytes, READ_LIMITS } from './chunking';

/**
 * The byte-bounded batching rule (NRN-s30) on its own, without a vault: it is
 * what keeps a whole-vault read under the MCP transport's response cap, and the
 * cases below are the three edges that decide whether a chunk is safe.
 */

const LIMITS = { budget: 100, ceiling: 4 };

test('a chunk closes on the byte budget, not on a document count', () => {
  const chunks = chunkByWeight([40, 40, 40, 40], (weight) => weight, LIMITS);
  expect(chunks).toEqual([
    [40, 40],
    [40, 40],
  ]);
});

test('the count ceiling closes a chunk of documents too small to spend the budget', () => {
  const chunks = chunkByWeight([1, 1, 1, 1, 1, 1], (weight) => weight, LIMITS);
  expect(chunks).toEqual([
    [1, 1, 1, 1],
    [1, 1],
  ]);
});

test('an item heavier than the whole budget rides a chunk of its own', () => {
  // The caller cannot make one oversized document smaller, so it must not drag
  // its neighbours into the same over-cap call.
  const chunks = chunkByWeight([10, 500, 10], (weight) => weight, LIMITS);
  expect(chunks).toEqual([[10], [500], [10]]);
});

test('no items means no calls (an empty target list to vault.get is unverified)', () => {
  expect(chunkByWeight([], (weight: number) => weight, LIMITS)).toEqual([]);
});

test('the default read budget keeps a chunk of maximum-sized documents under the cap', () => {
  // The observed connection-close floor is ~3 MB; the default limits must not
  // be able to ask for that much even when every document is at the largest
  // size observed on a real vault (125 KB).
  const documents = Array.from({ length: READ_LIMITS.ceiling }, () => 64 * 1024);
  const [first = []] = chunkByWeight(documents, (weight) => weight, READ_LIMITS);
  expect(first.length * 125 * 1024).toBeLessThan(3_000_000);
});

test('jsonBytes measures the wire encoding, not the key count', () => {
  expect(jsonBytes({ a: 'x' })).toBe(9);
  expect(jsonBytes(undefined)).toBe(0);
});
