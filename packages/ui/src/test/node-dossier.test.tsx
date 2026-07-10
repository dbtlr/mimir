import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, vi } from 'vitest';

import { NodeDossier } from '../components/node-dossier';
import { task } from './fixtures';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', async (orig) => ({
  // import() type captures the whole module for orig<>(); no clean type-import equiv
  // oxlint-disable-next-line typescript/consistent-type-imports
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));

/** A minimal WireTreeNode for the Move… picker (parentOptions reads id/title/type). */
function treeNode(
  id: string,
  title: string,
  type: 'initiative' | 'phase' | 'project',
  children: unknown[] = [],
) {
  return { ...task({ id, status: 'in_progress', title, type }), children };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { refetchInterval: false, retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Wire apiGet for a node + its annotations; the parent breadcrumb fetch is stubbed. */
function mockNode(
  node: ReturnType<typeof task>,
  annotations: { content: string; created_at: string }[] = [],
) {
  apiGet.mockImplementation((path: string) => {
    if (path === `/api/nodes/${node.id}`) {
      return Promise.resolve(node);
    }
    if (path === `/api/nodes/${node.id}/annotations`) {
      return Promise.resolve({ items: annotations, total: annotations.length });
    }
    if (path.startsWith('/api/nodes/')) {
      // parent breadcrumb lookup — a minimal stub is enough
      return Promise.resolve(task({ id: 'MMR-1', status: 'in_progress', title: 'Parent' }));
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

describe('nodeDossier', () => {
  it('renders the full record with annotations, tags, signals and artifacts', async () => {
    mockNode(
      task({
        artifacts: [
          {
            created_at: '2026-06-10T00:00:00.000Z',
            id: 'MMR-a3',
            tags: [],
            title: 'console design notes',
          },
        ],
        deps: {
          blocking: [{ id: 'MMR-51', status: 'awaiting', title: 'downstream' }],
          depends_on: [{ id: 'MMR-15', status: 'done', title: 'upstream' }],
        },
        id: 'MMR-16',
        priority: 'p1',
        size: 'large',
        status: 'in_progress',
        tags: [{ created_at: '2026-06-10T00:00:00.000Z', note: null, tag: 'release:v0.5' }],
        title: 'Web UI chunk 1',
      }),
      [{ content: 'Groomed: read-only console first.', created_at: '2026-06-10T01:00:00.000Z' }],
    );

    render(<NodeDossier nodeId="MMR-16" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });

    await expect(screen.findByText('Web UI chunk 1')).resolves.toBeDefined();
    await expect(screen.findByText('Groomed: read-only console first.')).resolves.toBeDefined();
    expect(screen.getByText('console design notes')).toBeDefined();
    expect(screen.getByText('MMR-15')).toBeDefined();
    expect(screen.getByText('MMR-51')).toBeDefined();
    expect(screen.getByText('release:v0.5')).toBeDefined();
    expect(screen.getByText('p1')).toBeDefined();
    // status pill uppercases the label
    expect(screen.getByText('IN PROGRESS')).toBeDefined();
  });

  it('timeline merges transitions + annotations oldest-first, with the creation anchor', async () => {
    mockNode(
      task({
        created_at: '2026-06-01T10:00:00.000Z',
        history: [
          {
            at: '2026-06-02T09:00:00.000Z',
            from: 'todo',
            kind: 'lifecycle',
            reason: null,
            to: 'in_progress',
          },
          {
            at: '2026-06-04T09:00:00.000Z',
            from: 'none',
            kind: 'hold',
            reason: 'waiting on Saga',
            to: 'parked',
          },
        ],
        id: 'MMR-60',
        status: 'parked',
        title: 'task timeline',
      }),
      [{ content: 'looked into the facet', created_at: '2026-06-03T09:00:00.000Z' }],
    );

    render(<NodeDossier nodeId="MMR-60" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });

    await screen.findByText('Created');
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    const idx = (needle: string) => rows.findIndex((t) => t.includes(needle));
    expect(idx('Started')).toBeGreaterThanOrEqual(0);
    expect(idx('Parked')).toBeGreaterThanOrEqual(0);
    expect(idx('waiting on Saga')).toBeGreaterThanOrEqual(0);
    expect(idx('Created')).toBeLessThan(idx('Started'));
    expect(idx('Started')).toBeLessThan(idx('looked into the facet'));
    expect(idx('looked into the facet')).toBeLessThan(idx('Parked'));
  });

  it('timeline tabs split the feed: Activity hides notes, Notes hides transitions', async () => {
    mockNode(
      task({
        history: [
          {
            at: '2026-06-02T09:00:00.000Z',
            from: 'todo',
            kind: 'lifecycle',
            reason: null,
            to: 'in_progress',
          },
        ],
        id: 'MMR-60',
        status: 'in_progress',
        title: 'task timeline',
      }),
      [{ content: 'a freeform note', created_at: '2026-06-03T09:00:00.000Z' }],
    );

    render(<NodeDossier nodeId="MMR-60" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });

    await userEvent.click(await screen.findByRole('tab', { name: 'Activity' }));
    expect(screen.getByText('Started')).toBeDefined();
    expect(screen.queryByText('a freeform note')).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(screen.getByText('a freeform note')).toBeDefined();
    expect(screen.queryByText('Started')).toBeNull();
  });

  it('closed dossier renders nothing', () => {
    render(<NodeDossier nodeId={undefined} onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    expect(screen.queryByTestId('dossier-body')).toBeNull();
  });

  it('replaces the kebab with labeled verb chips; an immediate verb fires directly', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-51' });
    mockNode(task({ id: 'MMR-51', status: 'ready', title: 'Chunk 2' }));
    render(<NodeDossier nodeId="MMR-51" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });

    await userEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-51/start', undefined);
  });

  it('a reason-carrying verb chip opens the reason dialog, then mutates', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-51' });
    mockNode(task({ id: 'MMR-51', status: 'ready', title: 'Chunk 2' }));
    render(<NodeDossier nodeId="MMR-51" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });

    await userEvent.click(await screen.findByRole('button', { name: 'Park…' }));
    await userEvent.type(await screen.findByRole('textbox'), 'later');
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-51/park', { reason: 'later' });
  });

  it('offline disables the verb chips and hides Edit', async () => {
    mockNode(task({ id: 'MMR-51', status: 'ready', title: 'Chunk 2' }));
    render(<NodeDossier nodeId="MMR-51" offline onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });

    await expect(screen.findByRole('button', { name: 'Start' })).resolves.toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('under review surfaces the verdict block; Approve fires done', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-70' });
    mockNode(
      task({
        external_ref: 'https://example.test/pr/41',
        history: [
          {
            at: '2026-06-05T09:00:00.000Z',
            from: 'in_progress',
            kind: 'lifecycle',
            reason: null,
            to: 'under_review',
          },
        ],
        id: 'MMR-70',
        status: 'under_review',
        title: 'shippable chunk',
      }),
      [{ content: '79 tests · drop-cause facet', created_at: '2026-06-05T10:00:00.000Z' }],
    );
    render(<NodeDossier nodeId="MMR-70" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });

    // derived submitted-summary (latest annotation at/after submit) — echoed in
    // the verdict block AND the timeline feed, so both instances are expected
    await screen.findByRole('button', { name: 'Approve' });
    expect(screen.getAllByText('79 tests · drop-cause facet').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/example\.test\/pr\/41/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Return with notes…' })).toBeDefined();
    // done/return are inline (Approve/Return), never duplicated as header chips
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-70/done', undefined);
  });

  it('the breadcrumb titles the parent from its fetched record', async () => {
    mockNode(task({ id: 'MMR-16', parent: 'MMR-1', status: 'in_progress', title: 'child' }));
    render(<NodeDossier nodeId="MMR-16" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    await expect(screen.findByText('Parent')).resolves.toBeDefined();
  });

  it('edit chip toggles the task form, prefilled with node values', async () => {
    mockNode(task({ id: 'MMR-51', status: 'ready', title: 'Chunk 2 edit test' }));
    render(<NodeDossier nodeId="MMR-51" offline={false} onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    await screen.findByText('Chunk 2 edit test');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const titleInput = screen.getByLabelText(/title/i);
    expect((titleInput as HTMLInputElement).value).toBe('Chunk 2 edit test');
    expect(screen.getByRole('button', { name: /save/i })).toBeDefined();
  });

  it('edit PATCH omits empty optional fields (no null values sent to server)', async () => {
    mockNode(
      task({
        description: null,
        external_ref: null,
        id: 'MMR-65',
        status: 'ready',
        title: 'Regression task',
      }),
    );
    apiSend.mockResolvedValue({ id: 'MMR-65' });

    render(<NodeDossier nodeId="MMR-65" offline={false} onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    await screen.findByText('Regression task');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(apiSend).toHaveBeenCalledWith(
      'PATCH',
      expect.stringContaining('/api/nodes/'),
      expect.not.objectContaining({ description: null }),
    );
    expect(apiSend).toHaveBeenCalledWith(
      'PATCH',
      expect.stringContaining('/api/nodes/'),
      expect.not.objectContaining({ external_ref: null }),
    );
  });

  it('edit form pre-populates existing tags', async () => {
    mockNode(
      task({
        id: 'MMR-90',
        status: 'ready',
        tags: [
          { created_at: '2026-06-01T00:00:00.000Z', note: null, tag: 'ui' },
          { created_at: '2026-06-01T00:00:00.000Z', note: null, tag: 'release:v0.5' },
        ],
        title: 'tagged task',
      }),
    );
    render(<NodeDossier nodeId="MMR-90" offline={false} onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    await screen.findByText('tagged task');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText(/tags/i)).toHaveValue('ui, release:v0.5');
  });

  it('saving with an added tag fires the tag mutation with the right payload', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-91' });
    mockNode(task({ id: 'MMR-91', status: 'ready', tags: [], title: 'tag-add task' }));
    render(<NodeDossier nodeId="MMR-91" offline={false} onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    await screen.findByText('tag-add task');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.type(screen.getByLabelText(/tags/i), 'feat');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith('PUT', '/api/nodes/MMR-91/tags/feat', undefined),
    );
  });

  it('saving with a removed tag fires untag', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-92' });
    mockNode(
      task({
        id: 'MMR-92',
        status: 'ready',
        tags: [{ created_at: '2026-06-01T00:00:00.000Z', note: null, tag: 'ui' }],
        title: 'tag-remove task',
      }),
    );
    render(<NodeDossier nodeId="MMR-92" offline={false} onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    await screen.findByText('tag-remove task');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.clear(screen.getByLabelText(/tags/i));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith('DELETE', '/api/nodes/MMR-92/tags/ui', undefined),
    );
  });

  it('saving with unchanged tags fires neither tag nor untag, but scalars still update', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-93' });
    mockNode(
      task({
        id: 'MMR-93',
        status: 'ready',
        tags: [{ created_at: '2026-06-01T00:00:00.000Z', note: null, tag: 'ui' }],
        title: 'tag-keep task',
      }),
    );
    render(<NodeDossier nodeId="MMR-93" offline={false} onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    await screen.findByText('tag-keep task');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/nodes/MMR-93', expect.anything()),
    );
    // Scoped to this node's id — apiSend accumulates calls across the file.
    const tagWrites = apiSend.mock.calls.filter(
      ([, path]) => typeof path === 'string' && path.includes('/MMR-93/tags/'),
    );
    expect(tagWrites).toStrictEqual([]);
  });

  it('appending a tag by typing keeps the existing tag intact', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-94' });
    mockNode(
      task({
        id: 'MMR-94',
        status: 'ready',
        tags: [{ created_at: '2026-06-01T00:00:00.000Z', note: null, tag: 'ui' }],
        title: 'tag-append task',
      }),
    );
    render(<NodeDossier nodeId="MMR-94" offline={false} onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    await screen.findByText('tag-append task');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    // Keystroke-by-keystroke append: a trailing comma must survive mid-typing
    // (the parse must never rewrite the box), or "ui" and "feat" merge.
    await userEvent.type(screen.getByLabelText(/tags/i), ', feat');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith('PUT', '/api/nodes/MMR-94/tags/feat', undefined),
    );
    // Scoped to this node's id — apiSend accumulates calls across the file.
    const tagWrites = apiSend.mock.calls.filter(
      ([, path]) => typeof path === 'string' && path.includes('/MMR-94/tags/'),
    );
    expect(tagWrites).toStrictEqual([['PUT', '/api/nodes/MMR-94/tags/feat', undefined]]);
  });

  it('one save fires add + remove for the changed tags and nothing for the kept one', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-95' });
    mockNode(
      task({
        id: 'MMR-95',
        status: 'ready',
        tags: [
          { created_at: '2026-06-01T00:00:00.000Z', note: null, tag: 'keep' },
          { created_at: '2026-06-01T00:00:00.000Z', note: null, tag: 'drop' },
        ],
        title: 'tag-mix task',
      }),
    );
    render(<NodeDossier nodeId="MMR-95" offline={false} onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    await screen.findByText('tag-mix task');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByLabelText(/tags/i);
    await userEvent.clear(input);
    await userEvent.type(input, 'keep, fresh');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith('PUT', '/api/nodes/MMR-95/tags/fresh', undefined),
    );
    expect(apiSend).toHaveBeenCalledWith('DELETE', '/api/nodes/MMR-95/tags/drop', undefined);
    const keepWrites = apiSend.mock.calls.filter(
      ([, path]) => typeof path === 'string' && path.endsWith('/tags/keep'),
    );
    expect(keepWrites).toStrictEqual([]);
  });

  it('a failed tag mutation keeps the edit form open', async () => {
    apiSend.mockImplementation((method: string) =>
      method === 'PUT'
        ? Promise.reject(new Error('tag write failed'))
        : Promise.resolve({ id: 'MMR-96' }),
    );
    mockNode(task({ id: 'MMR-96', status: 'ready', tags: [], title: 'tag-fail task' }));
    render(<NodeDossier nodeId="MMR-96" offline={false} onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    await screen.findByText('tag-fail task');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.type(screen.getByLabelText(/tags/i), 'feat');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(apiSend).toHaveBeenCalledWith('PUT', '/api/nodes/MMR-96/tags/feat', undefined),
    );
    // The partial failure must not close the form back to the record view.
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/tags/i)).toBeInTheDocument();
  });

  it('surfaces the description body and carried-forward meta rows', async () => {
    mockNode(
      task({
        completed_at: '2026-07-01T00:00:00.000Z',
        description: 'The full unclamped body text.',
        external_ref: 'GH-123',
        id: 'MMR-80',
        status: 'in_progress',
        target: '2026-08-01',
        title: 'described task',
      }),
    );
    render(<NodeDossier nodeId="MMR-80" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });

    await screen.findByText('described task');
    expect(screen.getByText('The full unclamped body text.')).toBeDefined();
    // Carried-forward meta rows the drawer used to show (regression guard).
    expect(screen.getByText('target')).toBeDefined();
    expect(screen.getByText('2026-08-01')).toBeDefined();
    expect(screen.getByText('created')).toBeDefined();
    expect(screen.getByText('updated')).toBeDefined();
    expect(screen.getByText('completed')).toBeDefined();
    // A non-URL external_ref renders as plain text, never a dead in-app link.
    const ref = screen.getByText('GH-123');
    expect(ref.tagName).not.toBe('A');
  });

  it('move… opens the reparent picker and moves to the chosen parent', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-16' });
    const node = task({ id: 'MMR-16', parent: 'MMR-1', status: 'in_progress', title: 'chunk' });
    const tree = treeNode('MMR', 'proj', 'project', [
      treeNode('MMR-1', 'Initiative one', 'initiative'),
      treeNode('MMR-2', 'Initiative two', 'initiative'),
    ]);
    apiGet.mockImplementation((path: string) => {
      if (path === '/api/nodes/MMR-16') {
        return Promise.resolve(node);
      }
      if (path === '/api/nodes/MMR-16/annotations') {
        return Promise.resolve({ items: [], total: 0 });
      }
      if (path === '/api/projects/MMR/tree') {
        return Promise.resolve(tree);
      }
      if (path.startsWith('/api/nodes/')) {
        return Promise.resolve(
          task({ id: 'MMR-1', status: 'in_progress', title: 'Initiative one' }),
        );
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(<NodeDossier nodeId="MMR-16" offline={false} onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Move…' }));
    // Options render once the tree loads (which also enables the select).
    await screen.findByRole('option', { name: /Initiative two/ });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'New parent' }), 'MMR-2');
    await userEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-16/move', { to: 'MMR-2' });
  });

  it('clicking an artifact navigates to the reader with provenance', async () => {
    navigate.mockClear();
    mockNode(
      task({
        artifacts: [
          {
            created_at: '2026-06-10T00:00:00.000Z',
            id: 'MMR-a3',
            tags: [],
            title: 'console notes',
          },
        ],
        id: 'MMR-16',
        status: 'in_progress',
        title: 'chunk 1',
      }),
    );
    render(<NodeDossier nodeId="MMR-16" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    await userEvent.click(await screen.findByText('console notes'));
    expect(navigate).toHaveBeenCalledWith({
      search: { a: 'MMR-a3', from: 'MMR-16' },
      to: '/artifacts',
    });
  });
});
