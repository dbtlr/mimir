import { describe, expect, it } from 'vitest';

import { cn } from '../lib/cn';

describe('cn — tailwind-merge with the Meridian type scale', () => {
  it('keeps a custom font-size when a text color follows (they are not one group)', () => {
    // Regression: the ActionButton outline variant + the archived shelf's
    // Unarchive className — text-mono-id must survive text-ink-dim.
    expect(cn('text-body text-ink', 'text-mono-id text-ink-dim')).toBe('text-mono-id text-ink-dim');
  });

  it('conflicts custom type-scale steps against each other and Tailwind sizes', () => {
    expect(cn('text-mono-id', 'text-tag')).toBe('text-tag');
    expect(cn('text-xs', 'text-body')).toBe('text-body');
  });

  it('keeps a font-size alongside a color within one class list', () => {
    expect(cn('text-body text-ink-dim')).toBe('text-body text-ink-dim');
  });
});
