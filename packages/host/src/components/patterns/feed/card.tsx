import { useId } from 'react';
import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';
import { cardVariants } from '../../ui/card';
import { useCardPreview } from './feed-preview';
import { FeedStatusLine } from './status-line';

/**
 * A feed card (ADR 0019, MMR-719 and MMR-720 refinements): a status line, the
 * title, an optional detail line, an optional chip row, and at most one button.
 * The whole card is one button that opens the card's preview: the title's
 * button stretches over the card, so a tap anywhere on it, beside the button
 * too, opens the preview, and a tap on the selected card closes it. The card's
 * own button is stacked over that target as its own target. A card sits inside
 * a `FeedPreview`, which holds which card is selected.
 *
 * `lead` is what the item is, from the feature: a task's status badge, or the
 * word _Decisions_ after an attention dot. The target's accessible description
 * is the status line and the chip row, so a screen reader hears the status with
 * the title.
 */
export function FeedCard({
  previewKey,
  lead,
  id,
  project,
  age,
  title,
  detail,
  chips,
  action,
  cold = false,
}: {
  /** The key the card's `FeedPreview` asks its preview for. */
  previewKey: string;
  lead: ReactNode;
  /** The record's ID, set in mono after the lead. */
  id?: string;
  /** The project's name after the ID, where the feed spans projects (the Needs you deck, MMR-721). */
  project?: string;
  /** How long ago the item last moved ("50m"), at the right of the first line. */
  age?: string;
  title: string;
  /** One line of context, two lines at most. */
  detail?: ReactNode;
  /** The row chips (size, grooming, stale), in their own row under the title. */
  chips?: ReactNode;
  /** The card's one button, passed itself rather than wrapped, so the card can size it. */
  action?: ReactNode;
  /** A going-cold card: its title is demoted to ink-dim (ADR 0019 §7, MMR-718). */
  cold?: boolean;
}) {
  const statusId = useId();
  const chipsId = useId();
  const { selected, toggle } = useCardPreview(previewKey);
  // A slot given `false` or `null` (`chips={stale && <StaleBadge />}`) is empty.
  const hasChips = chips !== undefined && chips !== null && chips !== false;
  const hasAction = action !== undefined && action !== null && action !== false;
  const describedBy = hasChips ? `${statusId} ${chipsId}` : statusId;
  return (
    <article
      data-slot="feed-card"
      data-selected={selected ? '' : undefined}
      className={cn(
        cardVariants(),
        'group/card relative flex flex-col px-4 pt-3 pb-4 transition-colors hover:border-line-bright',
        // The selected card: a 7% accent wash mixed into the card's fill and the full accent edge.
        'data-selected:border-accent data-selected:bg-[color-mix(in_srgb,var(--color-accent)_7%,var(--color-well-850))] data-selected:hover:border-accent',
      )}
    >
      <FeedStatusLine
        id={statusId}
        lead={lead}
        recordId={id}
        project={project}
        age={age}
        className="mb-2"
      />
      <h3
        className={cn(
          'm-0 text-title font-medium text-pretty wrap-anywhere',
          cold ? 'text-ink-dim' : 'text-ink-bright',
        )}
      >
        <button
          type="button"
          data-slot="feed-card-target"
          aria-haspopup="dialog"
          aria-expanded={selected}
          aria-describedby={describedBy}
          onClick={(event) => {
            toggle(event.currentTarget);
          }}
          // The ring is drawn on the stretched overlay, so it rings the whole
          // card. `outline-none` sets the outline style the overlay inherits, so
          // the overlay sets its own style back to solid.
          className="cursor-pointer text-left outline-none after:absolute after:inset-0 after:rounded-[10px] after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-solid focus-visible:after:outline-accent"
        >
          {title}
        </button>
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
        // the stretched target, so a tap beside it still opens the preview.
        // The card holds the button at 44 on a phone and 36 on desktop, whatever
        // size the caller's button sets. On the selected card's wash an outline
        // button's ink-faint edge falls under 3:1, so it steps up to ink-dim.
        <div
          data-slot="feed-card-action"
          className="pointer-events-none relative mt-auto flex pt-3 *:pointer-events-auto *:relative *:z-10 *:min-h-11 group-data-selected/card:*:inset-ring-ink-dim md:*:min-h-9"
        >
          {action}
        </div>
      )}
    </article>
  );
}
