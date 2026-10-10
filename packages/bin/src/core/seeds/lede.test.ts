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
  describe('markdown projects to plain prose', () => {
    test('headings lose their # markers and do not glue to the next block', () => {
      expect(deriveLede('# Heading\n## Sub\nBody text')).toBe('Heading Sub Body text');
    });

    test('bold and italic lose their markers', () => {
      expect(deriveLede('some **bold** and *italic* and __strong__ and _em_ words')).toBe(
        'some bold and italic and strong and em words',
      );
    });

    test('inline code loses its backticks', () => {
      expect(deriveLede('run `bun test` now')).toBe('run bun test now');
    });

    test('links give their text only; images give their alt text', () => {
      expect(deriveLede('see [the docs](https://example.com/docs) now')).toBe('see the docs now');
      expect(deriveLede('look ![a diagram](https://example.com/d.png) here')).toBe(
        'look a diagram here',
      );
    });

    test('autolinks give the URL text', () => {
      expect(deriveLede('go to <https://example.com> soon')).toBe('go to https://example.com soon');
    });

    test('bulleted and ordered list items join with spaces and no markers', () => {
      expect(deriveLede('- one\n- two\n- three')).toBe('one two three');
      expect(deriveLede('1. first\n2. second\n3. third')).toBe('first second third');
    });

    test('task-list markers are stripped', () => {
      expect(deriveLede('- [ ] todo\n- [x] done\n- [X] also done')).toBe('todo done also done');
    });

    test('blockquotes lose their > marker', () => {
      expect(deriveLede('> quoted line\n> more quote\n\nafter')).toBe(
        'quoted line more quote after',
      );
    });

    test('hard breaks become a space', () => {
      expect(deriveLede('first  \nsecond\\\nthird')).toBe('first second third');
    });

    test('block-level html is dropped and thematic breaks vanish', () => {
      expect(deriveLede('before\n\n<div>raw</div>\n\n---\n\nafter')).toBe('before after');
      expect(deriveLede('> quoted\n>\n> <div>raw</div>\n\nafter')).toBe('quoted after');
      expect(deriveLede('- item\n\n  <div>raw</div>')).toBe('item');
    });

    test('inline angle-bracket placeholders keep their literal text', () => {
      expect(deriveLede('run mimir get <id> first')).toBe('run mimir get <id> first');
      expect(deriveLede('waiting on <KEY-s3>')).toBe('waiting on <KEY-s3>');
      expect(deriveLede('# see <id>\n\n**use <id>**')).toBe('see <id> use <id>');
    });

    test('html comments are dropped wherever they appear', () => {
      expect(deriveLede('before <!-- note --> after')).toBe('before after');
      expect(deriveLede('before\n\n<!-- note -->\n\nafter')).toBe('before after');
    });

    test('fenced and indented code blocks are dropped', () => {
      expect(deriveLede('intro\n\n```ts\nconst x = 1;\n```\n\noutro')).toBe('intro outro');
      expect(deriveLede('intro\n\n    indented code\n\noutro')).toBe('intro outro');
    });

    test('a code-only body has no prose, so no lede', () => {
      expect(deriveLede('```\nconst x = 1;\n```')).toBeNull();
      expect(deriveLede('    just code')).toBeNull();
    });

    test('adjacent blocks never glue their words together', () => {
      expect(deriveLede('# Title\nParagraph one.\n\n- item\n\n> quote')).toBe(
        'Title Paragraph one. item quote',
      );
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
    });

    test('plain prose is unchanged', () => {
      expect(deriveLede('a rough idea, with punctuation: it works (mostly).')).toBe(
        'a rough idea, with punctuation: it works (mostly).',
      );
    });
  });
});
