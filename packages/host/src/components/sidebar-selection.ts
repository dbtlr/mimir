import { DRAWER_TAP_ROW } from '../lib/touch-target';

/**
 * A sidebar row: 32 tall beside the page and 44 in the drawer (ADR 0013,
 * MMR-730 refinement; DESIGN.md's 25 outline row is seed MMR-s136).
 */
export const SIDEBAR_ROW = `flex min-h-8 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-meta text-ink transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent ${DRAWER_TAP_ROW}`;

/**
 * The sidebar's selection treatment (ADR 0019): the accent as a low-alpha
 * wash with a hairline inset ring, never a solid fill. Settings' sections key
 * it on any `aria-current`.
 */
export const SECTION_CURRENT =
  'aria-[current]:bg-accent/10 aria-[current]:text-ink-bright aria-[current]:inset-ring aria-[current]:inset-ring-accent/28';

/**
 * A row that is the page (`aria-current="page"`) takes the wash with a
 * full-strength ring; one that holds the page (`data-holds`) takes the ring
 * alone, which must read at 3:1 without the wash (ADR 0013, MMR-730).
 */
export const ROW_CURRENT =
  'aria-[current=page]:bg-accent/10 aria-[current=page]:text-ink-bright aria-[current=page]:inset-ring aria-[current=page]:inset-ring-accent';
export const ROW_HOLDS =
  'data-[holds]:text-ink-bright data-[holds]:inset-ring data-[holds]:inset-ring-accent';
