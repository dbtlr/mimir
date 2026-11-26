import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';
import { Card } from '../../ui/card';

/*
 * A record's timeline rows (ADR 0019, MMR-728 refinement), hung on the
 * thread a `thread` day fold draws: each row keeps a 16 column whose dot sits
 * on the thread, as the Finished row's does, and its content 8 after it, so
 * an event's words and a note's card line up with the day label. An event is
 * one line of words, not a link; a note is a card on the thread.
 */

/**
 * A 7 dot on the thread, ringed 3 in the page's ground so the thread stops
 * short of it. `className` gives the fill, such as a status hue; without one
 * the dot is hollow, as a note's is.
 */
export function ThreadDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-[7px] shrink-0 rounded-full ring-3 ring-well-900',
        className ?? 'bg-well-900 inset-ring-[1.5px] inset-ring-ink-dim',
      )}
    />
  );
}

/** The 16 dot column and the content 8 after it. */
function ThreadRow({ dot, children }: { dot: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2">
      <span aria-hidden className="relative z-[1] flex justify-center pt-[7px]">
        {dot}
      </span>
      {children}
    </div>
  );
}

/**
 * One event: its words (14 / 20, the feature sets the lead in `ink-bright`
 * and the detail in `ink-dim`), then its time in 13 mono `ink-dim` at the
 * right. A long event wraps, and the time holds to its first line.
 */
export function ThreadEvent({
  dot,
  time,
  children,
}: {
  dot: ReactNode;
  time: string;
  children: ReactNode;
}) {
  return (
    <ThreadRow dot={dot}>
      <div className="flex items-baseline gap-2 py-px text-label text-ink">
        <div className="min-w-0 flex-1 wrap-anywhere">{children}</div>
        <time className="shrink-0 font-mono text-meta whitespace-nowrap text-ink-dim">{time}</time>
      </div>
    </ThreadRow>
  );
}

/**
 * One note: a hollow dot, then a card (the Card block's surface, 10 top, 16
 * sides, 14 bottom) headed by its kind and its time in 13 `ink-dim`, 6 above
 * the body. `footer` follows the body, such as a long note's Show all.
 */
export function ThreadNote({
  label = 'Note',
  time,
  footer,
  children,
}: {
  label?: string;
  time: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ThreadRow dot={<ThreadDot />}>
      <Card className="min-w-0 px-4 pt-2.5 pb-3.5">
        <div className="mb-1.5 flex justify-between gap-2 text-meta text-ink-dim">
          <span>{label}</span>
          <time className="font-mono whitespace-nowrap">{time}</time>
        </div>
        {children}
        {footer}
      </Card>
    </ThreadRow>
  );
}
