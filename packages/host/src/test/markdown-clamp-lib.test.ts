import { describe, expect, it } from 'vitest';

import { clampFit } from '../lib/markdown-clamp';

/** Line bottoms for `count` lines of 20px text, `pitch` apart, the first at the top. */
function lines(count: number, pitch = 20): number[] {
  return Array.from({ length: count }, (_, i) => i * pitch + 20);
}

describe('clampFit', () => {
  it('folds a text of more lines than the clamp at the bottom of its last whole line', () => {
    expect(
      clampFit({ bottoms: lines(5, 32), clamp: 3, contentHeight: 148, lineHeight: 20 }),
    ).toEqual({ height: 84, overflowing: true });
  });

  it('folds three short lines followed by rules below their third line, though no fourth line of text exists', () => {
    // Ten horizontal rules run the content 250px past the third line's bottom.
    expect(clampFit({ bottoms: lines(3), clamp: 3, contentHeight: 310, lineHeight: 20 })).toEqual({
      height: 60,
      overflowing: true,
    });
  });

  it('folds a few lines of text followed by images once they pass the lines the text leaves unused', () => {
    // Two lines, then 400px of images, against a 12-line clamp.
    expect(clampFit({ bottoms: lines(2), clamp: 12, contentHeight: 440, lineHeight: 20 })).toEqual({
      height: 240,
      overflowing: true,
    });
  });

  it('shows 11 one-line bullets whole, though their list spacing runs past 12 lines’ height', () => {
    expect(
      clampFit({ bottoms: lines(11, 30), clamp: 12, contentHeight: 330, lineHeight: 20 }),
    ).toEqual({ height: 'none', overflowing: false });
  });

  it('shows a text of exactly the clamp’s lines whole when nothing reaches below its last line', () => {
    expect(clampFit({ bottoms: lines(3), clamp: 3, contentHeight: 60, lineHeight: 20 })).toEqual({
      height: 'none',
      overflowing: false,
    });
  });
});
