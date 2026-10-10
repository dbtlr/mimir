import { useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';

import { cn } from '../lib/cn';
import { Sheet, SheetClose, SheetContent, SheetTitle } from './ui/sheet';
import { Skeleton } from './ui/skeleton';

/** One phone chip: its label, an optional count, and what its bottom sheet holds. */
export type RailChip = {
  label: string;
  count?: number;
  content: ReactNode;
};

/** A titled block of the rail, divided from the next by a hairline. */
export function RailSection({
  label,
  count,
  children,
}: {
  label: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-b border-line pb-4 last:border-b-0 last:pb-0">
      <h2 className="microlabel text-ink-faint">
        {label}
        {count !== undefined && ` · ${String(count)}`}
      </h2>
      {children}
    </section>
  );
}

/**
 * Close the open sheet once something inside it is chosen: a link navigates
 * away, and an action changes the record behind the sheet. A button that
 * opens a dialog of its own (`aria-haspopup="dialog"`) leaves the sheet open
 * beneath it, because that dialog lives inside the sheet's content. Clicks
 * inside that dialog reach here only through React's portal bubbling, so a
 * target outside the sheet body is ignored.
 */
function closeOnChoice(close: () => void) {
  return (event: MouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof Element) || !event.currentTarget.contains(target)) {
      return;
    }
    const choice = target.closest('a, button');
    if (choice !== null && choice.getAttribute('aria-haspopup') !== 'dialog') {
      close();
    }
  };
}

/** The phone rail: a row of chips under the page head, each opening a bottom sheet. */
function RailChips({ chips }: { chips: readonly RailChip[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const active = chips.find((c) => c.label === open);
  return (
    <>
      <div role="group" aria-label="Record details" className="flex flex-wrap gap-2 md:hidden">
        {chips.map((chip) => (
          <button
            key={chip.label}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open === chip.label}
            onClick={() => setOpen(chip.label)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3.5 text-meta font-medium text-ink inset-ring inset-ring-line-bright transition-colors hover:bg-well-800 focus-visible:outline-2 focus-visible:outline-accent"
          >
            {chip.label}
            {chip.count !== undefined && (
              <span className="font-mono text-micro text-ink-faint">{chip.count}</span>
            )}
          </button>
        ))}
      </div>
      <Sheet
        open={active !== undefined}
        onOpenChange={(next) => {
          if (!next) {
            setOpen(null);
          }
        }}
      >
        {active !== undefined && (
          <SheetContent side="bottom" aria-describedby={undefined}>
            <div className="flex items-center border-b border-line px-5 py-3">
              <SheetTitle className="microlabel text-ink-faint">{active.label}</SheetTitle>
              <SheetClose
                aria-label="Close"
                className="ml-auto flex size-9 items-center justify-center rounded text-ink-faint transition-colors hover:bg-well-800 hover:text-ink-bright focus-visible:outline-2 focus-visible:outline-accent"
              >
                ✕
              </SheetClose>
            </div>
            {/* The sheet body is a click boundary, not a control: choosing a
                link or button inside it closes the sheet. */}
            {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
            <div
              className="flex flex-col gap-4 overflow-y-auto px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
              onClick={closeOnChoice(() => setOpen(null))}
            >
              {active.content}
            </div>
          </SheetContent>
        )}
      </Sheet>
    </>
  );
}

/**
 * The record page shell (ADR 0013, v0.23 refinement): a main column beside a
 * rail, the same page on desktop and phone. Below `md` the rail folds into
 * chips under the page head, each opening its part of the rail in a bottom
 * sheet. Project, container, task, seed, and artifact pages share it.
 */
export function RecordLayout({
  head,
  rail,
  chips,
  children,
  className,
}: {
  /** Path, status, and title — above the phone chips. */
  head: ReactNode;
  /** The desktop rail's sections. */
  rail: ReactNode;
  /** The same rail regrouped as phone chips. */
  chips: readonly RailChip[];
  children: ReactNode;
  className?: string;
}) {
  return (
    <main className={cn('min-h-0 flex-1 overflow-y-auto', className)}>
      <div className="mx-auto grid min-h-full w-full max-w-[1200px] grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px]">
        <article className="flex min-w-0 flex-col gap-4 px-4 py-5 md:px-6">
          {head}
          <RailChips chips={chips} />
          {children}
        </article>
        <aside
          aria-label="Record details"
          className="hidden flex-col gap-4 border-l border-line px-4 py-5 md:flex"
        >
          {rail}
        </aside>
      </div>
    </main>
  );
}

/**
 * A record page before its record arrives: skeleton lines while the read is
 * in flight, or the unreachable notice when it failed with nothing cached.
 */
export function RecordPending({ unreachable }: { unreachable: boolean }) {
  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-2 p-5">
      {unreachable ? (
        <p className="text-xs text-status-blocked">
          Unreachable, and nothing cached yet — is `mimir serve` running?
        </p>
      ) : (
        <>
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </>
      )}
    </main>
  );
}
