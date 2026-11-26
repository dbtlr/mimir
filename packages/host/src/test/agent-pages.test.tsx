import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cancelGroom } from '../api/fns/agent';
import { consoleRoutes } from '../router';
import { agentRun, readyCard, runningActivity } from './agent-fixtures';
import { serveAgent } from './agent-fns';
import { serveBrowse } from './browse-fns';
import { engineTree, engineProject } from './engine-fixtures';
import { engineContainer, engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { renderRoute } from './router';
import { serveShell } from './shell-fns';
import { engineWork, nowRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/agent');
vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

// Mon Oct 12 2026, 18:00 in the suite's pinned zone (America/New_York).
const NOW = Date.parse('2026-10-12T22:00:00.000Z');

beforeEach(() => {
  serveBrowse();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const leaf = (id: string, parent: string) =>
  engineTree({ id, parent, status: 'ready', title: `task ${id}`, type: 'task' });

const TREE = engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
  engineTree({ id: 'MMR-1', status: 'ready', title: 'Initiative', type: 'initiative' }, [
    engineTree({ id: 'MMR-2', parent: 'MMR-1', status: 'ready', title: 'Phase A', type: 'phase' }, [
      leaf('MMR-640', 'MMR-2'),
    ]),
    engineTree({ id: 'MMR-3', parent: 'MMR-1', status: 'ready', title: 'Phase B', type: 'phase' }, [
      leaf('MMR-641', 'MMR-3'),
    ]),
  ]),
]);

const quietClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** The Now row of a task: its link is named by the title, the rest hangs in the row. */
const rowOf = async (title: string) => {
  const link = await screen.findByRole('link', { name: title });
  const row = link.closest<HTMLElement>('[data-row-id]');
  expect(row).not.toBeNull();
  return { link, row: row as HTMLElement };
};

const nowGroup = () => screen.findByRole('heading', { name: /^Now/ });

describe('the task page', () => {
  const task = engineTask({
    description: 'Sync times.',
    grooming: 'not_groomed',
    id: 'MMR-640',
    parent: 'MMR-2',
    status: 'ready',
    title: 'Show sync times',
  });

  it('places the card in the banner slot on Work, above the description', async () => {
    serveShell({ trees: { MMR: TREE } });
    serveNodes({ nodes: [task], notes: { 'MMR-640': [] } });
    serveViews();
    serveAgent({ card: readyCard() });
    await renderRoute(consoleRoutes, '/p/MMR/640', quietClient());
    const card = await screen.findByRole('region', { name: 'Groom with agent' });
    const description = screen.getByText('Sync times.');
    expect(
      card.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('has no card on a started task', async () => {
    serveShell({ trees: { MMR: TREE } });
    serveNodes({
      nodes: [{ ...task, lifecycle: 'in_progress', status: 'in_progress' }],
      notes: { 'MMR-640': [] },
    });
    serveViews();
    serveAgent({ card: readyCard() });
    await renderRoute(consoleRoutes, '/p/MMR/640', quietClient());
    await screen.findByRole('heading', { level: 1, name: 'Show sync times' });
    expect(screen.queryByRole('region', { name: 'Groom with agent' })).toBeNull();
  });
});

describe('Now on the work page', () => {
  const PROJECT = engineProject({ id: 'MMR', title: 'Mimir' });
  const PHASE_A = engineContainer({
    id: 'MMR-2',
    parent: 'MMR-1',
    status: 'ready',
    title: 'Phase A',
    type: 'phase',
  });

  async function openProject(activity = runningActivity()) {
    serveShell({ trees: { MMR: TREE } });
    serveNodes({ nodes: [PROJECT] });
    serveViews();
    const state = serveAgent({ activity });
    await renderRoute(consoleRoutes, '/p/MMR', quietClient());
    await screen.findByRole('heading', { level: 1, name: 'Mimir' });
    return state;
  }

  async function openPhase(activity = runningActivity(), id = PHASE_A.id) {
    serveShell({ trees: { MMR: TREE } });
    serveNodes({ nodes: [PHASE_A], notes: { [PHASE_A.id]: [] } });
    serveViews();
    serveAgent({ activity });
    await renderRoute(consoleRoutes, `/p/MMR/${id.replace('MMR-', '')}`, quietClient());
    await screen.findByRole('heading', { level: 1, name: 'Phase A' });
  }

  it('shows the running agent as a row on its task, keeping Now shown with no count', async () => {
    await openProject(
      runningActivity({ startedAt: new Date(NOW - 2 * 60_000) }, 'Show each clone’s last sync'),
    );
    const { link, row } = await rowOf('Show each clone’s last sync');
    expect(link).toHaveAttribute('href', '/p/MMR/640');
    expect(row).toHaveTextContent('MMR-640');
    expect(row).toHaveTextContent('Agent');
    expect(row).toHaveTextContent('Grooming, started 2m ago');
    expect(row).toHaveTextContent('0.36M of 4M tokens');
    await expect(nowGroup()).resolves.toHaveTextContent(/^Now$/);
  });

  it('sets the row of a run whose task has no card above the cards, out of the head’s count', async () => {
    serveShell({ trees: { MMR: TREE } });
    serveNodes({ nodes: [PROJECT] });
    serveViews({
      projects: { MMR: engineWork({ now: [nowRow({ id: 'MMR-11', title: 'Wire the dialect' })] }) },
    });
    serveAgent({ activity: runningActivity() });
    await renderRoute(consoleRoutes, '/p/MMR', quietClient());
    const { row } = await rowOf('Show each clone’s last sync time');
    await expect(nowGroup()).resolves.toHaveTextContent(/^Now 1$/);
    const card = screen.getByRole('button', { name: 'Wire the dialect' });
    expect(card).toBeVisible();
    // oxlint-disable-next-line no-bitwise -- DOM position flags are a bit mask
    expect(row.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // A task queued while the agent grooms it is in Now on its own: the run rides on its card, so the task shows once.
  it('carries the run on its task’s card, with Stop, when its task has a card', async () => {
    serveShell({ trees: { MMR: TREE } });
    serveNodes({ nodes: [PROJECT] });
    serveViews({
      projects: {
        MMR: engineWork({
          now: [nowRow({ id: 'MMR-640', status: 'queued', title: 'Show each clone’s last sync' })],
        }),
      },
    });
    serveAgent({
      activity: runningActivity(
        { cancellable: true, startedAt: new Date(NOW - 2 * 60_000) },
        'Show each clone’s last sync',
      ),
    });
    await renderRoute(consoleRoutes, '/p/MMR', quietClient());
    const target = await screen.findByRole('button', { name: 'Show each clone’s last sync' });
    const card = target.closest<HTMLElement>('[data-slot="feed-card"]');
    expect(card).not.toBeNull();
    // The agent's read lands apart from the work read: wait for its Stop before asserting the run.
    const stop = await within(card as HTMLElement).findByRole('button', {
      name: 'Stop run on MMR-640',
    });
    expect(screen.queryByRole('link', { name: 'Show each clone’s last sync' })).toBeNull();
    expect(card).toHaveTextContent('Agent grooming, started 2m ago');
    expect(card).toHaveTextContent('0.36M of 4M tokens');
    expect(screen.getAllByRole('button', { name: /^Stop run on / })).toHaveLength(1);
    await expect(nowGroup()).resolves.toHaveTextContent(/^Now 1$/);
    await userEvent.click(stop);
    await expect(
      screen.findByRole('alertdialog', { name: 'Stop the agent on MMR-640?' }),
    ).resolves.toBeVisible();
  });

  // The cap hides the run's task's card, so the run keeps its row, and Stop stays reachable.
  it('keeps the run’s row, with Stop, when its task’s card is past the cap', async () => {
    serveShell({ trees: { MMR: TREE } });
    serveNodes({ nodes: [PROJECT] });
    const newer = Array.from({ length: 6 }, (_, i) =>
      nowRow(
        { id: `MMR-${String(11 + i)}`, title: `Newer task ${String(i + 1)}` },
        { startedAt: new Date(NOW - (i + 1) * 60_000) },
      ),
    );
    const oldest = nowRow(
      { id: 'MMR-640', status: 'queued', title: 'Show each clone’s last sync' },
      { startedAt: new Date(NOW - 60 * 60_000) },
    );
    serveViews({ projects: { MMR: engineWork({ now: [...newer, oldest] }) } });
    serveAgent({ activity: runningActivity({ cancellable: true }, 'Show each clone’s last sync') });
    await renderRoute(consoleRoutes, '/p/MMR', quietClient());
    await expect(
      screen.findByRole('button', { name: 'Stop run on MMR-640' }),
    ).resolves.toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show each clone’s last sync' })).toBeNull();
    await expect(nowGroup()).resolves.toHaveTextContent(/^Now \d of 7$/);
  });

  it('has no Now when no agent run is active and nothing is in flight', async () => {
    await openProject({ running: null });
    await expect(screen.findByText(/^Nothing is running/)).resolves.toBeVisible();
    expect(screen.queryByRole('heading', { name: /^Now/ })).toBeNull();
  });

  it('leaves out a run on another project', async () => {
    await openProject(runningActivity({ project: 'OTH', task: 'OTH-1' }));
    await expect(screen.findByText(/^Nothing is running/)).resolves.toBeVisible();
  });

  it('shows a run whose task is inside the container', async () => {
    await openPhase();
    expect((await rowOf('Show each clone’s last sync time')).link).toBeVisible();
  });

  it('leaves out a run on a task in another container', async () => {
    await openPhase(runningActivity({ task: 'MMR-641' }));
    await expect(screen.findByText(/^Nothing is running/)).resolves.toBeVisible();
    expect(screen.queryByRole('link', { name: 'Show each clone’s last sync time' })).toBeNull();
  });

  it('marks a stale run', async () => {
    await openProject({ running: { ...agentRun({ stale: true }), taskTitle: 'T' } });
    const { row } = await rowOf('T');
    expect(within(row).getByText(/stopped reporting/)).toBeVisible();
  });

  it('has no stop button on a run that cannot be stopped', async () => {
    await openProject(runningActivity({ cancellable: false }));
    const { row } = await rowOf('Show each clone’s last sync time');
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('opens the stop confirm from an icon button, and stops the run', async () => {
    await openProject(runningActivity({ cancellable: true }));
    const { row } = await rowOf('Show each clone’s last sync time');
    const stop = within(row).getByRole('button', { name: 'Stop run on MMR-640' });
    expect(stop).toHaveAttribute('title', 'Stop run');
    await userEvent.click(stop);
    const dialog = await screen.findByRole('alertdialog', { name: 'Stop the agent on MMR-640?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop run' }));
    await waitFor(() => {
      expect(cancelGroom).toHaveBeenCalledWith({ data: { runId: 'run-1' } });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('stops the run the confirm opened on, though a poll swapped the running run under it', async () => {
    const state = await openProject(runningActivity({ cancellable: true }));
    const { row } = await rowOf('Show each clone’s last sync time');
    await userEvent.click(within(row).getByRole('button', { name: 'Stop run on MMR-640' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Stop the agent on MMR-640?' });
    state.activity = runningActivity({ cancellable: true, id: 'run-2', task: 'MMR-641' }, 'Next');
    await vi.advanceTimersByTimeAsync(10_500);
    // The modal hides the page behind it from the accessibility tree.
    await screen.findByRole('link', { hidden: true, name: 'Next' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop run' }));
    await waitFor(() => {
      expect(cancelGroom).toHaveBeenCalledWith({ data: { runId: 'run-1' } });
    });
    expect(cancelGroom).not.toHaveBeenCalledWith({ data: { runId: 'run-2' } });
  });

  it('keeps the refusal readable when the run it answers for has left Now', async () => {
    const state = await openProject(runningActivity({ cancellable: true }));
    const { row } = await rowOf('Show each clone’s last sync time');
    await userEvent.click(within(row).getByRole('button', { name: 'Stop run on MMR-640' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Stop the agent on MMR-640?' });
    // The run ended on its own: the stop answers ended, and the refresh empties Now.
    state.cancel = { runState: 'succeeded', state: 'ended' };
    state.activity = { running: null };
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop run' }));
    await vi.advanceTimersByTimeAsync(10_500);
    const answered = await screen.findByRole('alertdialog', { name: 'Stop the agent on MMR-640?' });
    await expect(
      within(answered).findByText('The run already ended (succeeded).'),
    ).resolves.toBeInTheDocument();
  });

  it('marks a stopping run with a badge and its meta, and offers no button', async () => {
    await openProject(runningActivity({ stopping: true }));
    const { row } = await rowOf('Show each clone’s last sync time');
    expect(row).toHaveTextContent('Stopping');
    expect(row).toHaveTextContent('Stopping after its current step');
    expect(row).toHaveTextContent('0.36M of 4M tokens');
    expect(row).not.toHaveTextContent('Grooming, started');
    expect(within(row).queryByRole('button')).toBeNull();
  });
});
