import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EngineSeed } from '../api/browse-queries';
import { getSeed } from '../api/fns/browse';
import { SeedPromoteSheet } from '../components/seed-promote-sheet';
import { seedIn } from './browse-fixtures';
import { serveBrowse } from './browse-fns';
import { engineProject, engineTree } from './engine-fixtures';
import { serveShell } from './shell-fns';

vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));
// The sheet's only router touch is useNavigate for "& open"; stub it.
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

/** Projects/tree reads the AuthoringSheet fires; the seed detail read answers `detail`. */
function baseReads(detail: Promise<EngineSeed>) {
  serveShell({
    projects: [engineProject({ id: 'MMR', title: 'Mimir' })],
    trees: {
      MMR: engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }),
    },
  });
  serveBrowse();
  vi.mocked(getSeed).mockReturnValue(detail);
}

function renderPromote(s: EngineSeed) {
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
    baseReads(
      Promise.resolve(
        seedIn('untriaged', {
          description: 'lands later',
          id: 'MMR-s1',
          title: 'Scroll snaps to top',
        }),
      ),
    );
    const s = seedIn('untriaged', { id: 'MMR-s1', title: 'Scroll snaps to top' });
    renderPromote(s);

    // the list-row title shows immediately, before the detail read resolves
    expect(screen.getByDisplayValue('Scroll snaps to top')).toBeInTheDocument();
    // the description reads as pending rather than silently empty
    expect(screen.getByPlaceholderText('loading the seed body…')).toBeInTheDocument();
  });

  it('folds the body into the description once the (slow) detail read lands', async () => {
    baseReads(
      Promise.resolve(
        seedIn('untriaged', {
          description: 'Repro: scroll to bottom, it snaps back.',
          id: 'MMR-s1',
          title: 'Scroll snaps to top',
        }),
      ),
    );
    const s = seedIn('untriaged', { id: 'MMR-s1', title: 'Scroll snaps to top' });
    renderPromote(s);

    expect(getSeed).toHaveBeenCalledWith({ data: { content: true, id: 'MMR-s1' } });
    await waitFor(() =>
      expect(screen.getByLabelText('Description')).toHaveValue(
        'Repro: scroll to bottom, it snaps back.',
      ),
    );
    expect(screen.queryByPlaceholderText('loading the seed body…')).not.toBeInTheDocument();
  });

  it('toasts and resets the promoting state when the body read errors', async () => {
    baseReads(Promise.reject(new Error('boom')));
    const s = seedIn('untriaged', { id: 'MMR-s1', title: 'Scroll snaps to top' });
    const { onOpenChange } = renderPromote(s);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('MMR-s1')),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
