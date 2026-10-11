import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WireSeed } from '../api/types';
import { SeedVerbs } from '../components/seed-verbs';
import { seed } from './fixtures';

vi.mock('../api/client', () => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

afterEach(() => {
  vi.clearAllMocks();
});

function renderVerbs(s: WireSeed, onPromote?: (seed: WireSeed) => void): void {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <SeedVerbs seed={s} onLater={() => {}} onPromote={onPromote} />
    </QueryClientProvider>,
  );
}

describe('seedVerbs promote chip (MMR-248)', () => {
  it('leads the verb row on an untriaged seed', () => {
    renderVerbs(seed({ lane: 'untriaged' }), vi.fn());
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('Promote to task…');
    expect(screen.getByRole('button', { name: 'Reject…' })).toBeInTheDocument();
  });

  it('is offered on a promoted (in-flight) seed — promote is repeatable while live', () => {
    renderVerbs(seed({ lane: 'promoted', lifecycle: 'promoted', spawned: ['MMR-90'] }), vi.fn());
    expect(screen.getByRole('button', { name: 'Promote again…' })).toBeInTheDocument();
  });

  it('follows Resolve as a secondary chip on the ready lane — one primary per lane', () => {
    renderVerbs(
      seed({ lane: 'ready', lifecycle: 'promoted', ready_to_resolve: true, spawned: ['MMR-90'] }),
      vi.fn(),
    );
    const buttons = screen.getAllByRole('button');
    // Resolve keeps the lead; Promote falls in right behind it, ahead of Reject.
    expect(buttons[0]).toHaveTextContent('Resolve…');
    expect(buttons[1]).toHaveTextContent('Promote again…');
    expect(buttons[2]).toHaveTextContent('Reject…');
  });

  it('leads the verb row on a promoted (in-flight) seed', () => {
    renderVerbs(seed({ lane: 'promoted', lifecycle: 'promoted', spawned: ['MMR-90'] }), vi.fn());
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('Promote again…');
  });

  it('is absent on a settled seed — frozen, no verbs at all', () => {
    renderVerbs(seed({ lane: 'settled', lifecycle: 'resolved' }), vi.fn());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('is absent when no promote handler is wired', () => {
    renderVerbs(seed({ lane: 'untriaged' }));
    expect(screen.queryByRole('button', { name: 'Promote to task…' })).not.toBeInTheDocument();
  });

  it('fires onPromote with the seed', async () => {
    const onPromote = vi.fn();
    const s = seed({ lane: 'untriaged' });
    renderVerbs(s, onPromote);
    await userEvent.click(screen.getByRole('button', { name: 'Promote to task…' }));
    expect(onPromote).toHaveBeenCalledWith(s);
  });
});
