import type { EngineTree } from '@mimir/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArtifactRecord } from '../api/browse-queries';
import { getArtifact } from '../api/fns/browse';
import { tree } from '../api/fns/shell';
import type { WireNode } from '../api/types';
import { routeTree } from '../router';
import { engineArtifactRecord } from './browse-fixtures';
import { serveBrowse } from './browse-fns';
import { engineProject, engineTree } from './engine-fixtures';
import { emptyRead, task } from './fixtures';
import { serveShell } from './shell-fns';
import { serveViews } from './views-fns';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');
vi.mock('sonner', () => ({ Toaster: () => null, toast: { error: vi.fn(), success: vi.fn() } }));

const PROJECTS = [engineProject({ id: 'MMR', title: 'Mimir' })];

function tn(
  id: string,
  type: EngineTree['type'],
  title: string,
  children: EngineTree[] = [],
  status: EngineTree['status'] = 'ready',
): EngineTree {
  return engineTree({ id, status, title, type }, children);
}

const TREE = tn('MMR', 'project', 'Mimir', [
  tn('MMR-2', 'initiative', 'Maintenance & releases', [
    tn('MMR-432', 'task', 'serve answers any Host'),
  ]),
  tn('MMR-437', 'phase', 'Console phase 1', [
    tn('MMR-448', 'task', 'Mock the palette', [], 'done'),
    tn('MMR-451', 'task', 'Seed pages', [], 'under_review'),
    tn('MMR-452', 'task', 'Artifact pages', [], 'in_progress'),
  ]),
]);

const hostTask = task({
  artifacts: [
    { created_at: '2026-10-06T16:07:41.112Z', id: 'MMR-a232', tags: ['spec'], title: 'Shaping' },
    {
      created_at: '2026-10-06T20:00:00.000Z',
      id: 'MMR-a233',
      tags: ['session_summary'],
      title: 'Session summary: optional serve',
    },
  ],
  completed_at: '2026-10-06T21:00:00.000Z',
  id: 'MMR-432',
  status: 'done',
  title: 'serve answers any Host',
});

const spec = engineArtifactRecord({
  content: '## The decision\n\nServe becomes **run it and reach it** by default.',
  createdAt: new Date('2026-10-06T16:07:41.112Z'),
  id: 'MMR-a232',
  links: ['MMR-432'],
  summary: 'v0.22.1 design-of-record for the network modes.',
  tags: ['spec', 'kind:shaping'],
  title: 'Shaping: optional serve hardening and network modes',
});

const picks = engineArtifactRecord({
  content: 'Chosen variants.',
  createdAt: new Date('2026-10-10T22:16:00.000Z'),
  id: 'MMR-a239',
  links: ['MMR-448', 'MMR-451', 'MMR-452'],
  tags: ['session_summary'],
  title: 'Session summary: phase 1 mocks chosen',
});

const loose = engineArtifactRecord({
  content: 'A note with no record.',
  createdAt: new Date('2026-10-01T09:00:00.000Z'),
  id: 'MMR-a9',
  tags: ['note'],
  title: 'Loose note',
});

/**
 * Serve one artifact and the given nodes at their detail paths; empty lists
 * elsewhere (beforeEach serves the project list and tree).
 */
function serve(record: ArtifactRecord, nodes: WireNode[] = []) {
  serveBrowse({ records: { [record.id]: record } });
  apiGet.mockImplementation((path: string) => {
    const node = nodes.find((n) => path === `/api/nodes/${n.id}`);
    if (node !== undefined) {
      return Promise.resolve(node);
    }
    return Promise.resolve(emptyRead(path));
  });
}

function renderAt(url: string) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [url] }),
    routeTree,
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

const path = () => screen.findByRole('navigation', { name: 'Path' });
const rail = () => screen.findByRole('complementary', { name: 'Record details' });

beforeEach(() => {
  serveViews();
  apiGet.mockReset();
  apiSend.mockReset();
  serveShell({ projects: PROJECTS, trees: { MMR: TREE } });
});

describe('artifact page (MMR-452)', () => {
  it('opens an artifact at /p/KEY/aN with its id, kind, title, lede, and frozen body', async () => {
    serve(spec, [hostTask]);
    renderAt('/p/MMR/a232');

    await expect(
      screen.findByRole('heading', { level: 1, name: spec.title }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText('MMR-a232 · artifact')).toBeInTheDocument();
    expect(screen.getByText('shaping')).toBeInTheDocument();
    expect(screen.getByText('Frozen 2026-10-06')).toBeInTheDocument();
    expect(screen.getByText(spec.summary ?? '')).toBeInTheDocument();
    expect(screen.getByText('run it and reach it').tagName).toBe('STRONG');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  describe('attached to one record', () => {
    it('runs the path through that record', async () => {
      serve(spec, [hostTask]);
      renderAt('/p/MMR/a232');

      const nav = await path();
      await waitFor(() =>
        expect(
          within(nav)
            .getAllByRole('link')
            .map((a) => a.getAttribute('href')),
        ).toStrictEqual(['/p/MMR', '/p/MMR/2', '/p/MMR/432']),
      );
      expect(nav).toHaveTextContent(/Mimir\s*›\s*Maintenance & releases\s*›\s*MMR-432/);
    });

    it('shows the record in a card above the body, linked to its page with how it stands', async () => {
      serve(spec, [hostTask]);
      renderAt('/p/MMR/a232');

      const card = await screen.findByRole('group', { name: 'Attached to' });
      const link = within(card).getByRole('link', { name: /MMR-432/ });
      expect(link).toHaveAttribute('href', '/p/MMR/432');
      expect(link).toHaveTextContent('serve answers any Host');
      await waitFor(() => expect(card).toHaveTextContent('done 2026-10-06'));
    });

    it("lists the record's artifacts in the rail, this one marked as current", async () => {
      serve(spec, [hostTask]);
      renderAt('/p/MMR/a232');

      const aside = await rail();
      await within(aside).findByText("MMR-432's artifacts · 2");
      const sibling = within(aside).getByRole('link', { name: /Session summary: optional serve/ });
      expect(sibling).toHaveAttribute('href', '/p/MMR/a233');
      expect(within(aside).getByRole('link', { name: /Shaping/ })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });

    it('runs the path through the record even when the tree cannot be read', async () => {
      serve(spec, [hostTask]);
      vi.mocked(tree).mockRejectedValue(new Error('tree unreachable'));
      renderAt('/p/MMR/a232');

      const nav = await path();
      await waitFor(() =>
        expect(
          within(nav)
            .getAllByRole('link')
            .map((a) => a.getAttribute('href')),
        ).toStrictEqual(['/p/MMR', '/p/MMR/432']),
      );
    });

    it('gives a container its status alone, since only a task stamps when it settled', async () => {
      const phase = task({
        id: 'MMR-437',
        status: 'done',
        title: 'Console phase 1, as loaded',
        type: 'phase',
        updated_at: '2026-06-01T10:00:00.000Z',
      });
      serve({ ...spec, links: ['MMR-437'] }, [phase]);
      renderAt('/p/MMR/a232');

      const card = await screen.findByRole('group', { name: 'Attached to' });
      await within(card).findByText('Console phase 1, as loaded');
      expect(card).toHaveTextContent(/as loaded\s*done$/);
    });
  });

  describe('attached to several records', () => {
    it('runs the path to the nearest container holding them all', async () => {
      serve(picks);
      renderAt('/p/MMR/a239');

      const nav = await path();
      await waitFor(() =>
        expect(
          within(nav)
            .getAllByRole('link')
            .map((a) => a.getAttribute('href')),
        ).toStrictEqual(['/p/MMR', '/p/MMR/437']),
      );
      expect(nav).toHaveTextContent(/Mimir\s*›\s*Console phase 1/);
    });

    it('lists every record it is attached to, each linked with its state', async () => {
      serve(picks);
      renderAt('/p/MMR/a239');

      const card = await screen.findByRole('group', { name: 'Attached to · 3' });
      const links = within(card).getAllByRole('link');
      expect(links.map((a) => a.getAttribute('href'))).toStrictEqual([
        '/p/MMR/448',
        '/p/MMR/451',
        '/p/MMR/452',
      ]);
      expect(links[1]).toHaveTextContent(/Seed pages.*under review/i);
    });

    it('orders the records by their number, not as text', async () => {
      serveShell({
        projects: PROJECTS,
        trees: {
          MMR: tn('MMR', 'project', 'Mimir', [
            tn('MMR-9', 'task', 'Nine'),
            tn('MMR-10', 'task', 'Ten'),
          ]),
        },
      });
      serve({ ...picks, links: ['MMR-10', 'MMR-9'] });
      renderAt('/p/MMR/a239');

      const card = await screen.findByRole('group', { name: 'Attached to · 2' });
      expect(
        within(card)
          .getAllByRole('link')
          .map((a) => a.textContent),
      ).toStrictEqual([expect.stringContaining('Nine'), expect.stringContaining('Ten')]);
    });

    it('folds past five records, and unfolds and refolds on request', async () => {
      const many = Array.from({ length: 7 }, (_, i) => `MMR-${String(i + 1)}`);
      serve({ ...picks, links: many });
      renderAt('/p/MMR/a239');

      const card = await screen.findByRole('group', { name: 'Attached to · 7' });
      expect(within(card).getAllByRole('link')).toHaveLength(5);
      await userEvent.click(within(card).getByRole('button', { name: 'Show all 7' }));
      expect(within(card).getAllByRole('link')).toHaveLength(7);
      await userEvent.click(within(card).getByRole('button', { name: 'Show fewer' }));
      expect(within(card).getAllByRole('link')).toHaveLength(5);
    });

    it("lists no single record's artifacts", async () => {
      serve(picks);
      renderAt('/p/MMR/a239');

      const aside = await rail();
      await within(aside).findByText('Copy link');
      expect(within(aside).queryByText(/'s artifacts/)).not.toBeInTheDocument();
    });
  });

  describe('attached to no record', () => {
    it('falls back to provenance: the path is the project, and the rail links it', async () => {
      serve(loose);
      renderAt('/p/MMR/a9');

      const nav = await path();
      await waitFor(() =>
        expect(
          within(nav)
            .getAllByRole('link')
            .map((a) => a.getAttribute('href')),
        ).toStrictEqual(['/p/MMR']),
      );
      expect(screen.queryByRole('group', { name: /Attached to/ })).not.toBeInTheDocument();
      const aside = await rail();
      expect(within(aside).getByRole('link', { name: /MMR\s*Mimir/ })).toHaveAttribute(
        'href',
        '/p/MMR',
      );
      expect(within(aside).getByText('note')).toBeInTheDocument();
    });
  });

  describe('actions', () => {
    it('copies the page link', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      serve(spec, [hostTask]);
      renderAt('/p/MMR/a232');

      const aside = await rail();
      await userEvent.click(within(aside).getByRole('button', { name: 'Copy link' }));
      expect(writeText).toHaveBeenCalledWith(`${globalThis.location.origin}/p/MMR/a232`);
    });

    it('downloads the frozen body as markdown named for the artifact', async () => {
      serve(spec, [hostTask]);
      renderAt('/p/MMR/a232');

      const aside = await rail();
      const download = await within(aside).findByRole('link', { name: 'Download .md' });
      expect(download).toHaveAttribute('download', 'MMR-a232.md');
      expect(download.getAttribute('href')).toMatch(/^data:text\/markdown/);
      expect(decodeURIComponent(download.getAttribute('href') ?? '')).toContain(
        'Serve becomes **run it and reach it** by default.',
      );
    });
  });

  describe('addressing', () => {
    it('redirects a bare artifact id to its page', async () => {
      serve(spec, [hostTask]);
      const testRouter = renderAt('/mmr-a232');

      await screen.findByRole('heading', { level: 1, name: spec.title });
      expect(testRouter.state.location.pathname).toBe('/p/MMR/a232');
    });

    it('moves any other spelling to the canonical path', async () => {
      serve(spec, [hostTask]);
      const testRouter = renderAt('/p/mmr/A0232');

      await screen.findByRole('heading', { level: 1, name: spec.title });
      expect(testRouter.state.location.pathname).toBe('/p/MMR/a232');
    });

    it('shows not-found for a key off the grammar rather than redirecting', async () => {
      serve(spec);
      const testRouter = renderAt('/p/MM-X/a1');

      await expect(screen.findByText('No record at /p/MM-X/a1.')).resolves.toBeInTheDocument();
      expect(testRouter.state.location.pathname).toBe('/p/MM-X/a1');
    });

    it('owns the not-found state when no artifact has the id', async () => {
      serve(spec);
      renderAt('/p/MMR/a999');

      await expect(screen.findByText('No record MMR-a999.')).resolves.toBeInTheDocument();
    });

    it('shows not-found without a lookup for a suffix off the grammar', async () => {
      serve(spec);
      renderAt('/p/MMR/a2x');

      await expect(screen.findByText('No record at /p/MMR/a2x.')).resolves.toBeInTheDocument();
      expect(getArtifact).not.toHaveBeenCalled();
    });
  });
});
