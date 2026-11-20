import type { EngineNode } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { launchT3, t3Catalog, t3Origin } from '../api/fns/t3';
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
) {
  serveShell({ trees: { MMR: TREE } });
  serveNodes({ nodes: [node], notes: { [node.id]: [] }, scratchpads: [] });
  serveT3Launch(connectedCatalog([system]), undefined, origin);
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

  // UI SDK's sheets render in place, so the launch sheet sits inside the Actions chip's sheet, whose
  // body closes on a chosen button and unmounts the launch control. The settings dialog outlives it.
  it.each([
    ['the main half’s Launch in T3…', null],
    ['the caret’s Choose settings…', 'Choose settings…'],
    ['the caret’s Launch on Valhalla', 'Launch on Valhalla'],
  ] as const)(
    'on a phone with no remembered choice, %s in the Actions sheet opens the settings dialog with focus in it',
    async (_path, item) => {
      stubViewport('phone');
      localStorage.clear();
      await openTask(
        engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'ready' }),
        T3_ORIGIN,
        twoProjects(),
      );
      const chip = screen.getByRole('button', { name: 'Actions' });
      await userEvent.click(chip);
      const actions = await screen.findByRole('dialog', { name: 'Actions' });
      if (item === null) {
        await userEvent.click(
          await within(actions).findByRole('button', { name: 'Launch in T3…' }),
        );
      } else {
        await userEvent.click(
          await within(actions).findByRole('button', { name: 'Choose where to launch' }),
        );
        const sheet = await screen.findByRole('dialog', { name: 'Launch in T3' });
        await userEvent.click(within(sheet).getByRole('button', { name: item }));
      }
      const settings = await screen.findByRole('dialog', { name: 'Launch MMR-7 in T3' });
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Launch in T3' })).toBeNull();
      });
      await waitFor(() => {
        expect(settings).toContainElement(document.activeElement as HTMLElement);
      });
      // The dialog launches what it was opened for, though the control that opened it is gone.
      await userEvent.selectOptions(
        within(settings).getByRole('combobox', { name: 'Project' }),
        'proj-2',
      );
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
    },
  );

  it('on a phone, Cancel on the settings dialog leaves the Actions sheet closed and focus on its chip', async () => {
    stubViewport('phone');
    localStorage.clear();
    await openTask(
      engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'ready' }),
      T3_ORIGIN,
      twoProjects(),
    );
    const chip = screen.getByRole('button', { name: 'Actions' });
    await userEvent.click(chip);
    const actions = await screen.findByRole('dialog', { name: 'Actions' });
    await userEvent.click(await within(actions).findByRole('button', { name: 'Launch in T3…' }));
    const settings = await screen.findByRole('dialog', { name: 'Launch MMR-7 in T3' });
    await userEvent.click(within(settings).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(launchT3).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Actions' })).toHaveFocus();
    });
  });

  it.each([
    ['the main half', null],
    ['the caret', 'Launch on Valhalla'],
  ] as const)(
    'on a phone, a plain launch from %s in the Actions sheet runs and closes it',
    async (_path, item) => {
      stubViewport('phone');
      localStorage.clear();
      await openTask(engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'ready' }));
      await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
      const actions = await screen.findByRole('dialog', { name: 'Actions' });
      if (item === null) {
        await userEvent.click(
          await within(actions).findByRole('button', { name: 'Launch on Valhalla' }),
        );
      } else {
        await userEvent.click(
          await within(actions).findByRole('button', { name: 'Choose where to launch' }),
        );
        const sheet = await screen.findByRole('dialog', { name: 'Launch in T3' });
        await userEvent.click(within(sheet).getByRole('button', { name: item }));
      }
      await waitFor(() => {
        expect(launchT3).toHaveBeenCalledOnce();
      });
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(document.body).not.toHaveFocus();
    },
  );

  it('on a phone, Cancel in the caret sheet closes only that sheet', async () => {
    stubViewport('phone');
    await openTask(engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'ready' }));
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const actions = await screen.findByRole('dialog', { name: 'Actions' });
    await userEvent.click(
      await within(actions).findByRole('button', { name: 'Choose where to launch' }),
    );
    const sheet = await screen.findByRole('dialog', { name: 'Launch in T3' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Launch in T3' })).toBeNull();
    });
    expect(screen.getByRole('dialog', { name: 'Actions' })).toBe(actions);
    expect(launchT3).not.toHaveBeenCalled();
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

  // A queued task still offers Start, so only the launch gate keeps T3 out of its rail.
  it('is not offered on a queued task, and nothing is asked of T3', async () => {
    const rail = await openTask(engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'queued' }));
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
