import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  annotate,
  block,
  depend,
  done,
  groom,
  move,
  park,
  returnTask,
  start,
  tag,
  undepend,
  untag,
  update,
} from '../api/fns/nodes';
import { create, updateProject } from '../api/fns/shell';
import {
  useAnnotate,
  useCreateNode,
  useDepend,
  useGroom,
  useMoveNode,
  useTag,
  useTransition,
  useUndepend,
  useUntag,
  useUpdateDirection,
  useUpdateNode,
} from '../api/node-mutations';
import { engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));

beforeEach(() => {
  serveNodes({ nodes: [engineTask({ id: 'MMR-9', status: 'ready' })] });
});

afterEach(() => {
  vi.clearAllMocks();
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('mutation hooks', () => {
  it('useTransition calls the verb function with just the id for plain verbs', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useTransition('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate({ verb: 'start' });
    await waitFor(() => {
      expect(start).toHaveBeenCalledWith({ data: { id: 'MMR-9' } });
    });
  });

  it('useTransition sends a trimmed reason for reason verbs', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useTransition('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate({ reason: '  waiting  ', verb: 'park' });
    await waitFor(() => {
      expect(park).toHaveBeenCalledWith({ data: { id: 'MMR-9', reason: 'waiting' } });
    });
  });

  it('useTransition reaches the Engine method each console verb names', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useTransition('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate({ verb: 'done' });
    await waitFor(() => {
      expect(done).toHaveBeenCalledWith({ data: { id: 'MMR-9' } });
    });
    result.current.mutate({ reason: 'needs work', verb: 'return' });
    await waitFor(() => {
      expect(returnTask).toHaveBeenCalledWith({ data: { id: 'MMR-9', reason: 'needs work' } });
    });
    result.current.mutate({ reason: 'waiting', verb: 'block' });
    await waitFor(() => {
      expect(block).toHaveBeenCalledWith({ data: { id: 'MMR-9', reason: 'waiting' } });
    });
  });

  it('useMoveNode moves the node to the new parent (MMR-73)', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useMoveNode('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate('MMR-3');
    await waitFor(() => {
      expect(move).toHaveBeenCalledWith({ data: { id: 'MMR-9', to: 'MMR-3' } });
    });
  });

  it('invalidates the review page on settle', async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useTransition('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate({ verb: 'done' });
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ['review'] });
    });
  });

  it('toasts the error message on failure', async () => {
    vi.mocked(done).mockRejectedValueOnce(new Error('already done'));
    const client = new QueryClient();
    const { result } = renderHook(() => useTransition('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate({ verb: 'done' });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('already done');
    });
  });
});

describe('grooming and direction hooks', () => {
  it('useGroom sets the state for the one task, without an empty note', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useGroom('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate({ note: '   ', state: 'groomed' });
    await waitFor(() => {
      expect(groom).toHaveBeenCalledWith({ data: { ids: ['MMR-9'], state: 'groomed' } });
    });
  });

  it('useGroom sends the trimmed note with the state', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useGroom('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate({ note: ' Which backend? ', state: 'needs_answers' });
    await waitFor(() => {
      expect(groom).toHaveBeenCalledWith({
        data: { ids: ['MMR-9'], note: 'Which backend?', state: 'needs_answers' },
      });
    });
  });

  it('useUpdateDirection writes a project’s direction through updateProject', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useUpdateDirection({ key: 'MMR', kind: 'project' }), {
      wrapper: wrapper(client),
    });
    result.current.mutate('New plan.');
    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({ data: { id: 'MMR', next: 'New plan.' } });
    });
  });

  it('useUpdateDirection writes a container’s direction through update', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useUpdateDirection({ id: 'MMR-12', kind: 'node' }), {
      wrapper: wrapper(client),
    });
    result.current.mutate('New plan.');
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({ data: { id: 'MMR-12', next: 'New plan.' } });
    });
  });
});

describe('authoring mutation hooks', () => {
  it('useCreateNode creates a task with its task-only fields', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useCreateNode(), { wrapper: wrapper(client) });
    result.current.mutate({
      external_ref: 'GH-1',
      parent: 'MMR-7',
      priority: 'p1',
      size: 'small',
      tags: ['ui'],
      title: 'new',
      type: 'task',
    });
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        data: {
          externalRef: 'GH-1',
          parent: 'MMR-7',
          priority: 'p1',
          size: 'small',
          tags: ['ui'],
          title: 'new',
          type: 'task',
        },
      });
    });
  });

  it('useCreateNode carries container-only fields for phase/initiative', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useCreateNode(), { wrapper: wrapper(client) });
    result.current.mutate({ open_ended: true, parent: 'MMR', title: 'Polish', type: 'initiative' });
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        data: { openEnded: true, parent: 'MMR', title: 'Polish', type: 'initiative' },
      });
    });
  });

  it('useDepend depends the node on the given ones, id at mutate time', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useDepend(), { wrapper: wrapper(client) });
    result.current.mutate({ id: 'MMR-99', on: ['MMR-7', 'MMR-8'] });
    await waitFor(() => {
      expect(depend).toHaveBeenCalledWith({ data: { id: 'MMR-99', on: ['MMR-7', 'MMR-8'] } });
    });
  });

  it('useDepend({ silent: true }) suppresses the raw-cause toast (MMR-273)', async () => {
    vi.mocked(depend).mockRejectedValueOnce(new Error('would create a cycle'));
    const client = new QueryClient();
    const { result } = renderHook(() => useDepend({ silent: true }), {
      wrapper: wrapper(client),
    });
    await expect(result.current.mutateAsync({ id: 'MMR-99', on: ['MMR-7'] })).rejects.toThrow(
      'would create a cycle',
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('useDepend() (no options) still toasts the raw cause — the default owner', async () => {
    vi.mocked(depend).mockRejectedValueOnce(new Error('would create a cycle'));
    const client = new QueryClient();
    const { result } = renderHook(() => useDepend(), { wrapper: wrapper(client) });
    result.current.mutate({ id: 'MMR-99', on: ['MMR-7'] });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('would create a cycle');
    });
  });

  it('useUndepend removes the dependencies (symmetry)', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useUndepend(), { wrapper: wrapper(client) });
    result.current.mutate({ id: 'MMR-99', on: ['MMR-7'] });
    await waitFor(() => {
      expect(undepend).toHaveBeenCalledWith({ data: { id: 'MMR-99', on: ['MMR-7'] } });
    });
  });

  it('useUpdateNode writes the given fields, with the external ref in the Engine’s spelling', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useUpdateNode('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate({ externalRef: 'GH-9', size: 'small', title: 'renamed' });
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        data: { externalRef: 'GH-9', id: 'MMR-9', size: 'small', title: 'renamed' },
      });
    });
  });

  it('useAnnotate appends the note', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useAnnotate('MMR-9'), { wrapper: wrapper(client) });
    result.current.mutate('a note');
    await waitFor(() => {
      expect(annotate).toHaveBeenCalledWith({ data: { content: 'a note', id: 'MMR-9' } });
    });
  });

  it('useTag adds and useUntag removes one tag, spaces and all', async () => {
    const client = new QueryClient();
    const adding = renderHook(() => useTag('MMR-9'), { wrapper: wrapper(client) });
    adding.result.current.mutate('needs design');
    await waitFor(() => {
      expect(tag).toHaveBeenCalledWith({ data: { ids: ['MMR-9'], tags: ['needs design'] } });
    });
    const removing = renderHook(() => useUntag('MMR-9'), { wrapper: wrapper(client) });
    removing.result.current.mutate('needs design');
    await waitFor(() => {
      expect(untag).toHaveBeenCalledWith({ data: { ids: ['MMR-9'], tags: ['needs design'] } });
    });
  });
});
