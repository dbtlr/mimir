// Pending-write gates need manually controlled server promises.
// oxlint-disable promise/avoid-new
import type { ConsoleOutput } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { screen, within, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ApiError } from '../api/errors';
import {
  confirm,
  overturn,
  deliveryUnblock,
  deliveryUnpark,
  deliveryPark,
  deliveryAbandon,
} from '../api/fns/deliveries';
import { deliveryPage, phaseDeliveries } from '../api/fns/views';
import { POLL_MS } from '../api/queries';
import { createQueryClient } from '../api/query-client';
import { toast } from '../components/patterns/notice';
import { consoleRoutes } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { engineContainer, engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { pressAndDropFocus } from './press-and-drop-focus';
import { renderShell, renderRoute } from './router';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import { engineReview, stripRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/deliveries');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/views');
vi.mock('../components/patterns/notice', () => ({
  NoticeHost: () => null,
  toast: { error: vi.fn(), success: vi.fn() },
}));

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
        option_details: [null, null],
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
  vi.mocked(confirm).mockResolvedValue(fixture().decisions[0]!);
  vi.mocked(overturn).mockResolvedValue({
    record: fixture().decisions[0]!,
    wake: { state: 'sent' },
  });
  for (const fn of [deliveryUnblock, deliveryUnpark, deliveryPark, deliveryAbandon]) {
    vi.mocked(fn).mockResolvedValue({ record: fixture().delivery, wake: { state: 'sent' } });
  }
  serveViews();
  serveShell({ projects: [engineProject({ id: 'MMR', title: 'Mimir' })] });
  vi.mocked(deliveryPage).mockResolvedValue(fixture());
  vi.mocked(phaseDeliveries).mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());
const open = async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...(await renderRoute(consoleRoutes, '/p/MMR/d3', qc)), qc };
};

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

test('reads a member row’s status word in bright ink, the hue only on its dot', async () => {
  const page = fixture();
  vi.mocked(deliveryPage).mockResolvedValue({
    ...page,
    members: [
      ...page.members,
      engineTask({ id: 'MMR-5', status: 'parked', title: 'Wire the rail' }),
    ],
  });
  await open();
  const link = await screen.findByRole('link', { name: /Wire the rail/ });
  const row = link.closest<HTMLElement>('[data-row-id]');
  if (row === null) {
    throw new Error('the member has no row');
  }
  const word = within(row).getByText('Parked');
  expect(word).toHaveClass('text-ink-bright');
  expect(word.className).not.toMatch(/status-/);
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

// A delivery may name no tasks, so a phase with none can still have a live one.
test('a phase with no tasks still shows its live delivery card, on Work', async () => {
  const page = fixture();
  serveNodes({ nodes: [{ ...page.phase, distribution: {} }] });
  vi.mocked(phaseDeliveries).mockResolvedValue([{ delivery: page.delivery, members: [] }]);
  await renderRoute(consoleRoutes, '/p/MMR/2');
  const cards = await screen.findByRole('region', { name: 'Live deliveries' });
  expect(within(cards).getByRole('link', { name: /Deliver the console/ })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Work', selected: true })).toBeInTheDocument();
});

// A cached empty list may predate a delivery agreed since; only a current read hides Work for good.
test('a phase with no tasks keeps Work in its URL until its delivery read is current', async () => {
  const page = fixture();
  serveNodes({ nodes: [{ ...page.phase, distribution: {} }] });
  const answer = Promise.withResolvers<Awaited<ReturnType<typeof phaseDeliveries>>>();
  vi.mocked(phaseDeliveries).mockReturnValue(answer.promise);
  const client = createQueryClient();
  client.setQueryData(['nodes', 'deliveries', 'MMR-2'], [], { updatedAt: Date.now() - 12_000 });
  const { router } = await renderRoute(consoleRoutes, '/p/MMR/2', client);
  await screen.findByRole('tab', { name: 'Details', selected: true });
  await waitFor(() => expect(phaseDeliveries).toHaveBeenCalled());
  expect(router.state.location.searchStr).toBe('');
  answer.resolve([
    { delivery: { ...page.delivery, hold: 'none', lifecycle: 'agreed' }, members: [] },
  ]);
  await screen.findByRole('tab', { name: 'Work', selected: true });
  expect(router.state.location.searchStr).toBe('');
});

// Work's own cards read the deliveries; the page reads them only while they decide Work's tab.
test('a phase with tasks reads no deliveries off its Work tab', async () => {
  const page = fixture();
  serveNodes({ nodes: [{ ...page.phase, distribution: { ready: 1 } }] });
  await renderRoute(consoleRoutes, '/p/MMR/2?tab=timeline', createQueryClient());
  await screen.findByRole('tab', { name: /Timeline/, selected: true });
  expect(screen.getByRole('tab', { name: 'Work' })).toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(POLL_MS + 100);
  expect(phaseDeliveries).not.toHaveBeenCalled();
});

test('the delivery’s own Needs you decision omits a delivery self-link', async () => {
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
  vi.unstubAllGlobals();
});

test('decision chips name and commit the exact answer once', async () => {
  await open();
  const confirmChip = await screen.findByRole('button', {
    name: 'Confirm option 1 for MMR-q1: Keep',
  });
  expect(confirmChip).toHaveClass('max-md:min-h-11', 'inset-ring-attention/45');
  expect(confirmChip.closest('[data-row-actions]')).toBeNull();
  expect(screen.getByRole('group', { name: 'Answers for MMR-q1' })).toHaveClass('flex-wrap');
  fireEvent.click(confirmChip);
  await waitFor(() => expect(confirm).toHaveBeenCalledExactlyOnceWith({ data: { id: 'MMR-q1' } }));
});

test.each(
  (['agreed', 'running', 'milestone', 'landed', 'abandoned'] as const).flatMap((lifecycle) =>
    (['none', 'stopped', 'paused'] as const).map((hold) => ({ hold, lifecycle })),
  ),
)('delivery $lifecycle / $hold offers only legal verbs', async ({ lifecycle, hold }) => {
  const data = fixture();
  data.delivery.lifecycle = lifecycle;
  data.delivery.hold = hold;
  vi.mocked(deliveryPage).mockResolvedValue(data);
  await open();
  await screen.findByRole('heading', { name: 'Deliver the console' });
  const terminal = lifecycle === 'landed' || lifecycle === 'abandoned';
  expect(screen.queryAllByRole('button', { name: 'Clear stop' })).toHaveLength(
    !terminal && hold === 'stopped' ? 2 : 0,
  );
  expect(screen.queryAllByRole('button', { name: 'Abandon…' })).toHaveLength(terminal ? 0 : 1);
  expect(screen.queryAllByRole('button', { name: 'Pause…' })).toHaveLength(
    !terminal && hold === 'none' ? 1 : 0,
  );
  expect(screen.queryAllByRole('button', { name: 'Resume' })).toHaveLength(
    !terminal && hold === 'paused' ? 1 : 0,
  );
  expect(screen.queryByRole('button', { name: /Return|Update/ })).not.toBeInTheDocument();
});

test('Take sends only its numbered option, and a pending answer disables all chips', async () => {
  let finish!: () => void;
  vi.mocked(overturn).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ record: fixture().decisions[0]!, wake: { state: 'sent' } });
      }),
  );
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Take option 2 for MMR-q1: Remove' }));
  await waitFor(() =>
    expect(overturn).toHaveBeenCalledExactlyOnceWith({
      data: { attempt: expect.any(String), id: 'MMR-q1', option: 2 },
    }),
  );
  for (const chip of within(screen.getByRole('group', { name: 'Answers for MMR-q1' })).getAllByRole(
    'button',
  )) {
    expect(chip).toBeDisabled();
  }
  finish();
  await waitFor(() => expect(screen.getByRole('button', { name: /Take option/ })).toBeEnabled());
});

test.each(['Confirm with note', 'Answer with note'])(
  '%s requires a note, keeps refused text, and sends only the note',
  async (label) => {
    const fn = label === 'Confirm with note' ? confirm : overturn;
    vi.mocked(fn).mockRejectedValue(new Error('Refused answer'));
    await open();
    fireEvent.click(await screen.findByRole('button', { name: /Note for MMR-q1/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Answer MMR-q1' });
    expect(within(dialog).getByText('Keep the rail?')).toBeInTheDocument();
    const commit = within(dialog).getByRole('button', { name: label });
    expect(commit).toHaveClass('inset-ring-line-bright');
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '  Use neither  ' } });
    pressAndDropFocus(commit);
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    const attempt = expect.any(String);
    expect(fn).toHaveBeenCalledWith({
      data: {
        id: 'MMR-q1',
        note: 'Use neither',
        ...(label === 'Answer with note' ? { attempt } : {}),
      },
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Refused answer'));
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox')).toHaveValue('  Use neither  ');
    // Focus comes back to the commit inside the open dialog once it is enabled again.
    await waitFor(() => expect(commit).toHaveFocus());
  },
);

test('a refused one-tap decision returns focus to its chip', async () => {
  vi.mocked(confirm).mockRejectedValue(new Error('Refused answer'));
  await open();
  const chip = await screen.findByRole('button', { name: /Confirm option/ });
  pressAndDropFocus(chip);
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Refused answer'));
  await waitFor(() => expect(chip).toHaveFocus());
});

test.each(['agreed', 'running', 'milestone'] as const)(
  'unheld and paused %s deliveries offer Pause and Resume respectively',
  async (lifecycle) => {
    const data = fixture();
    data.delivery.lifecycle = lifecycle;
    data.delivery.hold = 'none';
    vi.mocked(deliveryPage).mockResolvedValue(data);
    const { qc: queryClient } = await open();
    await expect(screen.findByRole('button', { name: 'Pause…' })).resolves.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    data.delivery = { ...data.delivery, hold: 'paused' };
    await queryClient.invalidateQueries({ queryKey: ['nodes'] });
    await expect(screen.findByRole('button', { name: 'Resume' })).resolves.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause…' })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Paused' })).queryByRole('button'),
    ).not.toBeInTheDocument();
  },
);

test.each(['Pause', 'Abandon'])(
  '%s dialog requires a reason, names its commit, and retains refused text',
  async (verb) => {
    const data = fixture();
    data.delivery.hold = 'none';
    vi.mocked(deliveryPage).mockResolvedValue(data);
    const fn = verb === 'Pause' ? deliveryPark : deliveryAbandon;
    vi.mocked(fn).mockRejectedValue(new Error('Refused delivery'));
    await open();
    const chip = await screen.findByRole('button', { name: `${verb}…` });
    expect(chip).toHaveClass(
      verb === 'Abandon' ? 'inset-ring-status-blocked/35' : 'inset-ring-line-bright',
    );
    fireEvent.click(chip);
    const dialog = await screen.findByRole('dialog', { name: `${verb} MMR-d3` });
    const commit = within(dialog).getByRole('button', { name: `${verb} delivery` });
    expect(commit).toHaveClass(
      verb === 'Abandon' ? 'inset-ring-status-blocked/35' : 'inset-ring-line-bright',
    );
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(commit).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: '  Wait for access  ' },
    });
    pressAndDropFocus(commit);
    await waitFor(() =>
      expect(fn).toHaveBeenCalledExactlyOnceWith({
        data: { attempt: expect.any(String), id: 'MMR-d3', reason: 'Wait for access' },
      }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Refused delivery'));
    await waitFor(() => expect(commit).toBeEnabled());
    expect(screen.getByRole('dialog', { name: `${verb} MMR-d3` })).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox')).toHaveValue('  Wait for access  ');
    await waitFor(() => expect(commit).toHaveFocus());
  },
);

test('Clear stop shares a pending write across both places and disables every delivery verb', async () => {
  let finish!: () => void;
  vi.mocked(deliveryUnblock).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ record: fixture().delivery, wake: { state: 'sent' } });
      }),
  );
  await open();
  const chips = await screen.findAllByRole('button', { name: 'Clear stop' });
  fireEvent.click(chips[1]!);
  await waitFor(() =>
    expect(deliveryUnblock).toHaveBeenCalledExactlyOnceWith({
      data: { attempt: expect.any(String), id: 'MMR-d3' },
    }),
  );
  for (const chip of [...chips, screen.getByRole('button', { name: 'Abandon…' })]) {
    expect(chip).toBeDisabled();
  }
  fireEvent.click(chips[0]!);
  expect(deliveryUnblock).toHaveBeenCalledTimes(1);
  finish();
  await waitFor(() => expect(chips[0]).toBeEnabled());
});

test.each([false, true])(
  'after Resume focus goes to the h1 only when lost (moved=%s)',
  async (moved) => {
    const data = fixture();
    data.delivery.hold = 'paused';
    vi.mocked(deliveryPage).mockImplementation(async () => structuredClone(data));
    let finish!: () => void;
    vi.mocked(deliveryUnpark).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            data.delivery.hold = 'none';
            resolve({ record: data.delivery, wake: { state: 'sent' } });
          };
        }),
    );
    await open();
    const chip = await screen.findByRole('button', { name: 'Resume' });
    chip.focus();
    fireEvent.click(chip);
    await waitFor(() => expect(deliveryUnpark).toHaveBeenCalledTimes(1));
    const link = screen.getByRole('link', { name: 'Console phase' });
    if (moved) {
      link.focus();
    }
    finish();
    await screen.findByRole('button', { name: 'Pause…' });
    await waitFor(() =>
      expect(
        moved ? link : screen.getByRole('heading', { name: 'Deliver the console' }),
      ).toHaveFocus(),
    );
  },
);

test('offline disables decision chips and all delivery verbs', async () => {
  const { qc: queryClient } = await open();
  await screen.findByRole('button', { name: /Confirm option/ });
  vi.mocked(deliveryPage).mockRejectedValue(new Error('Offline'));
  await queryClient.invalidateQueries({ queryKey: ['nodes'] });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Confirm option/ })).toBeDisabled(),
  );
  for (const chip of [
    ...screen.getAllByRole('button', { name: 'Clear stop' }),
    screen.getByRole('button', { name: 'Abandon…' }),
    ...within(screen.getByRole('group', { name: 'Answers for MMR-q1' })).getAllByRole('button'),
  ]) {
    expect(chip).toBeDisabled();
  }
});

test('a successful Pause closes its dialog and focuses the title after its chip leaves', async () => {
  const data = fixture();
  data.delivery.hold = 'none';
  vi.mocked(deliveryPage).mockImplementation(async () => structuredClone(data));
  vi.mocked(deliveryPark).mockImplementation(async () => {
    data.delivery.hold = 'paused';
    return { record: data.delivery, wake: { state: 'sent' } };
  });
  await open();
  const chip = await screen.findByRole('button', { name: 'Pause…' });
  chip.focus();
  fireEvent.click(chip);
  const dialog = await screen.findByRole('dialog', { name: 'Pause MMR-d3' });
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Take a break' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Pause delivery' }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Deliver the console' })).toHaveFocus(),
  );
});

test.each(['Clear stop', 'Resume'])('refused %s returns focus to its own chip', async (label) => {
  const data = fixture();
  data.delivery.hold = label === 'Resume' ? 'paused' : 'stopped';
  vi.mocked(deliveryPage).mockResolvedValue(data);
  const fn = label === 'Resume' ? deliveryUnpark : deliveryUnblock;
  vi.mocked(fn).mockRejectedValue(new Error('Cannot change delivery'));
  await open();
  const chip = (await screen.findAllByRole('button', { name: label }))[0]!;
  pressAndDropFocus(chip);
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Cannot change delivery'));
  await waitFor(() => expect(chip).toHaveFocus());
});

test('the delivery Needs you section hands focus to the next decision row', async () => {
  const data = fixture();
  data.decisions.push({
    ...data.decisions[0]!,
    id: 'MMR-q2',
    question: 'Second question?',
    seq: 2,
  });
  vi.mocked(deliveryPage).mockImplementation(async () => structuredClone(data));
  vi.mocked(confirm).mockImplementation(async () => {
    const answered = data.decisions.shift()!;
    return answered;
  });
  await open();
  const chip = await screen.findByRole('button', { name: 'Confirm option 1 for MMR-q1: Keep' });
  chip.focus();
  fireEvent.click(chip);
  await waitFor(() => expect(chip).not.toBeInTheDocument());
  await waitFor(() =>
    expect(
      screen.getByRole('heading', { name: 'Second question?' }).closest('[data-row-id]'),
    ).toHaveFocus(),
  );
});

async function goOffline(queryClient: QueryClient) {
  vi.mocked(deliveryPage).mockRejectedValue(new Error('Offline'));
  await queryClient.invalidateQueries({ queryKey: ['nodes'] });
  await waitFor(() =>
    expect(screen.getByRole('button', { hidden: true, name: /Confirm option/ })).toBeDisabled(),
  );
}

function holdNone() {
  const data = fixture();
  data.delivery.hold = 'none';
  vi.mocked(deliveryPage).mockResolvedValue(data);
}

test.each(['Cancel', 'Escape'])(
  'going offline never traps an open Pause dialog (%s)',
  async (how) => {
    holdNone();
    const { qc: queryClient } = await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pause MMR-d3' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Wait' } });
    await goOffline(queryClient);
    expect(within(dialog).getByRole('button', { name: 'Pause delivery' })).toBeDisabled();
    if (how === 'Cancel') {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    } else {
      fireEvent.keyDown(within(dialog).getByRole('textbox'), { key: 'Escape' });
    }
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    // The opener is disabled offline, so focus falls back to the page title.
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
  },
);

test.each(['Pause', 'Abandon'])(
  'Cancel on %s… returns focus to the chip that opened it',
  async (verb) => {
    holdNone();
    await open();
    const chip = await screen.findByRole('button', { name: `${verb}…` });
    chip.focus();
    fireEvent.click(chip);
    const dialog = await screen.findByRole('dialog', { name: `${verb} MMR-d3` });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(chip).toHaveFocus());
  },
);

test('the Note dialog scrolls inside the viewport and wraps a long question', async () => {
  const data = fixture();
  data.decisions[0]!.question = `https://example.test/${'x'.repeat(200)}`;
  vi.mocked(deliveryPage).mockResolvedValue(data);
  await open();
  fireEvent.click(await screen.findByRole('button', { name: /Note for MMR-q1/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Answer MMR-q1' });
  expect(dialog).toHaveClass('max-h-[min(88dvh,var(--visual-viewport-height,100dvh))]');
  expect(dialog).toHaveClass('overflow-y-auto');
  expect(within(dialog).getByText(data.decisions[0]!.question)).toHaveClass('wrap-anywhere');
});

test('two synchronous clicks on a Take chip make one overturn', async () => {
  await open();
  const chip = await screen.findByRole('button', { name: 'Take option 2 for MMR-q1: Remove' });
  fireEvent.click(chip);
  fireEvent.click(chip);
  await waitFor(() => expect(overturn).toHaveBeenCalledTimes(1));
});

test('Take then Confirm in quick succession writes only the first', async () => {
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Take option 2 for MMR-q1: Remove' }));
  fireEvent.click(screen.getByRole('button', { name: /Confirm option 1/ }));
  await waitFor(() => expect(overturn).toHaveBeenCalledTimes(1));
  expect(confirm).not.toHaveBeenCalled();
});

test('two synchronous clicks on Answer with note make one overturn', async () => {
  await open();
  fireEvent.click(await screen.findByRole('button', { name: /Note for MMR-q1/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Answer MMR-q1' });
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Neither' } });
  const commit = within(dialog).getByRole('button', { name: 'Answer with note' });
  fireEvent.click(commit);
  fireEvent.click(commit);
  await waitFor(() => expect(overturn).toHaveBeenCalledTimes(1));
});

test('two synchronous clicks on Clear stop make one unblock', async () => {
  await open();
  const chip = (await screen.findAllByRole('button', { name: 'Clear stop' }))[0]!;
  fireEvent.click(chip);
  fireEvent.click(chip);
  await waitFor(() => expect(deliveryUnblock).toHaveBeenCalledTimes(1));
});

test('a double click on Pause delivery makes one park', async () => {
  holdNone();
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Pause…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Pause MMR-d3' });
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Wait' } });
  const commit = within(dialog).getByRole('button', { name: 'Pause delivery' });
  fireEvent.click(commit);
  fireEvent.click(commit);
  await waitFor(() => expect(deliveryPark).toHaveBeenCalledTimes(1));
});

test('a refused chip refocuses only once it is enabled again', async () => {
  let refuse!: () => void;
  vi.mocked(confirm).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        refuse = () => reject(new Error('Refused answer'));
      }),
  );
  await open();
  const chip = await screen.findByRole('button', { name: /Confirm option/ });
  pressAndDropFocus(chip);
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  const focusSpy = vi.spyOn(chip, 'focus');
  refuse();
  await waitFor(() => expect(chip).toHaveFocus());
  expect(focusSpy).toHaveBeenCalledTimes(1);
  expect(chip).toBeEnabled();
});

test.each(['decision chip', 'delivery verb'])(
  'a %s refused while offline takes focus back once the console is online again',
  async (kind) => {
    let refuse!: () => void;
    const pending = () =>
      new Promise<never>((_resolve, reject) => {
        refuse = () => reject(new Error('Refused write'));
      });
    const online = fixture();
    if (kind === 'decision chip') {
      vi.mocked(confirm).mockImplementation(pending);
    } else {
      online.delivery.hold = 'paused';
      vi.mocked(deliveryUnpark).mockImplementation(pending);
    }
    vi.mocked(deliveryPage).mockResolvedValue(online);
    const { qc: queryClient } = await open();
    const chip = await screen.findByRole('button', {
      name: kind === 'decision chip' ? /Confirm option/ : 'Resume',
    });
    pressAndDropFocus(chip);
    await waitFor(() =>
      expect(kind === 'decision chip' ? confirm : deliveryUnpark).toHaveBeenCalledTimes(1),
    );
    await goOffline(queryClient);
    refuse();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Refused write'));
    expect(chip).toBeDisabled();
    expect(chip).not.toHaveFocus();
    // Back online: the chip is enabled again and takes the focus it lost.
    vi.mocked(deliveryPage).mockResolvedValue(online);
    await queryClient.invalidateQueries({ queryKey: ['nodes'] });
    await waitFor(() => expect(chip).toBeEnabled());
    await waitFor(() => expect(chip).toHaveFocus());
  },
);
