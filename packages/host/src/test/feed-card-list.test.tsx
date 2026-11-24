import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CardAction } from '../components/patterns/feed/card-actions';
import { FeedCardList } from '../components/patterns/feed/card-list';
import type {
  FeedCardListHandle,
  ListCard,
  ListSection,
} from '../components/patterns/feed/card-list';
import { nodeLink } from '../lib/record-url';
import { renderInRouter } from './router';
import { stubViewport } from './viewport';

/*
 * The grouped card list (ADR 0019, MMR-723 refinement: The list's state): one
 * feed section per group, and where focus goes when a card leaves, a section
 * empties, a dialog returns, or nothing is left, at the pattern's seam. The
 * successor rule itself is swept in card-list-model.test.ts.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A card with the given identity; its title is `Card <key>`. */
function card(key: string, action?: CardAction): ListCard {
  return {
    action,
    card: { id: key, lead: <span>Ready</span>, title: `Card ${key}` },
    key,
    previewKey: key,
  };
}

/** Sections from `[title, keys]` pairs, each counted by its cards. */
function sections(...groups: [string, (string | ListCard)[]][]): ListSection[] {
  return groups.map(([title, cards]) => ({
    cards: cards.map((each) => (typeof each === 'string' ? card(each) : each)),
    count: `${String(cards.length)} cards`,
    key: title,
    title,
  }));
}

function list(groups: readonly ListSection[], handle = createRef<FeedCardListHandle>()) {
  const ui = (
    <FeedCardList
      ref={handle}
      sections={groups}
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

async function renderList(
  groups: readonly ListSection[],
  viewport: 'phone' | 'desktop' = 'desktop',
) {
  stubViewport(viewport);
  const { handle, ui } = list(groups);
  const rendered = await renderInRouter(ui);
  const refetch = (next: readonly ListSection[]) => {
    rendered.rerender(list(next, handle).ui);
  };
  return { ...rendered, handle, refetch };
}

const target = (key: string) => screen.getByRole('button', { name: `Card ${key}` });

describe('the sections', () => {
  it('shows one section per group, headed by its title and worded count, with its cards in order', async () => {
    await renderList(sections(['Fleet', ['F-1', 'F-2']], ['Mimir', ['M-1']]));
    const fleet = screen.getByRole('region', { name: 'Fleet 2 cards' });
    expect(
      within(fleet)
        .getAllByRole('button', { name: /^Card/u })
        .map((button) => button.textContent),
    ).toStrictEqual(['Card F-1', 'Card F-2']);
    expect(screen.getByRole('region', { name: 'Mimir 1 cards' })).toBeInTheDocument();
    // A section head is not a link.
    expect(within(fleet).queryByRole('link')).toBeNull();
  });

  it('puts the return-target name a card’s action names on its button', async () => {
    const review: CardAction = {
      kind: 'navigate',
      label: 'Review 2 decisions',
      returnTarget: 'delivery:F-d2',
      run: vi.fn(),
    };
    await renderList(sections(['Fleet', [card('delivery:F-d2', review)]]));
    expect(screen.getByRole('button', { name: 'Review 2 decisions' })).toHaveAttribute(
      'data-walkthrough-return',
      'delivery:F-d2',
    );
  });
});

describe('cards that leave', () => {
  it('moves focus from a card that left to the next card in the old order, across sections', async () => {
    const { refetch } = await renderList(sections(['Fleet', ['F-1', 'F-2']], ['Mimir', ['M-1']]));
    target('F-2').focus();
    refetch(sections(['Fleet', ['F-1']], ['Mimir', ['M-1']]));
    expect(target('M-1')).toHaveFocus();
  });

  it('moves focus to the card before when the last card leaves, and drops a section with its last card', async () => {
    const { refetch } = await renderList(sections(['Fleet', ['F-1']], ['Mimir', ['M-1']]));
    target('M-1').focus();
    refetch(sections(['Fleet', ['F-1']]));
    expect(target('F-1')).toHaveFocus();
    expect(screen.queryByRole('region', { name: /^Mimir/u })).toBeNull();
  });

  it('moves focus to the first card when no card that was on the page survives', async () => {
    const { refetch } = await renderList(sections(['Fleet', ['F-1', 'F-2']]));
    target('F-2').focus();
    refetch(sections(['Mimir', ['M-1', 'M-2']]));
    expect(target('M-1')).toHaveFocus();
  });

  it('moves no focus when a card that holds none leaves', async () => {
    const { refetch } = await renderList(sections(['Fleet', ['F-1', 'F-2', 'F-3']]));
    target('F-3').focus();
    refetch(sections(['Fleet', ['F-2', 'F-3']]));
    expect(target('F-3')).toHaveFocus();
  });

  it('moves no focus when the card that focus let go of leaves', async () => {
    const { refetch } = await renderList(sections(['Fleet', ['A', 'B', 'C']]));
    target('B').focus();
    // A press on the page's background lets focus go to the body.
    act(() => {
      target('B').blur();
    });
    await act(async () => {
      await Promise.resolve();
    });
    refetch(sections(['Fleet', ['A', 'C']]));
    expect(document.body).toHaveFocus();
  });

  it('keeps focus in a card that stays but lost its button, on that card’s target', async () => {
    const clear: CardAction = {
      kind: 'write',
      label: 'Clear stop',
      name: 'Clear stop B',
      run: vi.fn(),
    };
    const { refetch } = await renderList(sections(['Fleet', ['A', card('B', clear), 'C']]));
    screen.getByRole('button', { name: 'Clear stop B' }).focus();
    refetch(sections(['Fleet', ['A', 'B', 'C']]));
    expect(target('B')).toHaveFocus();
  });

  it('falls to the quiet line, which takes the focus the last card held', async () => {
    const { refetch } = await renderList(sections(['Fleet', ['F-1']]));
    target('F-1').focus();
    refetch([]);
    expect(screen.getByText('Nothing needs you.')).toHaveFocus();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('closes the preview of a card that left and moves the focus in it to the successor', async () => {
    const { refetch } = await renderList(sections(['Fleet', ['F-1', 'F-2']]));
    await userEvent.click(target('F-1'));
    const panel = screen.getByRole('dialog');
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    refetch(sections(['Fleet', ['F-2']]));
    expect(target('F-2')).toHaveFocus();
    expect(target('F-2')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('focus after a dialog opened from a card', () => {
  const answer: CardAction = { kind: 'dialog', label: 'Answer…', name: 'Answer A', run: vi.fn() };

  it('goes to the card’s button, to its successor’s target once it left, and to the quiet line once none remain', async () => {
    const { handle, refetch } = await renderList(
      sections(['Fleet', [card('A', answer)]], ['Mimir', ['B']]),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Answer A' }));
    act(() => {
      handle.current?.restoreFocus('A');
    });
    expect(screen.getByRole('button', { name: 'Answer A' })).toHaveFocus();
    refetch(sections(['Mimir', ['B']]));
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

  it('goes to its target when its button is gone but the card stays', async () => {
    const { handle, refetch } = await renderList(sections(['Fleet', [card('A', answer), 'B']]));
    await userEvent.click(screen.getByRole('button', { name: 'Answer A' }));
    refetch(sections(['Fleet', ['A', 'B']]));
    act(() => {
      handle.current?.restoreFocus('A');
    });
    expect(target('A')).toHaveFocus();
  });
});

describe('the quiet line', () => {
  it('takes focus when asked, as when Work through all leaves with the last card', async () => {
    const { handle, refetch } = await renderList(sections(['Fleet', ['F-1']]));
    refetch([]);
    act(() => {
      handle.current?.focusQuiet();
    });
    expect(screen.getByText('Nothing needs you.')).toHaveFocus();
  });
});
