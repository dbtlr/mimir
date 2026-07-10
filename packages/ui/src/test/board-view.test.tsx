import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, vi } from 'vitest';

import type { WireTreeNode } from '../api/types';
import { BoardView, swipeTarget } from '../components/board';
import { buildBoard } from '../lib/board';
import { NOW, daysAgo, task } from './fixtures';

vi.mock('../api/mutations', () => ({
  useReorder: () => ({ mutate: vi.fn() }),
  useTransition: () => ({ mutate: vi.fn() }),
}));

// The quick view fetches the node's detail facet on open; resolve it so the
// panel/shelf mount cleanly (the shell renders from the in-memory node anyway).
const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend: vi.fn() }));
apiGet.mockImplementation((path: string) =>
  path.endsWith('/annotations')
    ? Promise.resolve({ items: [], total: 0 })
    : Promise.resolve({ description: null }),
);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { refetchInterval: false, retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The desktop swimlane container — the surface under test (mobile is a separate branch). */
function swimlane(): HTMLElement {
  return screen.getByTestId('swimlane');
}

describe('boardView — swimlane', () => {
  it('cards land in their status column, Ready in the given order', () => {
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
    render(
      <BoardView
        board={board}
        bands="off"
        onOpenNode={vi.fn()}
        doneTotal={1}
        onViewDone={vi.fn()}
      />,
      { wrapper },
    );

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

  it('groups band rows by nearest phase/initiative in Phase mode', () => {
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
    render(
      <BoardView
        board={board}
        bands="phase"
        tree={tree}
        onOpenNode={vi.fn()}
        doneTotal={0}
        onViewDone={vi.fn()}
      />,
      { wrapper },
    );
    // The band spine names the phase container.
    expect(within(swimlane()).getByText('Phase A')).toBeDefined();
  });

  it('the HELD ledge counts parked/blocked/awaiting project-wide', () => {
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
    render(
      <BoardView
        board={board}
        bands="off"
        onOpenNode={vi.fn()}
        doneTotal={0}
        onViewDone={vi.fn()}
      />,
      { wrapper },
    );
    const held = within(swimlane()).getByText('HELD').parentElement as HTMLElement;
    expect(within(held).getByText('Parked').parentElement?.textContent).toContain('1');
    // Blocked carries the red wash when it holds work.
    const blocked = within(held).getByText('Blocked');
    expect(blocked.className).toContain('text-status-blocked-foreground');
    expect(blocked.parentElement?.textContent).toContain('2');
  });

  it('an under-review card exposes the verdict affordance', () => {
    const board = buildBoard(
      [task({ id: 'MMR-3', status: 'under_review', title: 'awaiting sign-off' })],
      [],
      NOW,
    );
    render(
      <BoardView
        board={board}
        bands="off"
        onOpenNode={vi.fn()}
        doneTotal={0}
        onViewDone={vi.fn()}
      />,
      { wrapper },
    );
    expect(within(swimlane()).getByText('NEEDS VERDICT')).toBeDefined();
    expect(within(swimlane()).getByText('Approve')).toBeDefined();
  });

  it('swipeTarget pages the full board-status order; ends and weak/vertical swipes are no-ops', () => {
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

  it('clicking a card opens the quick view, not the dossier (MMR-223)', async () => {
    const onOpen = vi.fn();
    const board = buildBoard([task({ id: 'MMR-8', status: 'ready', title: 'open me' })], [], NOW);
    render(
      <BoardView
        board={board}
        bands="off"
        onOpenNode={onOpen}
        doneTotal={0}
        onViewDone={vi.fn()}
      />,
      { wrapper },
    );
    const title = within(swimlane()).getByText('open me').closest('button');
    await userEvent.click(title as HTMLElement);
    // The card selects into the drop panel — it does not route to `?node=`.
    expect(onOpen).not.toHaveBeenCalled();
    expect(within(swimlane()).getByTestId('quick-panel')).toBeDefined();
  });

  it("the drop panel's Full dossier link routes via onOpenNode (MMR-223)", async () => {
    const onOpen = vi.fn();
    const board = buildBoard([task({ id: 'MMR-8', status: 'ready', title: 'open me' })], [], NOW);
    render(
      <BoardView
        board={board}
        bands="off"
        onOpenNode={onOpen}
        doneTotal={0}
        onViewDone={vi.fn()}
      />,
      { wrapper },
    );
    const title = within(swimlane()).getByText('open me').closest('button');
    await userEvent.click(title as HTMLElement);
    await userEvent.click(within(swimlane()).getByText('Full dossier ↗'));
    expect(onOpen).toHaveBeenCalledWith('MMR-8');
  });
});

/** The mobile board body — the md:hidden single-status surface (mock 9a). */
function mobile(): HTMLElement {
  return screen.getByTestId('mobile-board');
}

describe('boardView — mobile board (mock 9a)', () => {
  it('the status control opens the nine-word sheet with Done·7d and census-only new/abandoned', () => {
    const board = buildBoard(
      [
        task({ id: 'MMR-2', status: 'in_progress', title: 'building' }),
        task({ id: 'MMR-3', status: 'ready', title: 'queued' }),
      ],
      [],
      NOW,
    );
    render(
      <BoardView
        board={board}
        bands="off"
        onOpenNode={vi.fn()}
        doneTotal={0}
        onViewDone={vi.fn()}
        distribution={{ abandoned: 2, in_progress: 1, new: 5, ready: 1 }}
      />,
      { wrapper },
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

  it('selecting a sheet row re-renders the body for that status', () => {
    const board = buildBoard(
      [
        task({ id: 'MMR-2', status: 'in_progress', title: 'building' }),
        task({ id: 'MMR-3', status: 'ready', title: 'queued' }),
      ],
      [],
      NOW,
    );
    render(
      <BoardView
        board={board}
        bands="off"
        onOpenNode={vi.fn()}
        doneTotal={0}
        onViewDone={vi.fn()}
      />,
      { wrapper },
    );
    fireEvent.click(within(mobile()).getByRole('button', { name: /In progress/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Ready/ }));
    // The body swapped: the Ready card shows, the In-progress card is gone.
    expect(within(mobile()).getByText('queued')).toBeDefined();
    expect(within(mobile()).queryByText('building')).toBeNull();
  });

  it('renders an inline band header per band: name, ∞ for standing bands, and the card', () => {
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
    render(
      <BoardView
        board={board}
        bands="phase"
        tree={tree}
        onOpenNode={vi.fn()}
        doneTotal={0}
        onViewDone={vi.fn()}
      />,
      { wrapper },
    );
    const body = mobile();
    expect(within(body).getByText('Phase A')).toBeDefined();
    expect(within(body).getByText('∞')).toBeDefined();
    expect(within(body).getByText('phased')).toBeDefined();
  });

  it('falls back to the empty state on an empty board', () => {
    const board = buildBoard([], [], NOW);
    render(
      <BoardView
        board={board}
        bands="off"
        onOpenNode={vi.fn()}
        doneTotal={0}
        onViewDone={vi.fn()}
      />,
      { wrapper },
    );
    // No cards anywhere: selection falls back to In progress and shows its empty copy.
    expect(within(mobile()).getByText(/Nothing in progress/i)).toBeDefined();
  });

  it('opens on the first populated status when in-progress is empty', () => {
    // Delta Records shape: work exists only in held/terminal columns, not in-progress.
    const board = buildBoard(
      [task({ id: 'MMR-3', status: 'parked', title: 'shelved for now' })],
      [task({ completed_at: daysAgo(1), id: 'MMR-4', status: 'done', title: 'shipped' })],
      NOW,
    );
    render(
      <BoardView
        board={board}
        bands="off"
        onOpenNode={vi.fn()}
        doneTotal={1}
        onViewDone={vi.fn()}
      />,
      { wrapper },
    );
    // Lands on Parked (first populated in canonical order), not an empty In progress.
    expect(within(mobile()).getByRole('button', { name: /Parked/ })).toBeDefined();
    expect(within(mobile()).getByText('shelved for now')).toBeDefined();
    expect(within(mobile()).queryByText(/Nothing/i)).toBeNull();
  });

  it('the status control announces itself as a dialog trigger to assistive tech', () => {
    const board = buildBoard(
      [task({ id: 'MMR-2', status: 'in_progress', title: 'building' })],
      [],
      NOW,
    );
    render(
      <BoardView
        board={board}
        bands="off"
        onOpenNode={vi.fn()}
        doneTotal={0}
        onViewDone={vi.fn()}
      />,
      { wrapper },
    );
    const control = within(mobile()).getByRole('button', { name: /In progress/ });
    expect(control.getAttribute('aria-haspopup')).toBe('dialog');
    expect(control.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(control);
    expect(control.getAttribute('aria-expanded')).toBe('true');
  });

  it('a card tap opens the mobile shelf, not the dossier (MMR-258)', () => {
    const onOpen = vi.fn();
    const board = buildBoard(
      [task({ id: 'MMR-8', status: 'in_progress', title: 'open me mobile' })],
      [],
      NOW,
    );
    render(
      <BoardView
        board={board}
        bands="off"
        onOpenNode={onOpen}
        doneTotal={0}
        onViewDone={vi.fn()}
      />,
      { wrapper },
    );
    fireEvent.click(within(mobile()).getByText('open me mobile').closest('button') as HTMLElement);
    expect(onOpen).not.toHaveBeenCalled();
    expect(within(mobile()).getByTestId('quick-shelf')).toBeDefined();
  });

  it("the shelf's Dossier ↗ routes via onOpenNode (MMR-258)", async () => {
    const onOpen = vi.fn();
    const board = buildBoard(
      [task({ id: 'MMR-8', status: 'in_progress', title: 'open me mobile' })],
      [],
      NOW,
    );
    render(
      <BoardView
        board={board}
        bands="off"
        onOpenNode={onOpen}
        doneTotal={0}
        onViewDone={vi.fn()}
      />,
      { wrapper },
    );
    fireEvent.click(within(mobile()).getByText('open me mobile').closest('button') as HTMLElement);
    await userEvent.click(within(screen.getByTestId('quick-shelf')).getByText('Dossier ↗'));
    expect(onOpen).toHaveBeenCalledWith('MMR-8');
  });

  it('the shelf closes when the status page changes (MMR-258)', () => {
    const board = buildBoard(
      [
        task({ id: 'MMR-8', status: 'in_progress', title: 'open me mobile' }),
        task({ id: 'MMR-9', status: 'ready', title: 'queued' }),
      ],
      [],
      NOW,
    );
    render(
      <BoardView
        board={board}
        bands="off"
        onOpenNode={vi.fn()}
        doneTotal={0}
        onViewDone={vi.fn()}
      />,
      { wrapper },
    );
    fireEvent.click(within(mobile()).getByText('open me mobile').closest('button') as HTMLElement);
    expect(within(mobile()).getByTestId('quick-shelf')).toBeDefined();
    fireEvent.click(within(mobile()).getByRole('button', { name: /In progress/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Ready/ }));
    expect(within(mobile()).queryByTestId('quick-shelf')).toBeNull();
  });
});
