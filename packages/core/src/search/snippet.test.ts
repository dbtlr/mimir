import { describe, expect, test } from 'bun:test';

import { snippet } from './intent';

describe('snippet', () => {
  const long =
    'Opening words that run on for a good while before anything useful appears, then the seed page itself, ' +
    'followed by a long tail of prose that keeps going well past any reasonable preview length here.';

  test('cuts at word boundaries around the first matched word', () => {
    const text = snippet(long, ['seed']);
    expect(text).toContain('the seed page itself');
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    // The kept text starts and ends on whole words of the source.
    const inner = text.slice(1, -1);
    const at = long.indexOf(inner);
    expect(at).toBeGreaterThan(0);
    expect(long[at - 1]).toBe(' ');
    expect(long[at + inner.length]).toBe(' ');
  });

  test('a short description is whole, with no ellipsis', () => {
    expect(snippet('The **seed** page layout.', ['seed'])).toBe('The seed page layout.');
  });
});
