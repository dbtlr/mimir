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

/** A system where two projects match the task's remote, so nothing launches without asking which. */
/**
 * The settings form: the Form sheet titled "Launch in T3", which names the task in its context
 * line (MMR-743). The phone's caret sheet shares the title, so the task tells them apart.
 */
const settingsForm = () =>
  screen.findByRole('dialog', { description: /MMR-7/, name: 'Launch in T3' });

/** The caret's sheet of launches, which shares the form's title but names no task. */
const caretSheets = () =>
  screen
    .queryAllByRole('dialog', { name: 'Launch in T3' })
    .filter((dialog) => dialog.querySelector('[data-slot="form-sheet-header"]') === null);

/** Choose the second project in the form's Project Select (a UI SDK Select, not a native one). */
async function chooseFork(settings: HTMLElement) {
  await userEvent.click(within(settings).getByRole('combobox', { name: 'Project' }));
  await userEvent.click(await screen.findByRole('option', { name: 'mimir-fork' }));
}

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

  it.each(['queued', 'in_progress'] as const)(
    'closes open settings without launching when a refresh changes the task to %s',
    async (status) => {
      const client = quiet();
      const node = engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'ready' });
      localStorage.clear();
      const rail = await openTask(node, T3_ORIGIN, twoProjects(), client);
      await waitFor(() => {
        expect(within(rail).getByRole('button', { name: 'Launch in T3…' })).toBeEnabled();
      });
      await userEvent.click(within(rail).getByRole('button', { name: 'Launch in T3…' }));
      const settings = await settingsForm();
      await chooseFork(settings);
      expect(within(settings).getByRole('button', { name: 'Launch' })).toBeEnabled();

      const { queryKey } = nodeQuery(node.id);
      await act(async () => {
        client.setQueryData(queryKey, { ...node, status });
      });
      await waitFor(() => {
        expect(settings).not.toBeInTheDocument();
      });

      await act(async () => {
        client.setQueryData(queryKey, node);
      });
      await expect(
        within(rail).findByRole('button', { name: 'Launch in T3…' }),
      ).resolves.toBeVisible();
      expect(screen.queryByRole('dialog', { name: 'Launch in T3' })).toBeNull();
      expect(launchT3).not.toHaveBeenCalled();
    },
  );

  it('an already-open settings dialog still submits when the record goes offline', async () => {
    const client = quiet();
    localStorage.clear();
    const rail = await openTask(
      engineTask({ id: 'MMR-7', parent: 'MMR-2', status: 'ready' }),
      T3_ORIGIN,
      twoProjects(),
      client,
    );
    const trigger = () => within(rail).getByRole('button', { hidden: true, name: 'Launch in T3…' });
    await waitFor(() => {
      expect(trigger()).toBeEnabled();
    });
    await userEvent.click(trigger());
    const settings = await settingsForm();
    await chooseFork(settings);
    failNotes();
    await act(async () => {
      await client.refetchQueries({ queryKey: annotationsQuery('MMR-7').queryKey });
    });
    await waitFor(() => {
      expect(trigger()).toBeDisabled();
    });
    const submit = within(settings).getByRole('button', { name: 'Launch' });
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() => {
      expect(launchT3).toHaveBeenCalledOnce();
    });
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
      const settings = await settingsForm();
      await waitFor(() => {
        expect(caretSheets()).toHaveLength(0);
      });
      await waitFor(() => {
        expect(settings).toContainElement(document.activeElement as HTMLElement);
      });
      await waitFor(() => {
        expect(actions).not.toBeInTheDocument();
      });
      // The dialog launches what it was opened for, though the control that opened it is gone.
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
    },
  );

  // A phone's Form sheet has no Cancel (MMR-743): its close, in the top bar, backs out.
  it('on a phone, closing the settings form leaves the Actions sheet closed and focus on its chip', async () => {
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
    const settings = await settingsForm();
    await userEvent.click(within(settings).getByRole('button', { name: 'Close' }));
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
