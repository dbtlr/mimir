import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { BoardView, swipeTarget } from '../components/board';
import { buildBoard } from '../lib/board';
import { NOW, daysAgo, task } from './fixtures';

vi.mock('../api/mutations', () => ({
  useTransition: () => ({ mutate: vi.fn() }),
  useReorder: () => ({ mutate: vi.fn() }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe('boardView', () => {
  it('cards land in their status-word column, Ready in given order', () => {
    const board = buildBoard(
      [
        task({ id: 'MMR-9', status: 'ready', title: 'queued first' }),
        task({ id: 'MMR-2', status: 'in_progress', title: 'being built' }),
        task({ id: 'MMR-7', status: 'ready', title: 'queued second' }),
        task({ id: 'MMR-4', status: 'blocked', title: 'stuck on review' }),
      ],
      [task({ id: 'MMR-50', status: 'done', title: 'shipped', completed_at: daysAgo(2) })],
      NOW,
    );
    render(<BoardView board={board} onOpenNode={vi.fn()} doneTotal={1} onViewDone={vi.fn()} />, {
      wrapper,
    });

    // desktop sections are labelled by their status word
    const [ready] = screen.getAllByRole('region', { name: 'Ready' });
    expect(ready).toBeDefined();
    const readyCards = within(ready as HTMLElement).getAllByRole('listitem');
    expect(readyCards.map((c) => c.textContent)).toStrictEqual([
      expect.stringContaining('MMR-9'),
      expect.stringContaining('MMR-7'),
    ]);

    const [inProgress] = screen.getAllByRole('region', { name: 'In progress' });
    expect(within(inProgress as HTMLElement).getByText('being built')).toBeDefined();

    const [done] = screen.getAllByRole('region', { name: 'Done' });
    expect(within(done as HTMLElement).getByText('shipped')).toBeDefined();
  });

  it('a stale in-flight card carries the stale marker', () => {
    const board = buildBoard(
      [
        task({
          id: 'MMR-3',
          status: 'in_progress',
          verdicts: { stale: true, blocking: false, orphaned: false },
        }),
      ],
      [],
      NOW,
    );
    render(<BoardView board={board} onOpenNode={vi.fn()} doneTotal={1} onViewDone={vi.fn()} />, {
      wrapper,
    });
    expect(screen.getAllByText(/stale/).length).toBeGreaterThan(0);
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

  it('clicking a card opens its node', async () => {
    const onOpen = vi.fn();
    const board = buildBoard([task({ id: 'MMR-8', status: 'ready', title: 'open me' })], [], NOW);
    render(<BoardView board={board} onOpenNode={onOpen} doneTotal={0} onViewDone={vi.fn()} />, {
      wrapper,
    });
    screen.getAllByText('open me')[0]?.closest('button')?.click();
    expect(onOpen).toHaveBeenCalledWith('MMR-8');
  });
});
