import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WireSeed } from '../api/types';
import { SeedPromoteSheet } from '../components/seed-promote-sheet';
import { seed } from './fixtures';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend: vi.fn() }));
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));
// The sheet's only router touch is useNavigate for "& open"; stub it.
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

/** Projects/tree reads the AuthoringSheet fires; the seed detail is per-test. */
function baseReads(seedDetail: (path: string) => Promise<unknown> | undefined) {
  apiGet.mockImplementation((path: string) => {
    const detail = seedDetail(path);
    if (detail !== undefined) {
      return detail;
    }
    if (path === '/api/projects') {
      return Promise.resolve({ items: [{ id: 'MMR', title: 'Mimir' }], total: 1 });
    }
    if (path.startsWith('/api/projects/MMR/tree')) {
      return Promise.resolve({
        children: [],
        created_at: '',
        id: 'MMR',
        open_ended: false,
        parent: null,
        status: 'in_progress',
        title: 'Mimir',
        type: 'project',
        updated_at: '',
      });
    }
    return Promise.resolve({ items: [], total: 0 });
  });
}

function renderPromote(s: WireSeed) {
  const onOpenChange = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { refetchInterval: false, retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SeedPromoteSheet seed={s} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('seedPromoteSheet (MMR-248 dead-click fix)', () => {
  it('mounts at once with the list-row title and a pending description before the body lands', () => {
    // The detail read is queued but not yet flushed — the synchronous first render
    // must already show the sheet, not hang blank waiting on the body.
    baseReads((path) =>
      path === '/api/seeds/MMR-s1'
        ? Promise.resolve({
            ...seed({ id: 'MMR-s1', lane: 'untriaged', title: 'Scroll snaps to top' }),
            description: 'lands later',
          })
        : undefined,
    );
    const s = seed({ id: 'MMR-s1', lane: 'untriaged', title: 'Scroll snaps to top' });
    renderPromote(s);

    // the list-row title shows immediately, before the detail read resolves
    expect(screen.getByDisplayValue('Scroll snaps to top')).toBeInTheDocument();
    // the description reads as pending rather than silently empty
    expect(screen.getByPlaceholderText('loading the seed body…')).toBeInTheDocument();
  });

  it('folds the body into the description once the (slow) detail read lands', async () => {
    baseReads((path) =>
      path === '/api/seeds/MMR-s1'
        ? Promise.resolve({
            ...seed({ id: 'MMR-s1', lane: 'untriaged', title: 'Scroll snaps to top' }),
            description: 'Repro: scroll to bottom, it snaps back.',
          })
        : undefined,
    );
    const s = seed({ id: 'MMR-s1', lane: 'untriaged', title: 'Scroll snaps to top' });
    renderPromote(s);

    await waitFor(() =>
      expect(screen.getByLabelText('Description')).toHaveValue(
        'Repro: scroll to bottom, it snaps back.',
      ),
    );
    expect(screen.queryByPlaceholderText('loading the seed body…')).not.toBeInTheDocument();
  });

  it('toasts and resets the promoting state when the body read errors', async () => {
    baseReads((path) =>
      path === '/api/seeds/MMR-s1' ? Promise.reject(new Error('boom')) : undefined,
    );
    const s = seed({ id: 'MMR-s1', lane: 'untriaged', title: 'Scroll snaps to top' });
    const { onOpenChange } = renderPromote(s);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('MMR-s1')),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
