import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  annotate,
  getNode,
  groom,
  move,
  scratchList,
  start,
  tag,
  untag,
  update,
} from '../api/fns/nodes';
import { routeTree } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject, engineTree } from './engine-fixtures';
import { engineContainer, engineNote, engineTag, engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

/*
 * The node records run on server functions (MMR-539): a task's page, a
 * container's and a project's work page, and every node write reach the
 * Engine through them; the pages render inside the real router.
 */

const SQLITE = engineTask({
  grooming: 'not_groomed',
  id: 'MMR-417',
  parent: 'MMR-2',
  status: 'ready',
  tags: [engineTag('ui')],
  title: 'Add the SQLite dialect',
});

beforeEach(() => {
  stubViewport('desktop');
  localStorage.clear();
  serveShell({
    projects: [engineProject({ id: 'MMR', title: 'Mimir' })],
    trees: {
      MMR: engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
        engineTree({ id: 'MMR-1', status: 'ready', title: 'Backends', type: 'initiative' }, [
          engineTree({ id: 'MMR-2', parent: 'MMR-1', status: 'ready', type: 'phase' }, [
            engineTree({ id: 'MMR-417', parent: 'MMR-2', status: 'ready', type: 'task' }),
          ]),
        ]),
      ]),
    },
  });
  serveViews();
  serveBrowse();
  serveNodes({
    nodes: [
      engineProject({ id: 'MMR', title: 'Mimir' }),
      engineContainer({ id: 'MMR-2', parent: 'MMR-1', status: 'ready', type: 'phase' }),
      SQLITE,
    ],
    notes: { 'MMR-417': [engineNote('Settled the dialect seam')] },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderAt(url: string) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [url] }),
    routeTree,
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('the node records on server functions (MMR-539)', () => {
  it('reads a task’s record, notes, and board Scratchpads', async () => {
    renderAt('/p/MMR/417');

    await expect(
      screen.findByRole('heading', { level: 1, name: 'Add the SQLite dialect' }),
    ).resolves.toBeInTheDocument();
    await expect(screen.findByText('Settled the dialect seam')).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(scratchList).toHaveBeenCalledWith({ data: { project: 'MMR' } });
    });
    expect(getNode).toHaveBeenCalledWith({
      data: expect.objectContaining({ facets: expect.arrayContaining(['deps']), id: 'MMR-417' }),
    });
    expect(getNode).toHaveBeenCalledWith({ data: { facets: ['annotations'], id: 'MMR-417' } });
  });

  it('reads a project’s and a container’s record', async () => {
    renderAt('/p/MMR');
    await expect(
      screen.findByRole('heading', { level: 1, name: 'Mimir' }),
    ).resolves.toBeInTheDocument();
    expect(getNode).toHaveBeenCalledWith({
      data: expect.objectContaining({ facets: expect.arrayContaining(['children']), id: 'MMR' }),
    });
  });

  it('writes a task’s verbs, edits, move, grooming, and notes', async () => {
    const user = userEvent.setup();
    renderAt('/p/MMR/417');
    const rail = await screen.findByRole('complementary', { name: 'Record details' });

    // A lifecycle verb.
    await user.click(within(rail).getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(start).toHaveBeenCalledWith({ data: { id: 'MMR-417' } });
    });

    // A note.
    await user.type(screen.getByRole('textbox', { name: /note/i }), 'next steps');
    await user.click(screen.getByRole('button', { name: 'Append note' }));
    await waitFor(() => {
      expect(annotate).toHaveBeenCalledWith({ data: { content: 'next steps', id: 'MMR-417' } });
    });

    // Grooming.
    await user.click(within(rail).getByRole('button', { name: 'Set grooming…' }));
    const grooming = await screen.findByRole('dialog', { name: 'Grooming state' });
    await user.click(within(grooming).getByRole('radio', { name: /^groomed/ }));
    await user.click(within(grooming).getByRole('button', { name: 'Set grooming' }));
    await waitFor(() => {
      expect(groom).toHaveBeenCalledWith({ data: { ids: ['MMR-417'], state: 'groomed' } });
    });

    // Move.
    await user.click(within(rail).getByRole('button', { name: 'Move…' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'New parent' }), 'MMR-1');
    await user.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => {
      expect(move).toHaveBeenCalledWith({ data: { id: 'MMR-417', to: 'MMR-1' } });
    });

    // Edit: the fields, one tag added, one removed.
    await user.click(within(rail).getByRole('button', { name: 'Edit' }));
    const tags = await screen.findByLabelText(/tags/i);
    await user.clear(tags);
    await user.type(tags, 'feat');
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        data: expect.objectContaining({ id: 'MMR-417', title: 'Add the SQLite dialect' }),
      });
    });
    expect(tag).toHaveBeenCalledWith({ data: { ids: ['MMR-417'], tags: ['feat'] } });
    expect(untag).toHaveBeenCalledWith({ data: { ids: ['MMR-417'], tags: ['ui'] } });
  });
});
