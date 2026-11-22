import { Link } from '@tanstack/react-router';
import type { LinkOptions } from '@tanstack/react-router';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';

/*
 * A feed section and its head (ADR 0019, MMR-719 refinement): the section's
 * name in sentence case with its count in the same heading, and an optional
 * See all that opens the full list with a filter set. The head's row is 44px on
 * a phone with or without the link, so every section starts the same distance
 * below its head.
 */

/** Where a See all or a door leads: a router target, so its href is real. */
export type FeedLink = LinkOptions;

/** The link look shared by the feed's doors: accent text, a focus ring inside. */
export const FEED_LINK_CLASS =
  'text-accent-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

export function SectionHead({
  id,
  title,
  count,
  seeAll,
}: {
  /** The heading's id, which the section is labelled by. */
  id: string;
  title: string;
  count?: number;
  seeAll?: FeedLink;
}) {
  return (
    <div className="mb-2 flex min-h-11 items-center gap-2 md:min-h-9">
      <h2 id={id} className="m-0 min-w-0 text-section font-semibold text-ink-bright">
        {title}
        {count !== undefined && ' '}
        {count !== undefined && (
          <span className="ml-1 text-meta font-normal text-ink-dim">
            {count.toLocaleString('en-US')}
          </span>
        )}
      </h2>
      {seeAll !== undefined && (
        <Link
          {...seeAll}
          aria-label={`See all in ${title}`}
          className={cn(
            'ml-auto inline-flex min-h-11 shrink-0 items-center rounded-md px-1 text-meta font-medium md:min-h-9',
            FEED_LINK_CLASS,
          )}
        >
          See all
        </Link>
      )}
    </div>
  );
}

/** A feed section: its head, then its block. Sections sit 32px apart. */
export function FeedSection({
  title,
  count,
  seeAll,
  children,
  className,
}: {
  title: string;
  count?: number;
  seeAll?: FeedLink;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('mt-8 first:mt-0', className)}>
      <SectionHead id={id} title={title} count={count} seeAll={seeAll} />
      {children}
    </section>
  );
}
