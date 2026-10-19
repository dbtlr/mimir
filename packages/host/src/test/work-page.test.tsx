import { MimirError } from '@mimir/contract';
import type { EngineNode, EngineTree } from '@mimir/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostFaultError } from '../api/errors';
import { done, groom as setGrooming, returnTask, start } from '../api/fns/nodes';
import { nodeWork, projectWork } from '../api/fns/views';
import type { NeedsYouTask, WorkReport } from '../api/view-queries';
import type { RecordArtifact } from '../lib/work-page';
import { routeTree } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject, engineTree } from './engine-fixtures';
import { engineContainer } from './node-fixtures';
import { failNotes, serveNodes } from './node-fns';
import { serveShell } from './shell-fns';
import {
  engineWork,
  frontierRow as makeFrontierRow,
  needsYouRow,
  nowRow as makeNowRow,
  shippedRow as makeShippedRow,
  workTask,
} from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

// Mon Oct 12 2026, 18:00 in the suite's pinned zone (America/New_York).
const NOW = Date.parse('2026-10-12T22:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000);
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60_000);

beforeEach(() => {
  serveBrowse();
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function leaf(id: string, status: EngineTree['status'], title = `task ${id}`): EngineTree {
  return engineTree({ id, status, title, type: 'task' });
}

function node(
  id: string,
  type: 'initiative' | 'phase',
  status: EngineTree['status'],
  title: string,
  children: EngineTree[] = [],
  extra: Partial<EngineTree> = {},
): EngineTree {
  return engineTree({ id, status, title, type, ...extra }, children);
}

/** The project's whole tree: live and finished initiatives, an open-ended and a parked one. */
const TREE = engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
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
]);

const PROJECT: EngineNode = engineProject({
  artifacts: [
    {
      createdAt: new Date('2026-06-01T10:00:00.000Z'),
      id: 'MMR-a7',
      tags: [],
      title: 'Shaping brief',
    },
  ],
  description: 'The **work** tool.',
  distribution: { done: 3, in_progress: 1, parked: 1 },
  id: 'MMR',
  next: 'Ship the work page.\n\nThen the review page.',
  target: '0.24.0',
  title: 'Mimir',
});

const PHASE: EngineNode = engineContainer({
  deps: {
    awaitingOn: [],
    blocking: [{ id: 'MMR-115', status: 'new', title: 'Review page' }],
    dependsOn: [{ id: 'MMR-102', status: 'done', title: 'Record pages' }],
  },
  description: 'One page for every scope.',
  distribution: { done: 1, ready: 1 },
  id: 'MMR-105',
  next: 'Land the sections.\n\nThen the actions.',
  parent: 'MMR-101',
  status: 'in_progress',
  title: 'Work page',
  type: 'phase',
});

type Scope = {
  name: string;
  record: EngineNode;
  url: string;
  /** The server function the scope's work page reads, and the input it sends. */
  work: typeof projectWork | typeof nodeWork;
  asked: object;
  /** Where the world holds the scope's work report. */
  world: (
    report: WorkReport,
  ) => { projects: Record<string, WorkReport> } | { nodes: Record<string, WorkReport> };
};

const PROJECT_SCOPE: Scope = {
  asked: { data: { project: 'MMR', timeZone: 'America/New_York' } },
  name: 'project',
  record: PROJECT,
  url: '/p/MMR',
  work: projectWork,
  world: (report) => ({ projects: { MMR: report } }),
};

const PHASE_SCOPE: Scope = {
  asked: { data: { id: 'MMR-105', timeZone: 'America/New_York' } },
  name: 'phase',
  record: PHASE,
  url: '/p/MMR/105',
  work: nodeWork,
  world: (report) => ({ nodes: { 'MMR-105': report } }),
};

const SCOPES = [PROJECT_SCOPE, PHASE_SCOPE];

/** Serve the scope's record, the project tree, and `report` as its work read. */
function serve(scope: Scope, report: WorkReport | Error = engineWork(), tree = TREE) {
  serveShell({ trees: { MMR: tree } });
  serveNodes({ nodes: [scope.record] });
  if (report instanceof Error) {
    serveViews();
    vi.mocked(scope.work).mockRejectedValue(report);
  } else {
    serveViews(scope.world(report));
  }
}

/** How many row writes (verbs and grooming) the page has issued. */
const writeCalls = () =>
  [start, done, returnTask, setGrooming].reduce(
    (sum, fn) => sum + vi.mocked(fn).mock.calls.length,
    0,
  );

function renderAt(url: string) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [url] }),
    routeTree,
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
async function open(scope: Scope, report?: WorkReport | Error, tree?: EngineTree) {
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

const nowRow = makeNowRow(
  { branch: 'feat/dialect', harness: 'claude-code', id: 'MMR-11', title: 'Wire the dialect' },
  {
    latestNote: { content: 'Seam extracted', createdAt: minutesAgo(9) },
    scratchpads: [{ id: 'MMR-p1', title: 'Cutover episode' }],
    startedAt: minutesAgo(41),
  },
);

const reviewRow = needsYouRow(
  { id: 'MMR-12', status: 'under_review', title: 'Extract the seam' },
  'under_review',
);

const blockedRow = needsYouRow(
  {
    blockOwner: 'you',
    hold: 'blocked',
    holdReason: 'Waiting on your sign-off',
    id: 'MMR-13',
    status: 'blocked',
    title: 'Record health copy',
  },
  'blocked',
);

const answersRow = needsYouRow(
  {
    grooming: 'needs_answers',
    id: 'MMR-14',
    status: 'ready',
    title: 'Refuse to open unmigrated stores',
  },
  'needs_answers',
  { question: 'Should it refuse, or warn?' },
);

const frontierRow = (id: string, title: string, extra: Partial<EngineNode> = {}) =>
  makeFrontierRow({ grooming: 'groomed', id, status: 'ready', title, ...extra });

const shippedRow = (id: string, at: string | Date, extra: Partial<EngineNode> = {}) =>
  makeShippedRow({ id, title: `Shipped ${id}`, ...extra }, new Date(at));

describe.each(SCOPES)('work page sections, $name', (scope) => {
  it('asks for its own work read, in the browser’s time zone', async () => {
    await open(scope);

    expect(scope.work).toHaveBeenCalledWith(scope.asked);
  });

  it('lists what is running, with when it started, where, and its latest note', async () => {
    await open(scope, engineWork({ now: [nowRow] }));

    const now = await section('Now · 1');
    expect(hrefOf(now, 'Wire the dialect')).toBe('/p/MMR/11');
    expect(now).toHaveTextContent('Started 41m ago');
    expect(now).toHaveTextContent('claude-code');
    expect(now).toHaveTextContent('feat/dialect');
    expect(now).toHaveTextContent('Scratchpad open');
    expect(now).toHaveTextContent('Latest note, 9m ago: “Seam extracted”');
  });

  it('lists what needs you with why, and the question a needs-answers task asks', async () => {
    await open(scope, engineWork({ needsYou: [reviewRow, blockedRow, answersRow] }));

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
      engineWork({
        frontier: {
          nextToUnlock: [
            {
              prerequisite: { id: 'MMR-11', status: 'in_progress', title: 'Wire the dialect' },
              tasks: [
                {
                  ...frontierRow('MMR-21', 'Remove the old backend', { size: 'large' }),
                  awaitingOn: ['MMR-11'],
                },
              ],
            },
          ],
          runnable: [frontierRow('MMR-20', 'Add the SQLite dialect')],
          toGroom: [
            frontierRow('MMR-22', 'Triage the flaky suite', { grooming: 'not_groomed' }),
            makeFrontierRow(
              { id: 'MMR-23', status: 'new', title: 'Hosted backends', type: 'initiative' },
              { breakDown: true },
            ),
          ],
          waitingOnOthers: [],
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
      engineWork({
        frontier: {
          nextToUnlock: [],
          runnable: [],
          toGroom: [],
          waitingOnOthers: [
            {
              blockReason: 'Vendor has not replied',
              stale: false,
              task: workTask({
                blockOwner: 'others',
                hold: 'blocked',
                id: 'MMR-24',
                status: 'blocked',
                title: 'Vendor key rotation',
              }),
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
      engineWork({
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
            abandonReason: 'moot under ADR 0032',
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
      engineWork({
        frontier: { nextToUnlock: [], runnable: [stale], toGroom: [], waitingOnOthers: [] },
        goingCold: [{ ...stale.task, updatedAt: daysAgo(20) }],
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
    ).toBe('/p/MMR/tasks?status=terminal');
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
      engineWork({
        frontier: {
          nextToUnlock: [],
          runnable: [],
          toGroom: [],
          waitingOnOthers: [
            {
              blockReason: null,
              stale: false,
              task: workTask({
                hold: 'blocked',
                id: 'MMR-24',
                status: 'blocked',
                title: 'Vendor key',
              }),
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
    vi.mocked(scope.work).mockReturnValue(Promise.withResolvers<WorkReport>().promise);
    renderAt(scope.url);

    await screen.findByRole('heading', { level: 1, name: scope.record.title });
    expect(document.querySelector('[aria-busy]')).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
  });

  it('says so when the work read fails with nothing cached, while the rail still renders', async () => {
    await open(scope, new TypeError('fetch failed'));

    await expect(screen.findByText(/couldn’t load the work page/i)).resolves.toHaveTextContent(
      'is the Mimir host running?',
    );
    const rail = screen.getByRole('complementary', { name: 'Record details' });
    expect(within(rail).getByText(scope.record.next?.split('\n')[0] ?? '')).toBeDefined();
  });

  it.each([
    ['an Engine refusal', new MimirError('validation', 'timeZone is not a time zone')],
    ['a host fault', new HostFaultError()],
  ])(
    'does not ask whether the server is running when it answered with %s',
    async (_kind, error) => {
      await open(scope, error);

      const message = await screen.findByText(/couldn’t load the work page/i);
      expect(message).toHaveTextContent('Couldn’t load the work page.');
      expect(message).not.toHaveTextContent('host running');
    },
  );
});

describe.each(SCOPES)('work page rail, $name', (scope) => {
  it('runs Direction, About, then Artifacts (when it has any), with no structure or other views', async () => {
    await open(scope);

    const labels = within(getRail())
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(labels).toStrictEqual([
      'Direction',
      'About',
      ...((scope.record.artifacts ?? []).length > 0 ? ['Artifacts'] : []),
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

  it('holds the description, artifacts, and details in About', async () => {
    await open(scope);

    const about = within(getRail()).getByRole('heading', { name: 'About' }).closest('section');
    expect(about).not.toBeNull();
    const panel = within(about as HTMLElement);
    expect(about).toHaveTextContent((scope.record.description ?? '').replaceAll('**', ''));
    expect(panel.getByText('created')).toBeDefined();
    expect(panel.getByText('updated')).toBeDefined();
  });

  it('ends its sections with a link to the project’s tasks, and holds no board or Other views', async () => {
    await open(scope);

    const link = await screen.findByRole('link', { name: /All tasks in MMR/ });
    expect(link.getAttribute('href')).toBe('/p/MMR/tasks');
    expect(within(getRail()).queryByRole('link', { name: /All tasks/ })).toBeNull();
    expect(within(getRail()).queryByRole('navigation', { name: 'Other views' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Board' })).toBeNull();
    // The link comes after the last section.
    const goingCold = screen.getByRole('region', { name: 'Going cold' });
    expect(goingCold.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
      'About',
      ...((scope.record.artifacts ?? []).length > 0 ? ['Artifacts'] : []),
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

    fireEvent.click(within(chips).getByRole('button', { name: 'About' }));
    const about = await screen.findByRole('dialog', { name: 'About' });
    expect(within(about).getByText('created')).toBeDefined();
    fireEvent.click(within(about).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

/**
 * Serve `before` at the project's work route until a write lands, then `after`,
 * the way the server's next read reflects the action.
 */
async function openForWrite(before: WorkReport, after: WorkReport) {
  serve(PROJECT_SCOPE);
  const views = serveViews({ projects: { MMR: before } });
  // Any row write lands: the next work read answers `after`.
  for (const write of [start, done, returnTask, setGrooming]) {
    const echoed = vi.mocked(write).getMockImplementation();
    vi.mocked(write).mockImplementation(async (options) => {
      views.projects.MMR = after;
      return echoed?.(options as never) as never;
    });
  }
  renderAt(PROJECT_SCOPE.url);
  await screen.findByRole('heading', { level: 1, name: PROJECT.title });
}

/** Accept writes, and hold the project's next work read until the test resolves it. */
function holdRefresh() {
  const refresh = Promise.withResolvers<WorkReport>();
  vi.mocked(projectWork).mockReturnValue(refresh.promise);
  return refresh;
}

const runningAs = (row: { task: { id: string; title: string } }) =>
  makeNowRow({ id: row.task.id, title: row.task.title });

describe('work page row actions', () => {
  it('starts a runnable task, which then shows under Now', async () => {
    const runnable = frontierRow('MMR-20', 'Add the SQLite dialect');
    await openForWrite(
      engineWork({ frontier: { ...engineWork().frontier, runnable: [runnable] } }),
      engineWork({ now: [runningAs(runnable)] }),
    );

    fireEvent.click(within(await actionsOf('MMR-20')).getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(start).toHaveBeenCalledWith({ data: { id: 'MMR-20' } });
    });
    const now = await section('Now · 1');
    expect(hrefOf(now, 'Add the SQLite dialect')).toBe('/p/MMR/20');
    expect(screen.queryByRole('region', { name: 'Runnable now' })).toBeNull();
  });

  it('approves a task in review, which then shows under Shipped', async () => {
    await openForWrite(
      engineWork({ needsYou: [reviewRow] }),
      engineWork({ shipped: [shippedRow('MMR-12', minutesAgo(1), { title: 'Extract the seam' })] }),
    );

    fireEvent.click(within(await actionsOf('MMR-12')).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(done).toHaveBeenCalledWith({ data: { id: 'MMR-12' } });
    });
    const shipped = await section('Shipped · 1');
    expect(hrefOf(shipped, 'Extract the seam')).toBe('/p/MMR/12');
    await expect(section('Needs you')).resolves.toHaveTextContent('Nothing needs you.');
  });

  it('sends a task in review back with a reason, and it returns to Now', async () => {
    await openForWrite(
      engineWork({ needsYou: [reviewRow] }),
      engineWork({ now: [runningAs(reviewRow)] }),
    );

    fireEvent.click(within(await actionsOf('MMR-12')).getByRole('button', { name: 'Send back…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back' });
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Cover the empty case' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(returnTask).toHaveBeenCalledWith({
        data: { id: 'MMR-12', reason: 'Cover the empty case' },
      });
    });
    const now = await section('Now · 1');
    expect(hrefOf(now, 'Extract the seam')).toBe('/p/MMR/12');
    await expect(section('Needs you')).resolves.toHaveTextContent('Nothing needs you.');
  });

  it('answers a question and sets the grooming state, and the task moves to the frontier', async () => {
    await openForWrite(
      engineWork({ needsYou: [answersRow] }),
      engineWork({
        frontier: {
          ...engineWork().frontier,
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
      expect(setGrooming).toHaveBeenCalledWith({
        data: {
          ids: ['MMR-14'],
          note: 'Refuse, and name the export command.',
          state: 'groomed',
        },
      });
    });
    const runnable = await section('Runnable now');
    expect(hrefOf(runnable, 'Refuse to open unmigrated stores')).toBe('/p/MMR/14');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Answer' })).toBeNull();
    });
    await expect(section('Needs you')).resolves.toHaveTextContent('Nothing needs you.');
  });

  it('sends a task back with no reason when none is given', async () => {
    await openForWrite(
      engineWork({ needsYou: [reviewRow] }),
      engineWork({ now: [runningAs(reviewRow)] }),
    );

    fireEvent.click(within(await actionsOf('MMR-12')).getByRole('button', { name: 'Send back…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(returnTask).toHaveBeenCalledWith({ data: { id: 'MMR-12' } });
    });
  });

  it('keeps a row’s buttons off until the sections have refreshed, so one tap writes once', async () => {
    await open(PROJECT_SCOPE, engineWork({ needsYou: [reviewRow] }));
    // The write lands, but the refreshed sections are still on their way.
    const refresh = holdRefresh();

    const approve = within(await actionsOf('MMR-12')).getByRole('button', { name: 'Approve' });
    fireEvent.click(approve);
    await waitFor(() => {
      expect(writeCalls()).toBe(1);
    });
    expect(approve).toBeDisabled();
    expect(
      within(await actionsOf('MMR-12')).getByRole('button', { name: 'Send back…' }),
    ).toBeDisabled();

    refresh.resolve(engineWork());
    await expect(section('Needs you')).resolves.toHaveTextContent('Nothing needs you.');
  });

  it('keeps the answer dialog open until the sections have refreshed', async () => {
    await open(PROJECT_SCOPE, engineWork({ needsYou: [answersRow] }));
    const refresh = holdRefresh();

    fireEvent.click(within(await actionsOf('MMR-14')).getByRole('button', { name: 'Answer…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /answer/i }), {
      target: { value: 'Refuse.' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^groomed/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Answer' }));
    await waitFor(() => {
      expect(writeCalls()).toBe(1);
    });
    expect(within(dialog).getByRole('button', { name: 'Answer' })).toBeDisabled();

    refresh.resolve(engineWork());
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Answer' })).toBeNull();
    });
  });

  it('asks for what is still open when the answer keeps the task at needs answers', async () => {
    await open(PROJECT_SCOPE, engineWork({ needsYou: [answersRow] }));

    fireEvent.click(within(await actionsOf('MMR-14')).getByRole('button', { name: 'Answer…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    expect(within(dialog).getByRole('textbox', { name: 'Answer (required)' })).toBeDefined();

    fireEvent.click(within(dialog).getByRole('radio', { name: /^needs answers/ }));
    expect(
      within(dialog).getByRole('textbox', { name: 'Answer, and what is still open (required)' }),
    ).toBeDefined();
  });

  it('needs both an answer and a chosen state before it answers', async () => {
    await open(PROJECT_SCOPE, engineWork({ needsYou: [answersRow] }));

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

const secondReview = needsYouRow(
  { id: 'MMR-15', status: 'under_review', title: 'Name the seam' },
  'under_review',
);
/** Press a row's button the way a keyboard does: focused first, then activated. */
const press = async (id: string, name: string) => {
  const button = within(await actionsOf(id)).getByRole('button', { name });
  button.focus();
  fireEvent.click(button);
};

describe('work page focus after an acted-on row moves away', () => {
  it('lands on the next row’s actions after Approve moves a row out of Needs you', async () => {
    await openForWrite(
      engineWork({ needsYou: [reviewRow, secondReview] }),
      engineWork({ needsYou: [secondReview] }),
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
      engineWork({ needsYou: [secondReview, reviewRow] }),
      engineWork({ needsYou: [secondReview] }),
    );

    await press('MMR-12', 'Approve');

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: /^Needs you · 1/ })).toHaveFocus();
    });
  });

  it('lands on the next runnable row’s Start after Start moves a row to Now', async () => {
    const first = frontierRow('MMR-20', 'Add the SQLite dialect');
    const second = frontierRow('MMR-21', 'Add the Postgres dialect');
    const runnable = (rows: (typeof first)[]) => ({ ...engineWork().frontier, runnable: rows });
    await openForWrite(
      engineWork({ frontier: runnable([first, second]) }),
      engineWork({ frontier: runnable([second]), now: [runningAs(first)] }),
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
      engineWork({ needsYou: [reviewRow, secondReview] }),
      engineWork({ needsYou: [secondReview], now: [runningAs(reviewRow)] }),
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
      engineWork({ needsYou: [answersRow, secondReview] }),
      engineWork({ needsYou: [secondReview] }),
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
    const runnable = (rows: (typeof first)[]) => ({ ...engineWork().frontier, runnable: rows });
    await openForWrite(
      engineWork({ frontier: runnable([first, second]), needsYou: [answersRow, secondReview] }),
      // MMR-14 was answered elsewhere meanwhile, so Start's refresh drops it too.
      engineWork({
        frontier: runnable([second]),
        needsYou: [secondReview],
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
    const runnable = (rows: (typeof first)[]) => ({ ...engineWork().frontier, runnable: rows });
    const before = engineWork({
      frontier: runnable([first, second]),
      needsYou: [reviewRow, secondReview],
    });
    await open(PROJECT_SCOPE, before);

    const failedRefresh = holdRefresh();
    vi.mocked(done).mockRejectedValueOnce(new Error('conflict'));
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
      engineWork({
        frontier: runnable([second]),
        needsYou: [secondReview],
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
    const runnable = (rows: (typeof first)[]) => ({ ...engineWork().frontier, runnable: rows });
    await open(
      PROJECT_SCOPE,
      engineWork({ frontier: runnable([first, second]), needsYou: [reviewRow, secondReview] }),
    );

    // MMR-12 is blocked elsewhere as it is approved, so it stays with no action.
    const blockedRefresh = holdRefresh();
    await press('MMR-12', 'Approve');
    const blockedAs: NeedsYouTask = {
      ...blockedRow,
      task: { ...blockedRow.task, id: 'MMR-12', title: reviewRow.task.title },
    };
    blockedRefresh.resolve(
      engineWork({ frontier: runnable([first, second]), needsYou: [blockedAs, secondReview] }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Actions for MMR-12' })).toBeNull();
    });

    const startRefresh = holdRefresh();
    await press('MMR-20', 'Start');
    startRefresh.resolve(
      engineWork({
        frontier: runnable([second]),
        needsYou: [secondReview],
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
    await open(PROJECT_SCOPE, engineWork({ needsYou: [reviewRow, secondReview] }));
    const refresh = holdRefresh();

    await press('MMR-12', 'Approve');
    await waitFor(() => {
      expect(writeCalls()).toBe(1);
    });
    const elsewhere = within(getRail()).getAllByRole('link')[0];
    elsewhere?.focus();
    refresh.resolve(engineWork({ needsYou: [secondReview] }));

    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Actions for MMR-12' })).toBeNull();
    });
    expect(elsewhere).toHaveFocus();
  });
});

describe('work page offline', () => {
  it('disables New task, including the one in an empty frontier', async () => {
    serve(PHASE_SCOPE);
    // An errored read over loaded data is the console's offline signal.
    failNotes();
    renderAt('/p/MMR/105');

    const frontier = await section('Frontier');
    await waitFor(() => {
      expect(within(frontier).getByRole('button', { name: 'New task' })).toBeDisabled();
    });
  });

  it('disables every row action', async () => {
    serve(
      PHASE_SCOPE,
      engineWork({
        frontier: { ...engineWork().frontier, runnable: [frontierRow('MMR-20', 'Runnable')] },
        needsYou: [reviewRow, answersRow],
      }),
    );
    failNotes();
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

  it('a phase links its parent for a phone, files new work into itself, and has no settings or breadcrumb', async () => {
    await open(PHASE_SCOPE);

    const parent = await screen.findByRole('link', { name: /Console work/ });
    await waitFor(() => {
      expect(parent.getAttribute('href')).toBe('/p/MMR/101');
    });
    // Phone only: the sidebar outline carries the place from md up.
    expect(parent.className).toContain('lg:hidden');
    expect(screen.queryByRole('navigation', { name: 'Path' })).toBeNull();
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
function artifactsOf(count: number): RecordArtifact[] {
  return Array.from({ length: count }, (_, i) => ({
    createdAt: new Date(`2026-06-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`),
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
      '/p/MMR/artifacts',
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
