import type { EngineNode } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { launchT3, t3Catalog, t3Origin } from '../api/fns/t3';
import { annotationsQuery, nodeQuery } from '../api/node-queries';
import { NowRow } from '../components/work-sections';
import { consoleRoutes } from '../router';
import { serveBrowse } from './browse-fns';
import { engineTree } from './engine-fixtures';
import { engineTask } from './node-fixtures';
import { failNotes, serveNodes } from './node-fns';
import { renderInRouter, renderRoute } from './router';
import { serveShell } from './shell-fns';
import { connectedCatalog, reachableSystem } from './t3-fixtures';
import { serveT3Launch, T3_ORIGIN } from './t3-fns';
import { stubViewport } from './viewport';
import { nowRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');
vi.mock('../api/fns/t3');
vi.mock('../components/patterns/notice', () => ({
  NoticeHost: () => null,
  toast: { error: vi.fn(), success: vi.fn() },
}));

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
  vi.unstubAllGlobals();
});

/**
 * The settings form: the Form sheet titled "Launch in T3", which names the task in its context
 * line (MMR-743).
 */
const settingsForm = () =>
  screen.findByRole('dialog', { description: /MMR-7/, name: 'Launch in T3' });

/** Choose the second project in the form's Project Select (a UI SDK Select, not a native one). */
async function chooseFork(settings: HTMLElement) {
  await userEvent.click(within(settings).getByRole('combobox', { name: 'Project' }));
  await userEvent.click(await screen.findByRole('option', { name: 'mimir-fork' }));
}

/** A system where two projects match the task's remote, so nothing launches without asking which. */
function twoProjects() {
  const system = reachableSystem();
  system.projects = [
    ...system.projects,
    { ...system.projects[0]!, id: 'proj-2', title: 'mimir-fork' },
  ];
  return system;
}

async function openTask(
  node: EngineNode,
  origin: string | null = T3_ORIGIN,
  system = reachableSystem(),
  client = quiet(),
) {
  serveShell({ trees: { MMR: TREE } });
  serveNodes({ nodes: [node], notes: { [node.id]: [] }, scratchpads: [] });
  serveT3Launch(connectedCatalog([system]), undefined, origin);
  await renderRoute(consoleRoutes, '/p/MMR/7', client);
  return screen.findByRole('heading', { level: 1 });
}

/** Open the header's More, a bottom sheet on a phone, once T3 has answered. */
async function openMore() {
  await waitFor(() => {
    expect(t3Catalog).toHaveBeenCalled();
  });
  await userEvent.click(await screen.findByRole('button', { name: 'More' }));
  return screen.findByRole('dialog', { name: 'Task MMR-7' });
}

/** Choose Start in T3… from More and return the settings form it opens. */
async function startInT3() {
  const more = await openMore();
  const row = await within(more).findByRole('button', { name: 'Start in T3…' });
  await waitFor(() => {
    expect(row).toBeEnabled();
  });
  await userEvent.click(row);
  return settingsForm();
}

const ready = () =>
  engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'ready', title: 'Task MMR-7' });

describe('Start in T3 from the task page’s More (ADR 0040, MMR-726)', () => {
  beforeEach(() => {
    stubViewport('phone');
    localStorage.clear();
  });

  it('sits in More after the status changes, the header keeping Start as the main action', async () => {
    await openTask(ready());
    const more = await openMore();
    await within(more).findByRole('button', { name: 'Start in T3…' });
    expect(
      within(more)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toStrictEqual([
      'Edit',
      'Start on Valhalla',
      'Start in T3…',
      'Park for later…',
      'Mark blocked…',
      'Abandon…',
      'Cancel',
    ]);
    expect(screen.getAllByRole('button', { name: 'Start' })).toHaveLength(1);
  });

  it('follows the status changes in their group, where an awaiting task keeps Start', async () => {
    await openTask(
      engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'awaiting', title: 'Task MMR-7' }),
    );
    const more = await openMore();
    await within(more).findByRole('button', { name: 'Start in T3…' });
    const rows = [...more.querySelectorAll('button, [data-slot="separator"]')].map((el) =>
      el.tagName === 'BUTTON' ? el.textContent : '—',
    );
    expect(rows).toStrictEqual([
      'Edit',
      '—',
      'Start',
      'Start on Valhalla',
      'Start in T3…',
      '—',
      'Park for later…',
      'Mark blocked…',
      '—',
      'Abandon…',
      'Cancel',
    ]);
  });

  it('starts on the default system in one click from the More sheet, with no form', async () => {
    await openTask(ready());
    const more = await openMore();
    const row = await within(more).findByRole('button', { name: 'Start on Valhalla' });
    await userEvent.click(row);
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledOnce();
    });
    expect(vi.mocked(launchT3).mock.calls[0]?.[0].data).toMatchObject({
      environmentId: 'env-1',
      projectId: 'proj-1',
      task: 'MMR-7',
    });
    expect(screen.queryByRole('dialog', { name: 'Launch in T3' })).toBeNull();
  });

  it.each(['queued', 'in_progress'] as const)(
    'closes open settings without launching when a refresh changes the task to %s',
    async (status) => {
      const client = quiet();
      const node = ready();
      await openTask(node, T3_ORIGIN, twoProjects(), client);
      const settings = await startInT3();
      await chooseFork(settings);
      expect(within(settings).getByRole('button', { name: 'Launch' })).toBeEnabled();

      const { queryKey } = nodeQuery(node.id);
      await act(async () => {
        client.setQueryData(queryKey, { ...node, status });
      });
      await waitFor(() => {
        expect(settings).not.toBeInTheDocument();
      });
      expect(launchT3).not.toHaveBeenCalled();
    },
  );

  it('an already-open settings form still submits when the record goes offline', async () => {
    const client = quiet();
    await openTask(ready(), T3_ORIGIN, twoProjects(), client);
    const settings = await startInT3();
    await chooseFork(settings);
    failNotes();
    await act(async () => {
      await client.refetchQueries({ queryKey: annotationsQuery('MMR-7').queryKey });
    });
    const submit = within(settings).getByRole('button', { name: 'Launch' });
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledOnce();
    });
  });

  // UI SDK's sheets render in place, so More's sheet closes on the chosen row and unmounts it.
  // The settings form outlives it, launching what it was opened for.
  it('opens the settings form from the More sheet with focus in it, and launches the choice', async () => {
    await openTask(ready(), T3_ORIGIN, twoProjects());
    const settings = await startInT3();
    await waitFor(() => {
      expect(settings).toContainElement(document.activeElement as HTMLElement);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Task MMR-7' })).toBeNull();
    });
    await chooseFork(settings);
    await userEvent.click(within(settings).getByRole('button', { name: 'Launch' }));
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledOnce();
    });
    expect(vi.mocked(launchT3).mock.calls[0]?.[0].data).toMatchObject({
      projectId: 'proj-2',
      task: 'MMR-7',
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.body).not.toHaveFocus();
  });

  // A phone's Form sheet has no Cancel (MMR-743): its close, in the top bar, backs out.
  it('closing the settings form launches nothing and hands focus back to More', async () => {
    await openTask(ready(), T3_ORIGIN, twoProjects());
    const settings = await startInT3();
    await userEvent.click(within(settings).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(launchT3).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
    });
  });

  it('is absent, and T3 is never asked for a catalog, when T3 is unconfigured', async () => {
    await openTask(ready(), null);
    await waitFor(() => {
      expect(t3Origin).toHaveBeenCalled();
    });
    await userEvent.click(await screen.findByRole('button', { name: 'More' }));
    const more = await screen.findByRole('dialog', { name: 'Task MMR-7' });
    expect(within(more).queryByRole('button', { name: /T3/ })).toBeNull();
    expect(t3Catalog).not.toHaveBeenCalled();
  });

  // A queued task still offers Start in More, so only the launch gate keeps T3 out of it.
  it('is not offered on a queued task, and nothing is asked of T3', async () => {
    await openTask(
      engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'queued', title: 'Task MMR-7' }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'More' }));
    const more = await screen.findByRole('dialog', { name: 'Task MMR-7' });
    expect(within(more).getByRole('button', { name: 'Start' })).toBeDefined();
    expect(within(more).queryByRole('button', { name: /T3/ })).toBeNull();
    expect(t3Origin).not.toHaveBeenCalled();
    expect(t3Catalog).not.toHaveBeenCalled();
  });
});

describe('Open in T3', () => {
  const handles = { harness: 't3', host: 'env-1', session: 'thread-1' };

  it('links Details › Run to the thread', async () => {
    await openTask(engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'queued', ...handles }));
    await userEvent.click(screen.getByRole('tab', { name: 'Details' }));
    const run = await screen.findByRole('region', { name: 'Run' });
    const link = await within(run).findByRole('link', { name: /Open in T3/ });
    expect(link).toHaveAttribute('href', 't3code://threads/env-1/thread-1');
    // The app link hands off to the T3 app; a new tab would only leave a blank one behind.
    expect(link).not.toHaveAttribute('target');
  });

  it('links a Now row beside its meta', async () => {
    serveT3Launch(connectedCatalog([]));
    await renderInRouter(
      <NowRow row={nowRow({ id: 'MMR-7', status: 'queued', ...handles })} />,
      quiet(),
    );
    await expect(screen.findByRole('link', { name: /Open in T3/ })).resolves.toHaveAttribute(
      'href',
      't3code://threads/env-1/thread-1',
    );
  });

  // The only proof that a Now row passes its own harness to Open in T3.
  it('shows no link on a Now row held by another harness', async () => {
    serveT3Launch(connectedCatalog([]));
    await renderInRouter(
      <NowRow row={nowRow({ id: 'MMR-7', ...handles, harness: 'claude' })} />,
      quiet(),
    );
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
