import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/errors';
import type { WireNode, WireSeed } from '../api/types';
import { router } from '../router';
import { seed, task } from './fixtures';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
vi.mock('sonner', () => ({ Toaster: () => null, toast: { error: vi.fn(), success: vi.fn() } }));

const PROJECTS = {
  items: [
    { id: 'MMR', title: 'Mimir', type: 'project' },
    { id: 'NRN', title: 'Norn', type: 'project' },
  ],
  total: 2,
};

const crossBoardBug = seed({
  description: 'Reproduced with **norn 0.48.2** over the MCP stdio transport.',
  id: 'NRN-s30',
  kind: 'bug',
  lane: 'untriaged',
  project: 'NRN',
  requester: 'MMR',
  title: 'norn mcp closes the connection silently',
});

// An abandoned task carries no completed_at; it settled when it last changed.
const abandoned = task({
  id: 'MMR-364',
  status: 'abandoned',
  title: 'Shape the session skill router',
  updated_at: '2026-10-10T12:00:00.000Z',
});

const readyToResolve = seed({
  id: 'MMR-s23',
  lane: 'ready',
  lifecycle: 'promoted',
  ready_to_resolve: true,
  spawned: ['MMR-364'],
  title: 'Shape Mimir as the session skill router',
});

const upstreamPath = (id: string) =>
  `/api/nodes?type=task&status=all&eq=${encodeURIComponent(`upstream:${id}`)}`;

/** Serve one seed at its detail path, the project list, the given nodes, and empty lists elsewhere. */
function serve(
  record: WireSeed,
  { nodes = [], upstream = [] }: { nodes?: WireNode[]; upstream?: WireNode[] } = {},
) {
  apiGet.mockImplementation((path: string) => {
    if (path === `/api/seeds/${record.id}`) {
      return Promise.resolve(record);
    }
    if (path === '/api/projects') {
      return Promise.resolve(PROJECTS);
    }
    if (path === upstreamPath(record.id)) {
      return Promise.resolve({ items: upstream, total: upstream.length });
    }
    const node = nodes.find((n) => path === `/api/nodes/${n.id}`);
    if (node !== undefined) {
      return Promise.resolve(node);
    }
    return Promise.resolve({ items: [], total: 0 });
  });
}

function renderAt(url: string) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [url] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return testRouter;
}

beforeEach(() => {
  apiGet.mockReset();
  apiSend.mockReset();
});

describe('seed page (MMR-451)', () => {
  it('opens a seed at /p/KEY/sN with its id, kind, lane, title, and body', async () => {
    serve(crossBoardBug);
    renderAt('/p/NRN/s30');

    await expect(
      screen.findByRole('heading', { level: 1, name: crossBoardBug.title }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText('NRN-s30 · seed')).toBeInTheDocument();
    expect(screen.getByText('Untriaged')).toBeInTheDocument();
    expect(screen.getByText('norn 0.48.2').tagName).toBe('STRONG');
    expect(apiGet).not.toHaveBeenCalledWith('/api/nodes/NRN-s30');
  });

  it('reads as a request: the requesting board asks the owning board', async () => {
    serve(crossBoardBug);
    renderAt('/p/NRN/s30');

    const card = await screen.findByRole('group', { name: 'Request' });
    await waitFor(() => expect(card).toHaveTextContent(/Mimir\s*MMR\s*asks\s*Norn\s*NRN/));
  });

  it('a seed filed on its own board is your request', async () => {
    serve(seed({ id: 'MMR-s7', lane: 'untriaged', requester: null, title: 'Own idea' }));
    renderAt('/p/MMR/s7');

    const card = await screen.findByRole('group', { name: 'Request' });
    await waitFor(() => expect(card).toHaveTextContent(/You\s*ask\s*Mimir\s*MMR/));
  });

  it('moves a lowercase key to its canonical spelling', async () => {
    serve(crossBoardBug);
    const testRouter = renderAt('/p/nrn/s30');

    await screen.findByRole('heading', { level: 1, name: crossBoardBug.title });
    expect(testRouter.state.location.pathname).toBe('/p/NRN/s30');
  });

  it('moves an uppercase S to the canonical seed path', async () => {
    serve(crossBoardBug);
    const upper = renderAt('/p/NRN/S30');
    await screen.findByRole('heading', { level: 1, name: crossBoardBug.title });
    expect(upper.state.location.pathname).toBe('/p/NRN/s30');
  });

  it('moves a zero-padded seed number to its canonical path', async () => {
    serve(crossBoardBug);
    const padded = renderAt('/p/NRN/s030');
    await screen.findByRole('heading', { level: 1, name: crossBoardBug.title });
    expect(padded.state.location.pathname).toBe('/p/NRN/s30');
  });

  it('strips the padding as text, keeping every digit of a long seed number', async () => {
    serve(crossBoardBug);
    const long = renderAt('/p/NRN/s0123456789012345678901');
    await waitFor(() => expect(long.state.location.pathname).toBe('/p/NRN/s123456789012345678901'));
  });

  it('redirects a bare seed id to its page', async () => {
    serve(crossBoardBug);
    const testRouter = renderAt('/nrn-s30');

    await screen.findByRole('heading', { level: 1, name: crossBoardBug.title });
    expect(testRouter.state.location.pathname).toBe('/p/NRN/s30');
  });

  it('owns the not-found state when no seed has the id', async () => {
    apiGet.mockImplementation((path: string) =>
      path === '/api/seeds/NRN-s99'
        ? Promise.reject(new ApiError(`GET ${path} → 404`, 404))
        : Promise.resolve({ items: [], total: 0 }),
    );
    renderAt('/p/NRN/s99');

    await expect(screen.findByText('No record NRN-s99.')).resolves.toBeInTheDocument();
  });

  describe('what came of it', () => {
    it('says so when nothing was promoted and nothing waits on the seed', async () => {
      serve(crossBoardBug);
      renderAt('/p/NRN/s30');

      await expect(
        screen.findByText(
          'Nothing yet. No task has been promoted from this seed, and none waits on it.',
        ),
      ).resolves.toBeInTheDocument();
    });

    it('does not claim nothing waits on the seed when the upstream read fails', async () => {
      apiGet.mockImplementation((path: string) => {
        if (path === `/api/seeds/${crossBoardBug.id}`) {
          return Promise.resolve(crossBoardBug);
        }
        if (path === upstreamPath(crossBoardBug.id)) {
          return Promise.reject(new ApiError(`GET ${path} → 500`, 500));
        }
        return Promise.resolve({ items: [], total: 0 });
      });
      renderAt('/p/NRN/s30');

      await expect(
        screen.findByText('Couldn’t check which tasks wait on this seed.'),
      ).resolves.toBeInTheDocument();
      expect(screen.queryByText(/none waits on it/)).not.toBeInTheDocument();
    });

    it('links each spawned task to its page with its state', async () => {
      serve(readyToResolve, { nodes: [abandoned] });
      renderAt('/p/MMR/s23');

      const outcome = await screen.findByRole('region', { name: 'What came of it' });
      const link = await within(outcome).findByRole('link', { name: /Shape the session skill/ });
      expect(link).toHaveAttribute('href', '/p/MMR/364');
      expect(outcome).toHaveTextContent('abandoned 2026-10-10');
    });

    it('lists tasks on any board that name the seed as upstream', async () => {
      const waiting = task({ id: 'MMR-378', status: 'blocked', title: 'Chunk the export' });
      serve(crossBoardBug, { upstream: [waiting] });
      renderAt('/p/NRN/s30');

      const outcome = await screen.findByRole('region', { name: 'What came of it' });
      const link = await within(outcome).findByRole('link', { name: /Chunk the export/ });
      expect(link).toHaveAttribute('href', '/p/MMR/378');
      expect(outcome).toHaveTextContent('waits on it');
    });

    it('does not say a settled upstream task still waits on the seed', async () => {
      const finished = task({ id: 'MMR-379', status: 'done', title: 'Worked around it' });
      serve(crossBoardBug, { upstream: [finished] });
      renderAt('/p/NRN/s30');

      const outcome = await screen.findByRole('region', { name: 'What came of it' });
      await within(outcome).findByRole('link', { name: /Worked around it/ });
      expect(outcome).not.toHaveTextContent('waits on it');
      expect(outcome).toHaveTextContent('named it upstream');
    });
  });

  describe('your call', () => {
    it('offers triage on an untriaged seed, naming the owning board', async () => {
      serve(crossBoardBug);
      renderAt('/p/NRN/s30');

      const decision = await screen.findByRole('region', { name: 'Your call' });
      await waitFor(() => expect(decision).toHaveTextContent('work on the Norn board'));
      const labels = within(decision)
        .getAllByRole('button')
        .map((b) => b.textContent);
      expect(labels).toStrictEqual(['Promote to task…', 'Reject…', 'Later']);
    });

    it('Later returns to the seed project’s queue', async () => {
      serve(crossBoardBug);
      const testRouter = renderAt('/p/NRN/s30');

      const decision = await screen.findByRole('region', { name: 'Your call' });
      await userEvent.click(within(decision).getByRole('button', { name: 'Later' }));
      await waitFor(() => expect(testRouter.state.location.pathname).toBe('/seeds'));
      expect(testRouter.state.location.search).toEqual({ project: 'NRN' });
    });

    it('offers resolve on a seed whose only task settled, and says how it ended', async () => {
      serve(readyToResolve, { nodes: [abandoned] });
      renderAt('/p/MMR/s23');

      const decision = await screen.findByRole('region', { name: 'Your call' });
      await waitFor(() =>
        expect(decision).toHaveTextContent(
          'Its only task was abandoned. Resolve the seed, or promote it again.',
        ),
      );
      const labels = within(decision)
        .getAllByRole('button')
        .map((b) => b.textContent);
      expect(labels).toStrictEqual(['Resolve…', 'Promote again…', 'Reject…']);
    });

    it('offers another promotion while the seed’s work is under way', async () => {
      serve(seed({ id: 'MMR-s8', lane: 'promoted', lifecycle: 'promoted', spawned: [] }));
      renderAt('/p/MMR/s8');

      const decision = await screen.findByRole('region', { name: 'Your call' });
      const labels = within(decision)
        .getAllByRole('button')
        .map((b) => b.textContent);
      expect(labels).toStrictEqual(['Promote again…', 'Reject…']);
    });

    it('asks nothing of a settled seed', async () => {
      serve(seed({ id: 'MMR-s9', lane: 'settled', lifecycle: 'resolved', title: 'Done seed' }));
      renderAt('/p/MMR/s9');

      await screen.findByRole('heading', { level: 1, name: 'Done seed' });
      expect(screen.getByText('Resolved')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Your call' })).not.toBeInTheDocument();
    });
  });

  describe('actions', () => {
    it('edits the title, kind, and description of a live seed', async () => {
      serve(crossBoardBug);
      apiSend.mockResolvedValue(crossBoardBug);
      renderAt('/p/NRN/s30');

      const rail = await screen.findByRole('complementary', { name: 'Record details' });
      await userEvent.click(within(rail).getByRole('button', { name: 'Edit' }));
      const title = screen.getByRole('textbox', { name: 'Title' });
      await userEvent.clear(title);
      await userEvent.type(title, 'norn mcp drops large responses');
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'feature');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/seeds/NRN-s30', {
          kind: 'feature',
          title: 'norn mcp drops large responses',
        }),
      );
      await waitFor(() =>
        expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument(),
      );
    });

    it('sends only what changed, so an over-cap older title never blocks an edit', async () => {
      const longTitle = 'x'.repeat(150);
      serve({ ...crossBoardBug, title: longTitle });
      apiSend.mockResolvedValue(crossBoardBug);
      renderAt('/p/NRN/s30');

      const rail = await screen.findByRole('complementary', { name: 'Record details' });
      await userEvent.click(within(rail).getByRole('button', { name: 'Edit' }));
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'idea');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/seeds/NRN-s30', { kind: 'idea' }),
      );
    });

    it('closes an edit that changed nothing without a write', async () => {
      serve(crossBoardBug);
      renderAt('/p/NRN/s30');

      const rail = await screen.findByRole('complementary', { name: 'Record details' });
      await userEvent.click(within(rail).getByRole('button', { name: 'Edit' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument(),
      );
      expect(apiSend).not.toHaveBeenCalled();
    });

    it('offers no edit once the seed is settled', async () => {
      serve(seed({ id: 'MMR-s9', lane: 'settled', lifecycle: 'rejected', title: 'Gone' }));
      renderAt('/p/MMR/s9');

      const rail = await screen.findByRole('complementary', { name: 'Record details' });
      await within(rail).findByText('Copy link');
      expect(within(rail).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    });

    it('copies the page link', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      serve(crossBoardBug);
      renderAt('/p/NRN/s30');

      const rail = await screen.findByRole('complementary', { name: 'Record details' });
      await userEvent.click(within(rail).getByRole('button', { name: 'Copy link' }));
      expect(writeText).toHaveBeenCalledWith(`${globalThis.location.origin}/p/NRN/s30`);
    });
  });
});
