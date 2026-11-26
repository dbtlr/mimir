/** A clamped body's verdict: the height it folds at, or `none` when it shows whole. */
export type ClampFit = { height: number | 'none'; overflowing: boolean };

/** A laid-out box's extent from the body's top. */
export type ClampBox = { top: number; bottom: number };

/**
 * The bottoms of the lines a non-text block (a rule, an image) stands for: one
 * per line height it covers, at least one, the last at the block's bottom.
 */
function blockRows({ top, bottom }: ClampBox, lineHeight: number): number[] {
  const count = Math.max(1, Math.ceil((bottom - top) / lineHeight));
  return Array.from({ length: count }, (_, i) => Math.min(top + (i + 1) * lineHeight, bottom));
}

/**
 * Where a body clamped to `clamp` lines folds, from its laid-out geometry:
 * `bottoms` holds each rendered text line's bottom, `blocks` the boxes of its
 * non-text blocks (rules, images, media), and `contentHeight` the bottom of
 * its lowest box of any kind, all from the body's top.
 *
 * A block counts as the lines it covers, wherever it sits, so twenty rules
 * ahead of one line of text still fold. The fold sits at the bottom of line
 * `clamp`. A body of fewer lines keeps room for the lines it leaves unused,
 * one line height each below its last line, so its block spacing alone never
 * folds it. The body folds when it has more lines than the clamp, or when any
 * content reaches past that fold.
 */
export function clampFit({
  blocks = [],
  bottoms,
  clamp,
  contentHeight,
  lineHeight,
}: {
  blocks?: readonly ClampBox[];
  bottoms: readonly number[];
  clamp: number;
  contentHeight: number;
  lineHeight: number;
}): ClampFit {
  const rows = [...bottoms, ...blocks.flatMap((block) => blockRows(block, lineHeight))].toSorted(
    (a, b) => a - b,
  );
  const fold =
    rows.length >= clamp
      ? (rows[clamp - 1] ?? 0)
      : (rows.at(-1) ?? 0) + (clamp - rows.length) * lineHeight;
  // A pixel of slack absorbs subpixel rounding between text and box geometry.
  const overflowing = rows.length > clamp || contentHeight > fold + 1;
  return { height: overflowing ? fold : 'none', overflowing };
}
