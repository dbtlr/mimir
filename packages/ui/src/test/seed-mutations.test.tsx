import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useFileSeed, useRejectSeed, useResolveSeed, useUpdateSeed } from '../api/mutations';

const { apiSend } = vi.hoisted(() => ({ apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiSend }));
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));

afterEach(() => {
  vi.clearAllMocks();
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('seed mutation hooks (MMR-247)', () => {
  it('useFileSeed POSTs /api/seeds and never sends requester (self-filed)', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-s1' });
    const client = new QueryClient();
    const { result } = renderHook(() => useFileSeed(), { wrapper: wrapper(client) });
    result.current.mutate({ kind: 'bug', project: 'MMR', title: 'flaky' });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/seeds', {
        kind: 'bug',
        project: 'MMR',
        title: 'flaky',
      });
    });
    const body = apiSend.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(body).not.toHaveProperty('requester');
  });

  it('useRejectSeed POSTs the reject verb with the reason', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-s1', lifecycle: 'rejected' });
    const client = new QueryClient();
    const { result } = renderHook(() => useRejectSeed('MMR-s1'), { wrapper: wrapper(client) });
    result.current.mutate('duplicate');
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/seeds/MMR-s1/reject', {
        reason: 'duplicate',
      });
    });
  });

  it('useResolveSeed POSTs the resolve verb with the reason', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-s1', lifecycle: 'resolved' });
    const client = new QueryClient();
    const { result } = renderHook(() => useResolveSeed('MMR-s1'), { wrapper: wrapper(client) });
    result.current.mutate('already fixed');
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/seeds/MMR-s1/resolve', {
        reason: 'already fixed',
      });
    });
  });

  it('useUpdateSeed PATCHes /api/seeds/:id with the given fields', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-s1' });
    const client = new QueryClient();
    const { result } = renderHook(() => useUpdateSeed('MMR-s1'), { wrapper: wrapper(client) });
    result.current.mutate({ description: 'a fuller body' });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/seeds/MMR-s1', {
        description: 'a fuller body',
      });
    });
  });

  it('invalidates the seeds keys on settle', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-s1' });
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useResolveSeed('MMR-s1'), { wrapper: wrapper(client) });
    result.current.mutate('done');
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ['seeds'] });
    });
  });

  it('toasts the server error verbatim on failure', async () => {
    apiSend.mockRejectedValue(new Error('seed is terminal'));
    const client = new QueryClient();
    const { result } = renderHook(() => useUpdateSeed('MMR-s1'), { wrapper: wrapper(client) });
    result.current.mutate({ title: 'x' });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('seed is terminal');
    });
  });
});
