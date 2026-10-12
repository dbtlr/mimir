import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, vi } from 'vitest';

import type { WireTreeNode } from '../api/types';
import { BoardView, swipeTarget } from '../components/board';
import { buildBoard } from '../lib/board';
import { NOW, daysAgo, task } from './fixtures';
import { renderInRouter } from './router';

vi.mock('../api/mutations', () => ({
  useReorder: () => ({ mutate: vi.fn() }),
  useTransition: () => ({ mutate: vi.fn() }),
}));

/** The desktop swimlane container — the surface under test (mobile is a separate branch). */
function swimlane(): HTMLElement {
  return screen.getByTestId('swimlane');
}

describe('boardView — swimlane', () => {
  it('cards land in their status column, Ready in the given order', async () => {
    const board = buildBoard(
      [
        task({ id: 'MMR-9', status: 'ready', title: 'queued first' }),
        task({ id: 'MMR-2', status: 'in_progress', title: 'being built' }),
        task({ id: 'MMR-7', status: 'ready', title: 'queued second' }),
        task({ id: 'MMR-4', status: 'blocked', title: 'stuck on review' }),
      ],
      [task({ completed_at: daysAgo(2), id: 'MMR-50', status: 'done', title: 'shipped' })],
      NOW,
    );
    await renderInRouter(<BoardView board={board} bands="off" doneTotal={1} projectKey="MMR" />);

    const ready = within(swimlane()).getByRole('list', { name: 'Ready' });
    const readyIds = within(ready)
      .getAllByRole('listitem')
      .map((c) => c.textContent);
    expect(readyIds).toStrictEqual([
      expect.stringContaining('MMR-9'),
      expect.stringContaining('MMR-7'),
    ]);

    expect(
      within(within(swimlane()).getByRole('list', { name: 'In progress' })).getByText(
        'being built',
      ),
    ).toBeDefined();
    expect(
      within(within(swimlane()).getByRole('list', { name: 'Done' })).getByText('shipped'),
    ).toBeDefined();
  });

  it('groups band rows by nearest phase/initiative in Phase mode', async () => {
    const tree = {
      children: [
        {
          children: [
            {
              children: [{ children: [], id: 'MMR-9', title: 't', type: 'task' }],
              id: 'MMR-2',
              title: 'Phase A',
              type: 'phase',
            },
          ],
          id: 'MMR-1',
          title: 'Build',
          type: 'initiative',
        },
      ],
      id: 'MMR',
      title: 'Mimir',
      type: 'project',
    } as unknown as WireTreeNode;
    const board = buildBoard([task({ id: 'MMR-9', status: 'ready', title: 'phased' })], [], NOW);
    await renderInRouter(
      <BoardView board={board} bands="phase" tree={tree} doneTotal={0} projectKey="MMR" />,
    );
    // The band spine names the phase container.
    expect(within(swimlane()).getByText('Phase A')).toBeDefined();
  });

  it("links a phase band's spine and phone header to the container's page (MMR-450)", async () => {
    const tree = {
      children: [
        {
          children: [{ children: [], id: 'MMR-9', title: 't', type: 'task' }],
          id: 'MMR-2',
          title: 'Phase A',
          type: 'phase',
        },
      ],
      id: 'MMR',
      title: 'Mimir',
      type: 'project',
    } as unknown as WireTreeNode;
    const board = buildBoard([task({ id: 'MMR-9', status: 'ready', title: 'phased' })], [], NOW);
    await renderInRouter(
      <BoardView board={board} bands="phase" tree={tree} doneTotal={0} projectKey="MMR" />,
    );

    expect(within(swimlane()).getByRole('link', { name: /Phase A/ })).toHaveAttribute(
      'href',
      '/p/MMR/2',
    );
    expect(
      within(screen.getByTestId('mobile-board')).getByRole('link', { name: /Phase A/ }),
    ).toHaveAttribute('href', '/p/MMR/2');
  });

  it('the HELD ledge counts parked/blocked/awaiting project-wide', async () => {
    const board = buildBoard(
      [
        task({ id: 'MMR-1', status: 'parked' }),
        task({ id: 'MMR-2', status: 'blocked' }),
        task({ id: 'MMR-3', status: 'blocked' }),
        task({ id: 'MMR-4', status: 'ready' }),
      ],
      [],
      NOW,
    );
    await renderInRouter(<BoardView board={board} bands="off" doneTotal={0} projectKey="MMR" />);
    const held = within(swimlane()).getByText('HELD').parentElement as HTMLElement;
    expect(within(held).getByText('Parked').parentElement?.textContent).toContain('1');
    // Blocked carries the red wash when it holds work.
    const blocked = within(held).getByText('Blocked');
    expect(blocked.className).toContain('text-status-blocked-foreground');
    expect(blocked.parentElement?.textContent).toContain('2');
  });

  it('an under-review card exposes the verdict affordance', async () => {
    const board = buildBoard(
      [task({ id: 'MMR-3', status: 'under_review', title: 'awaiting sign-off' })],
      [],
      NOW,
    );
    await renderInRouter(<BoardView board={board} bands="off" doneTotal={0} projectKey="MMR" />);
    expect(within(swimlane()).getByText('NEEDS VERDICT')).toBeDefined();
    expect(within(swimlane()).getByText('Approve')).toBeDefined();
  });

  it('swipeTarget pages the full board-status order; ends and weak/vertical swipes are no-ops', async () => {
    // The mobile board pages this canonical order (STATUS_ORDER minus new/abandoned).
    const order = ['in_progress', 'under_review', 'ready', 'awaiting', 'blocked', 'parked', 'done'];
    expect(swipeTarget('in_progress', -150, 10, order)).toBe('under_review'); // left → next
    expect(swipeTarget('under_review', 150, 10, order)).toBe('in_progress'); // right → prev
    expect(swipeTarget('parked', -150, 10, order)).toBe('done'); // walks past held into done
    expect(swipeTarget('done', -150, 10, order)).toBeNull(); // past the end
    expect(swipeTarget('in_progress', 150, 10, order)).toBeNull(); // past the start
    expect(swipeTarget('ready', -30, 10, order)).toBeNull(); // below threshold
    expect(swipeTarget('ready', -150, 200, order)).toBeNull(); // vertical-dominant
  });

  it("a card's title is a real link to the task's page (MMR-453)", async () => {
    const board = buildBoard([task({ id: 'MMR-8', status: 'ready', title: 'open me' })], [], NOW);
    const { router } = await renderInRouter(
      <BoardView board={board} bands="off" doneTotal={0} projectKey="MMR" />,
    );
    const link = within(swimlane()).getByRole('link', { name: 'open me' });
    expect(link).toHaveAttribute('href', '/p/MMR/8');
    await userEvent.click(link);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/p/MMR/8');
    });
  });

  it("Done's drill-through links to the project's done tasks", async () => {
    const board = buildBoard(
      [],
      [task({ completed_at: daysAgo(1), id: 'MMR-50', status: 'done', title: 'shipped' })],
      NOW,
    );
    await renderInRouter(<BoardView board={board} bands="off" doneTotal={3} projectKey="MMR" />);
    expect(within(swimlane()).getByRole('link', { name: '1 of 3 recent · all →' })).toHaveAttribute(
      'href',
      '/tasks?project=MMR&status=done',
    );
  });
});

/** The mobile board body — the md:hidden single-status surface (mock 9a). */
function mobile(): HTMLElement {
  return screen.getByTestId('mobile-board');
}

describe('boardView — mobile board (mock 9a)', () => {
  it('the status control opens the nine-word sheet with Done·7d and census-only new/abandoned', async () => {
    const board = buildBoard(
      [
        task({ id: 'MMR-2', status: 'in_progress', title: 'building' }),
        task({ id: 'MMR-3', status: 'ready', title: 'queued' }),
      ],
      [],
      NOW,
    );
    await renderInRouter(
      <BoardView
        board={board}
        bands="off"
        doneTotal={0}
        projectKey="MMR"
        distribution={{ abandoned: 2, in_progress: 1, new: 5, ready: 1 }}
      />,
    );
    // The control names the default status + its live count.
    const control = within(mobile()).getByRole('button', { name: /In progress/ });
    expect(control.textContent).toContain('In progress · 1');

    fireEvent.click(control);
    const sheet = screen.getByRole('dialog');
    // Done carries the 7-day window tag, not a raw count.
    expect(within(sheet).getByText('Done · 7d')).toBeDefined();
    // New/abandoned counts come from the project rollup; the rows are census-only
    // (the board never fetched their card lists) — not buttons, no click handling.
    expect(within(sheet).queryByRole('button', { name: /New/ })).toBeNull();
    const newRow = within(sheet).getByText('New').closest('div');
    expect(newRow?.textContent).toContain('5');
  });

  it('selecting a sheet row re-renders the body for that status', async () => {
    const board = buildBoard(
      [
        task({ id: 'MMR-2', status: 'in_progress', title: 'building' }),
        task({ id: 'MMR-3', status: 'ready', title: 'queued' }),
      ],
      [],
      NOW,
    );
    await renderInRouter(<BoardView board={board} bands="off" doneTotal={0} projectKey="MMR" />);
    fireEvent.click(within(mobile()).getByRole('button', { name: /In progress/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Ready/ }));
    // The body swapped: the Ready card shows, the In-progress card is gone.
    expect(within(mobile()).getByText('queued')).toBeDefined();
    expect(within(mobile()).queryByText('building')).toBeNull();
  });

  it('renders an inline band header per band: name, ∞ for standing bands, and the card', async () => {
    const tree = {
      children: [
        {
          children: [{ children: [], id: 'MMR-9', title: 't', type: 'task' }],
          id: 'MMR-2',
          open_ended: true,
          title: 'Phase A',
          type: 'phase',
        },
      ],
      id: 'MMR',
      title: 'Mimir',
      type: 'project',
    } as unknown as WireTreeNode;
    const board = buildBoard(
      [task({ id: 'MMR-9', status: 'in_progress', title: 'phased' })],
      [],
      NOW,
    );
    await renderInRouter(
      <BoardView board={board} bands="phase" tree={tree} doneTotal={0} projectKey="MMR" />,
    );
    const body = mobile();
    expect(within(body).getByText('Phase A')).toBeDefined();
    expect(within(body).getByText('∞')).toBeDefined();
    expect(within(body).getByText('phased')).toBeDefined();
  });

  it('falls back to the empty state on an empty board', async () => {
    const board = buildBoard([], [], NOW);
    await renderInRouter(<BoardView board={board} bands="off" doneTotal={0} projectKey="MMR" />);
    // No cards anywhere: selection falls back to In progress and shows its empty copy.
    expect(within(mobile()).getByText(/Nothing in progress/i)).toBeDefined();
  });

  it('opens on the first populated status when in-progress is empty', async () => {
    // Delta Records shape: work exists only in held/terminal columns, not in-progress.
    const board = buildBoard(
      [task({ id: 'MMR-3', status: 'parked', title: 'shelved for now' })],
      [task({ completed_at: daysAgo(1), id: 'MMR-4', status: 'done', title: 'shipped' })],
      NOW,
    );
    await renderInRouter(<BoardView board={board} bands="off" doneTotal={1} projectKey="MMR" />);
    // Lands on Parked (first populated in canonical order), not an empty In progress.
    expect(within(mobile()).getByRole('button', { name: /Parked/ })).toBeDefined();
    expect(within(mobile()).getByText('shelved for now')).toBeDefined();
    expect(within(mobile()).queryByText(/Nothing/i)).toBeNull();
  });

  it('the status control announces itself as a dialog trigger to assistive tech', async () => {
    const board = buildBoard(
      [task({ id: 'MMR-2', status: 'in_progress', title: 'building' })],
      [],
      NOW,
    );
    await renderInRouter(<BoardView board={board} bands="off" doneTotal={0} projectKey="MMR" />);
    const control = within(mobile()).getByRole('button', { name: /In progress/ });
    expect(control.getAttribute('aria-haspopup')).toBe('dialog');
    expect(control.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(control);
    expect(control.getAttribute('aria-expanded')).toBe('true');
  });

  it("a card's title links to the task's page on the phone board (MMR-453)", async () => {
    const board = buildBoard(
      [task({ id: 'MMR-8', status: 'in_progress', title: 'open me mobile' })],
      [],
      NOW,
    );
    await renderInRouter(<BoardView board={board} bands="off" doneTotal={0} projectKey="MMR" />);
    expect(within(mobile()).getByRole('link', { name: 'open me mobile' })).toHaveAttribute(
      'href',
      '/p/MMR/8',
    );
  });

  it('names the band of loose tasks without a way to a page (MMR-450)', async () => {
    const tree = {
      children: [{ children: [], id: 'MMR-9', title: 't', type: 'task' }],
      id: 'MMR',
      title: 'Mimir',
      type: 'project',
    } as unknown as WireTreeNode;
    const board = buildBoard([task({ id: 'MMR-9', status: 'ready', title: 'loose' })], [], NOW);
    await renderInRouter(
      <BoardView board={board} bands="phase" tree={tree} doneTotal={0} projectKey="MMR" />,
    );

    expect(within(swimlane()).getByText('Mimir')).toBeDefined();
    expect(within(swimlane()).queryByRole('link', { name: 'Mimir' })).toBeNull();
    expect(
      within(screen.getByTestId('mobile-board')).queryByRole('link', { name: 'Mimir' }),
    ).toBeNull();
  });
});
