import { restingRoom } from '../form-sheet';
import type { BlockExtent } from '../form-sheet';

/*
 * Where a preview's body rests (DESIGN.md, Preview panel: a capped sheet rests
 * on a whole fact). At a rest neither bar cuts a block: the block at the
 * header sits a clearance below it with the block above hidden whole, and the
 * block at the footer is whole or hidden under it. A block taller than the
 * body can never show whole, so it scrolls freely between its own two ends.
 */

/** A block in the body's scroll space; `rests: false` (the fact list's hairline) still counts as cut or not, but no rest sits on it. */
export type RestBlock = BlockExtent & { rests?: boolean };

/** The body's rests, ascending, and the ranges a tall block scrolls freely in. */
export type BodyRests = { rests: number[]; free: (readonly [number, number])[] };

/** The clearance a rest keeps under the header: the field gap. */
const FIELD_GAP = 24;

/** The least clearance under the header: the fact list's own row gap. */
const ROW_GAP = 14;

/** Whether a bar at `y` runs through a block other than `excused`. */
function cutsAt(blocks: readonly RestBlock[], y: number, excused?: RestBlock): boolean {
  return blocks.some((block) => block !== excused && block.top < y - 0.5 && block.bottom > y + 0.5);
}

/**
 * Past its end a tall block stays cut at the header as the body scrolls on, so
 * there a scroll may rest wherever the footer cuts nothing: with the footer
 * between two blocks after it, or past the last one.
 */
function clearFooterPast({
  blocks,
  from,
  height,
}: {
  blocks: readonly RestBlock[];
  from: number;
  height: number;
}): (readonly [number, number])[] {
  const tall = blocks[from];
  const last = blocks.at(-1);
  if (tall === undefined || last === undefined) {
    return [];
  }
  const spans: (readonly [number, number])[] = blocks
    .slice(from, -1)
    .map((block, index) => [block.bottom, blocks[from + index + 1]?.top ?? block.bottom] as const);
  spans.push([last.bottom, tall.bottom + height]);
  return spans
    .map(
      ([low, high]) =>
        [
          Math.max(low - height, tall.bottom - height),
          Math.min(high - height, tall.bottom),
        ] as const,
    )
    .filter(([low, high]) => high > low);
}

/**
 * The body's rests for blocks in document order, a body `height` tall whose
 * top padding is `topPadding`. A block's rest puts it up to a field gap below
 * the header (20 for the first fact, 14 for a later one: the gap to the block
 * above, which hides whole), at the least scroll in that span where the footer
 * cuts nothing; a block with no such scroll has no rest, unless the body
 * needs one there to show every block whole (`withReach`). A tall block rests at
 * its top, and again where its bottom meets the footer, and scrolls freely
 * between the two.
 */
export function previewRests({
  blocks,
  height,
  topPadding,
}: {
  blocks: readonly RestBlock[];
  height: number;
  topPadding: number;
}): BodyRests {
  const rests: number[] = [];
  const free: (readonly [number, number])[] = [];
  // The header-clean rest of each block the footer left without one, in order.
  const fallbacks: number[] = [];
  blocks.forEach((block, index) => {
    if (block.rests === false) {
      return;
    }
    const tall = block.bottom - block.top > height - ROW_GAP;
    const above = blocks[index - 1]?.bottom;
    let rest: number | undefined;
    if (above === undefined) {
      rest = block.top <= topPadding + 0.5 ? 0 : Math.max(0, block.top - FIELD_GAP);
    } else {
      const low = Math.max(above, block.top - FIELD_GAP);
      const high = Math.max(low, block.top - Math.min(ROW_GAP, block.top - above));
      // The least scroll in [low, high] clear at the footer: `low`, or where a block's bottom meets it.
      rest = [low, ...blocks.map((other) => other.bottom - height)]
        .filter((at) => at >= low - 0.5 && at <= high + 0.5)
        .toSorted((x, y) => x - y)
        .find((at) => !cutsAt(blocks, at + height, tall ? block : undefined));
      if (rest === undefined) {
        fallbacks.push(low);
        return;
      }
    }
    rests.push(rest);
    if (tall) {
      const end = block.bottom - height;
      free.push([rest, end]);
      rests.push(end);
      free.push(...clearFooterPast({ blocks, from: index, height }));
    }
  });
  return { free, rests: withReach({ blocks, fallbacks, height, rests }) };
}

/**
 * The rests, with each fallback added where, without it, the two rests around
 * it lie more than a body apart, so some block between them would never show
 * whole. There the footer may cut a block; the header still cuts none.
 */
function withReach({
  rests,
  fallbacks,
  blocks,
  height,
}: {
  rests: readonly number[];
  fallbacks: readonly number[];
  blocks: readonly RestBlock[];
  height: number;
}): number[] {
  const all = rests.toSorted((x, y) => x - y);
  const last = (blocks.at(-1)?.bottom ?? 0) - height;
  for (const fallback of fallbacks) {
    const before = all.findLast((rest) => rest <= fallback) ?? 0;
    const after = all.find((rest) => rest > fallback) ?? Math.max(last, fallback);
    if (after - before > height + 0.5) {
      all.push(fallback);
      all.sort((x, y) => x - y);
    }
  }
  return all;
}

/**
 * Where a scroll that stopped at `at` settles, having moved from the rest at
 * `from`: inside a tall block's free range, or on a rest, it stays; otherwise
 * it goes on to the next rest the way it moved, so a short swipe still gets
 * somewhere. The top and `end`, the scroll's end, are rests too.
 */
export function settleAt({
  at,
  from,
  end,
  rests,
  free,
}: {
  at: number;
  from: number;
  end: number;
  rests: readonly number[];
  free: readonly (readonly [number, number])[];
}): number {
  if (free.some(([low, high]) => at >= low - 0.5 && at <= high + 0.5)) {
    return at;
  }
  const all = [0, end, ...rests]
    .filter((rest) => rest >= 0 && rest <= end)
    .toSorted((x, y) => x - y);
  if (all.some((rest) => Math.abs(rest - at) < 1)) {
    return at;
  }
  return at > from
    ? (all.find((rest) => rest > at) ?? end)
    : (all.findLast((rest) => rest < at) ?? 0);
}

/**
 * The bottom room the body adds so the end of its scroll rests cleanly: none
 * when its natural end lies in a tall block's free range, and otherwise the
 * room to the next rest (`restingRoom`).
 */
export function endRoom({
  naturalEnd,
  rests,
  free,
}: {
  naturalEnd: number;
  rests: readonly number[];
  free: readonly (readonly [number, number])[];
}): number {
  if (free.some(([low, high]) => naturalEnd >= low - 0.5 && naturalEnd <= high + 0.5)) {
    return 0;
  }
  return restingRoom(naturalEnd, rests);
}
