import { render, screen } from '@testing-library/react';
import { describe, expect, vi } from 'vitest';

import { BoardCard } from '../components/board-card';
import { task } from './fixtures';

const mutate = vi.fn();
vi.mock('../api/mutations', () => ({
  useTransition: () => ({ mutate }),
}));

describe('boardCard', () => {
  it('an under-review card shows the verdict tag and wires Approve to the done verb', () => {
    mutate.mockClear();
    render(
      <BoardCard
        node={task({ id: 'MMR-30', status: 'under_review', title: 'awaiting sign-off' })}
        column="under_review"
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText('NEEDS VERDICT')).toBeDefined();
    screen.getByText('Approve').click();
    expect(mutate).toHaveBeenCalledWith({ verb: 'done' });
  });

  it('a stale non-terminal card carries the inline cold marker and dims its title', () => {
    render(
      <BoardCard
        node={task({
          id: 'MMR-31',
          status: 'ready',
          title: 'cooling off',
          verdicts: { blocking: false, orphaned: false, stale: true },
        })}
        column="ready"
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText('⧗ cold')).toBeDefined();
  });

  it('clicking the title opens the node', () => {
    const onOpen = vi.fn();
    render(
      <BoardCard
        node={task({ id: 'MMR-32', status: 'ready', title: 'open me' })}
        column="ready"
        onOpen={onOpen}
      />,
    );
    screen.getByText('open me').closest('button')?.click();
    expect(onOpen).toHaveBeenCalledWith('MMR-32');
  });

  it('renders a release:* tag as the accent wash, not a neutral chip', () => {
    render(
      <BoardCard
        node={task({
          id: 'MMR-33',
          status: 'ready',
          tags: [{ created_at: '', note: null, tag: 'release:v0.13' }],
        })}
        column="ready"
        onOpen={vi.fn()}
      />,
    );
    const chip = screen.getByText('v0.13');
    expect(chip.className).toContain('bg-accent/12');
  });

  it('offline inerts the verdict buttons', () => {
    render(
      <BoardCard
        node={task({ id: 'MMR-34', status: 'under_review' })}
        column="under_review"
        onOpen={vi.fn()}
        offline
      />,
    );
    expect(screen.getByText('Approve')).toHaveProperty('disabled', true);
  });
});
