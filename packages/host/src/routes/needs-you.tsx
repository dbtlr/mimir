import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { reviewQuery } from '../api/view-queries';
import type { ReviewReport } from '../api/view-queries';
import { useConsoleNeedsYouWrites } from '../components/needs-you-deck';
import { needsYouSections } from '../components/needs-you-deck-model';
import { NeedsYouListView, counted } from '../components/needs-you-list';
import type { NeedsYouListHandle } from '../components/needs-you-list';
import { OfflineBanner } from '../components/offline-banner';
import { RecordPending } from '../components/record-layout';
import { actionButtonVariants } from '../components/ui/action-button';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { RETURN_TARGET_ATTRIBUTE, markState } from '../lib/walkthrough-mark';

/*
 * `/needs-you` — the Needs you page (ADR 0013 and ADR 0019, MMR-723
 * refinements): the whole needs-you set, the deck's cards grouped by project,
 * under Home's page head, and a bar at the bottom for Work through all. It
 * reads the review entry Home and the alert read, so the three never disagree.
 * The page's area is its scroller with the bar under it, so nothing scrolls
 * beneath the bar, and the shell's version footer stays under both.
 */

/** The path the page sits at, which the focus queue returns to. */
export const NEEDS_YOU_PATH = '/needs-you';

/** The return-target name of Work through all, which the focus queue's return lands on (MMR-714). */
export const WORK_THROUGH_ENTRY = 'needs-you:work-through';

/** "4 cards, 5 items in 2 projects." */
function summary(report: ReviewReport): string {
  const sections = needsYouSections(report);
  const cards = sections.reduce((sum, section) => sum + section.cards.length, 0);
  return `${counted(cards, 'card')}, ${counted(report.queue.length, 'item')} in ${counted(sections.length, 'project')}.`;
}

/** Whether the scroller has more below its view: the bar's top edge is then the overflow cue. */
function useContinues(scroller: RefObject<HTMLElement | null>): boolean {
  const [continues, setContinues] = useState(false);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) {
      return undefined;
    }
    const report = () => {
      setContinues(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
    };
    report();
    element.addEventListener('scroll', report, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report);
    observer?.observe(element);
    const content = element.firstElementChild;
    if (content !== null) {
      observer?.observe(content);
    }
    return () => {
      element.removeEventListener('scroll', report);
      observer?.disconnect();
    };
  }, [scroller]);
  return continues;
}

/**
 * The bar under the scroller: on desktop the note, then the page's one solid,
 * which stacks under the note full width when they cannot share a line; on a
 * phone the solid alone, full width. It is navigation, so it stays live offline.
 */
function WorkThroughBar({
  records,
  continues,
  onFocusChange,
}: {
  records: number;
  continues: boolean;
  onFocusChange: (focused: boolean) => void;
}) {
  return (
    <div
      data-slot="work-through-bar"
      data-continues={continues ? '' : undefined}
      className="shrink-0 border-t border-line bg-well-850 transition-[box-shadow,border-color] data-continues:border-ink-ghost data-continues:elevation-edge-up light:data-continues:border-line-bright"
    >
      <div className="mx-auto flex w-full max-w-[900px] flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-3 md:px-5 md:py-4">
        {/* The note takes the line's spare room, so the button keeps its width beside it and fills the line alone once it wraps under it. */}
        <p className="m-0 grow-9999 text-meta text-ink-dim max-md:hidden">
          One item at a time, in queue order across projects, then back here.
        </p>
        <Link
          to="/"
          search={{ mode: 'focus' }}
          state={markState({ entry: WORK_THROUGH_ENTRY, opener: NEEDS_YOU_PATH })}
          {...{ [RETURN_TARGET_ATTRIBUTE]: WORK_THROUGH_ENTRY }}
          onFocus={() => {
            onFocusChange(true);
          }}
          onBlur={(event) => {
            // Focus lost to the bar's own removal is still the bar's, for the quiet line to take.
            const link = event.currentTarget;
            queueMicrotask(() => {
              if (link.isConnected) {
                onFocusChange(false);
              }
            });
          }}
          className={cn(actionButtonVariants({ size: 'form', variant: 'action' }), 'grow')}
        >
          {records === 1
            ? 'Work through 1 item'
            : `Work through all ${records.toLocaleString('en-US')}`}
        </Link>
      </div>
    </div>
  );
}

export function NeedsYouPage() {
  const review = useQuery(reviewQuery());
  const conn = connectivity([review]);
  const writes = useConsoleNeedsYouWrites();
  const scroller = useRef<HTMLElement>(null);
  const list = useRef<NeedsYouListHandle>(null);
  // Work through all holds focus: when it leaves with the last card, the quiet line takes it.
  const barFocused = useRef(false);
  const continues = useContinues(scroller);
  const report = review.data;
  const records = report?.queue.length ?? 0;
  const empty = useMemo(
    () => report === undefined || needsYouSections(report).length === 0,
    [report],
  );

  useLayoutEffect(() => {
    if (empty && barFocused.current) {
      barFocused.current = false;
      list.current?.focusQuiet();
    }
  }, [empty]);

  if (report === undefined) {
    return (
      <>
        <OfflineBanner {...conn} />
        <RecordPending unreachable={review.isError} />
      </>
    );
  }

  return (
    <>
      <OfflineBanner {...conn} />
      {/* tabIndex -1: a focus fallback for a control that unmounts itself (focusMain). */}
      <main
        ref={scroller}
        tabIndex={-1}
        className={cn('min-h-0 flex-1 overflow-y-auto', conn.offline && 'offline-demoted')}
      >
        <div className="mx-auto w-full max-w-[900px] px-3.5 pt-4 pb-10 md:px-5 md:pt-6 md:pb-12">
          <header className={cn('mb-8', !empty && 'border-b border-line pb-5')}>
            <h1 className="m-0 text-page leading-9 font-bold text-ink-bright">Needs you</h1>
            {!empty && (
              <p className="mt-1 mb-0 max-w-[62ch] text-body text-ink">{summary(report)}</p>
            )}
          </header>
          <NeedsYouListView ref={list} report={report} writes={writes} offline={conn.offline} />
        </div>
      </main>
      {!empty && (
        <WorkThroughBar
          records={records}
          continues={continues}
          onFocusChange={(focused) => {
            barFocused.current = focused;
          }}
        />
      )}
    </>
  );
}
