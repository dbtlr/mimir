import type { ConsoleOutput } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { screen, within, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ApiError } from '../api/errors';
import { deliveryPage, phaseDeliveries } from '../api/fns/views';
import { consoleRoutes } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { engineContainer, engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { renderShell, renderRoute } from './router';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import { engineReview, stripRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/browse');
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

test('draws the stop and each open decision in attention, and nothing else', async () => {
  await open();
  const stopped = await screen.findByRole('region', { name: 'Stopped' });
  expect(stopped).toHaveClass(
    'border-attention/30',
    'bg-attention/10',
    'text-attention-foreground',
  );
  const row = screen.getByText('Keep the rail?').closest('div');
  expect(row).toHaveClass('border-l-2', 'border-attention');
  expect(row?.querySelector('span')).toHaveClass('text-attention-foreground');
  // The lifecycle and hold words are ink chips, so §3's status vocabulary stays closed.
  for (const word of ['running', 'stopped']) {
    const chip = screen.getAllByText(word).find((el) => el.className.includes('border-line'));
    expect(chip?.parentElement).toHaveClass('text-ink');
    expect(chip?.className).not.toMatch(/attention|status-/);
  }
});

test('shows a paused notice in ink and elapsed time without a cap', async () => {
  const data = fixture();
  data.delivery.hold = 'paused';
  data.delivery.hold_reason = 'Back tomorrow';
  data.delivery.time_cap_minutes = null;
  vi.mocked(deliveryPage).mockResolvedValue(data);
  await open();
  const paused = await screen.findByRole('region', { name: 'Paused' });
  expect(paused).toHaveClass('text-ink');
  expect(paused.className).not.toMatch(/attention/);
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.getAllByText('42 min elapsed').length).toBeGreaterThan(0);
});

test('reads “Not started” for a delivery with no elapsed time', async () => {
  const data = fixture();
  data.delivery.lifecycle = 'agreed';
  data.delivery.elapsed_minutes = null;
  vi.mocked(deliveryPage).mockResolvedValue(data);
  await open();
  await screen.findByRole('heading', { name: 'Deliver the console' });
  expect(screen.queryByText(/min elapsed/)).not.toBeInTheDocument();
  expect(screen.getAllByText('Not started')).toHaveLength(2);
});

test('closes the phone page with the facts, topping the rail on desktop, and reads None for the missing', async () => {
  await open();
  const rail = await screen.findByRole('complementary', { name: 'Delivery details' });
  const facts = within(rail).getByRole('heading', { name: 'Facts' }).closest('section');
  // Facts move to the top only from lg up; a base order would lift them on a phone too.
  expect(facts?.parentElement).toHaveClass('lg:-order-1');
  expect(facts?.parentElement?.className).not.toMatch(/(^|\s)-?order-/);
  expect(rail.lastElementChild).toBe(facts?.parentElement);
  // On desktop the facts carry the divider under them, and the journal, last on screen, carries none.
  expect(facts?.parentElement).toHaveClass('lg:border-b');
  const journal = within(rail)
    .getByRole('heading', { name: 'Recent run journal' })
    .closest('section');
  expect(journal).toHaveClass('lg:border-b-0');
  expect(within(rail).getAllByRole('heading', { name: 'Facts' })).toHaveLength(1);
  // No T3 origin and no session handles, so the thread slot reads None.
  const thread = within(facts as HTMLElement).getByText('Thread').nextElementSibling;
  expect(thread).toHaveTextContent('None');
});

test('wraps long unbroken text so the page never outgrows a phone', async () => {
  const long = 'x'.repeat(140);
  const data = fixture();
  data.delivery.title = `Title ${long}`;
  data.delivery.hold_reason = `Reason ${long}`;
  data.delivery.declined[0] = { ...data.delivery.declined[0]!, reason: `Declined ${long}` };
  data.decisions[0]!.options = [`Option ${long}`, 'Remove'];
  data.delivery.limitations[0] = { ...data.delivery.limitations[0]!, text: `Limit ${long}` };
  data.journal[0] = { ...data.journal[0]!, content: `Journal ${long}` };
  data.followUps[0]!.items[0] = { ...data.followUps[0]!.items[0]!, content: `Item ${long}` };
  vi.mocked(deliveryPage).mockResolvedValue(data);
  await open();
  for (const text of [
    `Title ${long}`,
    `Reason ${long}`,
    `Declined ${long}`,
    `Option ${long}`,
    `Limit ${long}`,
    `Journal ${long}`,
  ]) {
    expect((await screen.findByText(text)).closest('.wrap-anywhere')).not.toBeNull();
  }
  const item = await screen.findByText(new RegExp(`Item ${long}`), { selector: 'li' });
  expect(item.closest('.wrap-anywhere')).not.toBeNull();
});

test('redirects leading zeros to the canonical delivery address', async () => {
  const { router } = await renderRoute(consoleRoutes, '/p/mmr/D003');
  await waitFor(() => expect(router.state.location.pathname).toBe('/p/MMR/d3'));
});

test('shows not found for an unknown delivery’s 404', async () => {
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
  expect(within(cards).getByRole('link', { name: /Deliver the console/ })).toHaveClass(
    'wrap-anywhere',
  );
  expect(within(cards).getByRole('img', { name: /1/ })).toBeInTheDocument();
});

test('the alert marks this delivery and its decision omits a delivery self-link', async () => {
  serveBrowse();
  stubViewport('desktop');
  const page = fixture();
  const d = page.delivery;
  serveViews({
    review: engineReview({
      needsYou: [
        {
          project: { key: 'MMR', name: 'Mimir' },
          rows: [
            {
              delivery: {
                hold_reason: d.hold_reason,
                id: d.id,
                lifecycle: d.lifecycle,
                phase: d.phase,
                project: d.project_key,
                seq: d.seq,
                title: d.title,
                updated_at: d.updated_at,
              },
              kind: 'delivery',
            },
            { decision: page.decisions[0]!, kind: 'decision', workBuiltOnIt: true },
          ],
        },
      ],
      projects: [stripRow({ key: 'MMR', name: 'Mimir' }, { needsYou: 2 })],
      queue: [
        { id: d.id, kind: 'delivery' },
        { id: 'MMR-q1', kind: 'decision' },
      ],
    }),
  });
  await renderShell('/p/MMR/d3');
  await screen.findByRole('heading', { name: 'Deliver the console' });
  const ownNeedsYou = screen.getByRole('region', { name: /^Needs you/ });
  expect(within(ownNeedsYou).queryByRole('link', { name: 'MMR-d3' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '2 need you' }));
  const panel = await screen.findByRole('dialog', { name: 'Needs you' });
  expect(within(panel).getByText('This page')).toBeInTheDocument();
  expect(within(panel).queryByRole('link', { name: 'MMR-d3' })).not.toBeInTheDocument();
  vi.unstubAllGlobals();
});
