import { useId } from 'react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { cardVariants } from '../ui/card';

/*
 * The state banner (ADR 0019, MMR-728 refinement): the one card at the top of
 * a task's Work that says what its state asks of the reader, such as an
 * agent at work, a review waiting, or a hold. It is the Card block's surface
 * (10 radius, 12 top, 16 sides and bottom), 24 above what follows. Its head
 * is the state as a 15 / 22 600 `ink-bright` title after its dot, and how
 * long it has held, 13 / 20 `ink-dim`, at the right. A hold that waits on
 * the reader takes the attention tone: its own 7 violet dot and the card's
 * edge in the violet, which marks only what needs the operator.
 */

/**
 * A banner's look: neutral, with the state's dot from the feature (a status
 * dot), or the attention tone, which draws its own dot.
 */
export type StateBannerTone = { tone?: 'neutral'; dot: ReactNode } | { tone: 'attention' };

export function StateBanner({
  title,
  age,
  children,
  ...look
}: StateBannerTone & {
  title: string;
  /** How long the state has held ("12m ago"). */
  age?: string;
  children?: ReactNode;
}) {
  const id = useId();
  const attention = look.tone === 'attention';
  return (
    <section
      aria-labelledby={id}
      className={cn(cardVariants(), 'px-4 pt-3 pb-4', attention && 'border-attention/35')}
    >
      <div className="flex items-center gap-2">
        {attention ? (
          <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-attention" />
        ) : (
          look.dot
        )}
        <h2 id={id} className="min-w-0 text-section font-semibold text-ink-bright">
          {title}
        </h2>
        {age !== undefined && (
          <span className="ml-auto shrink-0 text-meta whitespace-nowrap text-ink-dim">{age}</span>
        )}
      </div>
      {children}
    </section>
  );
}

/** The banner's prose: 14 / 23 ink, 8 below what is above it. */
export function BannerText({ children }: { children: ReactNode }) {
  return <div className="mt-2 text-body leading-[23px] text-pretty text-ink">{children}</div>;
}

/** A label over the banner's prose ("Latest note"): 13 / 20 `ink-dim`, 12 below the head, 2 above its text. */
export function BannerLabel({ children }: { children: ReactNode }) {
  return <p className="mt-3 -mb-1.5 text-meta text-ink-dim">{children}</p>;
}

/** The banner's facts, under a `line` hairline 16 below the text, the first fact 16 under it. */
export function BannerFacts({ children }: { children: ReactNode }) {
  return <div className="mt-4 border-t border-line pt-4">{children}</div>;
}
