import { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewReport } from '../api/view-queries';
import { readMark } from '../lib/walkthrough-mark';
import { consoleRoutes } from '../router';
import { serveBrowse } from './browse-fns';
import { blocked, decision, question, report, stopped } from './needs-you-fixtures';
import { renderRoute } from './router';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import { serveViews } from './views-fns';

/*
 * The Needs you page at `/needs-you` (ADR 0013 and ADR 0019, MMR-723
 * refinements): the set's cards grouped by project under Home's page head,
 * the bar's Work through all, and the empty state. The grouping rule is swept
 * in needs-you-deck-model.test.ts and the list's focus rules in
 * feed-card-list.test.tsx; this proves the page puts them together.
 */

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');
vi.mock('../api/fns/deliveries');
vi.mock('../components/patterns/notice', () => ({
  NoticeHost: () => null,
  toast: { error: vi.fn(), success: vi.fn() },
}));

beforeEach(() => {
  serveBrowse();
  stubViewport('desktop');
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const NAMES = { FLT: 'Fleet', MMR: 'Mimir' };

/** Four cards holding five records in two projects, in the set's one order. */
const SET = report(
  [
    stopped('FLT-d2'),
    question('MMR-731'),
    decision('FLT-q1', { delivery: 'FLT-d2' }),
    decision('FLT-q2', { delivery: 'FLT-d2' }),
    blocked('MMR-688'),
  ],
  { names: NAMES },
);

async function openPage(served: ReviewReport) {
  const world = serveViews({ review: served });
  serveShell();
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } });
  const view = await renderRoute(consoleRoutes, '/needs-you', client);
  await screen.findByRole('heading', { level: 1, name: 'Needs you' });
  /** Serve `next` and refetch, as the poll after a write would. */
  const refetch = async (next: ReviewReport) => {
    world.review = next;
    await act(async () => {
      await client.invalidateQueries();
    });
  };
  return { ...view, refetch };
}

const bar = () => screen.getByRole('link', { name: /^Work through/u });
const target = (title: string) => screen.getByRole('button', { name: title });

describe('the list', () => {
  it('heads the page with its title and how many cards and items in how many projects', async () => {
    await openPage(SET);
    expect(screen.getByText('4 cards, 5 items in 2 projects.')).toBeVisible();
  });

  it('reads one card, one item, and one project in the singular', async () => {
    await openPage(report([question('MMR-731')], { names: NAMES }));
    expect(screen.getByText('1 card, 1 item in 1 project.')).toBeVisible();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Mimir 1 card, 1 item');
  });

  it('groups the cards by project at each project’s first card, in rank within it', async () => {
    await openPage(SET);
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((head) => head.textContent),
    ).toStrictEqual(['Fleet 2 cards, 3 items', 'Mimir 2 cards, 2 items']);
    const fleet = screen.getByRole('region', { name: /^Fleet/u });
    expect(
      within(fleet)
        .getAllByRole('button', { name: /^Delivery FLT-d2|^Rolling|^Decisions on/u })
        .map((button) => button.textContent),
    ).toStrictEqual(['Delivery FLT-d2', 'Decisions on FLT-d2']);
    const mimir = screen.getByRole('region', { name: /^Mimir/u });
    expect(within(mimir).getAllByRole('button', { name: /^Task MMR/u })).toHaveLength(2);
    expect(within(mimir).getByText('Task MMR-731')).toBeVisible();
  });

  it('puts the bundle’s set name on its button, so a walkthrough’s return finds it', async () => {
    await openPage(SET);
    expect(screen.getByRole('button', { name: 'Review 2 decisions on FLT-d2' })).toHaveAttribute(
      'data-walkthrough-return',
      'delivery:FLT-d2',
    );
  });
});

describe('Work through all', () => {
  it('names the set’s records and opens the focus queue marked as opened from the page', async () => {
    const { router } = await openPage(SET);
    expect(bar()).toHaveAccessibleName('Work through all 5');
    expect(bar()).toHaveAttribute('href', '/?mode=focus');
    expect(bar()).toHaveAttribute('data-walkthrough-return', 'needs-you:work-through');
    expect(
      screen.getByText('One item at a time, in queue order across projects, then back here.'),
    ).toBeInTheDocument();

    await userEvent.click(bar());
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ mode: 'focus' });
    });
    expect(readMark(router.state.location.state)).toStrictEqual({
      entry: 'needs-you:work-through',
      opener: '/needs-you',
    });
  });

  it('reads “Work through 1 item” for one record', async () => {
    await openPage(report([question('MMR-731')], { names: NAMES }));
    expect(bar()).toHaveAccessibleName('Work through 1 item');
  });

  it('sits outside the page’s scroller, after it', async () => {
    await openPage(SET);
    const main = screen.getByRole('main');
    expect(main).not.toContainElement(bar());
    expect(main.compareDocumentPosition(bar()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('cards that leave', () => {
  it('moves focus from a card that left to the next card, across a section that emptied', async () => {
    const { refetch } = await openPage(
      report([stopped('FLT-d2'), question('MMR-731')], { names: NAMES }),
    );
    target('Delivery FLT-d2').focus();
    await refetch(report([question('MMR-731')], { names: NAMES }));
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: /^Fleet/u })).toBeNull();
    });
    expect(target('Task MMR-731')).toHaveFocus();
    expect(screen.getByText('1 card, 1 item in 1 project.')).toBeVisible();
  });

  it('falls to the quiet line, with no sentence and no bar, and gives it the bar’s focus', async () => {
    const { refetch } = await openPage(report([question('MMR-731')], { names: NAMES }));
    bar().focus();
    await refetch(report([], { names: NAMES }));
    const quietLine = await screen.findByText('Nothing needs you.');
    expect(quietLine).toHaveFocus();
    expect(screen.queryByRole('link', { name: /^Work through/u })).toBeNull();
    expect(screen.queryByText(/in \d+ projects?\./u)).toBeNull();
  });
});

describe('an empty set', () => {
  it('shows the title and the quiet line alone', async () => {
    await openPage(report([], { names: NAMES }));
    expect(screen.getByText('Nothing needs you.')).toBeVisible();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Work through/u })).toBeNull();
  });
});
