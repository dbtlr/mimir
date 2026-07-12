import { describe, expect, test } from 'bun:test';

import { deriveLede, SEED_LEDE_BUDGET } from './lede';

/**
 * The seed lede derivation (MMR-263) — a pure, bounded read-time projection of a
 * seed's `## Seed Description` prose. Nothing here touches the vault.
 */
describe('deriveLede', () => {
  test('null / empty / whitespace-only description → no lede', () => {
    expect(deriveLede(null)).toBeNull();
    expect(deriveLede('')).toBeNull();
    expect(deriveLede('   \n\t  ')).toBeNull();
  });

  test('short prose is returned verbatim (whitespace normalized)', () => {
    expect(deriveLede('a rough idea')).toBe('a rough idea');
    // Newlines and runs collapse to single spaces — the body flows into one lede.
    expect(deriveLede('first line\n\nsecond   paragraph')).toBe('first line second paragraph');
  });

  test('prose at the budget is not truncated', () => {
    const exact = 'x'.repeat(SEED_LEDE_BUDGET);
    expect(deriveLede(exact)).toBe(exact);
  });

  test('over-budget prose truncates at a word boundary with an ellipsis', () => {
    const word = 'lorem ';
    const long = word.repeat(60).trim(); // 360 chars, all word-boundaried
    const lede = deriveLede(long);
    expect(lede).not.toBeNull();
    const value = lede ?? '';
    expect(value.endsWith('…')).toBe(true);
    // The extracted text (ellipsis aside) stays within the budget and cuts on a word.
    const text = value.slice(0, -1);
    expect(text.length).toBeLessThanOrEqual(SEED_LEDE_BUDGET);
    expect(text.endsWith(' ')).toBe(false);
    expect(long.startsWith(text)).toBe(true);
  });

  test('a single over-budget unbroken token is hard-cut (no word boundary to keep)', () => {
    const blob = 'y'.repeat(SEED_LEDE_BUDGET + 50);
    const lede = deriveLede(blob) ?? '';
    expect(lede.endsWith('…')).toBe(true);
    expect(lede.slice(0, -1).length).toBe(SEED_LEDE_BUDGET);
  });
});
