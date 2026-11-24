import { Link } from '@tanstack/react-router';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

import { cn } from '../../lib/cn';
import { useMediaQuery } from '../../lib/use-media-query';
import { DRAWER_DESKTOP_QUERY } from '../ui/drawer';
import { FEED_FOCUS_RING } from './feed/link';
import type { FeedLink } from './feed/link';
import { FeedStatusLine } from './feed/status-line';

/*
 * The record header (ADR 0019, MMR-726 refinement): what a project, initiative,
 * phase, or task is, in one shape. A quiet trail of its ancestors, the title,
 * the status line (the status, a hairline, then the type and ID), the summary
 * clamped to three lines, an optional chip row, then the state's main action
 * and More. On desktop the actions sit beside the title while the title keeps
 * at least 440px; otherwise, and always on a phone, they drop 16px below the
 * summary. Tabs, when a page has them, follow the header.
 */

/** One ancestor in the trail: its name and where it leads. */
export type TrailStep = { key: string; label: string; to: FeedLink };

const NO_TRAIL: readonly TrailStep[] = [];

/** The width the title keeps before the actions drop below the summary. */
const TITLE_MIN = 440;
/** The gap between the title and the actions beside it. */
const TITLE_GAP = 24;
/** The gap between two actions. */
const ACTION_GAP = 12;
/** A middle ancestor gives way to this width before the trail folds it into "…". */
const MIDDLE_MIN = 120;

/**
 * A tap target of at least 44 × 44 on a phone and 36 tall on desktop, centred
 * on a short link or text button without moving its text: the box around the
 * text is what you see, the pseudo-element is what you hit.
 */
const HIT_AREA =
  "relative after:absolute after:top-1/2 after:left-1/2 after:h-11 after:w-[max(100%,44px)] after:-translate-1/2 after:content-[''] md:after:h-9 md:after:w-full";

const TRAIL_LINK = cn(
  HIT_AREA,
  'inline-flex min-w-0 rounded-sm text-ink-dim transition-colors hover:text-accent-foreground',
  FEED_FOCUS_RING,
);

/**
 * Whether a desktop trail's middle ancestors have given way past their floor,
 * so the trail folds them. It folds at the width it overflowed at and unfolds
 * once the trail is wider than that again.
 */
function useTrailOverflow(trail: RefObject<HTMLElement | null>, measured: boolean) {
  const [foldedAt, setFoldedAt] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = trail.current;
    if (!measured || element === null) {
      return undefined;
    }
    const measure = () => {
      const width = element.clientWidth;
      if (width === 0) {
        return;
      }
      setFoldedAt((at) => {
        if (at !== null) {
          return width > at ? null : at;
        }
        const squeezed = [...element.querySelectorAll<HTMLElement>('[data-middle] > span')].some(
          (label) => label.clientWidth + 1 < Math.min(MIDDLE_MIN, label.scrollWidth),
        );
        return squeezed || element.scrollWidth > width + 1 ? width : null;
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [trail, measured]);
  return measured && foldedAt !== null;
}

function TrailSeparator() {
  return (
    <span aria-hidden className="shrink-0 text-ink-faint">
      /
    </span>
  );
}

/**
 * The trail of ancestors, outermost first, in one dim line with no type labels.
 * On a phone the ones between the project and the parent fold into "…"; on
 * desktop they give way first, each to 120px, then fold. The parent keeps its
 * whole name until it alone overflows. "…" shows the folded ones.
 */
function RecordTrail({ steps }: { steps: readonly TrailStep[] }) {
  const desktop = useMediaQuery(DRAWER_DESKTOP_QUERY);
  const [expanded, setExpanded] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const middles = steps.length - 2;
  const overflowing = useTrailOverflow(nav, desktop && middles > 0 && !expanded);
  const folded = middles > 0 && !expanded && (!desktop || overflowing);
  const first = steps[0];
  const last = steps.at(-1);
  const shown = folded && first !== undefined && last !== undefined ? [first, last] : steps;
  return (
    <nav
      ref={nav}
      aria-label="Ancestors"
      className={cn(
        'mb-2 flex min-w-0 items-center gap-2 text-meta whitespace-nowrap text-ink-dim',
        expanded && 'flex-wrap gap-y-1',
      )}
    >
      {shown.map((step, index) => {
        const middle = index > 0 && index < shown.length - 1;
        const parent = index === shown.length - 1 && index > 0;
        return (
          <span key={step.key} className="contents">
            {index > 0 && <TrailSeparator />}
            {folded && parent && (
              <>
                <button
                  type="button"
                  aria-label={`Show ${String(middles)} more ${middles === 1 ? 'ancestor' : 'ancestors'}`}
                  onClick={() => {
                    setExpanded(true);
                  }}
                  className={cn(HIT_AREA, 'shrink-0 rounded-sm text-ink-dim', FEED_FOCUS_RING)}
                >
                  …
                </button>
                <TrailSeparator />
              </>
            )}
            <Link
              {...step.to}
              data-middle={middle ? '' : undefined}
              className={cn(
                TRAIL_LINK,
                index === 0 && 'shrink-0',
                middle && 'shrink',
                // A sliver of shrink would already ellipsize the parent, so it
                // holds while a middle step can still give way.
                parent && (middles > 0 && !folded && !expanded ? 'shrink-0' : 'shrink'),
              )}
            >
              <span className="truncate">{step.label}</span>
            </Link>
          </span>
        );
      })}
    </nav>
  );
}

/** The summary, clamped to three lines, with "more" when it runs past them. */
function RecordSummary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const body = useRef<HTMLParagraphElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const element = body.current;
    if (element === null || open) {
      return undefined;
    }
    const measure = () => {
      setClamped(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [open]);
  return (
    <div className="mt-3 flex flex-col items-start">
      <p
        id={id}
        ref={body}
        className={cn(
          'max-w-[70ch] text-body text-pretty wrap-anywhere whitespace-pre-line text-ink',
          !open && 'line-clamp-3',
        )}
      >
        {text}
      </p>
      {(clamped || open) && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            setOpen((now) => !now);
          }}
          className={cn(
            HIT_AREA,
            'mt-1 rounded-sm text-label font-medium text-accent-foreground hover:underline',
            FEED_FOCUS_RING,
          )}
        >
          {open ? 'less' : 'more'}
        </button>
      )}
    </div>
  );
}

/**
 * Whether the actions fit beside the title with the title keeping 440px. Only
 * on desktop; a header with no layout (a DOM without one) keeps them below.
 */
function useActionsBeside(
  header: RefObject<HTMLElement | null>,
  actions: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [beside, setBeside] = useState(false);
  useLayoutEffect(() => {
    const element = header.current;
    if (!enabled || element === null) {
      return undefined;
    }
    let needed = 0;
    const measure = () => {
      const group = actions.current;
      if (group !== null) {
        const children = [...group.children];
        const total = children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
        needed = total + ACTION_GAP * Math.max(0, children.length - 1);
      }
      setBeside(needed > 0 && element.clientWidth >= TITLE_MIN + TITLE_GAP + needed);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (actions.current !== null) {
      observer.observe(actions.current);
    }
    return () => {
      observer.disconnect();
    };
  }, [header, actions, enabled]);
  return enabled && beside;
}

export function RecordHeader({
  trail = NO_TRAIL,
  title,
  status,
  type,
  recordId,
  summary,
  chips,
  actions,
  className,
}: {
  /** The record's ancestors, outermost first, ending with its parent; none for a project. */
  trail?: readonly TrailStep[];
  title: string;
  /** The status: a dot in its hue, then its word in bright ink. */
  status: ReactNode;
  /** The record's type in words ("Task", "Project"). */
  type: string;
  recordId: string;
  summary?: string | null;
  /** Chips about the record that sit with its summary (a task's grooming state). */
  chips?: ReactNode;
  /** The main action, then More. */
  actions?: ReactNode;
  className?: string;
}) {
  const desktop = useMediaQuery(DRAWER_DESKTOP_QUERY);
  const header = useRef<HTMLElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const beside = useActionsBeside(header, group, desktop && actions !== undefined);
  const text = summary?.trim() ?? '';
  const actionRow =
    actions === undefined ? null : (
      <div
        ref={group}
        data-slot="record-actions"
        className={cn('flex flex-wrap items-center gap-3', beside ? '-mt-1 shrink-0' : 'mt-4')}
      >
        {actions}
      </div>
    );
  return (
    <header ref={header} className={cn('flex min-w-0 flex-col', className)}>
      {trail.length > 0 && <RecordTrail steps={trail} />}
      <div className="flex items-start gap-6">
        <h1 className="min-w-0 flex-1 text-dossier leading-6 font-bold tracking-[-0.01em] text-pretty wrap-anywhere text-ink-bright md:text-header md:leading-7">
          {title}
        </h1>
        {beside && actionRow}
      </div>
      <FeedStatusLine className="mt-2" lead={status} type={type} recordId={recordId} />
      {/* Keyed by the text, so a new summary measures its own clamp afresh. */}
      {text !== '' && <RecordSummary key={text} text={text} />}
      {chips !== undefined && chips !== null && (
        <div className="mt-2 flex flex-wrap items-center gap-1">{chips}</div>
      )}
      {!beside && actionRow}
    </header>
  );
}
