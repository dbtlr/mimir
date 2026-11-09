import { QueryClient } from '@tanstack/react-query';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { consoleRoutes } from '../router';
import { agentRun, readyPanel, runningActivity } from './agent-fixtures';
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

  it('places the card above the description', async () => {
    serveShell({ trees: { MMR: TREE } });
    serveNodes({ nodes: [task], notes: { 'MMR-640': [] } });
    serveViews();
    serveAgent({ panel: readyPanel() });
    await renderRoute(consoleRoutes, '/p/MMR/640', quietClient());
    const card = await screen.findByRole('region', { name: 'Groom with agent' });
    const description = screen.getByRole('heading', { name: 'Description' });
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
    serveAgent({ panel: readyPanel() });
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
    serveAgent({ activity });
    await renderRoute(consoleRoutes, '/p/MMR', quietClient());
    await screen.findByRole('heading', { level: 1, name: 'Mimir' });
  }

  async function openPhase(activity = runningActivity(), id = PHASE_A.id) {
    serveShell({ trees: { MMR: TREE } });
    serveNodes({ nodes: [PHASE_A], notes: { [PHASE_A.id]: [] } });
    serveViews();
    serveAgent({ activity });
    await renderRoute(consoleRoutes, `/p/MMR/${id.replace('MMR-', '')}`, quietClient());
    await screen.findByRole('heading', { level: 1, name: 'Phase A' });
  }

  it('shows the running agent as a row on its task', async () => {
    await openProject(
      runningActivity({ startedAt: new Date(NOW - 2 * 60_000) }, 'Show each clone’s last sync'),
    );
    const { link, row } = await rowOf('Show each clone’s last sync');
    expect(link).toHaveAttribute('href', '/p/MMR/640');
    expect(row).toHaveTextContent('MMR-640');
    expect(row).toHaveTextContent('Agent');
    expect(row).toHaveTextContent('Grooming, started 2m ago');
    expect(row).toHaveTextContent('0.36M of 4M tokens');
    await expect(nowGroup()).resolves.toHaveTextContent('1');
    expect(screen.queryByText('Nothing running.')).toBeNull();
  });

  it('counts the row with the tasks already in Now', async () => {
    serveShell({ trees: { MMR: TREE } });
    serveNodes({ nodes: [PROJECT] });
    serveViews({
      projects: { MMR: engineWork({ now: [nowRow({ id: 'MMR-11', title: 'Wire the dialect' })] }) },
    });
    serveAgent({ activity: runningActivity() });
    await renderRoute(consoleRoutes, '/p/MMR', quietClient());
    await rowOf('Show each clone’s last sync time');
    await expect(nowGroup()).resolves.toHaveTextContent('2');
    expect(screen.getByRole('link', { name: 'Wire the dialect' })).toBeVisible();
  });

  it('says nothing is running when no agent run is active', async () => {
    await openProject({ running: null });
    await expect(screen.findByText('Nothing running.')).resolves.toBeVisible();
  });

  it('leaves out a run on another project', async () => {
    await openProject(runningActivity({ project: 'OTH', task: 'OTH-1' }));
    await expect(screen.findByText('Nothing running.')).resolves.toBeVisible();
  });

  it('shows a run whose task is inside the container', async () => {
    await openPhase();
    expect((await rowOf('Show each clone’s last sync time')).link).toBeVisible();
  });

  it('leaves out a run on a task in another container', async () => {
    await openPhase(runningActivity({ task: 'MMR-641' }));
    await expect(screen.findByText('Nothing running.')).resolves.toBeVisible();
    expect(screen.queryByRole('link', { name: 'Show each clone’s last sync time' })).toBeNull();
  });

  it('marks a stale run', async () => {
    await openProject({ running: { ...agentRun({ stale: true }), taskTitle: 'T' } });
    const { row } = await rowOf('T');
    expect(within(row).getByText(/stopped reporting/)).toBeVisible();
  });
});
