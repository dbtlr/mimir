import { describe, expect, it } from 'vitest';

import { endRoom, previewRests, settleAt } from '../components/patterns/feed/preview-rests';
import type { RestBlock } from '../components/patterns/feed/preview-rests';

/*
 * Where a capped preview sheet's body rests (DESIGN.md, Preview panel): neither
 * bar cuts a block, so a fact at the footer is whole or hidden under it, and a
 * block taller than the body scrolls freely between its own two ends.
 */

/** The reason 24–99, the fact list's hairline at 119, and facts 22 tall from 140, 14 apart. */
function factList(count: number): RestBlock[] {
  return [
    { bottom: 99, top: 24 },
    { bottom: 120, rests: false, top: 119 },
    ...Array.from({ length: count }, (_, index) => ({
      bottom: 162 + index * 36,
      top: 140 + index * 36,
    })),
  ];
}

/** Whether every block shows whole, between the bars, at one rest or another. */
const wholeSomewhere = (blocks: readonly RestBlock[], rests: readonly number[], height: number) =>
  blocks.every((block) =>
    rests.some((rest) => block.top >= rest - 0.5 && block.bottom <= rest + height + 0.5),
  );

/** Whether a block runs across the line at `y`, so a bar there would cut it. */
const cuts = (blocks: readonly RestBlock[], y: number) =>
  blocks.some((block) => block.top < y - 0.5 && block.bottom > y + 0.5);

describe('preview body rests', () => {
  it('moves a rest so the fact at the footer is whole rather than cut', () => {
    const blocks = factList(5);
    const { rests, free } = previewRests({ blocks, height: 145, topPadding: 24 });
    // The first fact's rest at 120 would put the footer at 265, through the fourth fact
    // (248–270); at 125 that fact ends at the footer, whole.
    expect(rests).toEqual([0, 125, 162, 198, 234, 270]);
    expect(free).toEqual([]);
    // The top is where the sheet opens, whatever the footer meets; every later rest is clean.
    for (const rest of rests.filter((at) => at > 0)) {
      expect(cuts(blocks, rest)).toBe(false);
      expect(cuts(blocks, rest + 145)).toBe(false);
    }
    expect(wholeSomewhere(blocks, rests, 145)).toBe(true);
  });

  it('keeps a rest the footer cuts only where, without it, a fact would never show whole', () => {
    const blocks = factList(6);
    const { rests } = previewRests({ blocks, height: 172, topPadding: 24 });
    // No rest for the first two facts clears the footer; from 0 straight to 198 the second
    // fact (176–198) would never show whole, so the first fact's rest stays, cut at the footer.
    expect(rests).toEqual([0, 120, 198, 234, 270, 306]);
    expect(wholeSomewhere(blocks, rests, 172)).toBe(true);
  });

  it('keeps the first fact 20 below the header, the hairline hidden, when the footer allows', () => {
    const { rests } = previewRests({ blocks: factList(2), height: 200, topPadding: 24 });
    expect(rests).toEqual([0, 120, 162]);
  });

  it('lets a fact taller than the body scroll freely between its top rest and its bottom at the footer', () => {
    const blocks: RestBlock[] = [
      { bottom: 99, top: 24 },
      { bottom: 120, rests: false, top: 119 },
      { bottom: 860, top: 140 },
      { bottom: 896, top: 874 },
    ];
    const { rests, free } = previewRests({ blocks, height: 532, topPadding: 24 });
    expect(rests).toEqual([0, 120, 328, 860]);
    // Past its end (328) it stays cut at the header, so the body may also rest wherever the
    // footer falls between it and the last fact (328–342) or past that fact (364 on).
    expect(free).toEqual([
      [120, 328],
      [328, 342],
      [364, 860],
    ]);
  });
});

describe('preview body settle', () => {
  const rests = [0, 120, 328, 860];
  const free = [
    [120, 328],
    [328, 342],
    [364, 860],
  ] as const;

  it('stays where a scroll stops inside a tall block, so every part of it can be read', () => {
    expect(settleAt({ at: 200, end: 900, free, from: 120, rests })).toBe(200);
    expect(settleAt({ at: 340, end: 900, free, from: 328, rests })).toBe(340);
  });

  it('goes on to the next rest the way it moved, past a tall block’s end', () => {
    // At 350 the footer runs through the last fact, so the scroll goes on.
    expect(settleAt({ at: 350, end: 900, free, from: 328, rests })).toBe(860);
    expect(settleAt({ at: 100, end: 900, free, from: 120, rests })).toBe(0);
    expect(settleAt({ at: 40, end: 900, free, from: 0, rests })).toBe(120);
  });

  it('stays on a rest, and goes no further than the end', () => {
    expect(settleAt({ at: 328, end: 900, free, from: 120, rests })).toBe(328);
    expect(settleAt({ at: 400, end: 500, free: [], from: 328, rests })).toBe(500);
  });
});

describe('preview body end room', () => {
  it('adds no room when the natural end already rests past a tall block, with the footer clear', () => {
    expect(endRoom({ free: [[364, 860]], naturalEnd: 400, rests: [0, 120, 328, 860] })).toBe(0);
  });

  it('adds the room to the next rest when the natural end would cut a block', () => {
    expect(endRoom({ free: [], naturalEnd: 150, rests: [0, 120, 162] })).toBe(12);
  });
});
