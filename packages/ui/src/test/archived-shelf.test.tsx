import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { WireNode } from '../api/types';
import { ArchivedShelf } from '../components/archived-shelf';
import { project } from './fixtures';

const { apiSend } = vi.hoisted(() => ({ apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiSend }));

function frozen(id: string, overrides: Partial<WireNode> = {}): WireNode {
  return project({
    archived_at: '2026-06-30T12:00:00.000Z',
    artifact_count: 12,
    id,
    leaf_counts: { done: 40, ready: 1 },
    status: 'done',
    ...overrides,
  });
}

function renderShelf(projects: WireNode[], offline = false) {
  const client = new QueryClient();
  const { rerender } = render(
    <QueryClientProvider client={client}>
      <ArchivedShelf projects={projects} offline={offline} />
    </QueryClientProvider>,
  );
  return (next: WireNode[]) => {
    rerender(
      <QueryClientProvider client={client}>
        <ArchivedShelf projects={next} offline={offline} />
      </QueryClientProvider>,
    );
  };
}

describe('archivedShelf (MMR-125)', () => {
  it('renders nothing at zero archived projects — never an empty shelf', () => {
    renderShelf([]);
    expect(screen.queryByRole('button', { name: /archived/i })).toBeNull();
  });

  it('folds to a count row by default; the bar is the disclosure', async () => {
    renderShelf([frozen('OLD'), frozen('DUSTY')]);
    const bar = screen.getByRole('button', { name: 'Archived, 2 projects' });
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    expect(
      screen.getByText('frozen — hidden from every default view, picker included'),
    ).toBeDefined();
    expect(screen.queryByText('project OLD')).toBeNull();

    await userEvent.click(bar);
    expect(bar.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('project OLD')).toBeDefined();
    expect(screen.getByText('project DUSTY')).toBeDefined();

    await userEvent.click(bar); // re-folds
    expect(screen.queryByText('project OLD')).toBeNull();
  });

  it('a frozen card carries the ❄ date, the count line, and an Unarchive button', async () => {
    renderShelf([frozen('OLD')]);
    await userEvent.click(screen.getByRole('button', { name: /archived/i }));

    expect(screen.getByText('❄ 2026-06-30')).toBeDefined();
    expect(screen.getByText('41 tasks · 12 artifacts · readable, nothing writable')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Unarchive project OLD' })).toBeDefined();
  });

  it('drops the artifact clause when the facet is absent, the ❄ when the date is', async () => {
    renderShelf([frozen('OLD', { archived_at: undefined, artifact_count: undefined })]);
    await userEvent.click(screen.getByRole('button', { name: /archived/i }));

    expect(screen.getByText('41 tasks · readable, nothing writable')).toBeDefined();
    expect(screen.queryByText(/❄/)).toBeNull();
  });

  it('unarchive POSTs the unarchive route — no confirmation', async () => {
    apiSend.mockResolvedValue({ id: 'OLD' });
    renderShelf([frozen('OLD')]);
    await userEvent.click(screen.getByRole('button', { name: /archived/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Unarchive project OLD' }));

    expect(apiSend).toHaveBeenCalledWith('POST', '/api/projects/OLD/unarchive', undefined);
  });

  it('moves focus to the disclosure bar when the unarchived card unmounts', async () => {
    apiSend.mockResolvedValue({ id: 'OLD' });
    const rerenderShelf = renderShelf([frozen('OLD'), frozen('DUSTY')]);
    await userEvent.click(screen.getByRole('button', { name: /archived/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Unarchive project OLD' }));

    rerenderShelf([frozen('DUSTY')]); // the refetched list, one card fewer
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Archived, 1 project' }),
    );
  });

  it('offline disables Unarchive — the write affordance goes inert', async () => {
    renderShelf([frozen('OLD')], true);
    await userEvent.click(screen.getByRole('button', { name: /archived/i }));

    const button = screen.getByRole('button', { name: 'Unarchive project OLD' });
    expect(button).toHaveProperty('disabled', true);
  });
});
