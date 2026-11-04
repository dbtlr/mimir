import type { EngineNode } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t3Catalog, t3Origin } from '../api/fns/t3';
import { NowRow } from '../components/work-sections';
import { consoleRoutes } from '../router';
import { serveBrowse } from './browse-fns';
import { engineTree } from './engine-fixtures';
import { engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { renderInRouter, renderRoute } from './router';
import { serveShell } from './shell-fns';
import { connectedCatalog, reachableSystem } from './t3-fixtures';
import { serveT3Launch, T3_ORIGIN } from './t3-fns';
import { nowRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');
vi.mock('../api/fns/t3');
vi.mock('sonner', () => ({ Toaster: () => null, toast: { error: vi.fn(), success: vi.fn() } }));

const TREE = engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
  engineTree({ id: 'MMR-1', status: 'ready', title: 'Initiative', type: 'initiative' }, [
    engineTree({ id: 'MMR-2', parent: 'MMR-1', status: 'ready', title: 'Phase', type: 'phase' }, [
      engineTree({ id: 'MMR-7', parent: 'MMR-2', status: 'ready', type: 'task' }),
    ]),
  ]),
]);

const quiet = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  serveBrowse();
  serveViews();
});

afterEach(() => {
  vi.clearAllMocks();
});

async function openTask(node: EngineNode, origin: string | null = T3_ORIGIN) {
  serveShell({ trees: { MMR: TREE } });
  serveNodes({ nodes: [node], notes: { [node.id]: [] }, scratchpads: [] });
  serveT3Launch(connectedCatalog([reachableSystem()]), undefined, origin);
  await renderRoute(consoleRoutes, '/p/MMR/7', quiet());
  return screen.findByRole('complementary', { name: 'Record details' });
}

describe('Launch in T3 on the task page', () => {
  it('sits beside Start on a ready task when T3 is configured', async () => {
    const rail = await openTask(engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'ready' }));
    await expect(
      within(rail).findByRole('button', { name: 'Launch on Valhalla' }),
    ).resolves.toBeVisible();
    expect(within(rail).getByRole('button', { name: 'Start' })).toBeVisible();
  });

  it('is absent, and T3 is never asked for a catalog, when T3 is unconfigured', async () => {
    const rail = await openTask(
      engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'ready' }),
      null,
    );
    await within(rail).findByRole('button', { name: 'Start' });
    await waitFor(() => {
      expect(t3Origin).toHaveBeenCalled();
    });
    expect(within(rail).queryByRole('button', { name: /Launch/ })).toBeNull();
    expect(t3Catalog).not.toHaveBeenCalled();
  });

  it.each([
    ['queued', { status: 'queued' as const }],
    ['in progress', { status: 'in_progress' as const }],
    ['parked', { hold: 'parked' as const, status: 'parked' as const }],
  ])('is not offered on a %s task, and nothing is asked of T3', async (_name, extra) => {
    const rail = await openTask(engineTask({ id: 'MMR-7', parent: 'MMR-2', ...extra }));
    await within(rail).findByRole('button', { name: 'Edit' });
    expect(within(rail).queryByRole('button', { name: /Launch/ })).toBeNull();
    expect(t3Origin).not.toHaveBeenCalled();
    expect(t3Catalog).not.toHaveBeenCalled();
  });
});

describe('Open in T3', () => {
  const handles = { harness: 't3', host: 'env-1', session: 'thread-1' };

  it('links the agent panel to the thread', async () => {
    const rail = await openTask(
      engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'queued', ...handles }),
    );
    const link = await within(rail).findByRole('link', { name: /Open in T3/ });
    expect(link).toHaveAttribute('href', `${T3_ORIGIN}/env-1/thread-1`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows no link on the agent panel when the host handle is missing', async () => {
    const rail = await openTask(
      engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'queued', ...handles, host: null }),
    );
    await within(rail).findByText('thread-1');
    await waitFor(() => {
      expect(t3Origin).toHaveBeenCalled();
    });
    expect(within(rail).queryByRole('link', { name: /Open in T3/ })).toBeNull();
  });

  it('links a Now row beside its meta', async () => {
    serveT3Launch(connectedCatalog([]));
    await renderInRouter(
      <NowRow row={nowRow({ id: 'MMR-7', status: 'queued', ...handles })} />,
      quiet(),
    );
    await expect(screen.findByRole('link', { name: /Open in T3/ })).resolves.toHaveAttribute(
      'href',
      `${T3_ORIGIN}/env-1/thread-1`,
    );
  });

  it.each([
    ['another harness', { harness: 'claude' }],
    ['no host', { host: null }],
    ['no session', { session: null }],
  ])('shows no link on a Now row with %s', async (_name, change) => {
    serveT3Launch(connectedCatalog([]));
    await renderInRouter(<NowRow row={nowRow({ id: 'MMR-7', ...handles, ...change })} />, quiet());
    await waitFor(() => {
      expect(t3Origin).toHaveBeenCalled();
    });
    expect(screen.queryByRole('link', { name: /Open in T3/ })).toBeNull();
  });

  it('shows no link on a Now row while T3 is unconfigured', async () => {
    serveT3Launch(connectedCatalog([]), undefined, null);
    await renderInRouter(<NowRow row={nowRow({ id: 'MMR-7', ...handles })} />, quiet());
    await waitFor(() => {
      expect(t3Origin).toHaveBeenCalled();
    });
    expect(screen.queryByRole('link', { name: /Open in T3/ })).toBeNull();
  });
});
