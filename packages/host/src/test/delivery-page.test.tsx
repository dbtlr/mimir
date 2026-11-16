import type { ConsoleOutput } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ApiError } from '../api/errors';
import { deliveryPage, phaseDeliveries } from '../api/fns/views';
import { consoleRoutes } from '../router';
import { engineProject } from './engine-fixtures';
import { engineContainer, engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { renderRoute } from './router';
import { serveShell } from './shell-fns';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/views');
vi.mock('sonner', () => ({ Toaster: () => null, toast: { error: vi.fn(), success: vi.fn() } }));

const stamp = new Date('2026-11-16T12:00:00Z');
function fixture(): ConsoleOutput<'deliveryPage'> {
  return {
    decisions: [
      {
        class: 'product',
        created_at: stamp,
        delivery: 'MMR-d3',
        history: [],
        id: 'MMR-q1',
        lifecycle: 'provisional',
        options: ['Keep', 'Remove'],
        outcome_note: null,
        overturn_option: null,
        project_key: 'MMR',
        question: 'Keep the rail?',
        recommended: 1,
        seq: 1,
        taken: 1,
        tasks: ['MMR-3'],
        updated_at: stamp,
        why: null,
      },
    ],
    delivery: {
      agreement: 'Ship it',
      branch: 'delivery/console',
      created_at: stamp,
      declined: [
        {
          created_at: stamp,
          finding: 'Add animations',
          number: 2,
          reason: 'Motion is unnecessary',
        },
      ],
      elapsed_minutes: 42,
      external_ref: 'https://example.com/pull/1',
      follow_ups: [],
      harness: null,
      history: [],
      hold: 'stopped',
      hold_reason: 'Decision cap reached',
      host: null,
      id: 'MMR-d3',
      journal: { artifacts: ['MMR-a1'], scratchpad: null },
      lifecycle: 'running',
      limitations: [{ created_at: stamp, number: 1, text: 'No offline edits' }],
      members: ['MMR-3'],
      phase: 'MMR-2',
      project_key: 'MMR',
      seq: 3,
      session: null,
      time_cap_minutes: 120,
      title: 'Deliver the console',
      updated_at: stamp,
    },
    followUps: [
      {
        id: 'MMR-4',
        items: [
          {
            content: 'Remove fixtures',
            created_at: stamp,
            number: 1,
            reason: null,
            settled_at: null,
            state: 'open',
          },
        ],
        status: 'ready',
        title: 'Clean up',
      },
    ],
    journal: [{ at: stamp, content: 'Stopped for your call', number: 1 }],
    members: [engineTask({ id: 'MMR-3', status: 'in_progress', title: 'Build the page' })],
    now: [
      {
        latestNote: null,
        scratchpads: [],
        stale: false,
        startedAt: stamp,
        submittedAt: null,
        task: engineTask({ id: 'MMR-3', status: 'in_progress', title: 'Build the page' }),
      },
    ],
    phase: engineContainer({
      id: 'MMR-2',
      status: 'in_progress',
      title: 'Console phase',
      type: 'phase',
    }),
  };
}
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(stamp);
  serveViews();
  serveShell({ projects: [engineProject({ id: 'MMR', title: 'Mimir' })] });
  vi.mocked(deliveryPage).mockResolvedValue(fixture());
  vi.mocked(phaseDeliveries).mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());
const open = () =>
  renderRoute(
    consoleRoutes,
    '/p/MMR/d3',
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );

test('renders the stopped dossier sections and puts facts and the final three sections in the rail', async () => {
  await open();
  await screen.findByRole('heading', { name: 'Deliver the console' });
  const rail = screen.getByRole('complementary', { name: 'Delivery details' });
  for (const label of [
    'Facts',
    'Follow-ups',
    'Known limitations',
    'Declined findings',
    'Recent run journal',
  ]) {
    expect(within(rail).getByRole('heading', { name: label })).toBeInTheDocument();
  }
  for (const text of [
    'Decision cap reached',
    'Keep the rail?',
    'Keep',
    'Remove',
    'Answer taken: Keep',
    'Build the page',
    'Remove fixtures',
    'No offline edits',
    'Motion is unnecessary',
    'Stopped for your call',
    'delivery/console',
  ]) {
    expect(screen.getByText(text, { exact: text !== 'Remove fixtures' })).toBeInTheDocument();
  }
  expect(screen.getAllByRole('progressbar', { name: 'Delivery time' })[0]).toHaveAttribute(
    'aria-valuenow',
    '42',
  );
});

test('shows a paused notice in ink and elapsed time without a cap', async () => {
  const data = fixture();
  data.delivery.hold = 'paused';
  data.delivery.hold_reason = 'Back tomorrow';
  data.delivery.time_cap_minutes = null;
  vi.mocked(deliveryPage).mockResolvedValue(data);
  await open();
  await expect(screen.findByText('Back tomorrow')).resolves.not.toHaveClass('text-attention');
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.getAllByText('42 min elapsed').length).toBeGreaterThan(0);
});

test('redirects leading zeros to the canonical delivery address', async () => {
  const { router } = await renderRoute(consoleRoutes, '/p/mmr/D003');
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/MMR/d3'));
});

test('shows not found for an unknown or archived delivery', async () => {
  vi.mocked(deliveryPage).mockRejectedValue(new ApiError('Missing', 404));
  await open();
  await expect(screen.findByText('No record MMR-d3.')).resolves.toBeInTheDocument();
});

test('links the phase’s live delivery card to its dossier with time and member distribution', async () => {
  const page = fixture();
  serveNodes({ nodes: [page.phase] });
  vi.mocked(phaseDeliveries).mockResolvedValue([
    { delivery: page.delivery, members: page.members },
  ]);
  await renderRoute(consoleRoutes, '/p/MMR/2');
  const cards = await screen.findByRole('region', { name: 'Live deliveries' });
  expect(within(cards).getByRole('link', { name: /Deliver the console/ })).toHaveAttribute(
    'href',
    '/p/MMR/d3',
  );
  expect(within(cards).getByText('stopped')).toBeInTheDocument();
  expect(within(cards).getByRole('img', { name: /1/ })).toBeInTheDocument();
});
