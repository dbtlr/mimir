import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineSeed } from '../api/browse-queries';
import { seedPark, seedUnpark } from '../api/fns/browse';
import { SeedVerbs } from '../components/seed-verbs';
import { seedIn } from './browse-fixtures';
import { serveBrowse } from './browse-fns';

vi.mock('../api/fns/browse');
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

beforeEach(() => {
  serveBrowse();
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderVerbs(s: EngineSeed, onPromote?: (seed: EngineSeed) => void): void {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <SeedVerbs seed={s} onPromote={onPromote} />
    </QueryClientProvider>,
  );
}

describe('seedVerbs promote chip (MMR-248)', () => {
  it('leads the verb row on an untriaged seed', () => {
    renderVerbs(seedIn('untriaged'), vi.fn());
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('Promote to task…');
    expect(screen.getByRole('button', { name: 'Reject…' })).toBeInTheDocument();
  });

  it('is offered on a promoted (in-flight) seed — promote is repeatable while live', () => {
    renderVerbs(seedIn('promoted', { spawned: ['MMR-90'] }), vi.fn());
    expect(screen.getByRole('button', { name: 'Promote again…' })).toBeInTheDocument();
  });

  it('follows Resolve as a secondary chip on the ready lane — one primary per lane', () => {
    renderVerbs(seedIn('ready', { spawned: ['MMR-90'] }), vi.fn());
    const buttons = screen.getAllByRole('button');
    // Resolve keeps the lead; Promote falls in right behind it, ahead of Reject.
    expect(buttons[0]).toHaveTextContent('Resolve…');
    expect(buttons[1]).toHaveTextContent('Promote again…');
    expect(buttons[2]).toHaveTextContent('Reject…');
  });

  it('leads the verb row on a promoted (in-flight) seed', () => {
    renderVerbs(seedIn('promoted', { spawned: ['MMR-90'] }), vi.fn());
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('Promote again…');
  });

  it('is absent on a settled seed — frozen, no verbs at all', () => {
    renderVerbs(seedIn('settled'), vi.fn());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('is absent when no promote handler is wired', () => {
    renderVerbs(seedIn('untriaged'));
    expect(screen.queryByRole('button', { name: 'Promote to task…' })).not.toBeInTheDocument();
  });

  it('fires onPromote with the seed', async () => {
    const onPromote = vi.fn();
    const s = seedIn('untriaged');
    renderVerbs(s, onPromote);
    await userEvent.click(screen.getByRole('button', { name: 'Promote to task…' }));
    expect(onPromote).toHaveBeenCalledWith(s);
  });
});

describe('seedVerbs parking (MMR-473)', () => {
  it('offers Park… on an untriaged seed, after Reject…', () => {
    renderVerbs(seedIn('untriaged'), vi.fn());
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toStrictEqual(['Promote to task…', 'Reject…', 'Park…']);
  });

  it('parks with an optional reason', async () => {
    renderVerbs(seedIn('untriaged', { id: 'MMR-s7' }));
    await userEvent.click(screen.getByRole('button', { name: 'Park…' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), '  after v1  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Park' }));
    expect(seedPark).toHaveBeenCalledWith({ data: { id: 'MMR-s7', reason: 'after v1' } });
  });

  it('parks without a reason when none is given', async () => {
    renderVerbs(seedIn('untriaged', { id: 'MMR-s7' }));
    await userEvent.click(screen.getByRole('button', { name: 'Park…' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Park' }));
    expect(seedPark).toHaveBeenCalledWith({ data: { id: 'MMR-s7' } });
  });

  it('offers Promote, Unpark, and Reject on a parked seed', () => {
    renderVerbs(seedIn('parked'), vi.fn());
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toStrictEqual(['Promote to task…', 'Unpark', 'Reject…']);
  });

  it('unparks straight away — no dialog', async () => {
    renderVerbs(seedIn('parked', { id: 'MMR-s7' }));
    await userEvent.click(screen.getByRole('button', { name: 'Unpark' }));
    expect(seedUnpark).toHaveBeenCalledWith({ data: { id: 'MMR-s7' } });
  });

  it('holds every chip off while a verb is pending, so it cannot be sent twice', async () => {
    vi.mocked(seedPark).mockReturnValue(Promise.withResolvers<EngineSeed>().promise);
    renderVerbs(seedIn('untriaged', { id: 'MMR-s7' }), vi.fn());
    await userEvent.click(screen.getByRole('button', { name: 'Park…' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Park' }),
    );
    await waitFor(() => {
      expect(screen.getAllByRole('button').every((b) => (b as HTMLButtonElement).disabled)).toBe(
        true,
      );
    });
  });
});
