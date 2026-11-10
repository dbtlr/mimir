import { MimirError } from '@mimir/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedCreate, seedPromote, seedResolve, seedUpdate } from '../api/fns/browse';
import { useFileSeed, usePromoteSeed, useResolveSeed, useUpdateSeed } from '../api/seed-mutations';
import { serveBrowse } from './browse-fns';

vi.mock('../api/fns/browse');
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));

beforeEach(() => {
  serveBrowse();
});

afterEach(() => {
  vi.clearAllMocks();
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const render = <T,>(hook: () => T) =>
  renderHook(hook, { wrapper: wrapper(new QueryClient()) }).result;

describe('seed mutation hooks (MMR-247, MMR-540)', () => {
  it('useFileSeed files through seedCreate and never sends requester (self-filed)', async () => {
    const result = render(() => useFileSeed());
    result.current.mutate({ kind: 'bug', project: 'MMR', title: 'flaky' });
    await waitFor(() => {
      expect(seedCreate).toHaveBeenCalledWith({
        data: { kind: 'bug', project: 'MMR', title: 'flaky' },
      });
    });
    expect(vi.mocked(seedCreate).mock.calls[0]?.[0].data).not.toHaveProperty('requester');
  });

  it('useResolveSeed sends seedResolve with the reason', async () => {
    const result = render(() => useResolveSeed('MMR-s1'));
    result.current.mutate('already fixed');
    await waitFor(() => {
      expect(seedResolve).toHaveBeenCalledWith({
        data: { id: 'MMR-s1', reason: 'already fixed' },
      });
    });
  });

  it('usePromoteSeed sends seedPromote and returns the spawned task (MMR-248)', async () => {
    const result = render(() => usePromoteSeed('MMR-s1'));
    result.current.mutate({ parent: 'MMR-9', title: 'Tree lens scroll' });
    await waitFor(() => {
      expect(seedPromote).toHaveBeenCalledWith({
        data: { id: 'MMR-s1', parent: 'MMR-9', title: 'Tree lens scroll' },
      });
    });
    await waitFor(() => {
      expect(result.current.data).toMatchObject({ created: 'MMR-900', spawnedId: 'MMR-900' });
    });
  });

  it('usePromoteSeed carries the priority and size the sheet chose', async () => {
    const result = render(() => usePromoteSeed('MMR-s1'));
    result.current.mutate({ parent: 'MMR-9', priority: 'p1', size: 'small', tags: ['ux'] });
    await waitFor(() => {
      expect(seedPromote).toHaveBeenCalledWith({
        data: { id: 'MMR-s1', parent: 'MMR-9', priority: 'p1', size: 'small', tags: ['ux'] },
      });
    });
  });

  it('invalidates the seeds keys on settle', async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useResolveSeed('MMR-s1'), { wrapper: wrapper(client) });
    result.current.mutate('done');
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ['seeds'] });
    });
  });

  it("toasts the Engine's refusal verbatim on failure", async () => {
    vi.mocked(seedUpdate).mockRejectedValue(
      new MimirError('validation', 'seed MMR-s1 is resolved — a terminal seed is frozen'),
    );
    const result = render(() => useUpdateSeed('MMR-s1'));
    result.current.mutate({ title: 'x' });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'seed MMR-s1 is resolved — a terminal seed is frozen',
      );
    });
  });
});
