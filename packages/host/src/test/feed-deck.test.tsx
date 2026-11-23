import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeedDeck } from '../components/patterns/feed/deck';
import type { DeckAction, DeckCard, FeedDeckHandle } from '../components/patterns/feed/deck';
import { nodeLink } from '../lib/record-url';
import { renderInRouter } from './router';
import { stubViewport } from './viewport';
import type { Viewport } from './viewport';

/*
 * The Needs you deck (ADR 0019, MMR-721 refinement): its pagers, keys, and
 * the deck's state through turns, refetches, writes, and previews, at the
 * pattern's seam. The pure rules for the current card are swept in
 * deck-model.test.ts; swipes, the peek's tap, layout, and motion are
 * Chromium's (e2e/feed-deck.test.ts).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const clearStop = vi.fn();

/** A card with the given identity; its title is `Card <key>`. */
function deckCard(key: string, action?: DeckAction): DeckCard {
  return {
    action,
    card: { id: key, lead: <span>Ready</span>, title: `Card ${key}` },
    key,
    previewKey: key,
  };
}

const keys = (count: number) =>
  Array.from({ length: count }, (_, index) => `T-${String(index + 1)}`);
const cardsOf = (list: readonly string[]) => list.map((key) => deckCard(key));

/** The deck's element; a refetch passes the first render's `handle`, so the handle stays attached. */
function deck(
  cards: readonly DeckCard[],
  { offline = false } = {},
  handle = createRef<FeedDeckHandle>(),
) {
  const ui = (
    <FeedDeck
      ref={handle}
      title="Needs you"
      cards={cards}
      offline={offline}
      quiet="Nothing needs you."
      preview={(key) => ({
        id: key,
        lead: <span>Ready</span>,
        open: nodeLink(key),
        reason: 'Waiting on you.',
        title: `Card ${key}`,
      })}
    />
  );
  return { handle, ui };
}

async function renderDeck(cards: readonly DeckCard[], viewport: Viewport, options = {}) {
  const resize = stubViewport(viewport);
  const { handle, ui } = deck(cards, options);
  const rendered = await renderInRouter(ui);
  const refetch = (next: readonly DeckCard[], nextOptions = options) => {
    rendered.rerender(deck(next, nextOptions, handle).ui);
  };
  return { ...rendered, handle, refetch, resize };
}

const target = (key: string) => screen.getByRole('button', { name: `Card ${key}` });
const group = (name: string) => screen.getByRole('group', { name });
const status = () => screen.getByRole('status');

describe('phone deck', () => {
  it('shows one card, names it by its position, and starts with Previous at its end', async () => {
    await renderDeck(cardsOf(keys(10)), 'phone');
    expect(within(group('1 of 10')).getByText('Card T-1')).toBeVisible();
    // The peeking card and the rest are hidden from screen readers.
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(screen.getByText('of 10', { exact: false })).toHaveTextContent('1 of 10');
    expect(screen.getByRole('button', { name: 'Previous card' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Next card' })).not.toHaveAttribute('aria-disabled');
  });

  it('keeps the peeking card out of the tab order without making it inert', async () => {
    await renderDeck(cardsOf(keys(3)), 'phone');
    const peek = document.querySelector<HTMLElement>('[data-deck-card="T-2"]');
    expect(peek).toHaveAttribute('aria-hidden', 'true');
    expect(peek).not.toHaveAttribute('inert');
    expect(peek?.querySelector('button')).toHaveAttribute('tabindex', '-1');
    // The card after the peek is wholly off screen.
    expect(document.querySelector('[data-deck-card="T-3"]')).toHaveAttribute('inert');
  });

  it('turns with Next, keeps focus on the arrow, and announces the incoming card once', async () => {
    await renderDeck(cardsOf(keys(10)), 'phone');
    const next = screen.getByRole('button', { name: 'Next card' });
    await userEvent.click(next);
    expect(within(group('2 of 10')).getByText('Card T-2')).toBeVisible();
    expect(next).toHaveFocus();
    expect(status()).toHaveTextContent('2 of 10: Card T-2');
  });

  it('disables Next at the last card but keeps its focus there', async () => {
    await renderDeck(cardsOf(keys(2)), 'phone');
    const next = screen.getByRole('button', { name: 'Next card' });
    await userEvent.click(next);
    expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(next).toHaveFocus();
    await userEvent.click(next);
    expect(group('2 of 2')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous card' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('turns one card on Right and Left, moving focus from the old card into the new one', async () => {
    await renderDeck(cardsOf(keys(5)), 'phone');
    target('T-1').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(target('T-2')).toHaveFocus();
    expect(group('2 of 5')).toBeVisible();
    // Focus moved into the card, so the group is read as focus enters; nothing is announced.
    expect(status()).toHaveTextContent('');
    await userEvent.keyboard('{ArrowLeft}');
    expect(target('T-1')).toHaveFocus();
  });

  it('turns on a pointer click of Next that does not focus it, as in Safari, moving focus out of the old card', async () => {
    await renderDeck(cardsOf(keys(3)), 'phone');
    target('T-1').focus();
    act(() => {
      screen.getByRole('button', { name: 'Next card' }).click();
    });
    expect(target('T-2')).toHaveFocus();
  });

  it('keeps the current card by identity through a refetch that reorders the deck', async () => {
    const { refetch } = await renderDeck(cardsOf(keys(4)), 'phone');
    await userEvent.click(screen.getByRole('button', { name: 'Next card' }));
    refetch(cardsOf(['T-9', 'T-4', 'T-3', 'T-2', 'T-1']));
    expect(within(group('4 of 5')).getByText('Card T-2')).toBeVisible();
  });

  it('shows a single card with no pager', async () => {
    await renderDeck(cardsOf(['T-1']), 'phone');
    expect(group('1 of 1')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Next card' })).toBeNull();
    expect(document.querySelector('[data-slot="swipe-peek"]')).toBeNull();
  });
});

describe('desktop deck', () => {
  it('shows four cards a page and the range and arrows in the section head', async () => {
    await renderDeck(cardsOf(keys(10)), 'desktop');
    const head = screen.getByRole('heading', { level: 2, name: 'Needs you 10' }).parentElement;
    expect(head).toHaveTextContent('1–4 of 10');
    expect(screen.getAllByRole('group').map((card) => card.getAttribute('aria-label'))).toEqual([
      '1 of 10',
      '2 of 10',
      '3 of 10',
      '4 of 10',
    ]);
    const next = screen.getByRole('button', { name: 'Next page' });
    await userEvent.click(next);
    await userEvent.click(next);
    expect(head).toHaveTextContent('9–10 of 10');
    expect(screen.getAllByRole('group')).toHaveLength(2);
    expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(next).toHaveFocus();
    expect(status()).toHaveTextContent('9–10 of 10');
  });

  it('holds the grid at two rows of the tallest card only when it has more than one page', async () => {
    const { refetch } = await renderDeck(cardsOf(keys(5)), 'desktop');
    expect(document.querySelector('[data-slot="card-grid"]')).toHaveAttribute('data-held');
    refetch(cardsOf(keys(4)));
    expect(document.querySelector('[data-slot="card-grid"]')).not.toHaveAttribute('data-held');
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  });

  it('turns a page on Right, moving focus from a card to the new page’s first card', async () => {
    await renderDeck(cardsOf(keys(10)), 'desktop');
    target('T-3').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(target('T-5')).toHaveFocus();
    expect(status()).toHaveTextContent('5–8 of 10');
    await userEvent.keyboard('{ArrowLeft}');
    expect(target('T-1')).toHaveFocus();
  });

  it('closes the open preview on a page turn and leaves focus on the arrow that turned it', async () => {
    await renderDeck(cardsOf(keys(10)), 'desktop');
    await userEvent.click(target('T-2'));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Card T-2');
    const next = screen.getByRole('button', { name: 'Next page' });
    await userEvent.click(next);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(next).toHaveFocus();
  });

  it('keeps an unanchored page and refills it when an earlier card leaves', async () => {
    const { refetch } = await renderDeck(cardsOf(keys(10)), 'desktop');
    const next = screen.getByRole('button', { name: 'Next page' });
    await userEvent.click(next);
    refetch(cardsOf(keys(10).filter((key) => key !== 'T-2')));
    expect(group('5 of 9')).toHaveTextContent('Card T-6');
    expect(next).toHaveFocus();
  });

  it('follows a focused card to the page that now holds it, and announces the range', async () => {
    const { refetch } = await renderDeck(cardsOf(keys(10)), 'desktop');
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    target('T-5').focus();
    refetch(cardsOf(keys(10).filter((key) => key !== 'T-2')));
    expect(group('4 of 9')).toHaveTextContent('Card T-5');
    expect(target('T-5')).toHaveFocus();
    expect(status()).toHaveTextContent('1–4 of 9');
  });

  it('follows the previewed card to the page that now holds it when focus is outside the deck', async () => {
    const { refetch } = await renderDeck(cardsOf(keys(8)), 'desktop');
    await userEvent.click(target('T-2'));
    act(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await act(() => Promise.resolve());
    refetch(cardsOf(['T-1', 'T-3', 'T-4', 'T-5', 'T-6', 'T-2', 'T-7', 'T-8']));
    expect(screen.getByRole('heading', { name: /^Needs you/u }).parentElement).toHaveTextContent('5–8 of 8');
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Card T-2');
  });

  it('closes the preview when a refetch moves its card off the page a focused card holds', async () => {
    const { refetch } = await renderDeck(cardsOf(keys(8)), 'desktop');
    await userEvent.click(target('T-2'));
    act(() => {
      target('T-3').focus();
    });
    refetch(cardsOf(['T-1', 'T-3', 'T-4', 'T-5', 'T-6', 'T-2', 'T-7', 'T-8']));
    expect(screen.getByRole('heading', { name: /^Needs you/u }).parentElement).toHaveTextContent('1–4 of 8');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(target('T-3')).toHaveFocus();
  });

  it('keeps the current card when the viewport crosses 768', async () => {
    const { resize } = await renderDeck(cardsOf(keys(10)), 'desktop');
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    resize('phone');
    expect(within(group('5 of 10')).getByText('Card T-5')).toBeVisible();
    resize('desktop');
    expect(screen.getByRole('heading', { level: 2 }).parentElement).toHaveTextContent('5–8 of 10');
  });
});

describe('cards that leave', () => {
  it('moves focus from the current card that left to its successor, in the same place', async () => {
    const { refetch } = await renderDeck(cardsOf(keys(4)), 'phone');
    await userEvent.click(screen.getByRole('button', { name: 'Next card' }));
    target('T-2').focus();
    refetch(cardsOf(['T-1', 'T-3', 'T-4']));
    expect(within(group('2 of 3')).getByText('Card T-3')).toBeVisible();
    expect(target('T-3')).toHaveFocus();
  });

  it('moves back one when the last card leaves', async () => {
    const { refetch } = await renderDeck(cardsOf(keys(3)), 'phone');
    const next = screen.getByRole('button', { name: 'Next card' });
    await userEvent.click(next);
    await userEvent.click(next);
    target('T-3').focus();
    refetch(cardsOf(['T-1', 'T-2']));
    expect(target('T-2')).toHaveFocus();
    expect(group('2 of 2')).toBeVisible();
  });

  it('moves no focus when a card that holds none leaves', async () => {
    const { refetch } = await renderDeck(cardsOf(keys(6)), 'phone');
    const next = screen.getByRole('button', { name: 'Next card' });
    for (const _ of [1, 2, 3, 4]) {
      await userEvent.click(next);
    }
    refetch(cardsOf(keys(6).filter((key) => key !== 'T-2')));
    expect(within(group('4 of 5')).getByText('Card T-5')).toBeVisible();
    expect(next).toHaveFocus();
  });

  it('takes the new card at the old index when no old card survives', async () => {
    const { refetch } = await renderDeck(cardsOf(keys(4)), 'phone');
    await userEvent.click(screen.getByRole('button', { name: 'Next card' }));
    target('T-2').focus();
    refetch(cardsOf(['N-1', 'N-2', 'N-3']));
    expect(target('N-2')).toHaveFocus();
  });

  it('hands focus from a pager that unmounts to the current card', async () => {
    const { refetch } = await renderDeck(cardsOf(keys(2)), 'phone');
    const next = screen.getByRole('button', { name: 'Next card' });
    await userEvent.click(next);
    refetch(cardsOf(['T-2']));
    expect(target('T-2')).toHaveFocus();
  });

  it('shows the quiet line when the only card leaves, and gives it the focus the card held', async () => {
    const { refetch } = await renderDeck(cardsOf(['T-1']), 'phone');
    target('T-1').focus();
    refetch([]);
    const quiet = screen.getByText('Nothing needs you.');
    expect(quiet).toHaveFocus();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('shows only the quiet line when nothing needs you', async () => {
    await renderDeck([], 'desktop');
    expect(screen.getByText('Nothing needs you.')).toBeVisible();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('group')).toBeNull();
  });
});

/** _Clear stop_ as a write that starts, and hands its refusal to `calls`. */
const stopAction = (key: string, calls: { write?: () => void } = {}): DeckAction => ({
  kind: 'write',
  label: 'Clear stop',
  name: `Clear stop ${key}`,
  run: (press) => {
    clearStop(press.from);
    press.write.start();
    calls.write = () => {
      press.write.refused();
    };
  },
});

describe('writes', () => {
  it('marks a write in flight aria-disabled, still focused, on the card and in its preview', async () => {
    clearStop.mockClear();
    await renderDeck(
      [deckCard('D-1', stopAction('D-1')), deckCard('D-2', stopAction('D-2'))],
      'desktop',
    );
    const button = screen.getByRole('button', { name: 'Clear stop D-1' });
    await userEvent.click(button);
    expect(clearStop).toHaveBeenCalledWith('card');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveFocus();
    await userEvent.click(button);
    expect(clearStop).toHaveBeenCalledOnce();
    // The other card's write stays live.
    expect(screen.getByRole('button', { name: 'Clear stop D-2' })).not.toHaveAttribute(
      'aria-disabled',
    );
    await userEvent.click(target('D-1'));
    const footer = within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Clear stop D-1',
    });
    expect(footer).toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps a refused write’s card and returns focus to the pressed control', async () => {
    const calls: { write?: () => void } = {};
    await renderDeck([deckCard('D-1', stopAction('D-1', calls))], 'phone');
    const button = screen.getByRole('button', { name: 'Clear stop D-1' });
    await userEvent.click(button);
    act(() => {
      calls.write?.();
    });
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(button).toHaveFocus();
  });

  it('leaves focus where the operator moved it when a write is refused', async () => {
    const calls: { write?: () => void } = {};
    await renderDeck([deckCard('D-1', stopAction('D-1', calls)), ...cardsOf(['D-2'])], 'desktop');
    await userEvent.click(screen.getByRole('button', { name: 'Clear stop D-1' }));
    act(() => {
      target('D-2').focus();
    });
    act(() => {
      calls.write?.();
    });
    expect(target('D-2')).toHaveFocus();
  });

  it('disables writes offline but keeps navigation live', async () => {
    clearStop.mockClear();
    const review = vi.fn();
    await renderDeck(
      [
        deckCard('D-1', stopAction('D-1')),
        deckCard('delivery:D-2', { kind: 'navigate', label: 'Review 3 decisions', run: review }),
      ],
      'desktop',
      { offline: true },
    );
    const stop = screen.getByRole('button', { name: 'Clear stop D-1' });
    expect(stop).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(stop);
    expect(clearStop).not.toHaveBeenCalled();
    const reviewButton = screen.getByRole('button', { name: 'Review 3 decisions' });
    expect(reviewButton).not.toHaveAttribute('aria-disabled');
    await userEvent.click(reviewButton);
    expect(review).toHaveBeenCalledOnce();
  });
});

describe('focus after a dialog opened from a card', () => {
  const answer: DeckAction = { kind: 'dialog', label: 'Answer…', name: 'Answer A', run: vi.fn() };

  it('goes to the card’s button, to its successor’s target once it left, and to the quiet line once none remain', async () => {
    const { handle, refetch } = await renderDeck(
      [deckCard('A', answer), ...cardsOf(['B'])],
      'phone',
    );
    act(() => {
      handle.current?.restoreFocus('A');
    });
    expect(screen.getByRole('button', { name: 'Answer A' })).toHaveFocus();
    refetch(cardsOf(['B']));
    act(() => {
      handle.current?.restoreFocus('A');
    });
    expect(target('B')).toHaveFocus();
    refetch([]);
    act(() => {
      handle.current?.restoreFocus('B');
    });
    expect(screen.getByText('Nothing needs you.')).toHaveFocus();
  });

  it('goes to the current card’s target when the successor left too while the dialog was open', async () => {
    const { handle, refetch } = await renderDeck(
      [deckCard('A', answer), ...cardsOf(['B', 'C'])],
      'phone',
    );
    screen.getByRole('button', { name: 'Answer A' }).focus();
    const closeDialog = openOutsideDialog();
    refetch(cardsOf(['B', 'C']));
    refetch(cardsOf(['C']));
    closeDialog();
    act(() => {
      handle.current?.restoreFocus('A');
    });
    expect(target('C')).toHaveFocus();
  });

  it('spends a card’s successor on one return, so a later one follows the current card', async () => {
    const { handle, refetch } = await renderDeck(
      [deckCard('A', answer), ...cardsOf(['B', 'C'])],
      'phone',
    );
    screen.getByRole('button', { name: 'Answer A' }).focus();
    const closeDialog = openOutsideDialog();
    refetch(cardsOf(['B', 'C']));
    closeDialog();
    act(() => {
      handle.current?.restoreFocus('A');
    });
    expect(target('B')).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Next card' }));
    act(() => {
      handle.current?.restoreFocus('A');
    });
    expect(target('C')).toHaveFocus();
  });
});

/** A dialog outside the deck that takes focus, as the answer dialog does; returns its close. */
function openOutsideDialog(): () => void {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const inside = document.createElement('button');
  dialog.append(inside);
  document.body.append(dialog);
  act(() => {
    inside.focus();
  });
  return () => {
    dialog.remove();
  };
}

describe('turning to a card by identity', () => {
  it('turns the deck to the card at once and focuses its button', async () => {
    const review = vi.fn();
    const cards = [
      ...cardsOf(keys(6)),
      deckCard('delivery:D-2', { kind: 'navigate', label: 'Review 3 decisions', run: review }),
    ];
    const { handle } = await renderDeck(cards, 'desktop');
    let found = false;
    act(() => {
      found = handle.current?.turnTo('delivery:D-2') ?? false;
    });
    expect(found).toBe(true);
    expect(screen.getByRole('button', { name: 'Review 3 decisions' })).toHaveFocus();
    expect(screen.getByRole('heading', { level: 2 }).parentElement).toHaveTextContent('5–7 of 7');
    expect(handle.current?.turnTo('delivery:gone')).toBe(false);
  });

  it('closes the open preview when it turns to a card on another page', async () => {
    const { handle } = await renderDeck(cardsOf(keys(8)), 'desktop');
    await userEvent.click(target('T-2'));
    act(() => {
      handle.current?.turnTo('T-6');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(target('T-6')).toHaveFocus();
  });
});
