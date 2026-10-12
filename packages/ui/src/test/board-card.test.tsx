import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, vi } from 'vitest';

import { BoardCard } from '../components/board-card';
import { task } from './fixtures';
import { renderInRouter } from './router';

const mutate = vi.fn();
vi.mock('../api/mutations', () => ({
  useTransition: () => ({ mutate }),
}));

describe('boardCard', () => {
  it('an under-review card shows the verdict tag and wires Approve to the done verb', async () => {
    mutate.mockClear();
    await renderInRouter(
      <BoardCard
        node={task({ id: 'MMR-30', status: 'under_review', title: 'awaiting sign-off' })}
        column="under_review"
      />,
    );
    expect(screen.getByText('NEEDS VERDICT')).toBeDefined();
    screen.getByText('Approve').click();
    expect(mutate).toHaveBeenCalledWith({ verb: 'done' });
  });

  it('a stale non-terminal card carries the inline cold marker and dims its title', async () => {
    await renderInRouter(
      <BoardCard
        node={task({
          id: 'MMR-31',
          status: 'ready',
          title: 'cooling off',
          verdicts: { blocking: false, orphaned: false, stale: true },
        })}
        column="ready"
      />,
    );
    expect(screen.getByText('⧗ cold')).toBeDefined();
  });

  it("the title is a real link to the task's page", async () => {
    const { router } = await renderInRouter(
      <BoardCard node={task({ id: 'MMR-32', status: 'ready', title: 'open me' })} column="ready" />,
    );
    const link = screen.getByRole('link', { name: 'open me' });
    expect(link).toHaveAttribute('href', '/p/MMR/32');
    await userEvent.setup().click(link);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/p/MMR/32');
    });
  });

  it('renders a release:* tag as the accent wash, not a neutral chip', async () => {
    await renderInRouter(
      <BoardCard
        node={task({
          id: 'MMR-33',
          status: 'ready',
          tags: [{ created_at: '', tag: 'release:v0.13' }],
        })}
        column="ready"
      />,
    );
    const chip = screen.getByText('v0.13');
    expect(chip.className).toContain('bg-accent/12');
  });

  it('offline inerts the verdict buttons', async () => {
    await renderInRouter(
      <BoardCard
        node={task({ id: 'MMR-34', status: 'under_review' })}
        column="under_review"
        offline
      />,
    );
    expect(screen.getByText('Approve')).toHaveProperty('disabled', true);
  });

  it('a todo card shows its grooming state; needs answers reads as attention, not groomed stays quiet', async () => {
    await renderInRouter(
      <>
        <BoardCard
          node={task({ grooming: 'groomed', id: 'MMR-35', status: 'ready', title: 'one' })}
          column="ready"
        />
        <BoardCard
          node={task({ grooming: 'needs_answers', id: 'MMR-36', status: 'ready', title: 'two' })}
          column="ready"
        />
        <BoardCard
          node={task({ grooming: 'not_groomed', id: 'MMR-37', status: 'ready', title: 'three' })}
          column="ready"
        />
      </>,
    );
    expect(screen.getByText('groomed')).toBeDefined();
    expect(screen.getByText('needs answers').className).toContain('text-attention-foreground');
    expect(screen.getByText('not groomed').className).toContain('text-ink-dim');
  });

  it('a started card carries no grooming chip', async () => {
    await renderInRouter(
      <BoardCard
        node={task({
          grooming: 'groomed',
          id: 'MMR-38',
          lifecycle: 'in_progress',
          status: 'in_progress',
        })}
        column="in_progress"
      />,
    );
    expect(screen.queryByText('groomed')).toBeNull();
  });
});
