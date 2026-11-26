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

  it('folds twenty rules ahead of one line of text, which put nothing below that line', () => {
    // Each rule is 2px tall on a 24px pitch; "tail" is the one text line, below them all.
    const blocks = Array.from({ length: 20 }, (_, i) => ({ bottom: i * 24 + 2, top: i * 24 }));
    expect(
      clampFit({ blocks, bottoms: [500], clamp: 3, contentHeight: 500, lineHeight: 20 }),
    ).toEqual({ height: 50, overflowing: true });
  });

  it('counts a tall image as the lines it covers, wherever it sits', () => {
    // One line, a 100px image (five lines), then one more line: seven against a clamp of 12.
    const blocks = [{ bottom: 130, top: 30 }];
    expect(
      clampFit({ blocks, bottoms: [20, 160], clamp: 12, contentHeight: 160, lineHeight: 20 }),
    ).toEqual({ height: 'none', overflowing: false });
    expect(
      clampFit({ blocks, bottoms: [20, 160], clamp: 3, contentHeight: 160, lineHeight: 20 }),
    ).toEqual({ height: 70, overflowing: true });
  });

  it('shows a text of exactly the clamp’s lines whole when nothing reaches below its last line', () => {
    expect(clampFit({ bottoms: lines(3), clamp: 3, contentHeight: 60, lineHeight: 20 })).toEqual({
      height: 'none',
      overflowing: false,
    });
  });
});
