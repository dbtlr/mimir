import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';
import { cardVariants } from '../../ui/card';
import type { FeedLink } from './link';

/**
 * A feed card (ADR 0019, MMR-719 refinement): a status line, the title, an
 * optional detail line, an optional chip row, and at most one button. The whole
 * card is one link: the title's link stretches over the card, so a tap anywhere
 * on it, beside the button too, follows the link. The button is stacked over
 * that link as its own target. Until the preview panel (MMR-720), the link
 * opens the record's page.
 *
 * `lead` is what the item is, from the feature: a task's status badge, or the
 * word _Decisions_ after an attention dot. The link's accessible description is
 * the status line and the chip row, so a screen reader hears the status with
 * the title.
 */
export function FeedCard({
  to,
  lead,
  id,
  age,
  title,
  detail,
  chips,
  action,
  cold = false,
}: {
  to: FeedLink;
  lead: ReactNode;
  /** The record's ID, set in mono after the lead. */
  id?: string;
  /** How long ago the item last moved ("50m"), at the right of the first line. */
  age?: string;
  title: string;
  /** One line of context, two lines at most. */
  detail?: ReactNode;
  /** The row chips (size, grooming, stale), in their own row under the title. */
  chips?: ReactNode;
  /** The card's one button. */
  action?: ReactNode;
  /** A going-cold card: its title is demoted to ink-dim (ADR 0019 §7, MMR-718). */
  cold?: boolean;
}) {
  const statusId = useId();
  const chipsId = useId();
  // A slot given `false` or `null` (`chips={stale && <StaleBadge />}`) is empty.
  const hasChips = chips !== undefined && chips !== null && chips !== false;
  const hasAction = action !== undefined && action !== null && action !== false;
  const describedBy = hasChips ? `${statusId} ${chipsId}` : statusId;
  return (
    <article
      className={cn(
        cardVariants(),
        'relative flex flex-col px-4 pt-3 pb-4 transition-colors hover:border-line-bright',
      )}
    >
      <div id={statusId} className="mb-2 flex items-start gap-2 text-meta text-ink-dim">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 wrap-anywhere">
          {lead}
          {/* Spaces between the parts: flex gaps set them apart on screen, the
              spaces keep them apart in the link's accessible description. */}{' '}
          {id !== undefined && <span className="font-mono whitespace-nowrap">{id}</span>}
        </span>{' '}
        {age !== undefined && <span className="shrink-0 whitespace-nowrap">{age}</span>}
      </div>
      <h3
        className={cn(
          'm-0 text-title font-medium text-pretty wrap-anywhere',
          cold ? 'text-ink-dim' : 'text-ink-bright',
        )}
      >
        <Link
          {...to}
          aria-describedby={describedBy}
          // The ring is drawn on the stretched overlay, so it rings the whole
          // card. `outline-none` sets the outline style the overlay inherits, so
          // the overlay sets its own style back to solid.
          className="outline-none after:absolute after:inset-0 after:rounded-[10px] after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-solid focus-visible:after:outline-accent"
        >
          {title}
        </Link>
      </h3>
      {detail !== undefined && (
        <p className="mt-1 mb-0 line-clamp-2 text-meta text-ink-dim wrap-anywhere">{detail}</p>
      )}
      {hasChips && (
        <div id={chipsId} className="flex flex-wrap gap-1 pt-2">
          {chips}
        </div>
      )}
      {hasAction && (
        // The button is held to the card's bottom, so in a grid row of unequal
        // cards the buttons line up. Only the button takes pointer events above
        // the stretched link, so a tap beside it still reaches the card's link.
        // The card holds the button at 44 on a phone and 36 on desktop, whatever
        // size the caller's button sets.
        <div className="pointer-events-none relative mt-auto flex pt-3 *:pointer-events-auto *:relative *:z-10 *:min-h-11 md:*:min-h-9">
          {action}
        </div>
      )}
    </article>
  );
}
