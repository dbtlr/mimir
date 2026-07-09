import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
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

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
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

  it('swipeTarget: left advances, right retreats, weak/vertical swipes ignored (MMR-70)', () => {
    const ids = ['held', 'awaiting', 'ready', 'in_progress', 'done'];
    expect(swipeTarget('in_progress', -150, 10, ids)).toBe('done'); // left → next
    expect(swipeTarget('in_progress', 150, 10, ids)).toBe('ready'); // right → prev
    expect(swipeTarget('done', -150, 10, ids)).toBeNull(); // past the end
    expect(swipeTarget('held', 150, 10, ids)).toBeNull(); // past the start
    expect(swipeTarget('ready', -30, 10, ids)).toBeNull(); // below threshold
    expect(swipeTarget('ready', -150, 200, ids)).toBeNull(); // vertical-dominant
  });

  it('clicking a card opens its node', () => {
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
    within(swimlane()).getByText('open me').closest('button')?.click();
    expect(onOpen).toHaveBeenCalledWith('MMR-8');
  });
});
