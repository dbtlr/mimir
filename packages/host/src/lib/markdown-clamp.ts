/** A clamped body's verdict: the height it folds at, or `none` when it shows whole. */
export type ClampFit = { height: number | 'none'; overflowing: boolean };

/**
 * Where a body clamped to `clamp` lines folds, from its laid-out geometry:
 * `bottoms` holds each rendered text line's bottom, and `contentHeight` the
 * bottom of its lowest box of any kind (a rule, a code block, an image), both
 * from the body's top.
 *
 * The fold sits at the bottom of line `clamp`. A text of fewer lines keeps
 * room for the lines it leaves unused, one line height each below its last
 * line, so its block spacing alone never folds it. The body folds when its
 * text has more lines than the clamp, or when any content reaches past that
 * fold.
 */
export function clampFit({
  bottoms,
  clamp,
  contentHeight,
  lineHeight,
}: {
  bottoms: readonly number[];
  clamp: number;
  contentHeight: number;
  lineHeight: number;
}): ClampFit {
  const fold =
    bottoms.length >= clamp
      ? (bottoms[clamp - 1] ?? 0)
      : (bottoms.at(-1) ?? 0) + (clamp - bottoms.length) * lineHeight;
  // A pixel of slack absorbs subpixel rounding between text and box geometry.
  const overflowing = bottoms.length > clamp || contentHeight > fold + 1;
  return { height: overflowing ? fold : 'none', overflowing };
}
