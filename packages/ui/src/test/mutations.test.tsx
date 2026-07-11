import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, vi } from 'vitest';

import {
  useAnnotate,
  useArchiveProject,
  useCreateNode,
  useCreateProject,
  useDepend,
  useMoveNode,
  useReorder,
  useTag,
  useTransition,
  useUnarchiveProject,
  useUndepend,
  useUntag,
  useUpdateNode,
  useUpdateProject,
} from '../api/mutations';

const { apiSend } = vi.hoisted(() => ({ apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiSend }));
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));

afterEach(() => {
  vi.clearAllMocks();
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('mutation hooks', () => {
  it('useTransition POSTs the verb route, no body for plain verbs', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-9' });
    const client = new QueryClient();
    const { result } = renderHook(() => useTransition('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate({ verb: 'start' });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-9/start', undefined);
    });
  });

  it('useTransition sends a reason body for reason verbs', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-9' });
    const client = new QueryClient();
    const { result } = renderHook(() => useTransition('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate({ reason: '  waiting  ', verb: 'park' });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-9/park', { reason: 'waiting' });
    });
  });

  it('useReorder POSTs the reorder route with the id given at mutate time', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-9' });
    const client = new QueryClient();
    const { result } = renderHook(() => useReorder(), { wrapper: wrapper(client) });
    result.current.mutate({ after: 'MMR-3', id: 'MMR-9' });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-9/reorder', { after: 'MMR-3' });
    });
  });

  it('useMoveNode POSTs the move route with the new parent (MMR-73)', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-9' });
    const client = new QueryClient();
    const { result } = renderHook(() => useMoveNode('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate('MMR-3');
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-9/move', { to: 'MMR-3' });
    });
  });

  it('invalidates board queries on settle', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-9' });
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useTransition('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate({ verb: 'done' });
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ['board'] });
    });
  });

  it('toasts the error message on failure', async () => {
    apiSend.mockRejectedValue(new Error('already done'));
    const client = new QueryClient();
    const { result } = renderHook(() => useTransition('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate({ verb: 'done' });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('already done');
    });
  });
});

describe('authoring mutation hooks', () => {
  it('useCreateNode POSTs /api/nodes with the given type (task)', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-99' });
    const client = new QueryClient();
    const { result } = renderHook(() => useCreateNode(), { wrapper: wrapper(client) });
    result.current.mutate({
      parent: 'MMR-7',
      priority: 'p1',
      tags: ['ui'],
      title: 'new',
      type: 'task',
    });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes', {
        parent: 'MMR-7',
        priority: 'p1',
        tags: ['ui'],
        title: 'new',
        type: 'task',
      });
    });
  });

  it('useCreateNode carries container-only fields for phase/initiative', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-42' });
    const client = new QueryClient();
    const { result } = renderHook(() => useCreateNode(), { wrapper: wrapper(client) });
    result.current.mutate({ open_ended: true, parent: 'MMR', title: 'Polish', type: 'initiative' });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes', {
        open_ended: true,
        parent: 'MMR',
        title: 'Polish',
        type: 'initiative',
      });
    });
  });

  it('useDepend POSTs the depend route with the on array, id at mutate time', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-99' });
    const client = new QueryClient();
    const { result } = renderHook(() => useDepend(), { wrapper: wrapper(client) });
    result.current.mutate({ id: 'MMR-99', on: ['MMR-7', 'MMR-8'] });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-99/depend', {
        on: ['MMR-7', 'MMR-8'],
      });
    });
  });

  it('useUndepend POSTs the undepend route (symmetry)', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-99' });
    const client = new QueryClient();
    const { result } = renderHook(() => useUndepend(), { wrapper: wrapper(client) });
    result.current.mutate({ id: 'MMR-99', on: ['MMR-7'] });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-99/undepend', {
        on: ['MMR-7'],
      });
    });
  });

  it('useUpdateNode PATCHes /api/nodes/:id with the given fields', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-9' });
    const client = new QueryClient();
    const { result } = renderHook(() => useUpdateNode('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate({ size: 'small', title: 'renamed' });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/nodes/MMR-9', {
        size: 'small',
        title: 'renamed',
      });
    });
  });

  it('useAnnotate POSTs the annotations route with content', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-9' });
    const client = new QueryClient();
    const { result } = renderHook(() => useAnnotate('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate('a note');
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-9/annotations', {
        content: 'a note',
      });
    });
  });

  it('useUpdateProject PATCHes /api/projects/:key with the given fields', async () => {
    apiSend.mockResolvedValue({ id: 'MMR' });
    const client = new QueryClient();
    const { result } = renderHook(() => useUpdateProject('MMR'), { wrapper: wrapper(client) });
    result.current.mutate({ description: 'A short blurb', title: 'Renamed' });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/projects/MMR', {
        description: 'A short blurb',
        title: 'Renamed',
      });
    });
  });

  it('useCreateProject POSTs /api/projects with key + name (MMR-230)', async () => {
    apiSend.mockResolvedValue({ id: 'SR' });
    const client = new QueryClient();
    const { result } = renderHook(() => useCreateProject(), { wrapper: wrapper(client) });
    result.current.mutate({ description: 'A relay', key: 'SR', name: 'Signal relay' });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/projects', {
        description: 'A relay',
        key: 'SR',
        name: 'Signal relay',
      });
    });
  });

  it('useCreateProject toasts the server rejection (dup/invalid key)', async () => {
    apiSend.mockRejectedValue(new Error('project SR already exists'));
    const client = new QueryClient();
    const { result } = renderHook(() => useCreateProject(), { wrapper: wrapper(client) });
    result.current.mutate({ key: 'SR', name: 'Signal relay' });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('project SR already exists');
    });
  });

  it('useArchiveProject and useUnarchiveProject POST the lifecycle routes (MMR-230)', async () => {
    apiSend.mockResolvedValue({ id: 'SR' });
    const client = new QueryClient();
    const archive = renderHook(() => useArchiveProject('SR'), { wrapper: wrapper(client) });
    archive.result.current.mutate();
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/projects/SR/archive', undefined),
    );
    const unarchive = renderHook(() => useUnarchiveProject('SR'), { wrapper: wrapper(client) });
    unarchive.result.current.mutate();
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/projects/SR/unarchive', undefined),
    );
  });

  it('useTag POSTs and useUntag DELETEs the tag route (encoded)', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-9' });
    const client = new QueryClient();
    const tag = renderHook(() => useTag('MMR-9'), { wrapper: wrapper(client) });
    tag.result.current.mutate('needs design');
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith(
        'PUT',
        '/api/nodes/MMR-9/tags/needs%20design',
        undefined,
      ),
    );
    const untag = renderHook(() => useUntag('MMR-9'), { wrapper: wrapper(client) });
    untag.result.current.mutate('needs design');
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith(
        'DELETE',
        '/api/nodes/MMR-9/tags/needs%20design',
        undefined,
      ),
    );
  });
});
