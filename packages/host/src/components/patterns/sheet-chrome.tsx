import type { ReactNode, RefObject, UIEvent } from 'react';

import { cn } from '../../lib/cn';
import { CloseIcon } from '../ui/icons';
import { BLOCK_SELECTOR } from './form-block';
import { restsOf, useRestingBody } from './resting-body';
import type { MeasuredRests } from './resting-body';

/*
 * The chrome the Form sheet and the Filter sheet share (DESIGN.md, Sheets): the
 * close in the header, the scrolling body that rests on whole blocks, and the
 * footer bar. Each sheet keeps its own header and surface.
 */

/** How far a negative margin on an element pulls its edge in, in px. */
function pulled(element: Element | null, side: 'marginTop' | 'marginBottom'): number {
  if (element === null) {
    return 0;
  }
  const margin = Number.parseFloat(getComputedStyle(element)[side]);
  return Number.isNaN(margin) ? 0 : Math.max(0, -margin);
}

/**
 * A sheet body's blocks (`BLOCK_SELECTOR`), measured in the body's scroll
 * space, and the rests they make.
 */
export function measureRests(element: HTMLElement): MeasuredRests {
  const origin = element.getBoundingClientRect().top - element.scrollTop;
  const blocks = [...element.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)];
  const extents = blocks.map((block) => {
    const rect = block.getBoundingClientRect();
    const first = block.firstElementChild;
    return {
      bottom:
        rect.bottom -
        origin -
        Math.max(pulled(block, 'marginBottom'), pulled(first, 'marginBottom')),
      top: rect.top - origin + Math.max(pulled(block, 'marginTop'), pulled(first, 'marginTop')),
    };
  });
  const content = element.lastElementChild;
  const last = blocks.at(-1);
  const contentFollows =
    content !== null &&
    last !== undefined &&
    content.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom > 1;
  const topPadding = Number.parseFloat(getComputedStyle(element).paddingTop);
  const rests = restsOf(extents, contentFollows, Number.isNaN(topPadding) ? 0 : topPadding);
  return { blocks, extents, origin, rests };
}

/**
 * The scrolling body between a sheet's bars: 24 top, 32 bottom, and 20 sides
 * on a phone, 32, 40, and 32 from `md` up, its blocks 24 apart. It rests by
 * the Sheets rule (`useRestingBody`) over its blocks, and mounts with the
 * sheet's content, so it measures what is shown.
 */
export function SheetBody({
  body,
  slot,
  onScroll,
  children,
}: {
  body: RefObject<HTMLDivElement | null>;
  /** The body's `data-slot` ("form-sheet-body"). */
  slot: string;
  onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const room = useRestingBody({ body, measure: measureRests });
  return (
    <div
      ref={body}
      data-slot={slot}
      onScroll={onScroll}
      style={room > 0 ? { paddingBottom: `calc(var(--sheet-body-end) + ${String(room)}px)` } : {}}
      className="relative min-h-0 flex-1 overflow-y-auto px-5 pt-6 pb-(--sheet-body-end) [--sheet-body-end:2rem] md:px-8 md:pt-8 md:[--sheet-body-end:2.5rem]"
    >
      <div className="flex flex-col gap-6">{children}</div>
    </div>
  );
}

/** A sheet's close in its header: a 44 target with a 20 glyph on a phone, 36 and 18 from `md` up. */
export function SheetClose({
  onClick,
  disabled,
  className,
}: {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label="Close"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-dim transition-colors hover:bg-line hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 md:size-9',
        className,
      )}
    >
      <CloseIcon className="size-5 md:size-[18px]" />
    </button>
  );
}

/**
 * A sheet's footer bar: a `line` hairline above, 12 top and 12 plus the
 * home-indicator inset below on a phone, its buttons 12 apart; 16 top and
 * bottom from `md` up, the buttons at the right.
 */
export const SHEET_FOOTER_CLASS =
  'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-well-850 px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:flex-nowrap md:justify-end md:px-8 md:py-4';
