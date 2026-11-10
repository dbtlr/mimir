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

  // Seed bodies are markdown (MMR-457): the lede is plain prose, never raw markup.
  // Each row packs the constructs that share a branch of the projection.
  test.each([
    [
      'headings, lists, task lists, and quotes lose their markers and never glue blocks together',
      '# Title\nParagraph one.\n\n- one\n- [x] done\n- [ ] todo\n\n1. first\n\n> quote',
      'Title Paragraph one. one done todo first quote',
    ],
    [
      'emphasis and inline code lose their markers, and hard breaks become a space',
      'some **bold** and *italic* and __strong__ and _em_ run `bun test`  \nnext\\\nlast',
      'some bold and italic and strong and em run bun test next last',
    ],
    [
      'links, autolinks, and images give their text',
      'see [the docs](https://example.com/docs) and <https://example.com> and ![a diagram](https://example.com/d.png)',
      'see the docs and https://example.com and a diagram',
    ],
    [
      'fenced and indented code, block html in the body, a quote, or a list item, and thematic breaks are dropped',
      'intro\n\n```ts\nconst x = 1;\n```\n\n    indented code\n\n<div>raw</div>\n\n> kept\n>\n> <div>quoted</div>\n\n---\n\noutro\n\n- item\n\n  <div>listed</div>',
      'intro kept outro item',
    ],
    [
      'html comments are dropped inline and as blocks',
      'before <!-- note --> mid\n\n<!-- block -->\n\nafter',
      'before mid after',
    ],
    [
      'inline angle-bracket placeholders keep their literal text',
      'run mimir get <id> first, waiting on <KEY-s3>\n\n# see <id>',
      'run mimir get <id> first, waiting on <KEY-s3> see <id>',
    ],
    ['a code-only body has no prose, so no lede', '```\nconst x = 1;\n```', null],
  ])('%s', (_name, markdown, lede) => {
    expect(deriveLede(markdown)).toBe(lede);
  });

  test('a long markdown body still respects the budget, word boundary and ellipsis', () => {
    const body = `# Heading\n\n${'**lorem** [ipsum](https://example.com) `dolor` '.repeat(40)}`;
    const value = deriveLede(body) ?? '';
    expect(value.endsWith('…')).toBe(true);
    expect(value.length).toBeLessThanOrEqual(SEED_LEDE_BUDGET);
    expect(value).not.toMatch(/[*`[\]#(]/);
    const text = value.slice(0, -1);
    expect(text.endsWith(' ')).toBe(false);
    // Cut on a whole word: the next character of the plain text is a space.
    const plain = `Heading ${'lorem ipsum dolor '.repeat(40)}`.trim();
    expect(plain.startsWith(text)).toBe(true);
    expect(plain[text.length]).toBe(' ');
    // The markup is projected away before the cut, so the prose fills the budget to within a word.
    expect(text.length).toBeGreaterThan(SEED_LEDE_BUDGET - 1 - 'lorem '.length);
  });
});
