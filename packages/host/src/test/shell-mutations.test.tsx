import type { EngineNode } from '@mimir/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { archive, create, unarchive, updateProject } from '../api/fns/shell';
import {
  useArchiveProject,
  useCreateProject,
  usePendingPins,
  usePinProject,
  useUnarchiveProject,
  useUpdateProject,
} from '../api/shell-mutations';
import { engineProject } from './engine-fixtures';
import { serveShell } from './shell-fns';

vi.mock('../api/fns/shell');
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));

/*
 * The shell's project writes (MMR-537), each through its Engine method's
 * server function: the hook sends the Engine input, toasts a refusal verbatim,
 * and the pin reports itself pending until its write settles.
 */

beforeEach(() => {
  serveShell();
});

afterEach(() => {
  vi.clearAllMocks();
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('project write hooks', () => {
  it('useUpdateProject sends the form title as the project name', async () => {
    const { result } = renderHook(() => useUpdateProject('MMR'), {
      wrapper: wrapper(new QueryClient()),
    });
    result.current.mutate({ description: 'A short blurb', title: 'Renamed' });
    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({
        data: { description: 'A short blurb', id: 'MMR', name: 'Renamed' },
      });
    });
  });

  it('useCreateProject creates a project with its key and name (MMR-230)', async () => {
    const { result } = renderHook(() => useCreateProject(), {
      wrapper: wrapper(new QueryClient()),
    });
    result.current.mutate({ description: 'A relay', key: 'SR', name: 'Signal relay' });
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        data: { description: 'A relay', key: 'SR', name: 'Signal relay', type: 'project' },
      });
    });
  });

  it('useCreateProject toasts the Engine refusal (dup/invalid key)', async () => {
    vi.mocked(create).mockRejectedValue(new Error('project SR already exists'));
    const { result } = renderHook(() => useCreateProject(), {
      wrapper: wrapper(new QueryClient()),
    });
    result.current.mutate({ key: 'SR', name: 'Signal relay' });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('project SR already exists');
    });
  });

  it('useArchiveProject and useUnarchiveProject run the lifecycle verbs on the key (MMR-230)', async () => {
    const client = new QueryClient();
    const archiving = renderHook(() => useArchiveProject('SR'), { wrapper: wrapper(client) });
    archiving.result.current.mutate();
    await waitFor(() => {
      expect(archive).toHaveBeenCalledWith({ data: { id: 'SR' } });
    });
    const restoring = renderHook(() => useUnarchiveProject('SR'), { wrapper: wrapper(client) });
    restoring.result.current.mutate();
    await waitFor(() => {
      expect(unarchive).toHaveBeenCalledWith({ data: { id: 'SR' } });
    });
  });
});

function pins() {
  return renderHook(() => ({ mutation: usePinProject(), pending: usePendingPins() }), {
    wrapper: wrapper(new QueryClient()),
  });
}

describe('usePinProject (MMR-497)', () => {
  it('writes the flag and reports it pending until the write settles', async () => {
    const held = Promise.withResolvers<EngineNode>();
    vi.mocked(updateProject).mockReturnValue(held.promise);
    const { result } = pins();
    act(() => {
      result.current.mutation.mutate({ key: 'MMR', pinned: true });
    });
    await waitFor(() => {
      expect(result.current.pending.get('MMR')).toBe(true);
    });
    expect(updateProject).toHaveBeenCalledWith({ data: { id: 'MMR', pinned: true } });
    held.resolve(engineProject({ id: 'MMR', pinned: true }));
    await waitFor(() => {
      expect(result.current.pending.size).toBe(0);
    });
  });

  it('drops a failed pin from the pending set and toasts, touching no cache', async () => {
    vi.mocked(updateProject).mockRejectedValue(new Error('read only'));
    const { result } = pins();
    act(() => {
      result.current.mutation.mutate({ key: 'MMR', pinned: true });
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('read only');
    });
    await waitFor(() => {
      expect(result.current.pending.size).toBe(0);
    });
  });

  it('keeps each pin until its own write settles, so one failing leaves the other pending', async () => {
    const first = Promise.withResolvers<EngineNode>();
    const second = Promise.withResolvers<EngineNode>();
    vi.mocked(updateProject).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = pins();
    act(() => {
      result.current.mutation.mutate({ key: 'MMR', pinned: true });
      result.current.mutation.mutate({ key: 'NRN', pinned: false });
    });
    await waitFor(() => {
      expect([...result.current.pending]).toStrictEqual([
        ['MMR', true],
        ['NRN', false],
      ]);
    });
    first.reject(new Error('read only'));
    await waitFor(() => {
      expect([...result.current.pending]).toStrictEqual([['NRN', false]]);
    });
    second.resolve(engineProject({ id: 'NRN' }));
    await waitFor(() => {
      expect(result.current.pending.size).toBe(0);
    });
  });
});
