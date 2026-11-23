import { cn } from '../../../lib/cn';
import { IconButton } from '../../ui/icon-button';
import { ChevronLeftIcon, ChevronRightIcon } from '../../ui/icons';
import { deckRange } from './deck-model';

/*
 * The Needs you deck's pagers (ADR 0019, MMR-721; DESIGN.md, Needs you deck):
 * the phone's Previous, position, and Next centred under the deck, and the
 * desktop's range and arrows in the section head. An arrow at an end is
 * `aria-disabled`, not disabled, so focus on it never drops to the page.
 */

/** Which way an arrow turns the deck. */
export type DeckTurn = -1 | 1;

/** One arrow: 44 square on a phone and 36 from `md`, edged in ink-dim on the page's ground. */
function PagerArrow({
  turn,
  label,
  atEnd,
  onTurn,
}: {
  turn: DeckTurn;
  label: string;
  atEnd: boolean;
  onTurn: (turn: DeckTurn) => void;
}) {
  const Chevron = turn === 1 ? ChevronRightIcon : ChevronLeftIcon;
  return (
    <IconButton
      aria-label={label}
      aria-disabled={atEnd ? true : undefined}
      onClick={() => {
        if (!atEnd) {
          onTurn(turn);
        }
      }}
      className={cn(
        'rounded-lg inset-ring md:rounded-lg',
        atEnd
          ? 'cursor-default text-ink-faint inset-ring-line hover:bg-transparent hover:text-ink-faint'
          : 'inset-ring-ink-dim',
      )}
    >
      <Chevron className="size-5 md:size-5" />
    </IconButton>
  );
}

/** A number that holds the width of the total's digits, so the arrows never shift as it grows. */
function Held({ value, digits }: { value: number; digits: number }) {
  return (
    <span className="inline-block text-right" style={{ minWidth: `${String(digits)}ch` }}>
      {value}
    </span>
  );
}

/** The phone's pager, centred 8 under the deck: Previous, "2 of 10", Next. */
export function PhonePager({
  index,
  count,
  onTurn,
}: {
  index: number;
  count: number;
  onTurn: (turn: DeckTurn) => void;
}) {
  const digits = String(count).length;
  return (
    <div data-slot="deck-pager" className="mt-2 flex items-center justify-center gap-3">
      <PagerArrow turn={-1} label="Previous card" atEnd={index === 0} onTurn={onTurn} />
      <p className="m-0 min-w-16 text-center text-meta text-ink-dim tabular-nums">
        <span className="font-semibold text-ink-bright">
          <Held value={index + 1} digits={digits} />
        </span>{' '}
        of {count}
      </p>
      <PagerArrow turn={1} label="Next card" atEnd={index === count - 1} onTurn={onTurn} />
    </div>
  );
}

/** The desktop pager for the section head: "5–8 of 10", then Previous page and Next page 8 apart. */
export function DesktopPager({
  page,
  count,
  pages,
  onTurn,
}: {
  page: number;
  count: number;
  pages: number;
  onTurn: (turn: DeckTurn) => void;
}) {
  const digits = String(count).length;
  const { first, last } = deckRange({ count, page });
  return (
    <div data-slot="deck-pager" className="flex items-center gap-3">
      <p className="m-0 text-meta text-ink-dim tabular-nums">
        <span className="font-semibold text-ink-bright">
          <Held value={first} digits={digits} />–<Held value={last} digits={digits} />
        </span>{' '}
        of {count}
      </p>
      <div className="flex gap-2">
        <PagerArrow turn={-1} label="Previous page" atEnd={page === 0} onTurn={onTurn} />
        <PagerArrow turn={1} label="Next page" atEnd={page === pages - 1} onTurn={onTurn} />
      </div>
    </div>
  );
}
