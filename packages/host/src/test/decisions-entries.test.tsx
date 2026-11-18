import type { ConsoleOutput } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { answerDecisions } from '../api/fns/deliveries';
import { tree } from '../api/fns/shell';
import { deliveryPage } from '../api/fns/views';
import type { ReviewReport } from '../api/view-queries';
import { readMark } from '../lib/walkthrough-mark';
import { consoleRoutes } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject, engineTree } from './engine-fixtures';
import { engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { renderRoute } from './router';
import { serveShell } from './shell-fns';
import { engineReview, engineWork, needsYouRow, stripRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/deliveries');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/views');

/** The entries that open the decisions walkthrough, and how it closes (ADR 0019, MMR-704 refinement). */

const stamp = new Date('2026-11-16T12:00:00Z');
type Decision = ConsoleOutput<'deliveryPage'>['decisions'][number];

function decision(seq: number, delivery: string | null, over: Partial<Decision> = {}): Decision {
  return {
    class: 'product',
    created_at: stamp,
    delivery,
    history: [],
    id: `MMR-q${String(seq)}`,
    lifecycle: 'provisional',
    option_details: [null, null],
    options: ['Keep', 'Remove'],
    outcome_note: null,
    overturn_option: null,
    project_key: 'MMR',
    question: `Question ${String(seq)}?`,
    recommended: 1,
    seq,
    taken: 1,
    tasks: [],
    updated_at: stamp,
    why: null,
    ...over,
  };
}

type Page = ConsoleOutput<'deliveryPage'>;
const task = (id: string, title: string) => engineTask({ id, status: 'in_progress', title });

function page(list: Decision[]): Page {
  return {
    decisions: list,
    delivery: {
      agreement: 'Ship it',
      branch: 'delivery/console',
      created_at: stamp,
      declined: [],
      elapsed_minutes: 42,
      external_ref: null,
      follow_ups: [],
      harness: null,
      history: [],
      hold: 'none',
      hold_reason: null,
      host: null,
      id: 'MMR-d3',
      journal: { artifacts: [], scratchpad: null },
      lifecycle: 'running',
      limitations: [],
      members: ['MMR-3', 'MMR-4'],
      phase: 'MMR-2',
      project_key: 'MMR',
      seq: 3,
      session: null,
      time_cap_minutes: null,
      title: 'Deliver the console',
      updated_at: stamp,
    },
    followUps: [],
    journal: [],
    members: [task('MMR-3', 'Build the page'), task('MMR-4', 'Wire the rail')],
    now: [],
    phase: engineTask({ id: 'MMR-2', status: 'in_progress', title: 'Console phase' }),
  };
}

const row = (d: Decision) => ({ decision: d, kind: 'decision' as const, workBuiltOnIt: false });

/** One MMR group: d4 (rows q1, q4), no delivery (q2), d3 (q3), in that needs-you order. */
function report(): ReviewReport {
  const rows = [
    row(decision(1, 'MMR-d4')),
    row(decision(2, null)),
    row(decision(3, 'MMR-d3')),
    row(decision(4, 'MMR-d4')),
  ];
  return engineReview({
    needsYou: [{ project: { key: 'MMR', name: 'Mimir' }, rows }],
    projects: [stripRow({ key: 'MMR', name: 'Mimir' }, { needsYou: rows.length })],
    queue: rows.map((r) => ({ id: r.decision.id, kind: 'decision' as const })),
  });
}

beforeEach(() => {
  serveBrowse();
  serveNodes({ nodes: [engineProject({ id: 'MMR', title: 'Mimir' })] });
  serveShell({ projects: [engineProject({ id: 'MMR', title: 'Mimir' })] });
  serveViews({ review: report() });
  vi.mocked(tree).mockResolvedValue(engineTree({ id: 'MMR', status: 'ready', type: 'project' }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5000 } } });

const entries = () =>
  screen
    .getAllByRole('link', { name: /^Review \d+ decisions? / })
    .map((a) => [a.textContent, a.getAttribute('href')]);

test('a project group lists an entry per delivery in needs-you order, then the no-delivery one', async () => {
  await renderRoute(consoleRoutes, '/');
  await screen.findByRole('link', { name: 'Review 2 decisions on MMR-d4' });
  expect(entries()).toStrictEqual([
    ['Review 2 decisions on MMR-d4', '/p/MMR/d4?mode=decisions'],
    ['Review 1 decision on MMR-d3', '/p/MMR/d3?mode=decisions'],
    ['Review 1 decision without a delivery', '/p/MMR?mode=decisions'],
  ]);
});

test('no-delivery decisions count in the plural', async () => {
  const rows = [row(decision(1, null)), row(decision(2, null))];
  serveViews({
    review: engineReview({
      needsYou: [{ project: { key: 'MMR', name: 'Mimir' }, rows }],
      projects: [stripRow({ key: 'MMR', name: 'Mimir' }, { needsYou: 2 })],
      queue: [],
    }),
  });
  await renderRoute(consoleRoutes, '/');
  await expect(
    screen.findByRole('link', { name: 'Review 2 decisions without a delivery' }),
  ).resolves.toHaveAttribute('href', '/p/MMR?mode=decisions');
});

test('a group whose rows are not decisions shows no entry', async () => {
  const rows = [needsYouRow({ id: 'MMR-52', status: 'blocked', title: 'Stuck' }, 'blocked')];
  serveViews({
    review: engineReview({
      needsYou: [{ project: { key: 'MMR', name: 'Mimir' }, rows }],
      projects: [stripRow({ key: 'MMR', name: 'Mimir' }, { needsYou: 1 })],
      queue: [],
    }),
  });
  await renderRoute(consoleRoutes, '/');
  await screen.findByText('MMR-52');
  expect(screen.queryByRole('link', { name: /^Review \d/ })).toBeNull();
});

test('the delivery page offers one entry above its decisions, counting the provisional ones', async () => {
  vi.mocked(deliveryPage).mockResolvedValue(
    page([
      decision(1, 'MMR-d3'),
      decision(2, 'MMR-d3', { lifecycle: 'confirmed' }),
      decision(3, 'MMR-d3'),
    ]),
  );
  await renderRoute(consoleRoutes, '/p/MMR/d3');
  const link = await screen.findByRole('link', { name: 'Review 2 decisions' });
  expect(link).toHaveAttribute('href', '/p/MMR/d3?mode=decisions');
});

test('an entry pushes the walkthrough marked with the page it was on', async () => {
  vi.mocked(deliveryPage).mockResolvedValue(page([decision(3, 'MMR-d3')]));
  const { router } = await renderRoute(consoleRoutes, '/', client());
  fireEvent.click(await screen.findByRole('link', { name: 'Review 1 decision on MMR-d3' }));
  await screen.findByRole('dialog');
  expect(router.state.location.pathname).toBe('/p/MMR/d3');
  expect(readMark(router.state.location.state)).toBe('/');
});

/** Open MMR-d3's one decision from `path`'s entry or address and send its answer; returns the done layer. */
async function sendFrom(path: string, entry?: string) {
  vi.mocked(deliveryPage).mockResolvedValue(page([decision(3, 'MMR-d3')]));
  vi.mocked(answerDecisions).mockResolvedValue({
    results: [{ id: 'MMR-q3', outcome: 'confirmed', record: decision(3, 'MMR-d3') }],
    wake: { state: 'sent' },
  });
  const view = await renderRoute(consoleRoutes, path, client());
  if (entry !== undefined) {
    fireEvent.click(await screen.findByRole('link', { name: entry }));
  }
  const layer = await screen.findByRole('dialog');
  fireEvent.click(await within(layer).findByRole('button', { name: 'Confirm and send (MMR-q3)' }));
  await within(layer).findByRole('heading', { name: 'Answers sent' });
  return { ...view, layer };
}

test('Close on a marked walkthrough goes back one entry', async () => {
  vi.mocked(deliveryPage).mockResolvedValue(page([decision(3, 'MMR-d3')]));
  const { router } = await renderRoute(consoleRoutes, '/', client());
  fireEvent.click(await screen.findByRole('link', { name: 'Review 1 decision on MMR-d3' }));
  const layer = await screen.findByRole('dialog');
  const back = vi.spyOn(router.history, 'back');
  fireEvent.click(await within(layer).findByRole('button', { name: 'Close the walkthrough' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(back).toHaveBeenCalledOnce();
  expect(router.state.location.pathname).toBe('/');
});

test('Close on an unmarked walkthrough replaces its entry and goes nowhere back', async () => {
  vi.mocked(deliveryPage).mockResolvedValue(page([decision(3, 'MMR-d3')]));
  const { router } = await renderRoute(consoleRoutes, '/p/MMR/d3?mode=decisions', client());
  const back = vi.spyOn(router.history, 'back');
  const length = router.history.length;
  const layer = await screen.findByRole('dialog');
  fireEvent.click(await within(layer).findByRole('button', { name: 'Close the walkthrough' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(back).not.toHaveBeenCalled();
  expect(router.state.location.search).not.toHaveProperty('mode');
  expect(router.history).toHaveLength(length);
});

test('the link back goes back when the opener is the walkthrough’s own page', async () => {
  const { router, layer } = await sendFrom('/p/MMR/d3', 'Review 1 decision');
  const back = vi.spyOn(router.history, 'back');
  fireEvent.click(within(layer).getByRole('link', { name: 'Back to MMR-d3' }));
  expect(back).toHaveBeenCalledOnce();
});

test('the link back replaces the entry when the opener is another page or there is none', async () => {
  const marked = await sendFrom('/', 'Review 1 decision on MMR-d3');
  const back = vi.spyOn(marked.router.history, 'back');
  const length = marked.router.history.length;
  fireEvent.click(within(marked.layer).getByRole('link', { name: 'Back to MMR-d3' }));
  await waitFor(() => {
    expect(marked.router.state.location.search).not.toHaveProperty('mode');
  });
  expect(marked.router.state.location.pathname).toBe('/p/MMR/d3');
  expect(back).not.toHaveBeenCalled();
  expect(marked.router.history).toHaveLength(length);
});

test('the next-set link replaces the entry and carries the mark over', async () => {
  const { router, layer } = await sendFrom('/', 'Review 1 decision on MMR-d3');
  const length = router.history.length;
  fireEvent.click(within(layer).getByRole('link', { name: 'Review them' }));
  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/p/MMR/d4');
  });
  expect(router.history).toHaveLength(length);
  expect(readMark(router.state.location.state)).toBe('/');
});

test('the next-set link carries no mark when the walkthrough had none', async () => {
  const { router, layer } = await sendFrom('/p/MMR/d3?mode=decisions');
  fireEvent.click(within(layer).getByRole('link', { name: 'Review them' }));
  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/p/MMR/d4');
  });
  expect(readMark(router.state.location.state)).toBeUndefined();
});

test('a modified click on the link back is left to the browser', async () => {
  const { router, layer } = await sendFrom('/p/MMR/d3', 'Review 1 decision');
  const back = vi.spyOn(router.history, 'back');
  const link = within(layer).getByRole('link', { name: 'Back to MMR-d3' });
  fireEvent.click(link, { ctrlKey: true });
  fireEvent.click(link, { metaKey: true });
  expect(back).not.toHaveBeenCalled();
});

test('the link back that goes back does not also navigate', async () => {
  const { router, layer } = await sendFrom('/p/MMR/d3', 'Review 1 decision');
  const back = vi.spyOn(router.history, 'back');
  const navigate = vi.spyOn(router, 'navigate');
  fireEvent.click(within(layer).getByRole('link', { name: 'Back to MMR-d3' }));
  expect(back).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
});

/** Open MMR's one decision with no delivery from the review page's entry and send its answer. */
async function sendProjectFrom(path: string, entry: string) {
  const q2 = decision(2, null);
  serveViews({
    projects: { MMR: engineWork({ needsYou: [row(q2)] }) },
    review: report(),
  });
  vi.mocked(answerDecisions).mockResolvedValue({
    results: [{ id: 'MMR-q2', outcome: 'confirmed', record: q2 }],
    wake: { state: 'sent' },
  });
  const view = await renderRoute(consoleRoutes, path, client());
  fireEvent.click(await screen.findByRole('link', { name: entry }));
  const layer = await screen.findByRole('dialog');
  fireEvent.click(await within(layer).findByRole('button', { name: 'Confirm and send (MMR-q2)' }));
  await within(layer).findByRole('heading', { name: 'Answers recorded' });
  return { ...view, layer };
}

test('a project walkthrough’s link back replaces the entry when the opener is another page', async () => {
  const { router, layer } = await sendProjectFrom('/', 'Review 1 decision without a delivery');
  expect(router.state.location.search).toHaveProperty('mode', 'decisions');
  const back = vi.spyOn(router.history, 'back');
  const length = router.history.length;
  fireEvent.click(within(layer).getByRole('link', { name: 'Back to MMR' }));
  await waitFor(() => {
    expect(router.state.location.search).not.toHaveProperty('mode');
  });
  expect(router.state.location.pathname).toBe('/p/MMR');
  expect(back).not.toHaveBeenCalled();
  expect(router.history).toHaveLength(length);
});

test('the next-set link to a project walkthrough replaces the entry and carries the mark over', async () => {
  const rows = [row(decision(2, null)), row(decision(3, 'MMR-d3'))];
  serveViews({
    review: engineReview({
      needsYou: [{ project: { key: 'MMR', name: 'Mimir' }, rows }],
      projects: [stripRow({ key: 'MMR', name: 'Mimir' }, { needsYou: rows.length })],
      queue: rows.map((r) => ({ id: r.decision.id, kind: 'decision' as const })),
    }),
  });
  const { router, layer } = await sendFrom('/', 'Review 1 decision on MMR-d3');
  const length = router.history.length;
  fireEvent.click(within(layer).getByRole('link', { name: 'Review it' }));
  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/p/MMR');
  });
  expect(router.state.location.search).toHaveProperty('mode', 'decisions');
  expect(router.history).toHaveLength(length);
  expect(readMark(router.state.location.state)).toBe('/');
});
