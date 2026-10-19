import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/errors';
import { POLL_MS } from '../api/queries';
import { createQueryClient } from '../api/query-client';
import type { WireNode } from '../api/types';
import { routeTree } from '../router';
import { serveBrowse } from './browse-fns';
import { engineTree } from './engine-fixtures';
import { emptyRead, task, workReport } from './fixtures';
import { serveShell } from './shell-fns';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('sonner', async (orig) => ({
  // oxlint-disable-next-line typescript/consistent-type-imports
  ...(await orig<typeof import('sonner')>()),
  toast: { error: vi.fn(), success: vi.fn() },
}));

const TREE = engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
  engineTree(
    { id: 'MMR-1', status: 'ready', title: 'Hosted and external backends', type: 'initiative' },
    [
      engineTree(
        {
          id: 'MMR-2',
          parent: 'MMR-1',
          status: 'ready',
          title: 'SQLite replaces Norn',
          type: 'phase',
        },
        [engineTree({ id: 'MMR-417', parent: 'MMR-2', status: 'ready', type: 'task' })],
      ),
    ],
  ),
]);

/** Serve `node` at its detail path, the MMR tree, and an empty list everywhere else. */
function serve(node: WireNode, extra: Record<string, unknown> = {}) {
  apiGet.mockImplementation((path: string) => {
    if (path in extra) {
      return Promise.resolve(extra[path]);
    }
    if (path === `/api/nodes/${node.id}`) {
      return Promise.resolve(node);
    }
    if (path.startsWith(`/api/nodes/${node.id}/work?`)) {
      return Promise.resolve(workReport());
    }
    return Promise.resolve(emptyRead(path));
  });
  serveShell({ trees: { MMR: TREE } });
}

function renderAt(
  url: string,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [url] }),
    routeTree,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return testRouter;
}

const sqlite = task({
  description: 'SQLite dialect over `bun:sqlite`.',
  id: 'MMR-417',
  parent: 'MMR-2',
  status: 'ready',
  title: 'Add the SQLite dialect',
});

beforeEach(() => {
  serveBrowse();
  apiGet.mockReset();
  apiSend.mockReset();
});

/** Markdown with a list, inline and fenced code, and a link — one body for every surface. */
const MARKDOWN_BODY = [
  '- first item',
  '- second with `inline_code`',
  '',
  '[the docs](https://example.com/docs)',
  '',
  '```ts',
  'const fenced = 1;',
  '```',
].join('\n');

/** The tag write requests for one node (apiSend accumulates calls across a test). */
function tagWrites(id: string) {
  return apiSend.mock.calls.filter(
    ([, path]) => typeof path === 'string' && path.includes(`/${id}/tags/`),
  );
}

/** Render the task page for `node` and wait for its desktop rail. */
async function openTask(node: WireNode, extra: Record<string, unknown> = {}) {
  serve(node, extra);
  renderAt(`/p/MMR/${node.id.replace('MMR-', '')}`);
  return screen.findByRole('complementary', { name: 'Record details' });
}

describe('task page (MMR-449)', () => {
  it('opens a task directly at its URL', async () => {
    serve(sqlite);
    renderAt('/p/MMR/417');

    await expect(
      screen.findByRole('heading', { level: 1, name: 'Add the SQLite dialect' }),
    ).resolves.toBeDefined();
    expect(screen.getByText('bun:sqlite')).toBeDefined();
    expect(screen.getByRole('textbox', { name: /note/i })).toBeDefined();
  });

  it('links its nearest container above the id for a phone, in place of a breadcrumb', async () => {
    serve(sqlite);
    renderAt('/p/MMR/417');

    const parent = await screen.findByRole('link', { name: /SQLite replaces Norn/ });
    expect(parent.getAttribute('href')).toBe('/p/MMR/2');
    // The sidebar outline carries the place from md up.
    expect(parent.className).toContain('lg:hidden');
    expect(screen.queryByRole('navigation', { name: 'Path' })).toBeNull();
  });

  it('links the project when no container holds the task', async () => {
    const loose = task({ id: 'MMR-9', parent: 'MMR', status: 'ready', title: 'A loose task' });
    serve(loose);
    serveShell({
      trees: {
        MMR: engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
          engineTree({
            id: 'MMR-9',
            parent: 'MMR',
            status: 'ready',
            title: 'A loose task',
            type: 'task',
          }),
        ]),
      },
    });
    renderAt('/p/MMR/9');

    // The brand is also named Mimir; the parent link is the one a desktop hides.
    await screen.findByRole('heading', { level: 1 });
    const parent = screen
      .getAllByRole('link', { name: 'Mimir' })
      .find((l) => l.className.includes('lg:hidden'));
    expect(parent?.getAttribute('href')).toBe('/p/MMR');
  });

  it('redirects a bare id, in any case, to the record page', async () => {
    serve(sqlite);
    const testRouter = renderAt('/mmr-417');

    await expect(
      screen.findByRole('heading', { level: 1, name: 'Add the SQLite dialect' }),
    ).resolves.toBeDefined();
    expect(testRouter.state.location.pathname).toBe('/p/MMR/417');
  });

  it('redirects a bare project key to the project page', async () => {
    serve(sqlite);
    const testRouter = renderAt('/MMR');

    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/MMR');
    });
  });

  it('shows its own not-found state when no record has the id', async () => {
    apiGet.mockImplementation((path: string) =>
      path === '/api/nodes/MMR-999'
        ? Promise.reject(new ApiError(`GET ${path} → 404`, 404))
        : Promise.resolve(emptyRead(path)),
    );
    renderAt('/p/MMR/999');

    await expect(screen.findByText(/no record MMR-999/i)).resolves.toBeDefined();
    expect(screen.queryByText(/offline — last synced/i)).toBeNull();
  });

  it('names no node for a suffix that is not a node id, without a lookup', async () => {
    serve(sqlite);
    renderAt('/p/MMR/x41');

    await expect(screen.findByText(/no record at \/p\/MMR\/x41/i)).resolves.toBeDefined();
    expect(apiGet.mock.calls.some(([path]) => String(path).startsWith('/api/nodes/'))).toBe(false);
  });

  it('asks for a verdict while the task is under review', async () => {
    serve({ ...sqlite, external_ref: 'https://github.com/x/pull/360', status: 'under_review' });
    renderAt('/p/MMR/417');

    await expect(screen.findByText(/needs your verdict/i)).resolves.toBeDefined();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined();
  });

  it('offers a container no verdict and no task actions, whatever its rollup reads', async () => {
    serve({
      ...task({
        id: 'MMR-2',
        parent: 'MMR-1',
        status: 'under_review',
        title: 'SQLite replaces Norn',
      }),
      type: 'phase',
    });
    renderAt('/p/MMR/2');

    await expect(
      screen.findByRole('heading', { level: 1, name: 'SQLite replaces Norn' }),
    ).resolves.toBeDefined();
    expect(screen.queryByText(/needs your verdict/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /park/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull();
  });

  it('links what the task depends on and what it blocks to their pages', async () => {
    serve({
      ...sqlite,
      deps: {
        blocking: [{ id: 'MMR-418', status: 'awaiting', title: 'Remove the Norn backend' }],
        depends_on: [{ id: 'MMR-416', status: 'done', title: 'Extract a dialect seam' }],
      },
    });
    renderAt('/p/MMR/417');

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    expect(
      within(rail)
        .getByRole('link', { name: /MMR-416/ })
        .getAttribute('href'),
    ).toBe('/p/MMR/416');
    expect(
      within(rail)
        .getByRole('link', { name: /MMR-418/ })
        .getAttribute('href'),
    ).toBe('/p/MMR/418');
  });

  it('links each of its artifacts to the artifact page (MMR-452)', async () => {
    serve({
      ...sqlite,
      artifacts: [
        { created_at: '2026-06-10T00:00:00.000Z', id: 'MMR-a3', tags: [], title: 'Dialect spec' },
      ],
    });
    renderAt('/p/MMR/417');

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    expect(within(rail).getByRole('link', { name: /Dialect spec/ })).toHaveAttribute(
      'href',
      '/p/MMR/a3',
    );
  });

  it('each rail chip opens its part of the rail in a sheet', async () => {
    serve({
      ...sqlite,
      deps: {
        blocking: [{ id: 'MMR-418', status: 'awaiting', title: 'Remove the Norn backend' }],
        depends_on: [{ id: 'MMR-416', status: 'done', title: 'Extract a dialect seam' }],
      },
    });
    renderAt('/p/MMR/417');

    const chips = await screen.findByRole('group', { name: 'Record details' });
    fireEvent.click(within(chips).getByRole('button', { name: /links/i }));

    const sheet = await screen.findByRole('dialog', { name: /links/i });
    expect(
      within(sheet)
        .getByRole('link', { name: /MMR-416/ })
        .getAttribute('href'),
    ).toBe('/p/MMR/416');
  });

  it('shows where an agent is working on it, with its Scratchpad', async () => {
    serve(
      { ...sqlite, branch: 'feat/mmr-417-sqlite', harness: 'claude-code', status: 'in_progress' },
      {
        '/api/scratchpads?project=MMR': {
          items: [
            {
              id: 'a',
              linked_work: ['MMR-417'],
              open_agenda: 1,
              project: 'MMR',
              state: 'active',
              title: 'SQLite cutover episode',
              updated_at: '2026-06-01T10:00:00.000Z',
            },
            {
              id: 'b',
              linked_work: ['MMR-12'],
              open_agenda: 0,
              project: 'MMR',
              state: 'active',
              title: 'Unrelated episode',
              updated_at: '2026-06-01T10:00:00.000Z',
            },
          ],
          total: 2,
        },
      },
    );
    renderAt('/p/MMR/417');

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    await expect(within(rail).findByText('SQLite cutover episode')).resolves.toBeDefined();
    expect(within(rail).getByText('claude-code')).toBeDefined();
    expect(within(rail).getByText('feat/mmr-417-sqlite')).toBeDefined();
    expect(within(rail).queryByText('Unrelated episode')).toBeNull();
  });

  it('moves a lowercase key to its canonical URL', async () => {
    serve(sqlite);
    const testRouter = renderAt('/p/mmr/417');

    await expect(
      screen.findByRole('heading', { level: 1, name: 'Add the SQLite dialect' }),
    ).resolves.toBeDefined();
    expect(testRouter.state.location.pathname).toBe('/p/MMR/417');
  });

  it('closes a sheet when a link in it is chosen, not when its text is', async () => {
    serve({
      ...sqlite,
      deps: {
        blocking: [],
        depends_on: [{ id: 'MMR-416', status: 'done', title: 'Extract a dialect seam' }],
      },
    });
    renderAt('/p/MMR/417');
    const chips = await screen.findByRole('group', { name: 'Record details' });

    fireEvent.click(within(chips).getByRole('button', { name: /details/i }));
    const details = await screen.findByRole('dialog', { name: /details/i });
    fireEvent.click(within(details).getByText('created'));
    expect(screen.getByRole('dialog', { name: /details/i })).toBeDefined();
    fireEvent.click(within(details).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    fireEvent.click(within(chips).getByRole('button', { name: /links/i }));
    const links = await screen.findByRole('dialog', { name: /links/i });
    fireEvent.click(within(links).getByRole('link', { name: /MMR-416/ }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /links/i })).toBeNull();
    });
  });

  it('closes a sheet when an action in it is chosen', async () => {
    serve(sqlite);
    renderAt('/p/MMR/417');
    const chips = await screen.findByRole('group', { name: 'Record details' });

    fireEvent.click(within(chips).getByRole('button', { name: 'Actions' }));
    const actions = await screen.findByRole('dialog', { name: 'Actions' });
    fireEvent.click(within(actions).getByRole('button', { name: 'Edit' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Actions' })).toBeNull();
    });
  });

  it('sets the actions aside while the edit form is open', async () => {
    serve(sqlite);
    renderAt('/p/MMR/417');
    const rail = await screen.findByRole('complementary', { name: 'Record details' });

    fireEvent.click(within(rail).getByRole('button', { name: 'Edit' }));
    await waitFor(() => {
      expect(within(rail).queryByRole('button', { name: 'Edit' })).toBeNull();
    });
    expect(within(rail).queryByRole('button', { name: 'Start' })).toBeNull();
  });
});

describe('container page (MMR-450)', () => {
  const phase: WireNode = {
    ...task({
      description: 'Swap the **store** under the board.',
      id: 'MMR-2',
      parent: 'MMR-1',
      status: 'ready',
      title: 'SQLite replaces Norn',
    }),
    next: 'Land the dialect first.\n\nThen remove the Norn backend.',
    type: 'phase',
  };

  it('shows its direction in full, with a way to rewrite it', async () => {
    serve(phase);
    renderAt('/p/MMR/2');

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    expect(within(rail).getByText('Land the dialect first.')).toBeDefined();
    expect(within(rail).getByText('Then remove the Norn backend.')).toBeDefined();
    fireEvent.click(within(rail).getByRole('button', { name: 'Edit direction' }));
    await expect(screen.findByRole('textbox', { name: 'Direction text' })).resolves.toHaveValue(
      'Land the dialect first.\n\nThen remove the Norn backend.',
    );
  });

  it('opens as the work page, with its path, its sections, and no task actions', async () => {
    serve(phase);
    renderAt('/p/MMR/2');

    await expect(
      screen.findByRole('heading', { level: 1, name: 'SQLite replaces Norn' }),
    ).resolves.toBeDefined();
    expect(screen.getByText('MMR-2 · phase')).toBeDefined();
    expect(
      screen.getByRole('link', { name: /Hosted and external backends/ }).getAttribute('href'),
    ).toBe('/p/MMR/1');
    expect(screen.queryByRole('navigation', { name: 'Path' })).toBeNull();
    for (const name of ['Now', 'Needs you', 'Frontier', 'Shipped', 'Going cold']) {
      // oxlint-disable-next-line no-await-in-loop -- one section at a time reads clearest
      await expect(screen.findByRole('region', { name })).resolves.toBeDefined();
    }
    expect(screen.queryByRole('region', { name: /contents/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('asks for the work of its own subtree', async () => {
    serve(phase);
    renderAt('/p/MMR/2');

    await screen.findByRole('region', { name: 'Now' });
    expect(apiGet).toHaveBeenCalledWith('/api/nodes/MMR-2/work?tz=America%2FNew_York');
  });

  it('an initiative opens as the work page too, its parent the project', async () => {
    serve({
      ...phase,
      id: 'MMR-1',
      parent: null,
      title: 'Hosted and external backends',
      type: 'initiative',
    });
    renderAt('/p/MMR/1');

    await screen.findByRole('heading', { level: 1 });
    const parent = screen
      .getAllByRole('link', { name: 'Mimir' })
      .find((l) => l.className.includes('lg:hidden'));
    expect(parent?.getAttribute('href')).toBe('/p/MMR');
    await expect(screen.findByRole('region', { name: 'Frontier' })).resolves.toBeDefined();
  });

  describe('Work | Timeline tabs', () => {
    const note = { content: 'Settled the dialect seam', created_at: '2026-06-02T00:00:00.000Z' };
    const withNote = { '/api/nodes/MMR-2/annotations': { items: [note], total: 1 } };

    it('opens on Work, with the timeline a tab away', async () => {
      serve(phase, withNote);
      renderAt('/p/MMR/2');

      const tabs = await screen.findByRole('tablist');
      const work = within(tabs).getByRole('tab', { name: 'Work' });
      expect(work.getAttribute('aria-selected')).toBe('true');
      expect(within(tabs).getByRole('tab', { name: /Timeline/ })).toHaveTextContent('Timeline2');
      // Only the selected tab names a panel, and that panel is in the DOM.
      const panel = screen.getByRole('tabpanel');
      expect(work.getAttribute('aria-controls')).toBe(panel.id);
      expect(within(tabs).getByRole('tab', { name: /Timeline/ })).not.toHaveAttribute(
        'aria-controls',
      );
      await expect(screen.findByRole('region', { name: 'Now' })).resolves.toBeDefined();
      expect(screen.queryByText('Settled the dialect seam')).toBeNull();
    });

    it('Timeline puts ?tab=timeline in the URL and shows the notes and the composer', async () => {
      serve(phase, withNote);
      const testRouter = renderAt('/p/MMR/2');

      fireEvent.click(await screen.findByRole('tab', { name: /Timeline/ }));

      await expect(screen.findByText('Settled the dialect seam')).resolves.toBeDefined();
      expect(testRouter.state.location.searchStr).toBe('?tab=timeline');
      expect(screen.getByRole('textbox', { name: /note/i })).toBeDefined();
      expect(screen.getByRole('tab', { name: /Timeline/ }).getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
    });

    it('opens on Timeline at ?tab=timeline, and Work takes the parameter back out', async () => {
      serve(phase, withNote);
      const testRouter = renderAt('/p/MMR/2?tab=timeline');

      await expect(screen.findByText('Settled the dialect seam')).resolves.toBeDefined();
      fireEvent.click(screen.getByRole('tab', { name: 'Work' }));

      await expect(screen.findByRole('region', { name: 'Now' })).resolves.toBeDefined();
      expect(testRouter.state.location.searchStr).toBe('');
    });

    it('drops a tab value it does not know', async () => {
      serve(phase, withNote);
      const testRouter = renderAt('/p/MMR/2?tab=sections');

      await expect(screen.findByRole('region', { name: 'Now' })).resolves.toBeDefined();
      expect(testRouter.state.location.searchStr).toBe('');
    });

    it('arrow keys move between the tabs', async () => {
      serve(phase, withNote);
      renderAt('/p/MMR/2');

      const work = await screen.findByRole('tab', { name: 'Work' });
      fireEvent.keyDown(work, { key: 'ArrowRight' });

      await expect(screen.findByText('Settled the dialect seam')).resolves.toBeDefined();
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Timeline/ }));
    });

    it('a task page has no tabs, and ignores the parameter', async () => {
      serve(sqlite);
      renderAt('/p/MMR/417?tab=timeline');

      await screen.findByRole('heading', { level: 1, name: 'Add the SQLite dialect' });
      expect(screen.queryByRole('tablist')).toBeNull();
      expect(screen.getByRole('heading', { name: /Timeline/ })).toBeDefined();
    });
  });
});

/** Open the edit form for `node` and return its Tags field. */
async function openEdit(node: WireNode) {
  const rail = await openTask(node);
  await userEvent.click(within(rail).getByRole('button', { name: 'Edit' }));
  return screen.findByLabelText(/tags/i);
}

/** Open a task page whose only timeline note carries `content`. */
async function openWithNote(content: string) {
  await openTask(task({ id: 'MMR-83', status: 'in_progress' }), {
    '/api/nodes/MMR-83/annotations': {
      items: [{ content, created_at: '2026-06-02T00:00:00.000Z' }],
      total: 1,
    },
  });
}

describe('task page edit (MMR-453)', () => {
  const stamp = '2026-06-01T00:00:00.000Z';

  it('pre-populates the existing tags in the edit form', async () => {
    const tags = await openEdit(
      task({
        id: 'MMR-90',
        status: 'ready',
        tags: [
          { created_at: stamp, tag: 'ui' },
          { created_at: stamp, tag: 'release:v0.5' },
        ],
      }),
    );
    expect(tags).toHaveValue('ui, release:v0.5');
  });

  it('saving with an added tag adds exactly that tag', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-91' });
    await userEvent.type(await openEdit(task({ id: 'MMR-91', status: 'ready', tags: [] })), 'feat');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PUT', '/api/nodes/MMR-91/tags/feat', undefined);
    });
    expect(tagWrites('MMR-91')).toHaveLength(1);
  });

  it('saving with a removed tag removes exactly that tag', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-92' });
    await userEvent.clear(
      await openEdit(
        task({ id: 'MMR-92', status: 'ready', tags: [{ created_at: stamp, tag: 'ui' }] }),
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('DELETE', '/api/nodes/MMR-92/tags/ui', undefined);
    });
    expect(tagWrites('MMR-92')).toHaveLength(1);
  });

  it('saving with unchanged tags fires no tag request, but the scalars still update', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-93' });
    await openEdit(
      task({ id: 'MMR-93', status: 'ready', tags: [{ created_at: stamp, tag: 'ui' }] }),
    );
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/nodes/MMR-93', expect.anything());
    });
    expect(tagWrites('MMR-93')).toStrictEqual([]);
  });

  it('appending a tag by typing keeps the existing tag intact', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-94' });
    // Keystroke-by-keystroke append: a trailing comma must survive mid-typing,
    // or "ui" and "feat" merge into one tag.
    await userEvent.type(
      await openEdit(
        task({ id: 'MMR-94', status: 'ready', tags: [{ created_at: stamp, tag: 'ui' }] }),
      ),
      ', feat',
    );
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(tagWrites('MMR-94')).toStrictEqual([
        ['PUT', '/api/nodes/MMR-94/tags/feat', undefined],
      ]);
    });
  });

  it('one save adds and removes the changed tags and leaves the kept one alone', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-95' });
    const tags = await openEdit(
      task({
        id: 'MMR-95',
        status: 'ready',
        tags: [
          { created_at: stamp, tag: 'keep' },
          { created_at: stamp, tag: 'drop' },
        ],
      }),
    );
    await userEvent.clear(tags);
    await userEvent.type(tags, 'keep, fresh');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(tagWrites('MMR-95')).toHaveLength(2);
    });
    expect(apiSend).toHaveBeenCalledWith('PUT', '/api/nodes/MMR-95/tags/fresh', undefined);
    expect(apiSend).toHaveBeenCalledWith('DELETE', '/api/nodes/MMR-95/tags/drop', undefined);
  });

  it('a failed tag save keeps the edit form open', async () => {
    apiSend.mockImplementation((method: string) =>
      method === 'PUT'
        ? Promise.reject(new Error('tag write failed'))
        : Promise.resolve({ id: 'MMR-96' }),
    );
    await userEvent.type(await openEdit(task({ id: 'MMR-96', status: 'ready', tags: [] })), 'feat');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PUT', '/api/nodes/MMR-96/tags/feat', undefined);
    });
    // The partial failure must not close the form back to the record view.
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/tags/i)).toBeInTheDocument();
  });

  it('omits empty optional fields from the PATCH instead of sending nulls', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-65' });
    await openEdit(task({ description: null, external_ref: null, id: 'MMR-65', status: 'ready' }));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/nodes/MMR-65', expect.anything());
    });
    // A null would be sent as JSON null; an absent (undefined) field is dropped.
    const body = apiSend.mock.calls.find(
      ([method]) => method === 'PATCH',
    )?.[2] as Partial<WireNode>;
    expect(body.description).toBeUndefined();
    expect(body.external_ref).toBeUndefined();
  });
});

describe('task page verbs (MMR-453)', () => {
  it('a plain verb fires immediately', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-51' });
    const rail = await openTask(task({ id: 'MMR-51', status: 'ready' }));

    await userEvent.click(within(rail).getByRole('button', { name: 'Start' }));

    expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-51/start', undefined);
  });

  it('a verb that needs a reason asks for it first, then fires with it', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-51' });
    const rail = await openTask(task({ id: 'MMR-51', status: 'ready' }));

    await userEvent.click(within(rail).getByRole('button', { name: 'Park for later…' }));
    expect(apiSend).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'later');
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));

    expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-51/park', { reason: 'later' });
  });

  it('Approve in the verdict block fires done', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-70' });
    await openTask(
      task({
        external_ref: 'https://example.test/pr/41',
        id: 'MMR-70',
        status: 'under_review',
      }),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-70/done', undefined);
  });

  it('offline disables Edit, Move…, and the verbs', async () => {
    const node = task({ id: 'MMR-51', status: 'ready' });
    serve(node, { '/api/nodes/MMR-51/annotations': undefined });
    // An errored read over loaded data is the console's offline signal.
    const base = apiGet.getMockImplementation();
    apiGet.mockImplementation((path: string) =>
      path === '/api/nodes/MMR-51/annotations'
        ? Promise.reject(new Error('unreachable'))
        : base?.(path),
    );
    renderAt('/p/MMR/51');

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    await waitFor(() => {
      expect(within(rail).getByRole('button', { name: 'Start' })).toBeDisabled();
    });
    expect(within(rail).getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(within(rail).getByRole('button', { name: 'Move…' })).toBeDisabled();
  });
});

describe('task page move (MMR-453)', () => {
  it('Move… picks a new parent and moves the task there', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-417' });
    const rail = await openTask(sqlite);

    await userEvent.click(within(rail).getByRole('button', { name: 'Move…' }));
    // Options render once the tree loads (which also enables the select).
    await screen.findByRole('option', { name: /Hosted and external backends/ });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'New parent' }), 'MMR-1');
    await userEvent.click(screen.getByRole('button', { name: 'Move' }));

    expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-417/move', { to: 'MMR-1' });
  });
});

describe('task page content (MMR-453)', () => {
  it('renders the description as markdown', async () => {
    await openTask(
      task({ description: MARKDOWN_BODY, id: 'MMR-81', status: 'in_progress', title: 'md task' }),
    );

    // The record layout is itself an article; the markdown body is the one holding the code.
    const article = (await screen.findByText('const fenced = 1;')).closest('article');
    expect(article).not.toBeNull();
    if (article === null) {
      return;
    }
    expect(within(article).getByText('const fenced = 1;').closest('pre')).not.toBeNull();
    expect(within(article).getByRole('link', { name: 'the docs' })).toHaveAttribute(
      'href',
      'https://example.com/docs',
    );
    expect(within(article).getByText('inline_code').tagName).toBe('CODE');
    expect(within(article).getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders a dependency in both depends_on and awaiting_on as one row, with the awaiting reading', async () => {
    const rail = await openTask(
      task({
        deps: {
          awaiting_on: [{ id: 'MMR-20', status: 'blocked', title: 'still gating' }],
          blocking: [],
          depends_on: [{ id: 'MMR-20', status: 'done', title: 'still gating (stale)' }],
        },
        id: 'MMR-21',
        status: 'in_progress',
      }),
    );

    expect(within(rail).getAllByText('MMR-20')).toHaveLength(1);
    expect(within(rail).getByText('still gating')).toBeDefined();
    expect(within(rail).queryByText('still gating (stale)')).toBeNull();
  });

  describe('note clamp toggle', () => {
    const proto = HTMLElement.prototype;
    const original = {
      client: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
      scroll: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
    };

    /** jsdom has no layout; stub the two heights the note measures. */
    function stubHeights(scrollHeight: number, clientHeight: number) {
      Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => scrollHeight });
      Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => clientHeight });
    }

    beforeEach(() => {
      // jsdom has no computed line-height; the clamp reads it off the article.
      const real = globalThis.getComputedStyle.bind(globalThis);
      vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((el, pseudo) =>
        el.tagName === 'ARTICLE'
          ? ({ lineHeight: '20px' } as CSSStyleDeclaration)
          : real(el, pseudo),
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
      for (const [name, descriptor] of [
        ['clientHeight', original.client],
        ['scrollHeight', original.scroll],
      ] as const) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(proto, name);
        } else {
          Object.defineProperty(proto, name, descriptor);
        }
      }
    });

    it('offers "Show all" with the rendered line count when the note overflows, and toggles the clamp', async () => {
      stubHeights(200, 60);
      await openWithNote('- one\n- two\n- three');

      // 200px of content at a 20px line-height: ten rendered lines.
      const toggle = await screen.findByRole('button', { name: 'Show all · 10 lines ⌄' });
      const article = screen.getByText('three').closest('article');
      expect(article).toHaveAttribute('data-clamped');
      await userEvent.click(toggle);
      expect(screen.getByRole('button', { name: 'Show less ⌃' })).toBeInTheDocument();
      expect(article).not.toHaveAttribute('data-clamped');
      await userEvent.click(screen.getByRole('button', { name: 'Show less ⌃' }));
      expect(screen.getByRole('button', { name: 'Show all · 10 lines ⌄' })).toBeInTheDocument();
      expect(article).toHaveAttribute('data-clamped');
    });

    it('offers no toggle when the note fits its clamp', async () => {
      stubHeights(60, 60);
      await openWithNote('- one\n- two\n- three');

      await screen.findByText('three');
      expect(screen.queryByRole('button', { name: /show (all|less)/i })).toBeNull();
    });
  });
});

describe('live refresh (MMR-458)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a note added outside the console within one poll', async () => {
    // Real time keeps ticking so findBy can still poll under the fake clock.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve(sqlite);
    renderAt('/p/MMR/417', createQueryClient());
    await screen.findByRole('heading', { level: 1, name: 'Add the SQLite dialect' });

    const note = { content: 'Annotated from the CLI', created_at: '2026-06-02T10:00:00.000Z' };
    serve(sqlite, { '/api/nodes/MMR-417/annotations': { items: [note], total: 1 } });
    expect(screen.queryByText('Annotated from the CLI')).toBeNull();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    await expect(screen.findByText('Annotated from the CLI')).resolves.toBeDefined();
  });
});

const groomed = () => task({ grooming: 'groomed', id: 'MMR-51', status: 'ready' });

/** The task read requests issued so far for MMR-51. */
const taskReads = () => apiGet.mock.calls.filter(([path]) => path === '/api/nodes/MMR-51');

describe('task page grooming state (MMR-466)', () => {
  it('shows the state in the header and as a Grooming row in Details', async () => {
    const rail = await openTask(groomed());

    const article = screen.getByRole('article');
    expect(within(article).getByText('groomed')).toBeDefined();
    expect(within(rail).getByText('grooming')).toBeDefined();
    expect(within(rail).getByText('groomed')).toBeDefined();
  });

  it.each([
    ['blocked', 'blocked'],
    ['parked', 'parked'],
  ] as const)('still shows the state on a todo task that is %s', async (hold, status) => {
    await openTask(task({ grooming: 'groomed', hold, hold_reason: 'why', id: 'MMR-51', status }));

    expect(within(screen.getByRole('article')).getByText('groomed')).toBeDefined();
  });

  it('wears the same font in Details as in the header', async () => {
    const rail = await openTask(groomed());

    expect(within(rail).getByText('groomed').className).toContain('font-sans');
  });

  it('keeps the dialog open and toasts the error when the request fails', async () => {
    apiSend.mockRejectedValue(new Error('needs_answers requires a note'));
    const rail = await openTask(groomed());

    await userEvent.click(within(rail).getByRole('button', { name: 'Set grooming…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Grooming state' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /^not groomed/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set grooming' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('needs_answers requires a note');
    });
    expect(screen.getByRole('dialog', { name: 'Grooming state' })).toBeDefined();
  });

  it('shows no state once the task has started', async () => {
    const rail = await openTask(
      task({
        grooming: 'groomed',
        id: 'MMR-51',
        lifecycle: 'in_progress',
        status: 'in_progress',
      }),
    );

    expect(screen.queryByText('groomed')).toBeNull();
    expect(within(rail).queryByText('grooming')).toBeNull();
    expect(within(rail).queryByRole('button', { name: 'Set grooming…' })).toBeNull();
  });

  it('shows no state on a container', async () => {
    const rail = await openTask({
      ...task({ id: 'MMR-2', status: 'ready' }),
      grooming: 'groomed',
      type: 'phase',
    });

    expect(screen.queryByText('groomed')).toBeNull();
    expect(within(rail).queryByRole('button', { name: 'Set grooming…' })).toBeNull();
  });

  it('sets the state without a note unless it needs answers', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-51' });
    const rail = await openTask(task({ grooming: 'not_groomed', id: 'MMR-51', status: 'ready' }));

    await userEvent.click(within(rail).getByRole('button', { name: 'Set grooming…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Grooming state' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /^groomed/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set grooming' }));

    expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-51/groom', { state: 'groomed' });
  });

  it('needs a note before it sets needs answers, and sends it with the state', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-51' });
    const rail = await openTask(groomed());

    await userEvent.click(within(rail).getByRole('button', { name: 'Set grooming…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Grooming state' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /^needs answers/ }));
    const submit = within(dialog).getByRole('button', { name: 'Set grooming' });
    expect(submit).toBeDisabled();

    const note = within(dialog).getByRole('textbox', { name: /open questions/i });
    await userEvent.type(note, '   ');
    expect(submit).toBeDisabled();
    await userEvent.type(note, 'Which backend wins?');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-51/groom', {
      note: 'Which backend wins?',
      state: 'needs_answers',
    });
  });

  it('refetches the task after the state is set', async () => {
    apiSend.mockResolvedValue({ id: 'MMR-51' });
    const rail = await openTask(groomed());
    const before = taskReads().length;

    await userEvent.click(within(rail).getByRole('button', { name: 'Set grooming…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Grooming state' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /^not groomed/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set grooming' }));

    await waitFor(() => {
      expect(taskReads().length).toBeGreaterThan(before);
    });
  });

  it('is offered from the Actions sheet on a phone', async () => {
    serve(groomed());
    renderAt('/p/MMR/51');
    const chips = await screen.findByRole('group', { name: 'Record details' });

    fireEvent.click(within(chips).getByRole('button', { name: 'Actions' }));
    const actions = await screen.findByRole('dialog', { name: 'Actions' });
    fireEvent.click(within(actions).getByRole('button', { name: 'Set grooming…' }));

    await expect(screen.findByRole('dialog', { name: 'Grooming state' })).resolves.toBeDefined();
  });

  it('is disabled while offline', async () => {
    const node = groomed();
    serve(node);
    const base = apiGet.getMockImplementation();
    apiGet.mockImplementation((path: string) =>
      path === '/api/nodes/MMR-51/annotations'
        ? Promise.reject(new Error('unreachable'))
        : base?.(path),
    );
    renderAt('/p/MMR/51');

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    await waitFor(() => {
      expect(within(rail).getByRole('button', { name: 'Set grooming…' })).toBeDisabled();
    });
  });
});

describe('task page hold callout (MMR-466)', () => {
  it.each([
    ['you', 'Blocked on you'],
    ['others', 'Blocked on others'],
  ] as const)('names who can clear a block owned by %s', async (owner, label) => {
    await openTask(
      task({
        block_owner: owner,
        hold: 'blocked',
        hold_reason: 'Needs an API token',
        id: 'MMR-51',
        status: 'blocked',
      }),
    );

    const article = screen.getByRole('article');
    expect(within(article).getByText(label)).toBeDefined();
    expect(within(article).getByText('Needs an API token')).toBeDefined();
  });

  it.each([
    ['you', 'Blocked on you'],
    ['others', 'Blocked on others'],
  ] as const)(
    'names the owner of a block owned by %s even with no reason',
    async (owner, label) => {
      await openTask(
        task({
          block_owner: owner,
          hold: 'blocked',
          hold_reason: null,
          id: 'MMR-51',
          status: 'blocked',
        }),
      );

      expect(within(screen.getByRole('article')).getByText(label)).toBeDefined();
    },
  );

  it('links a URL in the hold reason, opening in a new tab', async () => {
    await openTask(
      task({
        block_owner: 'you',
        hold: 'blocked',
        hold_reason: 'Pick a variant from https://example.com/a/b.',
        id: 'MMR-51',
        status: 'blocked',
      }),
    );

    const link = within(screen.getByRole('article')).getByRole('link', {
      name: 'https://example.com/a/b',
    });
    expect(link.getAttribute('href')).toBe('https://example.com/a/b');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows no callout for a parked task with no reason', async () => {
    await openTask(task({ hold: 'parked', hold_reason: null, id: 'MMR-51', status: 'parked' }));

    expect(within(screen.getByRole('article')).queryByText('parked')).toBeNull();
  });

  it('keeps the plain hold name for a parked task, which has no owner', async () => {
    await openTask(task({ hold: 'parked', hold_reason: 'later', id: 'MMR-51', status: 'parked' }));

    const article = screen.getByRole('article');
    expect(within(article).getByText('parked')).toBeDefined();
    expect(within(article).queryByText(/Blocked on/)).toBeNull();
  });
});
