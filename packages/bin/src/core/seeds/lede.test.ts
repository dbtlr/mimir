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
    // The RETURNED lede — ellipsis included — stays within the budget, cut on a word.
    expect(value.length).toBeLessThanOrEqual(SEED_LEDE_BUDGET);
    const text = value.slice(0, -1);
    expect(text.endsWith(' ')).toBe(false);
    expect(long.startsWith(text)).toBe(true);
  });

  test('a single over-budget unbroken token is hard-cut (no word boundary to keep)', () => {
    const blob = 'y'.repeat(SEED_LEDE_BUDGET + 50);
    const lede = deriveLede(blob) ?? '';
    expect(lede.endsWith('…')).toBe(true);
    // The RETURNED lede is exactly the budget: budget-1 content + the ellipsis.
    expect(lede.length).toBe(SEED_LEDE_BUDGET);
  });

  test('the hard cut never splits a surrogate pair (astral-heavy space-free body)', () => {
    // A space-free body of astral code points: a UTF-16 code-unit cut can land
    // mid-pair, leaving a lone high surrogate at the boundary — which is not a
    // valid string (encodeURIComponent throws on it). Both parities: one of the
    // two bodies puts the cut mid-pair whatever the (odd/even) budget cut-off is.
    for (const blob of ['😀'.repeat(200), `x${'😀'.repeat(200)}`]) {
      const lede = deriveLede(blob) ?? '';
      expect(() => encodeURIComponent(lede)).not.toThrow();
      // The cut backs off at most one unit — within (and near) the budget.
      expect(lede.length).toBeLessThanOrEqual(SEED_LEDE_BUDGET);
      expect(lede.length).toBeGreaterThanOrEqual(SEED_LEDE_BUDGET - 1);
    }
  });
});
