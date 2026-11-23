import { bindDrag, dragThreshold } from '@ui-sdk/core';
import type { BindDragOptions } from '@ui-sdk/core';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import { cn } from '../../lib/cn';

/*
 * The SwipeTrack primitive: a row of slides that shows one at a time with the
 * next one peeking at the right edge, turned by a swipe, a mouse or pen drag,
 * or a tap on the peek, for the phone Needs you deck (ADR 0019, MMR-721).
 * UI SDK's Carousel pages by native scroll snap, which settles with the
 * browser's own slide even under reduced motion, springs a drag back at the
 * ends, rests the last slide at the end of the content, and makes the peek
 * `inert`, which swallows the tap that should turn it. So this follows the
 * pointer with UI SDK's `bindDrag` and moves the row with a transform: one
 * slide per swipe, no spring at either end, no slide under reduced motion.
 */

/** Which way a swipe or a tap turned the track: back one slide, or on one. */
export type SwipeTurn = -1 | 1;

export type SwipeTrackProps = {
  /** The slide shown, counted from 0; the caller owns it. */
  index: number;
  count: number;
  /** The identity of the slide at `index`, so a new slide in the same place slides in from the right. */
  itemKey: string;
  /** Asked to turn one slide; the caller moves `index`, or does nothing at an end. */
  onTurn: (turn: SwipeTurn) => void;
  /** Whether a swipe or a tap on the peek may turn the track now. */
  enabled?: boolean;
  /** Moves to a new `index` at once, without the turn's slide, as focus brought from outside does. */
  instant?: boolean;
  /** How much of the next slide shows, in px. */
  peek: number;
  /** The gap between slides, in px. */
  gap: number;
  className?: string;
  /** The slides, each `w-(--swipe-slide) shrink-0`. */
  children: ReactNode;
};

/**
 * Shows the slide at `index` with the next slide's first `peek` px at the
 * right edge; the last slide rests where the others do, with nothing beside
 * it. A horizontal swipe or a mouse or pen drag moves the row with the
 * pointer, and once it passes half a slide, letting go turns it one slide; a
 * mostly vertical gesture scrolls the page. A drag never moves past either
 * end. A tap on the peek, or the gap before it (the tap target is
 * `peek + gap` wide), turns it on one and never reaches the peeking slide.
 * Turns slide to rest with no overshoot, and at once under reduced motion.
 */
export function SwipeTrack({
  index,
  count,
  itemKey,
  onTurn,
  enabled = true,
  instant = false,
  peek,
  gap,
  className,
  children,
}: SwipeTrackProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const stopDrag = useRef<(() => void) | undefined>(undefined);
  const shown = useRef({ index, itemKey });

  useEffect(
    () => () => {
      stopDrag.current?.();
    },
    [],
  );

  // A refetch that moves the shown slide repositions at once; a new slide in
  // the same place (the one shown left) slides in from the right as a turn does.
  useLayoutEffect(() => {
    const row = track.current;
    const before = shown.current;
    shown.current = { index, itemKey };
    if (row === null || (before.index === index && before.itemKey === itemKey)) {
      return;
    }
    if (before.itemKey === itemKey || instant) {
      jump(row, () => undefined);
    } else if (before.index === index) {
      jump(row, () => {
        row.style.setProperty('--swipe-drag', `${String(stepOf(row, gap))}px`);
      });
      row.style.setProperty('--swipe-drag', '0px');
    }
  }, [index, itemKey, gap, instant]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const row = track.current;
    const element = viewport.current;
    if (!enabled || event.button !== 0 || row === null || element === null || count < 2) {
      return;
    }
    stopDrag.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const step = stepOf(row, gap);
    // Past either end the row stays put: no stretch, so nothing springs back (ADR 0019 §8).
    const most = index < count - 1 ? step : 0;
    const least = index > 0 ? -step : 0;
    let moved = 0;
    const release = () => {
      delete row.dataset.dragging;
      row.style.setProperty('--swipe-drag', '0px');
    };
    const drag: BindDragOptions = {
      onEnd: (_event, canceled) => {
        stopDrag.current = undefined;
        release();
        if (!canceled && Math.abs(moved) > step / 2) {
          onTurn(moved < 0 ? 1 : -1);
        }
      },
      onMove: ({ x }) => {
        moved = Math.min(-least, Math.max(-most, x - startX));
        row.style.setProperty('--swipe-drag', `${String(moved)}px`);
      },
      onStart: (move) => {
        // A mostly vertical drag is a scroll; a finger's never reaches here (`touch-action: pan-y`).
        if (Math.abs(move.clientY - startY) > Math.abs(move.clientX - startX)) {
          return false;
        }
        row.dataset.dragging = '';
        return true;
      },
      threshold: dragThreshold,
    };
    stopDrag.current = bindDrag(element, event.nativeEvent, drag);
  };

  const style: CSSProperties & Record<`--${string}`, string | number> = {
    '--swipe-gap': `${String(gap)}px`,
    '--swipe-index': index,
    '--swipe-slide': `calc(100cqw - ${String(peek + gap)}px)`,
  };

  return (
    <div
      ref={viewport}
      data-slot="swipe-viewport"
      style={style}
      onPointerDown={onPointerDown}
      className={cn('relative @container touch-pan-y overflow-hidden', className)}
    >
      <div
        ref={track}
        data-slot="swipe-track"
        className="flex items-stretch gap-(--swipe-gap) transition-transform duration-200 ease-out select-none data-dragging:transition-none data-jump:transition-none motion-reduce:transition-none"
        style={{
          transform:
            'translateX(calc(var(--swipe-index) * -1 * (var(--swipe-slide) + var(--swipe-gap)) + var(--swipe-drag, 0px)))',
        }}
      >
        {children}
      </div>
      {enabled && index < count - 1 && (
        // The peek's tap target, over the peeking slide and the gap before it, so a
        // tap turns the track and never reaches the slide's own controls. It keeps
        // focus where it was, so the turn can carry focus held in the old slide.
        // Keys turn the track by the caller's pager and arrow keys.
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div
          aria-hidden="true"
          data-slot="swipe-peek"
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            onTurn(1);
          }}
          className="absolute inset-y-0 right-0 z-20 cursor-pointer"
          style={{ width: peek + gap }}
        />
      )}
    </div>
  );
}

/** How far one turn moves the row: a slide and the gap after it. */
function stepOf(row: HTMLElement, gap: number): number {
  const first = row.firstElementChild;
  return (first instanceof HTMLElement ? first.offsetWidth : row.offsetWidth) + gap;
}

/** Applies `place` without a transition, then lets the next change slide again. */
function jump(row: HTMLElement, place: () => void) {
  row.dataset.jump = '';
  place();
  // Reading layout commits the jump before the transition comes back.
  void row.offsetWidth;
  delete row.dataset.jump;
}
