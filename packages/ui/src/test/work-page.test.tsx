import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/errors';
import type { WireArtifact, WireNode, WireTreeNode, WireWorkReport } from '../api/types';
import { router } from '../router';
import { emptyRead, task, workReport } from './fixtures';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));

// Mon Oct 12 2026, 18:00 in the suite's pinned zone (America/New_York).
const NOW = Date.parse('2026-10-12T22:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60_000).toISOString();

beforeEach(() => {
  apiGet.mockReset();
  apiSend.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function leaf(id: string, status: WireNode['status'], title = `task ${id}`): WireTreeNode {
  return { ...task({ id, status, title }), children: [] };
}

function node(
  id: string,
  type: 'initiative' | 'phase',
  status: WireNode['status'],
  title: string,
  children: WireTreeNode[] = [],
  extra: Partial<WireNode> = {},
): WireTreeNode {
  return { ...task({ id, status, title }), ...extra, children, type };
}

/** The project's whole tree: live and finished initiatives, an open-ended and a parked one. */
const TREE: WireTreeNode = {
  ...task({ id: 'MMR', status: 'in_progress', title: 'Mimir' }),
  children: [
    node('MMR-101', 'initiative', 'in_progress', 'Console work', [
      node('MMR-102', 'phase', 'done', 'Record pages', [
        leaf('MMR-103', 'done'),
        leaf('MMR-104', 'done'),
      ]),
      node('MMR-105', 'phase', 'in_progress', 'Work page', [
        leaf('MMR-106', 'done'),
        leaf('MMR-107', 'ready'),
      ]),
    ]),
    node('MMR-108', 'initiative', 'ready', 'Maintenance', [], { open_ended: true }),
    node('MMR-109', 'initiative', 'parked', 'Post-v1 ideas', [leaf('MMR-110', 'parked')]),
    node('MMR-111', 'initiative', 'done', 'Old arc', [
      node('MMR-112', 'phase', 'done', 'Old phase', [leaf('MMR-113', 'done')]),
    ]),
    leaf('MMR-114', 'ready', 'A loose task'),
  ],
  type: 'project',
};

const PROJECT: WireNode = {
  ...task({ id: 'MMR', status: 'in_progress', title: 'Mimir' }),
  artifacts: [
    { created_at: '2026-06-01T10:00:00.000Z', id: 'MMR-a7', tags: [], title: 'Shaping brief' },
  ],
  description: 'The **work** tool.',
  distribution: { done: 3, in_progress: 1, parked: 1 },
  next: 'Ship the work page.\n\nThen the review page.',
  target: '0.24.0',
  type: 'project',
};

const PHASE: WireNode = {
  ...task({ id: 'MMR-105', status: 'in_progress', title: 'Work page' }),
  deps: {
    blocking: [{ id: 'MMR-115', status: 'new', title: 'Review page' }],
    depends_on: [{ id: 'MMR-102', status: 'done', title: 'Record pages' }],
  },
  description: 'One page for every scope.',
  distribution: { done: 1, ready: 1 },
  next: 'Land the sections.\n\nThen the actions.',
  parent: 'MMR-101',
  type: 'phase',
};

type Scope = {
  name: string;
  record: WireNode;
  recordPath: string;
  url: string;
  workPath: string;
};

const PROJECT_SCOPE: Scope = {
  name: 'project',
  record: PROJECT,
  recordPath: '/api/projects/MMR',
  url: '/p/MMR',
  workPath: '/api/projects/MMR/work',
};

const PHASE_SCOPE: Scope = {
  name: 'phase',
  record: PHASE,
  recordPath: '/api/nodes/MMR-105',
  url: '/p/MMR/105',
  workPath: '/api/nodes/MMR-105/work',
};

const SCOPES = [PROJECT_SCOPE, PHASE_SCOPE];

/** Serve the scope's record, the project tree, and `report` at its work route. */
function serve(scope: Scope, report: WireWorkReport | Error = workReport(), tree = TREE) {
  apiGet.mockImplementation((path: string) => {
    if (path.startsWith(`${scope.workPath}?`)) {
      return report instanceof Error ? Promise.reject(report) : Promise.resolve(report);
    }
    if (path === scope.recordPath) {
      return Promise.resolve(scope.record);
    }
    if (path === '/api/projects/MMR/tree') {
      return Promise.resolve(tree);
    }
    return Promise.resolve(emptyRead(path));
  });
}

function renderAt(url: string) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [url] }),
    routeTree: router.routeTree,
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return testRouter;
}

/** Serve `report` for the scope, open its page, and wait for the title. */
async function open(scope: Scope, report?: WireWorkReport | Error, tree?: WireTreeNode) {
  serve(scope, report, tree);
  const testRouter = renderAt(scope.url);
  await screen.findByRole('heading', { level: 1, name: scope.record.title });
  return testRouter;
}

const getRail = () => screen.getByRole('complementary', { name: 'Record details' });
const section = (name: string) => screen.findByRole('region', { name });
/** A row's action buttons, grouped and named for the task they act on. */
const actionsOf = (id: string) => screen.findByRole('group', { name: `Actions for ${id}` });
const hrefOf = (within_: HTMLElement, name: string | RegExp) =>
  within(within_).getByRole('link', { name }).getAttribute('href');

const nowRow = {
  ...task({
    branch: 'feat/dialect',
    harness: 'claude-code',
    id: 'MMR-11',
    status: 'in_progress',
    title: 'Wire the dialect',
  }),
  latest_note: { content: 'Seam extracted', created_at: minutesAgo(9) },
  scratchpads: [{ id: 'MMR-p1', title: 'Cutover episode' }],
  stale: false,
  started_at: minutesAgo(41),
};

const reviewRow = {
  ...task({ id: 'MMR-12', status: 'under_review', title: 'Extract the seam' }),
  question: null,
  reason: 'under_review' as const,
  stale: false,
};

const blockedRow = {
  ...task({
    block_owner: 'you',
    hold: 'blocked',
    hold_reason: 'Waiting on your sign-off',
    id: 'MMR-13',
    status: 'blocked',
    title: 'Record health copy',
  }),
  question: null,
  reason: 'blocked' as const,
  stale: false,
};

const answersRow = {
  ...task({
    grooming: 'needs_answers',
    id: 'MMR-14',
    status: 'ready',
    title: 'Refuse to open unmigrated stores',
  }),
  question: 'Should it refuse, or warn?',
  reason: 'needs_answers' as const,
  stale: false,
};

const frontierRow = (id: string, title: string, extra: Partial<WireNode> = {}) => ({
  ...task({ grooming: 'groomed', id, status: 'ready', title, ...extra }),
  awaiting_on: [],
  break_down: false,
  stale: false,
});

const shippedRow = (id: string, at: string, extra: Partial<WireNode> = {}) => ({
  ...task({ id, status: 'done', title: `Shipped ${id}`, ...extra }),
  abandon_reason: null,
  finished_at: at,
  stale: false,
});

describe.each(SCOPES)('work page sections, $name', (scope) => {
  it('asks for its own work route, in the browser’s time zone', async () => {
    await open(scope);

    const asked = apiGet.mock.calls.map(([path]) => path as string);
    expect(asked).toContain(`${scope.workPath}?tz=America%2FNew_York`);
  });

  it('lists what is running, with when it started, where, and its latest note', async () => {
    await open(scope, workReport({ now: [nowRow] }));

    const now = await section('Now · 1');
    expect(hrefOf(now, 'Wire the dialect')).toBe('/p/MMR/11');
    expect(now).toHaveTextContent('Started 41m ago');
    expect(now).toHaveTextContent('claude-code');
    expect(now).toHaveTextContent('feat/dialect');
    expect(now).toHaveTextContent('Scratchpad open');
    expect(now).toHaveTextContent('Latest note, 9m ago: “Seam extracted”');
  });

  it('lists what needs you with why, and the question a needs-answers task asks', async () => {
    await open(scope, workReport({ needs_you: [reviewRow, blockedRow, answersRow] }));

    const needs = await section('Needs you · 3');
    expect(hrefOf(needs, 'Extract the seam')).toBe('/p/MMR/12');
    expect(needs).toHaveTextContent('In review');
    expect(hrefOf(needs, 'Record health copy')).toBe('/p/MMR/13');
    expect(needs).toHaveTextContent('Blocked · yours');
    expect(needs).toHaveTextContent('Waiting on your sign-off');
    expect(hrefOf(needs, 'Refuse to open unmigrated stores')).toBe('/p/MMR/14');
    expect(within(needs).getByText('needs answers')).toBeDefined();
    expect(needs).toHaveTextContent('Should it refuse, or warn?');
    // A block's row offers no action here; the task page clears it.
    expect(within(needs).queryByRole('group', { name: 'Actions for MMR-13' })).toBeNull();
  });

  it('splits the frontier: runnable, next to unlock under its prerequisite, and to groom', async () => {
    await open(
      scope,
      workReport({
        frontier: {
          next_to_unlock: [
            {
              prerequisite: { id: 'MMR-11', status: 'in_progress', title: 'Wire the dialect' },
              tasks: [
                {
                  ...frontierRow('MMR-21', 'Remove the old backend', { size: 'large' }),
                  awaiting_on: ['MMR-11'],
                },
              ],
            },
          ],
          runnable: [frontierRow('MMR-20', 'Add the SQLite dialect')],
          to_groom: [
            frontierRow('MMR-22', 'Triage the flaky suite', { grooming: 'not_groomed' }),
            {
              ...task({ id: 'MMR-23', status: 'new', title: 'Hosted backends' }),
              awaiting_on: [],
              break_down: true,
              stale: false,
              type: 'initiative' as const,
            },
          ],
          waiting_on_others: [],
        },
      }),
    );

    const runnable = await section('Runnable now');
    expect(hrefOf(runnable, 'Add the SQLite dialect')).toBe('/p/MMR/20');
    expect(within(runnable).getByText('groomed')).toBeDefined();

    const unlock = await section('Next to unlock');
    expect(hrefOf(unlock, 'MMR-11')).toBe('/p/MMR/11');
    expect(unlock).toHaveTextContent('After MMR-11');
    expect(hrefOf(unlock, 'Remove the old backend')).toBe('/p/MMR/21');
    expect(within(unlock).getByText('l')).toBeDefined();

    const groom = await section('To groom');
    expect(hrefOf(groom, 'Triage the flaky suite')).toBe('/p/MMR/22');
    expect(within(groom).getByText('not groomed')).toBeDefined();
    expect(hrefOf(groom, 'Hosted backends')).toBe('/p/MMR/23');
    expect(groom).toHaveTextContent('initiative');
    expect(within(groom).getByText('break down')).toBeDefined();

    // Only a runnable row can be started from here.
    expect(within(runnable).getByRole('button', { name: 'Start' })).toBeDefined();
    expect(within(unlock).queryByRole('button')).toBeNull();
    expect(within(groom).queryByRole('button')).toBeNull();
  });

  it('folds what waits on others until opened, each row with its reason', async () => {
    await open(
      scope,
      workReport({
        frontier: {
          next_to_unlock: [],
          runnable: [],
          to_groom: [],
          waiting_on_others: [
            {
              ...task({
                block_owner: 'others',
                hold: 'blocked',
                id: 'MMR-24',
                status: 'blocked',
                title: 'Vendor key rotation',
              }),
              block_reason: 'Vendor has not replied',
              stale: false,
            },
          ],
        },
      }),
    );

    const frontier = await section('Frontier');
    const waiting = within(frontier).getByText('Waiting on others · 1').closest('details');
    expect(waiting).not.toBeNull();
    expect(waiting).not.toHaveAttribute('open');
    expect(within(frontier).getByText('Vendor has not replied')).not.toBeVisible();

    fireEvent.click(within(frontier).getByText('Waiting on others · 1'));

    expect(within(frontier).getByText('Vendor has not replied')).toBeVisible();
    expect(hrefOf(frontier, 'Vendor key rotation')).toBe('/p/MMR/24');
  });

  it('groups what shipped by day, caps a day at three until expanded, and strikes an abandoned task', async () => {
    await open(
      scope,
      workReport({
        shipped: [
          shippedRow('MMR-31', '2026-10-12T20:30:00.000Z'),
          shippedRow('MMR-32', '2026-10-12T19:00:00.000Z'),
          shippedRow('MMR-33', '2026-10-12T17:00:00.000Z'),
          shippedRow('MMR-34', '2026-10-12T16:00:00.000Z'),
          shippedRow('MMR-35', '2026-10-12T14:00:00.000Z'),
          shippedRow('MMR-36', '2026-10-11T15:00:00.000Z'),
          {
            ...shippedRow('MMR-37', '2026-10-10T18:05:00.000Z', {
              status: 'abandoned',
              title: 'Converge needs consent',
            }),
            abandon_reason: 'moot under ADR 0032',
          },
        ],
      }),
    );

    const shipped = await section('Shipped · 7');
    expect(within(shipped).getByText('Today · Mon Oct 12')).toBeDefined();
    expect(within(shipped).getByText('Yesterday · Sun Oct 11')).toBeDefined();
    expect(within(shipped).getByText('Sat Oct 10')).toBeDefined();
    expect(hrefOf(shipped, 'Shipped MMR-31')).toBe('/p/MMR/31');
    expect(shipped).toHaveTextContent('16:30');
    // Today holds five; three show, and the rest sit behind "2 more".
    expect(within(shipped).queryByText('Shipped MMR-34')).toBeNull();
    fireEvent.click(
      within(shipped).getByRole('button', { name: 'Show 2 more shipped on Today · Mon Oct 12' }),
    );
    // Focus moves to the first revealed row rather than falling to the page.
    expect(document.activeElement).toBe(
      within(shipped).getByRole('link', { name: 'Shipped MMR-34' }),
    );
    expect(within(shipped).getByText('Shipped MMR-34')).toBeDefined();
    expect(within(shipped).getByText('Shipped MMR-35')).toBeDefined();
    expect(within(shipped).queryByRole('button', { name: /more shipped/ })).toBeNull();

    const abandoned = within(shipped).getByRole('link', { name: 'Converge needs consent' });
    expect(abandoned.className).toContain('line-through');
    expect(shipped).toHaveTextContent('Abandoned: moot under ADR 0032');
    expect(shipped).toHaveTextContent('14:05');
  });

  it('marks a stale row in its section and again in going cold', async () => {
    const stale = { ...frontierRow('MMR-20', 'Add the SQLite dialect'), stale: true };
    await open(
      scope,
      workReport({
        frontier: { next_to_unlock: [], runnable: [stale], to_groom: [], waiting_on_others: [] },
        going_cold: [{ ...stale, updated_at: daysAgo(20) }],
      }),
    );

    const frontier = await section('Frontier');
    expect(within(frontier).getByText('⧗ stale')).toBeDefined();
    const cold = await section('Going cold · 1');
    expect(hrefOf(cold, 'Add the SQLite dialect')).toBe('/p/MMR/20');
    expect(within(cold).getByText('⧗ stale')).toBeDefined();
    expect(cold).toHaveTextContent('2w quiet');
  });

  it('says what each empty section means', async () => {
    await open(scope);

    await expect(section('Now')).resolves.toHaveTextContent(
      'Nothing running. No task is in progress.',
    );
    await expect(section('Needs you')).resolves.toHaveTextContent(
      'Nothing needs you. No reviews, blocks, or questions are waiting.',
    );
    await expect(section('Frontier')).resolves.toHaveTextContent(
      'The frontier is empty. No task is ready or one step from ready.',
    );
    const shipped = await section('Shipped');
    expect(shipped).toHaveTextContent('Nothing shipped in the last 7 days.');
    expect(
      within(shipped).getByRole('link', { name: 'Finished tasks →' }).getAttribute('href'),
    ).toBe('/tasks?project=MMR&status=terminal');
    await expect(section('Going cold')).resolves.toHaveTextContent(
      'Nothing stale. Everything here has moved recently.',
    );
  });

  it('offers New task from an empty frontier', async () => {
    await open(scope);

    const frontier = await section('Frontier');
    expect(within(frontier).getByRole('button', { name: 'New task' })).toBeDefined();
  });

  it('keeps Runnable now, with its hint, when the other frontier groups are empty', async () => {
    await open(
      scope,
      workReport({
        frontier: {
          next_to_unlock: [],
          runnable: [],
          to_groom: [],
          waiting_on_others: [
            {
              ...task({ hold: 'blocked', id: 'MMR-24', status: 'blocked', title: 'Vendor key' }),
              block_reason: null,
              stale: false,
            },
          ],
        },
      }),
    );

    await expect(section('Runnable now')).resolves.toHaveTextContent('Nothing runnable yet.');
    expect(screen.queryByRole('region', { name: 'Next to unlock' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'To groom' })).toBeNull();
    expect(screen.queryByText(/frontier is empty/)).toBeNull();
  });

  it('shows skeletons while the work read is pending', async () => {
    serve(scope);
    const served = apiGet.getMockImplementation();
    apiGet.mockImplementation((path: string) =>
      path.startsWith(`${scope.workPath}?`) ? Promise.withResolvers().promise : served?.(path),
    );
    renderAt(scope.url);

    await screen.findByRole('heading', { level: 1, name: scope.record.title });
    expect(document.querySelector('[aria-busy]')).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
  });

  it('says so when the work read fails with nothing cached, while the rail still renders', async () => {
    await open(scope, new TypeError('fetch failed'));

    await expect(screen.findByText(/couldn’t load the work page/i)).resolves.toHaveTextContent(
      'is `mimir serve` running?',
    );
    const rail = screen.getByRole('complementary', { name: 'Record details' });
    expect(within(rail).getByText(scope.record.next?.split('\n')[0] ?? '')).toBeDefined();
  });

  it('does not ask whether the server is running when it answered with a failure', async () => {
    await open(scope, new ApiError('GET → 500', 500));

    const message = await screen.findByText(/couldn’t load the work page/i);
    expect(message).toHaveTextContent('Couldn’t load the work page.');
    expect(message).not.toHaveTextContent('mimir serve');
  });
});

describe.each(SCOPES)('work page rail, $name', (scope) => {
  it('runs Direction, Structure, About, Artifacts (when it has any), then Other views', async () => {
    await open(scope);

    const labels = within(getRail())
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(labels).toStrictEqual([
      'Direction',
      'Structure',
      'About',
      ...((scope.record.artifacts ?? []).length > 0 ? ['Artifacts'] : []),
      'Other views',
    ]);
  });

  it('shows the direction in full, editable in place', async () => {
    await open(scope);

    const [first, second] = (scope.record.next ?? '').split('\n\n');
    expect(within(getRail()).getByText(first ?? '')).toBeDefined();
    expect(within(getRail()).getByText(second ?? '')).toBeDefined();
    fireEvent.click(within(getRail()).getByRole('button', { name: 'Edit direction' }));
    await expect(screen.findByRole('textbox', { name: 'Direction text' })).resolves.toHaveValue(
      scope.record.next,
    );
  });

  it('outlines initiatives and phases with progress, ∞, parked, and finished work folded', async () => {
    await open(scope);

    const structure = await within(getRail()).findByRole('navigation', { name: 'Structure' });
    const all = within(structure).getByRole('link', { name: /All work/ });
    expect(all.getAttribute('href')).toBe('/p/MMR');
    expect(all).toHaveTextContent('1/5');
    const live = within(structure).getByRole('link', { name: /Console work/ });
    expect(live.getAttribute('href')).toBe('/p/MMR/101');
    expect(live).toHaveTextContent('1/2');
    expect(within(structure).getByRole('link', { name: /Record pages/ })).toHaveTextContent('2/2');
    expect(within(structure).getByRole('link', { name: /Maintenance/ })).toHaveTextContent('∞');
    expect(within(structure).getByRole('link', { name: /Post-v1 ideas/ })).toHaveTextContent(
      'parked',
    );
    // Tasks are not in the outline.
    expect(within(structure).queryByText('A loose task')).toBeNull();
    // One finished initiative folds shut.
    const fold = within(structure).getByText('1 finished initiative').closest('details');
    expect(fold).not.toHaveAttribute('open');
    expect(within(structure).getByText('Old arc')).not.toBeVisible();
    fireEvent.click(within(structure).getByText('1 finished initiative'));
    expect(within(structure).getByText('Old arc')).toBeVisible();
  });

  it('marks the current scope in the outline', async () => {
    await open(scope);

    const structure = await within(getRail()).findByRole('navigation', { name: 'Structure' });
    const current = within(structure)
      .getAllByRole('link')
      .filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent(scope.name === 'project' ? 'All work' : 'Work page');
  });

  it('says so when the structure cannot be read', async () => {
    serve(scope);
    const served = apiGet.getMockImplementation();
    apiGet.mockImplementation((path: string) =>
      path === '/api/projects/MMR/tree'
        ? Promise.reject(new TypeError('fetch failed'))
        : served?.(path),
    );
    renderAt(scope.url);

    await expect(screen.findByText(/couldn’t load the structure/i)).resolves.toBeDefined();
  });

  it('holds the description, artifacts, and details in About', async () => {
    await open(scope);

    const about = within(getRail()).getByRole('heading', { name: 'About' }).closest('section');
    expect(about).not.toBeNull();
    const panel = within(about as HTMLElement);
    expect(about).toHaveTextContent((scope.record.description ?? '').replaceAll('**', ''));
    expect(panel.getByText('created')).toBeDefined();
    expect(panel.getByText('updated')).toBeDefined();
  });

  it('links to the board and to the project’s tasks', async () => {
    await open(scope);

    const views = within(getRail()).getByRole('navigation', { name: 'Other views' });
    expect(within(views).getByRole('link', { name: 'Board' }).getAttribute('href')).toBe(
      '/p/MMR/board',
    );
    expect(within(views).getByRole('link', { name: 'All tasks in MMR' }).getAttribute('href')).toBe(
      '/tasks?project=MMR',
    );
  });

  it('opens each rail part as a phone sheet with the same content', async () => {
    await open(scope);
    const chips = screen.getByRole('group', { name: 'Record details' });
    expect(
      within(chips)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toStrictEqual([
      'Direction',
      'Structure',
      'About',
      ...((scope.record.artifacts ?? []).length > 0 ? ['Artifacts'] : []),
      'Other views',
    ]);

    fireEvent.click(within(chips).getByRole('button', { name: 'Direction' }));
    const direction = await screen.findByRole('dialog', { name: 'Direction' });
    expect(
      within(direction).getByText((scope.record.next ?? '').split('\n\n')[0] ?? ''),
    ).toBeDefined();
    fireEvent.click(within(direction).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    fireEvent.click(within(chips).getByRole('button', { name: 'Structure' }));
    const structure = await screen.findByRole('dialog', { name: 'Structure' });
    expect(
      (await within(structure).findByRole('link', { name: /Console work/ })).getAttribute('href'),
    ).toBe('/p/MMR/101');
    fireEvent.click(within(structure).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    fireEvent.click(within(chips).getByRole('button', { name: 'About' }));
    const about = await screen.findByRole('dialog', { name: 'About' });
    expect(within(about).getByText('created')).toBeDefined();
    fireEvent.click(within(about).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    fireEvent.click(within(chips).getByRole('button', { name: 'Other views' }));
    const views = await screen.findByRole('dialog', { name: 'Other views' });
    expect(within(views).getByRole('link', { name: 'Board' }).getAttribute('href')).toBe(
      '/p/MMR/board',
    );
  });
});

describe('work page structure inside finished work', () => {
  const oldPhase: Scope = {
    name: 'phase',
    record: { ...PHASE, id: 'MMR-112', parent: 'MMR-111', title: 'Old phase' },
    recordPath: '/api/nodes/MMR-112',
    url: '/p/MMR/112',
    workPath: '/api/nodes/MMR-112/work',
  };

  it('opens the finished fold and marks the current phase when it sits under a finished initiative', async () => {
    await open(oldPhase);

    const structure = await within(getRail()).findByRole('navigation', { name: 'Structure' });
    const fold = within(structure).getByText('1 finished initiative').closest('details');
    expect(fold).toHaveAttribute('open');
    const current = within(structure).getByRole('link', { name: /Old phase/ });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(within(structure).getByRole('link', { name: /All work/ })).not.toHaveAttribute(
      'aria-current',
    );
  });
});

/**
 * Serve `before` at the project's work route until a write lands, then `after`,
 * the way the server's next read reflects the action.
 */
async function openForWrite(before: WireWorkReport, after: WireWorkReport) {
  let report = before;
  serve(PROJECT_SCOPE);
  const served = apiGet.getMockImplementation();
  apiGet.mockImplementation((path: string) =>
    path.startsWith(`${PROJECT_SCOPE.workPath}?`) ? Promise.resolve(report) : served?.(path),
  );
  apiSend.mockImplementation(() => {
    report = after;
    return Promise.resolve({});
  });
  renderAt(PROJECT_SCOPE.url);
  await screen.findByRole('heading', { level: 1, name: PROJECT.title });
}

/** Accept writes, and hold the project's next work read until the test resolves it. */
function holdRefresh() {
  const refresh = Promise.withResolvers<WireWorkReport>();
  const served = apiGet.getMockImplementation();
  apiGet.mockImplementation((path: string) =>
    path.startsWith(`${PROJECT_SCOPE.workPath}?`) ? refresh.promise : served?.(path),
  );
  apiSend.mockResolvedValue({});
  return refresh;
}

const runningAs = (row: { id: string; title: string }) => ({
  ...nowRow,
  branch: null,
  harness: null,
  id: row.id,
  latest_note: null,
  scratchpads: [],
  title: row.title,
});

describe('work page row actions', () => {
  it('starts a runnable task, which then shows under Now', async () => {
    const runnable = frontierRow('MMR-20', 'Add the SQLite dialect');
    await openForWrite(
      workReport({ frontier: { ...workReport().frontier, runnable: [runnable] } }),
      workReport({ now: [runningAs(runnable)] }),
    );

    fireEvent.click(within(await actionsOf('MMR-20')).getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-20/start', undefined);
    });
    const now = await section('Now · 1');
    expect(hrefOf(now, 'Add the SQLite dialect')).toBe('/p/MMR/20');
    expect(screen.queryByRole('region', { name: 'Runnable now' })).toBeNull();
  });

  it('approves a task in review, which then shows under Shipped', async () => {
    await openForWrite(
      workReport({ needs_you: [reviewRow] }),
      workReport({ shipped: [shippedRow('MMR-12', minutesAgo(1), { title: 'Extract the seam' })] }),
    );

    fireEvent.click(within(await actionsOf('MMR-12')).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-12/done', undefined);
    });
    const shipped = await section('Shipped · 1');
    expect(hrefOf(shipped, 'Extract the seam')).toBe('/p/MMR/12');
    await expect(section('Needs you')).resolves.toHaveTextContent('Nothing needs you.');
  });

  it('sends a task in review back with a reason, and it returns to Now', async () => {
    await openForWrite(
      workReport({ needs_you: [reviewRow] }),
      workReport({ now: [runningAs(reviewRow)] }),
    );

    fireEvent.click(within(await actionsOf('MMR-12')).getByRole('button', { name: 'Send back…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back' });
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Cover the empty case' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-12/return', {
        reason: 'Cover the empty case',
      });
    });
    const now = await section('Now · 1');
    expect(hrefOf(now, 'Extract the seam')).toBe('/p/MMR/12');
    await expect(section('Needs you')).resolves.toHaveTextContent('Nothing needs you.');
  });

  it('answers a question and sets the grooming state, and the task moves to the frontier', async () => {
    await openForWrite(
      workReport({ needs_you: [answersRow] }),
      workReport({
        frontier: {
          ...workReport().frontier,
          runnable: [frontierRow('MMR-14', 'Refuse to open unmigrated stores')],
        },
      }),
    );

    fireEvent.click(within(await actionsOf('MMR-14')).getByRole('button', { name: 'Answer…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    expect(dialog).toHaveTextContent('Should it refuse, or warn?');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /answer/i }), {
      target: { value: 'Refuse, and name the export command.' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^groomed/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Answer' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-14/groom', {
        note: 'Refuse, and name the export command.',
        state: 'groomed',
      });
    });
    const runnable = await section('Runnable now');
    expect(hrefOf(runnable, 'Refuse to open unmigrated stores')).toBe('/p/MMR/14');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Answer' })).toBeNull();
    });
    await expect(section('Needs you')).resolves.toHaveTextContent('Nothing needs you.');
  });

  it('sends a task back with no body when no reason is given', async () => {
    await openForWrite(
      workReport({ needs_you: [reviewRow] }),
      workReport({ now: [runningAs(reviewRow)] }),
    );

    fireEvent.click(within(await actionsOf('MMR-12')).getByRole('button', { name: 'Send back…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-12/return', undefined);
    });
  });

  it('keeps a row’s buttons off until the sections have refreshed, so one tap writes once', async () => {
    await open(PROJECT_SCOPE, workReport({ needs_you: [reviewRow] }));
    // The write lands, but the refreshed sections are still on their way.
    const refresh = holdRefresh();

    const approve = within(await actionsOf('MMR-12')).getByRole('button', { name: 'Approve' });
    fireEvent.click(approve);
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledOnce();
    });
    expect(approve).toBeDisabled();
    expect(
      within(await actionsOf('MMR-12')).getByRole('button', { name: 'Send back…' }),
    ).toBeDisabled();

    refresh.resolve(workReport());
    await expect(section('Needs you')).resolves.toHaveTextContent('Nothing needs you.');
  });

  it('keeps the answer dialog open until the sections have refreshed', async () => {
    await open(PROJECT_SCOPE, workReport({ needs_you: [answersRow] }));
    const refresh = holdRefresh();

    fireEvent.click(within(await actionsOf('MMR-14')).getByRole('button', { name: 'Answer…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /answer/i }), {
      target: { value: 'Refuse.' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^groomed/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Answer' }));
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledOnce();
    });
    expect(within(dialog).getByRole('button', { name: 'Answer' })).toBeDisabled();

    refresh.resolve(workReport());
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Answer' })).toBeNull();
    });
  });

  it('asks for what is still open when the answer keeps the task at needs answers', async () => {
    await open(PROJECT_SCOPE, workReport({ needs_you: [answersRow] }));

    fireEvent.click(within(await actionsOf('MMR-14')).getByRole('button', { name: 'Answer…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    expect(within(dialog).getByRole('textbox', { name: 'Answer (required)' })).toBeDefined();

    fireEvent.click(within(dialog).getByRole('radio', { name: /^needs answers/ }));
    expect(
      within(dialog).getByRole('textbox', { name: 'Answer, and what is still open (required)' }),
    ).toBeDefined();
  });

  it('needs both an answer and a chosen state before it answers', async () => {
    await open(PROJECT_SCOPE, workReport({ needs_you: [answersRow] }));

    fireEvent.click(within(await actionsOf('MMR-14')).getByRole('button', { name: 'Answer…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    const submit = within(dialog).getByRole('button', { name: 'Answer' });
    // No state is chosen for the operator: the grooming call is theirs to make.
    for (const radio of within(dialog).getAllByRole('radio')) {
      expect(radio).not.toBeChecked();
    }
    expect(submit).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('radio', { name: /^needs answers/ }));
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: /answer/i }), {
      target: { value: '   ' },
    });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: /answer/i }), {
      target: { value: 'Partly: refuse. Still open: the flag name.' },
    });
    expect(submit).toBeEnabled();
  });
});

const secondReview = {
  ...reviewRow,
  ...task({ id: 'MMR-15', status: 'under_review', title: 'Name the seam' }),
};
/** Press a row's button the way a keyboard does: focused first, then activated. */
const press = async (id: string, name: string) => {
  const button = within(await actionsOf(id)).getByRole('button', { name });
  button.focus();
  fireEvent.click(button);
};

describe('work page focus after an acted-on row moves away', () => {
  it('lands on the next row’s actions after Approve moves a row out of Needs you', async () => {
    await openForWrite(
      workReport({ needs_you: [reviewRow, secondReview] }),
      workReport({ needs_you: [secondReview] }),
    );

    await press('MMR-12', 'Approve');

    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Actions for MMR-12' })).toBeNull();
    });
    expect(
      within(await actionsOf('MMR-15')).getByRole('button', { name: 'Approve' }),
    ).toHaveFocus();
  });

  it('lands on the section heading when the moved row had no row after it', async () => {
    await openForWrite(
      workReport({ needs_you: [secondReview, reviewRow] }),
      workReport({ needs_you: [secondReview] }),
    );

    await press('MMR-12', 'Approve');

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: /^Needs you · 1/ })).toHaveFocus();
    });
  });

  it('lands on the next runnable row’s Start after Start moves a row to Now', async () => {
    const first = frontierRow('MMR-20', 'Add the SQLite dialect');
    const second = frontierRow('MMR-21', 'Add the Postgres dialect');
    const runnable = (rows: (typeof first)[]) => ({ ...workReport().frontier, runnable: rows });
    await openForWrite(
      workReport({ frontier: runnable([first, second]) }),
      workReport({ frontier: runnable([second]), now: [runningAs(first)] }),
    );

    await press('MMR-20', 'Start');

    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Actions for MMR-21' })).getByRole('button', {
          name: 'Start',
        }),
      ).toHaveFocus();
    });
  });

  it('lands on the next row after Send back… closes its dialog and the row moves', async () => {
    await openForWrite(
      workReport({ needs_you: [reviewRow, secondReview] }),
      workReport({ needs_you: [secondReview], now: [runningAs(reviewRow)] }),
    );

    await press('MMR-12', 'Send back…');
    const dialog = await screen.findByRole('dialog', { name: 'Send back' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Actions for MMR-15' })).getByRole('button', {
          name: 'Approve',
        }),
      ).toHaveFocus();
    });
  });

  it('lands on the next row after an answer moves its row out of Needs you', async () => {
    await openForWrite(
      workReport({ needs_you: [answersRow, secondReview] }),
      workReport({ needs_you: [secondReview] }),
    );

    await press('MMR-14', 'Answer…');
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /answer/i }), {
      target: { value: 'Refuse.' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^groomed/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Answer' }));

    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Actions for MMR-15' })).getByRole('button', {
          name: 'Approve',
        }),
      ).toHaveFocus();
    });
  });

  it('moves nothing for a cancelled answer’s row when it leaves later', async () => {
    const first = frontierRow('MMR-20', 'Add the SQLite dialect');
    const second = frontierRow('MMR-21', 'Add the Postgres dialect');
    const runnable = (rows: (typeof first)[]) => ({ ...workReport().frontier, runnable: rows });
    await openForWrite(
      workReport({ frontier: runnable([first, second]), needs_you: [answersRow, secondReview] }),
      // MMR-14 was answered elsewhere meanwhile, so Start's refresh drops it too.
      workReport({
        frontier: runnable([second]),
        needs_you: [secondReview],
        now: [runningAs(first)],
      }),
    );

    await press('MMR-14', 'Answer…');
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Answer' })).toBeNull();
    });
    await press('MMR-20', 'Start');

    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Actions for MMR-21' })).getByRole('button', {
          name: 'Start',
        }),
      ).toHaveFocus();
    });
  });

  it('moves nothing for a failed approval’s row when it leaves later', async () => {
    const first = frontierRow('MMR-20', 'Add the SQLite dialect');
    const second = frontierRow('MMR-21', 'Add the Postgres dialect');
    const runnable = (rows: (typeof first)[]) => ({ ...workReport().frontier, runnable: rows });
    const before = workReport({
      frontier: runnable([first, second]),
      needs_you: [reviewRow, secondReview],
    });
    await open(PROJECT_SCOPE, before);

    const failedRefresh = holdRefresh();
    apiSend.mockRejectedValueOnce(new Error('conflict'));
    await press('MMR-12', 'Approve');
    const approve = within(await actionsOf('MMR-12')).getByRole('button', { name: 'Approve' });
    await waitFor(() => {
      expect(approve).toBeDisabled();
    });
    failedRefresh.resolve(before);
    await waitFor(() => {
      expect(approve).toBeEnabled();
    });

    const startRefresh = holdRefresh();
    await press('MMR-20', 'Start');
    // MMR-12 was approved elsewhere meanwhile, so Start's refresh drops it too.
    startRefresh.resolve(
      workReport({
        frontier: runnable([second]),
        needs_you: [secondReview],
        now: [runningAs(first)],
      }),
    );

    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Actions for MMR-21' })).getByRole('button', {
          name: 'Start',
        }),
      ).toHaveFocus();
    });
  });

  it('moves nothing for a row that lost its action before it leaves', async () => {
    const first = frontierRow('MMR-20', 'Add the SQLite dialect');
    const second = frontierRow('MMR-21', 'Add the Postgres dialect');
    const runnable = (rows: (typeof first)[]) => ({ ...workReport().frontier, runnable: rows });
    await open(
      PROJECT_SCOPE,
      workReport({ frontier: runnable([first, second]), needs_you: [reviewRow, secondReview] }),
    );

    // MMR-12 is blocked elsewhere as it is approved, so it stays with no action.
    const blockedRefresh = holdRefresh();
    await press('MMR-12', 'Approve');
    const blockedAs = { ...blockedRow, id: 'MMR-12', title: reviewRow.title };
    blockedRefresh.resolve(
      workReport({ frontier: runnable([first, second]), needs_you: [blockedAs, secondReview] }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Actions for MMR-12' })).toBeNull();
    });

    const startRefresh = holdRefresh();
    await press('MMR-20', 'Start');
    startRefresh.resolve(
      workReport({
        frontier: runnable([second]),
        needs_you: [secondReview],
        now: [runningAs(first)],
      }),
    );

    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Actions for MMR-21' })).getByRole('button', {
          name: 'Start',
        }),
      ).toHaveFocus();
    });
  });

  it('leaves focus alone when the operator has moved on before the row leaves', async () => {
    await open(PROJECT_SCOPE, workReport({ needs_you: [reviewRow, secondReview] }));
    const refresh = holdRefresh();

    await press('MMR-12', 'Approve');
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledOnce();
    });
    const elsewhere = within(getRail()).getAllByRole('link')[0];
    elsewhere?.focus();
    refresh.resolve(workReport({ needs_you: [secondReview] }));

    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Actions for MMR-12' })).toBeNull();
    });
    expect(elsewhere).toHaveFocus();
  });
});

describe('work page offline', () => {
  it('disables New task, including the one in an empty frontier', async () => {
    serve(PHASE_SCOPE);
    const served = apiGet.getMockImplementation();
    // An errored read over loaded data is the console's offline signal.
    apiGet.mockImplementation((path: string) =>
      path === '/api/nodes/MMR-105/annotations'
        ? Promise.reject(new Error('unreachable'))
        : served?.(path),
    );
    renderAt('/p/MMR/105');

    const frontier = await section('Frontier');
    await waitFor(() => {
      expect(within(frontier).getByRole('button', { name: 'New task' })).toBeDisabled();
    });
  });

  it('disables every row action', async () => {
    serve(
      PHASE_SCOPE,
      workReport({
        frontier: { ...workReport().frontier, runnable: [frontierRow('MMR-20', 'Runnable')] },
        needs_you: [reviewRow, answersRow],
      }),
    );
    const served = apiGet.getMockImplementation();
    apiGet.mockImplementation((path: string) =>
      path === '/api/nodes/MMR-105/annotations'
        ? Promise.reject(new Error('unreachable'))
        : served?.(path),
    );
    renderAt('/p/MMR/105');

    const actions = await Promise.all(['MMR-12', 'MMR-14', 'MMR-20'].map(actionsOf));
    await waitFor(() => {
      for (const group of actions) {
        for (const button of within(group).getAllByRole('button')) {
          expect(button).toBeDisabled();
        }
      }
    });
  });
});

describe('work page head', () => {
  it('a project gets New task and its settings, and no tabs', async () => {
    await open(PROJECT_SCOPE);

    expect(screen.getByRole('button', { name: 'Project settings' })).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'New task' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText('MMR · project')).toBeDefined();
    expect(screen.getByText('1 in progress · 1 parked · 3 done')).toBeDefined();
    expect(screen.queryByRole('navigation', { name: 'Path' })).toBeNull();
  });

  it('a phase shows its path and files new work into itself, with no settings', async () => {
    await open(PHASE_SCOPE);

    const path = screen.getByRole('navigation', { name: 'Path' });
    await waitFor(() => {
      expect(within(path).getByRole('link', { name: 'Console work' }).getAttribute('href')).toBe(
        '/p/MMR/101',
      );
    });
    expect(within(path).getByRole('link', { name: 'Mimir' }).getAttribute('href')).toBe('/p/MMR');
    expect(screen.getByText('MMR-105 · phase')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Project settings' })).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'New task' })[0] as HTMLElement);
    const sheet = await screen.findByRole('dialog', { name: 'New work item' });
    // The phase is the home, not the first legal one (the initiative above it).
    await waitFor(() => {
      expect(within(sheet).getByRole('button', { name: /Home/ })).toHaveTextContent('Work page');
    });
  });

  it('a phase lists what it depends on and what it blocks in About', async () => {
    await open(PHASE_SCOPE);

    const rail = screen.getByRole('complementary', { name: 'Record details' });
    expect(
      within(rail)
        .getByRole('link', { name: /MMR-102/ })
        .getAttribute('href'),
    ).toBe('/p/MMR/102');
    expect(
      within(rail)
        .getByRole('link', { name: /MMR-115/ })
        .getAttribute('href'),
    ).toBe('/p/MMR/115');
  });

  it('a container with no description says so in About', async () => {
    const bare: Scope = {
      ...PHASE_SCOPE,
      record: { ...PHASE, deps: undefined, description: null },
    };
    await open(bare);

    expect(within(getRail()).getByText('No description.')).toBeDefined();
    expect(within(getRail()).queryByRole('heading', { name: 'Artifacts' })).toBeNull();
  });
});

/** `count` artifacts, numbered so that a higher number was created later. */
function artifactsOf(count: number): WireArtifact[] {
  return Array.from({ length: count }, (_, i) => ({
    created_at: `2026-06-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`,
    id: `MMR-a${String(i + 1)}`,
    tags: [],
    title: `Brief ${String(i + 1)}`,
  }));
}

const artifactsSection = () =>
  within(getRail()).getByRole('heading', { name: 'Artifacts' }).closest('section') as HTMLElement;

describe('work page rail About and Artifacts (MMR-486)', () => {
  it('prompts a project with no description to add one in its settings', async () => {
    await open({ ...PROJECT_SCOPE, record: { ...PROJECT, artifacts: [], description: undefined } });

    const about = within(getRail()).getByRole('heading', { name: 'About' }).closest('section');
    expect(about).toHaveTextContent('No description yet. Add one in project settings (⚙).');
  });

  it('lists the five newest artifacts and links to the project’s artifact browser', async () => {
    await open({ ...PROJECT_SCOPE, record: { ...PROJECT, artifacts: artifactsOf(7) } });

    const panel = within(artifactsSection());
    expect(
      panel.getAllByRole('link', { name: /^Brief/ }).map((l) => l.textContent?.replace('❄', '')),
    ).toStrictEqual(['Brief 7', 'Brief 6', 'Brief 5', 'Brief 4', 'Brief 3']);
    expect(panel.getByRole('link', { name: 'All 7 artifacts' }).getAttribute('href')).toBe(
      '/artifacts?project=MMR',
    );
    // Artifacts live in their own section, not under About.
    const about = within(getRail()).getByRole('heading', { name: 'About' }).closest('section');
    expect(about).not.toHaveTextContent('Brief');
  });

  it('lists every artifact and no all-link when they fit the cap', async () => {
    await open({ ...PROJECT_SCOPE, record: { ...PROJECT, artifacts: artifactsOf(5) } });

    const panel = within(artifactsSection());
    expect(panel.getAllByRole('link')).toHaveLength(5);
    expect(panel.queryByRole('link', { name: /^All \d+ artifacts$/ })).toBeNull();
  });

  it('omits the section when there are no artifacts', async () => {
    await open({ ...PROJECT_SCOPE, record: { ...PROJECT, artifacts: [] } });

    expect(within(getRail()).queryByRole('heading', { name: 'Artifacts' })).toBeNull();
  });

  it('a container lists what is attached to it, uncapped, with no project-wide link', async () => {
    await open({ ...PHASE_SCOPE, record: { ...PHASE, artifacts: artifactsOf(7) } });

    const panel = within(artifactsSection());
    expect(panel.getAllByRole('link')).toHaveLength(7);
    expect(panel.queryByRole('link', { name: /^All \d+ artifacts$/ })).toBeNull();
  });
});
