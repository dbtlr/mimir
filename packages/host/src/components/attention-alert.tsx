import { useQuery } from '@tanstack/react-query';
import { Link, useMatch, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';

import { needsYouId, reviewQuery } from '../api/view-queries';
import type { ReviewReport } from '../api/view-queries';
import { useAppBadge } from '../lib/app-badge';
import { cn } from '../lib/cn';
import { connectivity } from '../lib/connectivity';
import { nodeIdOf } from '../lib/record-url';
import { useMediaQuery } from '../lib/use-media-query';
import { useRowFocusHandoff } from '../lib/use-row-focus-handoff';
import { NEEDS_YOU_ENTRY, RETURN_TARGET_ATTRIBUTE } from '../lib/walkthrough-mark';
import { deliveryRoute, nodeRoute } from '../router';
import { NeedsYouGroups, PROJECT_LINK } from './decision-groups';
import { EntrySurfaceName } from './decisions-entry';
import { actionButtonVariants } from './ui/action-button';
import { iconButtonClass } from './ui/icon-button';
import { CloseIcon } from './ui/icons';
import { PopoverContent, PopoverRoot, PopoverTrigger } from './ui/legacy-popover';
import { Sheet, SheetClose, SheetContent } from './ui/sheet';

/** Tailwind's `md`: from here the alert opens a popover, below it a bottom sheet. */
const DESKTOP = '(min-width: 768px)';

// On a phone the pill sits among 44px icon buttons, so it takes their scale:
// 34px tall with a 14px count (MMR-715). Its tap target is theirs too: an
// overlay reaches 5px above and below the drawn pill, to 44 (DESIGN.md, Sizes;
// MMR-754), and is never narrower than 44, centred, should a one-digit pill
// draw narrower (its side margins leave the room).
const PILL =
  'relative inline-flex items-center gap-1.5 rounded-full whitespace-nowrap bg-attention/12 px-[11px] py-[5px] text-tag font-semibold text-attention-foreground inset-ring inset-ring-attention/24 transition-colors hover:bg-attention/16 focus-visible:outline-2 focus-visible:outline-accent max-md:mx-1 max-md:h-[34px] max-md:gap-2 max-md:px-3 max-md:py-0 max-md:text-body max-md:after:absolute max-md:after:-inset-y-[5px] max-md:after:left-1/2 max-md:after:w-full max-md:after:min-w-11 max-md:after:-translate-x-1/2';

/** The id of the work node whose page is showing, or undefined on any other page. */
function useCurrentNodeId(): string | undefined {
  const delivery = useMatch({ from: deliveryRoute.id, shouldThrow: false });
  const match = useMatch({ from: nodeRoute.id, shouldThrow: false });
  if (delivery) {
    return `${delivery.params.key}-d${delivery.params.seq}`;
  }
  return match === undefined ? undefined : nodeIdOf(match.params.key, match.params.seq);
}

/** A UI SDK dialog or alert dialog that is open (the patterns a row's actions open). */
const OPEN_DIALOG = '[data-slot="dialog-content"], [data-slot="alert-dialog-content"]';

/**
 * Run `close` when a link inside the panel is activated. Clicks inside a
 * dialog a row opened reach here through React's portal bubbling, so a target
 * outside the panel's own DOM is ignored.
 */
function closeOnLink(close: () => void) {
  return (event: MouseEvent<HTMLElement>) => {
    const target = event.target;
    if (
      target instanceof Element &&
      event.currentTarget.contains(target) &&
      target.closest('a') !== null
    ) {
      close();
    }
  };
}

/**
 * The needs-you set behind the badge, as one panel for the popover and the sheet:
 * a heading, the set's rows grouped by project with their in-place verbs, and
 * the footer links. Acting on a row keeps the panel open; the row leaves when
 * the write lands, and focus moves on to the next row (the heading takes it
 * when no row follows). `close` is the sheet's close control.
 */
function NeedsYouPanel({
  report,
  offline,
  currentId,
  onNavigate,
  close,
}: {
  report: ReviewReport;
  offline: boolean;
  currentId: string | undefined;
  onNavigate: () => void;
  close?: ReactNode;
}) {
  const count = report.queue.length;
  const { handoff, headingRef } = useRowFocusHandoff(
    report.needsYou.flatMap((group) => group.rows.map((row) => needsYouId(row))),
  );
  return (
    // The panel is a click boundary, not a control: following any link in it
    // closes it. A link to the page already showing changes no URL, so the
    // close-on-navigation in the alert would never see it.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className="flex min-h-0 flex-col" onClick={closeOnLink(onNavigate)}>
      <section className="flex min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="microlabel rounded-sm text-attention-foreground focus-visible:outline-2 focus-visible:outline-accent"
          >
            Needs you{count > 0 && ` · ${String(count)}`}
          </h2>
          {close}
        </div>
        <div className="min-h-0 overflow-y-auto px-4 py-3">
          {report.needsYou.length === 0 ? (
            <p className="text-xs text-ink-dim">Nothing needs you.</p>
          ) : (
            // Its entries are gone once the panel closes, so the alert takes focus back for them.
            <EntrySurfaceName.Provider value={NEEDS_YOU_ENTRY}>
              <NeedsYouGroups
                groups={report.needsYou}
                offline={offline}
                handoff={handoff}
                currentId={currentId}
              />
            </EntrySurfaceName.Provider>
          )}
        </div>
      </section>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
        <Link to="/" className={cn(PROJECT_LINK, 'text-meta text-ink-dim hover:text-ink-bright')}>
          Open Home
        </Link>
        {count > 0 && (
          <Link
            to="/"
            search={{ mode: 'focus' }}
            className={cn(
              actionButtonVariants({ size: 'sm', variant: 'attention' }),
              'ml-auto max-md:min-h-11',
            )}
          >
            Work through these · {count}
          </Link>
        )}
      </div>
    </div>
  );
}

/** The pill's face: a violet dot, the count, and on a desktop the words. */
function PillFace({ count, words }: { count: number; words: string }) {
  return (
    <>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-attention max-md:size-2" />
      {count}
      {/* A phone's top bar has room for the count alone; the label keeps the words. */}
      <span aria-hidden className="max-md:hidden">
        {words}
      </span>
    </>
  );
}

/**
 * The top-bar alert (ADR 0019, MMR-476 and MMR-492 refinements): the count of
 * members of the needs-you set waiting on the operator across projects, as a
 * violet pill. It opens the set in a popover on a desktop and a bottom sheet on a phone,
 * so a glance at the set never leaves the page. It reads Home's own review
 * query, so its count is the items count Home's Needs you head shows. Triage (seeds, going cold,
 * findings) stops no agent and never lights it. Absent at zero, and until the
 * review read lands, except that an open panel stays until it is closed, so
 * the last member to leave does not pull it away mid-use.
 */
export function AttentionAlert() {
  const review = useQuery(reviewQuery());
  const desktop = useMediaQuery(DESKTOP);
  const currentId = useCurrentNodeId();
  const href = useRouterState({ select: (state) => state.location.href });
  const [open, setOpen] = useState(false);
  const [seenHref, setSeenHref] = useState(href);
  const [seenDesktop, setSeenDesktop] = useState(desktop);
  // When this console mounted: the badge takes only reads that land after it.
  const [mountedAt] = useState(() => Date.now());
  // Navigating closes the panel: the operator has moved on to what they chose.
  // So does crossing the breakpoint, which swaps the popover for the sheet and
  // would remount the list, losing a row's open dialog and what is typed in it.
  if (seenHref !== href || seenDesktop !== desktop) {
    setSeenHref(href);
    setSeenDesktop(desktop);
    setOpen(false);
  }

  const report = review.data;
  const count = report?.queue.length ?? 0;
  // The installed app's icon carries the same count as the pill (MMR-710),
  // from this session's reads only: a persisted report may predate a push
  // that has since moved the icon. The persister restores after mount, so
  // only data read since mount counts, not isFetchedAfterMount; a failed
  // refetch keeps the last read's time and so never re-syncs.
  const freshRead = review.dataUpdatedAt >= mountedAt;
  useAppBadge(freshRead ? { count, readAt: review.dataUpdatedAt } : undefined);
  if (report === undefined || (count === 0 && !open)) {
    return null;
  }
  const label = `${String(count)} ${count === 1 ? 'needs' : 'need'} you`;
  const words = count === 1 ? 'needs you' : 'need you';
  // The trigger takes focus back from a walkthrough a panel entry opened (MMR-714).
  const returnTarget = { [RETURN_TARGET_ATTRIBUTE]: NEEDS_YOU_ENTRY };
  // A row's Reason or confirm dialog is not part of the popover's or sheet's tree, so
  // focus moving into it, or its Escape, reads as leaving. The panel stays until it closes.
  const holdForNestedDialog = (next: boolean) => {
    if (!next && document.querySelector(OPEN_DIALOG) !== null) {
      return;
    }
    setOpen(next);
  };
  const panel = (close?: ReactNode) => (
    <NeedsYouPanel
      report={report}
      offline={connectivity([review]).offline}
      currentId={currentId}
      onNavigate={() => {
        setOpen(false);
      }}
      close={close}
    />
  );

  if (desktop) {
    return (
      <PopoverRoot open={open} onOpenChange={holdForNestedDialog}>
        <PopoverTrigger aria-label={label} className={PILL} {...returnTarget}>
          <PillFace count={count} words={words} />
        </PopoverTrigger>
        <PopoverContent aria-label="Needs you">{panel()}</PopoverContent>
      </PopoverRoot>
    );
  }
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        {...returnTarget}
        onClick={() => {
          setOpen(true);
        }}
        className={PILL}
      >
        <PillFace count={count} words={words} />
      </button>
      <Sheet open={open} onOpenChange={holdForNestedDialog}>
        <SheetContent side="bottom" aria-label="Needs you" aria-describedby={undefined}>
          {panel(
            <SheetClose aria-label="Close" className={cn(iconButtonClass, '-mr-2 ml-auto')}>
              <CloseIcon />
            </SheetClose>,
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
