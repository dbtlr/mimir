import { Link } from '@tanstack/react-router';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';
import { FEED_FOCUS_RING, FEED_LINK_TEXT } from './link';
import type { FeedLink } from './link';

/*
 * A feed section and its head (ADR 0019, MMR-719 refinement): the section's
 * name in sentence case with its count in the same heading, and an optional
 * See all that opens the full list with a filter set. The head's row is 44px on
 * a phone with or without the link, so every section starts the same distance
 * below its head.
 */

export function SectionHead({
  id,
  title,
  count,
  seeAll,
  pager,
}: {
  /** The heading's id, which the section is labelled by. */
  id: string;
  title: string;
  count?: number;
  seeAll?: FeedLink;
  /** Controls that page the section (the Needs you deck's range and arrows), right-aligned before See all. */
  pager?: ReactNode;
}) {
  const { head, wrapped } = usePagerWrap(pager !== undefined);
  return (
    <div
      ref={head}
      data-wrapped={wrapped ? '' : undefined}
      className={cn('mb-3 flex min-h-11 items-center gap-x-2 md:min-h-9', wrapped && 'flex-wrap')}
    >
      <h2 id={id} className="m-0 min-w-0 text-section font-semibold text-ink-bright wrap-anywhere">
        <span data-slot="section-name" className={cn(pager !== undefined && 'whitespace-nowrap')}>
          {title}
          {count !== undefined && ' '}
          {count !== undefined && (
            <span className="ml-1 text-meta font-normal text-ink-dim">
              {count.toLocaleString('en-US')}
            </span>
          )}
        </span>
      </h2>
      {pager !== undefined && (
        <div
          data-slot="section-pager"
          className={cn(
            'flex shrink-0 items-center',
            wrapped ? 'order-last basis-full justify-end' : 'ml-auto',
          )}
        >
          {pager}
        </div>
      )}
      {seeAll !== undefined && (
        <Link
          {...seeAll}
          data-slot="section-see-all"
          aria-label={`See all in ${title}`}
          className={cn(
            'inline-flex min-h-11 shrink-0 items-center rounded-md px-1 text-meta font-medium md:min-h-9',
            // After the pager, the head's 8 gap and the link's 4 padding make DESIGN.md's 12.
            (pager === undefined || wrapped) && 'ml-auto',
            FEED_LINK_TEXT,
            FEED_FOCUS_RING,
          )}
        >
          See all
        </Link>
      )}
    </div>
  );
}

/** The room the head keeps between the name, the pager, and See all, in px (DESIGN.md, Needs you deck). */
const PAGER_GAP = 12;

/**
 * Whether the head's pager wraps to a line of its own under the name: when the
 * name, the pager, and See all do not fit on one line. The pager reserves its
 * widest width itself, so a page turn never changes the answer.
 */
function usePagerWrap(hasPager: boolean) {
  const head = useRef<HTMLDivElement>(null);
  const [wrapped, setWrapped] = useState(false);
  useLayoutEffect(() => {
    const element = head.current;
    if (!hasPager || element === null) {
      setWrapped(false);
      return undefined;
    }
    const width = (selector: string) =>
      element.querySelector(selector)?.getBoundingClientRect().width ?? 0;
    const measure = () => {
      const seeAll = width('[data-slot="section-see-all"]');
      // The pager's own content, since its box spans the head's width once wrapped.
      const needed =
        width('[data-slot="section-name"]') +
        PAGER_GAP +
        width('[data-slot="section-pager"] > *') +
        (seeAll === 0 ? 0 : PAGER_GAP + seeAll);
      // A head with no layout (a DOM without one) has nothing to wrap.
      setWrapped(element.clientWidth > 0 && needed > element.clientWidth);
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
  }, [hasPager]);
  return { head, wrapped };
}

/** A feed section: its head, then its block. Sections sit 32px apart. */
export function FeedSection({
  title,
  count,
  seeAll,
  pager,
  children,
  className,
}: {
  title: string;
  count?: number;
  seeAll?: FeedLink;
  pager?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('mt-8 first:mt-0', className)}>
      <SectionHead id={id} title={title} count={count} seeAll={seeAll} pager={pager} />
      {children}
    </section>
  );
}
