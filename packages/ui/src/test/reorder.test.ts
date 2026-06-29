import { describe, expect } from 'vitest';

import { reorderArgs } from '../lib/reorder';

const ids = ['A', 'B', 'C', 'D'];

describe('reorderArgs', () => {
  it('dragging down lands after the drop neighbor', () => {
    expect(reorderArgs('A', 'C', ids)).toStrictEqual({ after: 'C' });
  });

  it('dragging up lands before the drop neighbor', () => {
    expect(reorderArgs('D', 'B', ids)).toStrictEqual({ before: 'B' });
  });

  it('dropping onto itself is a no-op', () => {
    expect(reorderArgs('B', 'B', ids)).toBeNull();
  });

  it('unknown ids are a no-op', () => {
    expect(reorderArgs('A', 'Z', ids)).toBeNull();
    expect(reorderArgs('Z', 'A', ids)).toBeNull();
  });
});
