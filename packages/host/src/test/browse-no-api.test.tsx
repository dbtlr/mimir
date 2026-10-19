import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  artifacts,
  consoleUpstreamTasks,
  doctor,
  getArtifact,
  getSeed,
  list,
  seedCreate,
  seedPark,
  seedPromote,
  seedReject,
  seedUpdate,
  seeds,
} from '../api/fns/browse';
import { routeTree } from '../router';
import {
  engineArtifact,
  engineArtifactRecord,
  engineTask,
  recordHealth,
  seedIn,
} from './browse-fixtures';
import { serveBrowse } from './browse-fns';
import { engineProject, engineTree } from './engine-fixtures';
import { reviewReport, task } from './fixtures';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';

vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('sonner', () => ({ Toaster: () => null, toast: { error: vi.fn(), success: vi.fn() } }));

/*
 * The browsers, the seed and artifact pages, the seed writes, and record
 * health run on server functions (MMR-540): none of them asks /api. The real
 * fetch is stubbed, so any /api request a page makes is recorded rather than
 * mocked away; the pages render inside the real shell and router.
 *
 * Three /api reads remain around these pages, each owned by another area: the
 * shell's review report behind the attention alert, which moves with the
 * review page (MMR-538); the project record the browsers' project gate reads;
 * and the single node read (`nodeQuery`) behind a promoted seed's spawned tasks
 * and an artifact's lone attached record. The last two move with the node
 * records (MMR-539). When they move, these allowances go and the test holds
 * these pages to no /api request at all.
 */
const ALLOWED_API: ReadonlySet<string> = new Set(['/api/review', '/api/projects/MMR']);

/** One node's record read, `nodeQuery`'s path: owned by MMR-539. */
const NODE_READ = /^\/api\/nodes\/MMR-\d+$/;

let requested: string[];

/** The /api paths requested so far that no other area still owns. */
const strayApi = () =>
  requested.filter(
    (path) => path.startsWith('/api') && !ALLOWED_API.has(path) && !NODE_READ.test(path),
  );

/** The node records read through /api so far, by path. */
const nodeReads = () => requested.filter((path) => NODE_READ.test(path));

const idea = seedIn('untriaged', { id: 'MMR-s1', title: 'Name the project' });

beforeEach(() => {
  stubViewport('desktop');
  localStorage.clear();
  requested = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      requested.push(url.pathname);
      if (url.pathname === '/health') {
        return Response.json({ schema: 1, status: 'ok', version: 'host-build' });
      }
      if (url.pathname === '/api/review') {
        return Response.json(reviewReport());
      }
      if (NODE_READ.test(url.pathname)) {
        const id = url.pathname.slice('/api/nodes/'.length);
        return Response.json(task({ id, status: 'ready', title: `Task ${id}` }));
      }
      return Response.json({ error: { message: 'not served' } }, { status: 503 });
    }),
  );
  serveShell({
    projects: [engineProject({ id: 'MMR', title: 'Mimir' })],
    trees: {
      MMR: engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
        engineTree({ id: 'MMR-1', parent: 'MMR', status: 'in_progress', type: 'initiative' }, [
          engineTree({ id: 'MMR-2', parent: 'MMR-1', status: 'ready', type: 'task' }),
          engineTree({ id: 'MMR-3', parent: 'MMR-1', status: 'ready', type: 'task' }),
        ]),
      ]),
    },
  });
  serveBrowse({
    artifacts: [engineArtifact({ id: 'MMR-a1', title: 'The spec' })],
    health: recordHealth({ scope: { key: 'MMR', matched_records: 4 } }),
    // Attached to two records, so the page reads no single host record.
    records: { 'MMR-a1': engineArtifactRecord({ id: 'MMR-a1', links: ['MMR-2', 'MMR-3'] }) },
    seeds: [idea],
    tasks: [engineTask({ id: 'MMR-2', status: 'ready', title: 'Wire the browser' })],
    upstream: { 'MMR-s1': [engineTask({ id: 'MMR-9', status: 'blocked', title: 'Waits on it' })] },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderAt(path: string) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
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

describe('the browsers, seeds, artifacts, and doctor on server functions (MMR-540)', () => {
  it.each([
    ['/p/MMR/tasks', 'Wire the browser', list],
    ['/p/MMR/seeds', 'Name the project', seeds],
    ['/p/MMR/artifacts', 'The spec', artifacts],
  ])('%s reads its list without asking /api', async (path, row, read) => {
    renderAt(path);
    await expect(screen.findByRole('link', { name: row })).resolves.toBeInTheDocument();
    expect(read).toHaveBeenCalled();
    expect(strayApi()).toStrictEqual([]);
  });

  it('the artifact page reads the artifact and its attached records without asking /api', async () => {
    renderAt('/p/MMR/a1');
    const card = await screen.findByRole('group', { name: 'Attached to · 2' });
    await waitFor(() => {
      expect(card).toHaveTextContent('task MMR-2');
    });
    expect(getArtifact).toHaveBeenCalledWith({ data: { content: true, id: 'MMR-a1' } });
    expect(strayApi()).toStrictEqual([]);
  });

  it('the seed page reads the seed and the work waiting on it without asking /api', async () => {
    renderAt('/p/MMR/s1');
    const outcome = await screen.findByRole('region', { name: 'What came of it' });
    await within(outcome).findByRole('link', { name: /Waits on it/ });
    expect(getSeed).toHaveBeenCalledWith({ data: { content: true, id: 'MMR-s1' } });
    expect(consoleUpstreamTasks).toHaveBeenCalledWith({ data: { seed: 'MMR-s1' } });
    expect(strayApi()).toStrictEqual([]);
  });

  it("an artifact on one record reads that record only through MMR-539's node read", async () => {
    vi.mocked(getArtifact).mockResolvedValue(
      engineArtifactRecord({ id: 'MMR-a1', links: ['MMR-2'] }),
    );
    renderAt('/p/MMR/a1');
    await screen.findByRole('group', { name: 'Attached to' });
    await waitFor(() => {
      expect(nodeReads()).toStrictEqual(['/api/nodes/MMR-2']);
    });
    expect(strayApi()).toStrictEqual([]);
  });

  it("a promoted seed reads its spawned task only through MMR-539's node read", async () => {
    vi.mocked(getSeed).mockResolvedValue(
      seedIn('promoted', { id: 'MMR-s1', spawned: ['MMR-3'], title: 'Name the project' }),
    );
    renderAt('/p/MMR/s1');
    const outcome = await screen.findByRole('region', { name: 'What came of it' });
    await within(outcome).findByRole('link', { name: /Task MMR-3/ });
    expect(nodeReads()).toStrictEqual(['/api/nodes/MMR-3']);
    expect(strayApi()).toStrictEqual([]);
  });

  it('the doctor page reads record health without asking /api', async () => {
    renderAt('/doctor?project=MMR');
    await expect(screen.findByText('No findings')).resolves.toBeInTheDocument();
    expect(doctor).toHaveBeenCalledWith({ data: { project: 'MMR' } });
    expect(strayApi()).toStrictEqual([]);
  });

  it('files, edits, parks, rejects, and promotes a seed without asking /api', async () => {
    const user = userEvent.setup();
    renderAt('/p/MMR/seeds');
    await user.click(await screen.findByRole('button', { name: '+ File a seed' }));
    await user.type(await screen.findByLabelText('Seed'), 'A new idea');
    await user.click(screen.getByRole('button', { name: 'File ↵' }));
    await waitFor(() => {
      expect(seedCreate).toHaveBeenCalledOnce();
    });

    await user.click(screen.getByRole('link', { name: 'Name the project' }));
    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    await user.click(within(rail).getByRole('button', { name: 'Edit' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'bug');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(seedUpdate).toHaveBeenCalledOnce();
    });

    const decision = await screen.findByRole('region', { name: 'Your call' });
    await user.click(within(decision).getByRole('button', { name: 'Park…' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Park seed' })).getByRole('button', {
        name: 'Park',
      }),
    );
    await waitFor(() => {
      expect(seedPark).toHaveBeenCalledOnce();
    });

    await user.click(within(decision).getByRole('button', { name: 'Reject…' }));
    const reject = await screen.findByRole('dialog', { name: 'Reject seed' });
    await user.type(within(reject).getByRole('textbox'), 'Out of scope');
    await user.click(within(reject).getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(seedReject).toHaveBeenCalledOnce();
    });

    await user.click(within(decision).getByRole('button', { name: 'Promote to task…' }));
    const promote = await screen.findByRole('button', { name: 'Promote ↵' });
    await waitFor(() => {
      expect(promote).toBeEnabled();
    });
    await user.click(promote);
    await waitFor(() => {
      expect(seedPromote).toHaveBeenCalledOnce();
    });

    expect(strayApi()).toStrictEqual([]);
  });
});
