import { MimirError } from '@mimir/contract';
import type { EngineNode, EngineTree } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostFaultError } from '../api/errors';
import { start } from '../api/fns/nodes';
import { nodeWork, projectWork } from '../api/fns/views';
import type { WorkReport } from '../api/view-queries';
import type { RecordArtifact } from '../lib/work-page';
import { nodeRoute, projectRoute } from '../router';
import { recordHealth } from './browse-fixtures';
import { serveBrowse } from './browse-fns';
import { engineProject, engineTree } from './engine-fixtures';
import { blocked, question, report as reviewOf } from './needs-you-fixtures';
import { engineContainer } from './node-fixtures';
import { failNotes, serveNodes } from './node-fns';
import { renderRoute } from './router';
import { serveShell } from './shell-fns';
import {
  engineWork,
  frontierRow as makeFrontierRow,
  needsYouRow,
  nowRow as makeNowRow,
  shippedRow as makeShippedRow,
  stripRow,
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

function leaf(
  id: string,
  status: EngineTree['status'],
  extra: Partial<EngineTree> = {},
): EngineTree {
  return engineTree({ id, status, title: `task ${id}`, type: 'task', ...extra });
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
      // The project's last finish, nine days before the suite's now.
      leaf('MMR-104', 'done', { completedAt: daysAgo(9) }),
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
  leaf('MMR-114', 'ready', { title: 'A loose task' }),
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
  // The work read names the phase as its scope.
  world: (report) => ({
    nodes: {
      'MMR-105': { ...report, scope: { id: 'MMR-105', kind: 'phase', title: 'Work page' } },
    },
  }),
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

const routes = [nodeRoute, projectRoute];

const quietClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** Serve `report` for the scope, open its page, and wait for the title. */
async function open(scope: Scope, report?: WorkReport | Error, tree?: EngineTree) {
  serve(scope, report, tree);
  const { router: testRouter } = await renderRoute(routes, scope.url, quietClient());
  await screen.findByRole('heading', { level: 1, name: scope.record.title });
  return testRouter;
}

/** A feed section, by the start of its head (its name, then its count). */
const section = (name: string) => screen.findByRole('region', { name: new RegExp(`^${name}`) });
const hrefOf = (within_: HTMLElement, name: string | RegExp) =>
  within(within_).getByRole('link', { name }).getAttribute('href');
/** The card titles a section shows, in order. */
const cardTitles = (region: HTMLElement) =>
  [...region.querySelectorAll('[data-slot="feed-card-target"]')].map((card) => card.textContent);

const nowRow = makeNowRow(
  { branch: 'feat/dialect', harness: 'claude-code', id: 'MMR-11', title: 'Wire the dialect' },
  { startedAt: minutesAgo(41) },
);

/** A task in review is work in flight: it reads in Now, never in Needs you. */
const reviewRow = makeNowRow(
  { id: 'MMR-12', status: 'under_review', title: 'Extract the seam' },
  { startedAt: minutesAgo(180), submittedAt: minutesAgo(20) },
);

const answersRow = needsYouRow(
  {
    grooming: 'needs_answers',
    id: 'MMR-14',
    status: 'ready',
    title: 'Task MMR-14',
  },
  'needs_answers',
  { question: 'Where does the pin live?' },
);

const frontierRow = (id: string, title: string, extra: Partial<EngineNode> = {}) =>
  makeFrontierRow({ grooming: 'groomed', id, status: 'ready', title, ...extra });

const shippedRow = (id: string, at: string | Date, extra: Partial<EngineNode> = {}) =>
  makeShippedRow({ id, title: `Shipped ${id}`, ...extra }, new Date(at));

/** Every section of a project's Work tab holding something. */
const busyWork = () =>
  engineWork({
    frontier: {
      nextToUnlock: [
        {
          prerequisite: { id: 'MMR-11', status: 'in_progress', title: 'Wire the dialect' },
          tasks: [{ ...frontierRow('MMR-24', 'Remove the old backend'), awaitingOn: ['MMR-11'] }],
        },
      ],
      runnable: [
        frontierRow('MMR-20', 'Add the SQLite dialect'),
        frontierRow('MMR-21', 'Add the Postgres dialect'),
        frontierRow('MMR-22', 'Add the MySQL dialect'),
        frontierRow('MMR-23', 'Add the DuckDB dialect'),
      ],
      toGroom: [frontierRow('MMR-25', 'Triage the flaky suite', { grooming: 'not_groomed' })],
      waitingOnOthers: [
        {
          blockReason: 'Vendor has not replied',
          stale: false,
          task: workTask({ hold: 'blocked', id: 'MMR-26', status: 'blocked', title: 'Vendor key' }),
        },
      ],
    },
    goingCold: [workTask({ id: 'MMR-27', status: 'ready', updatedAt: daysAgo(20) })],
    needsYou: [answersRow],
    now: [nowRow, reviewRow],
    shipped: [
      shippedRow('MMR-31', '2026-10-12T20:30:00.000Z', { parent: 'MMR-105' }),
      shippedRow('MMR-32', '2026-10-11T15:00:00.000Z', { parent: 'MMR-105' }),
      shippedRow('MMR-33', '2026-10-12T14:00:00.000Z', { parent: 'MMR-101' }),
      shippedRow('MMR-34', '2026-10-12T15:00:00.000Z', {
        parent: 'MMR-105',
        status: 'abandoned',
      }),
    ],
  });

/** The review report: a question in scope, a block on another project, and Mimir's seeds to triage. */
const busyReview = () => ({
  ...reviewOf([question('MMR-14'), blocked('FLT-5')]),
  projects: [
    stripRow({ key: 'MMR', name: 'Mimir' }, { untriaged: 5 }),
    stripRow({ key: 'FLT', name: 'Fleet' }),
  ],
});

/** Open the project's Work tab with every section busy and three Record health findings. */
async function openBusyProject() {
  serveBrowse({ health: recordHealth({ finding_total: 3 }) });
  serveShell({ trees: { MMR: TREE } });
  serveNodes({ nodes: [PROJECT] });
  serveViews({ projects: { MMR: busyWork() }, review: busyReview() });
  await renderRoute(routes, '/p/MMR', quietClient());
  await screen.findByRole('heading', { level: 1, name: 'Mimir' });
  return screen.findByRole('tabpanel');
}

describe.each(SCOPES)('work page scope, $name', (scope) => {
  it('asks for its own work read, in the browser’s time zone', async () => {
    await open(scope);

    expect(scope.work).toHaveBeenCalledWith(scope.asked);
  });
});

describe('the scoped Work tab (MMR-727)', () => {
  it('runs Needs you, Now, Up next, Shipped this week, When you have a minute, then Parts', async () => {
    const panel = await openBusyProject();

    await within(panel).findByRole('region', { name: /^Needs you/ });
    const heads = within(panel)
      .getAllByRole('heading', { level: 2 })
      .map((head) => head.textContent?.replaceAll(/\s+/g, ' ').trim());
    expect(heads).toStrictEqual([
      expect.stringMatching(/^Needs you/),
      'Now 2',
      'Up next 4 can start',
      'Shipped this week 3',
      'When you have a minute',
      'Parts 4',
    ]);
  });

  it('keeps the deck to the cards in the scope’s needs-you set, with no See all', async () => {
    await openBusyProject();

    const needs = await section('Needs you');
    expect(cardTitles(needs)).toStrictEqual(['Task MMR-14']);
    expect(within(needs).queryByRole('link', { name: /See all/ })).toBeNull();
  });

  it('says nothing here needs you when the deck has no card and other sections show', async () => {
    await open(PROJECT_SCOPE, engineWork({ now: [nowRow] }));

    await expect(screen.findByText('Nothing here needs you.')).resolves.toBeVisible();
  });

  it('shows Now’s cards most recent move first, and See all opens the project’s In flight', async () => {
    await openBusyProject();

    const now = await section('Now');
    expect(cardTitles(now)).toStrictEqual(['Extract the seam', 'Wire the dialect']);
    expect(hrefOf(now, 'See all in Now')).toBe('/p/MMR/tasks?show=in-flight');
  });

  it('shows three of the tasks that can start as cards, each starting its task', async () => {
    await openBusyProject();

    const next = await section('Up next');
    expect(cardTitles(next)).toStrictEqual([
      'Add the SQLite dialect',
      'Add the Postgres dialect',
      'Add the MySQL dialect',
    ]);
    expect(within(next).queryByRole('link', { name: /See all/ })).toBeNull();
    fireEvent.click(within(next).getByRole('button', { name: 'Start MMR-20' }));
    await waitFor(() => {
      expect(start).toHaveBeenCalledWith({ data: { id: 'MMR-20' } });
    });
  });

  it('hands focus to the page when the last task that could start leaves Up next', async () => {
    const runnable = frontierRow('MMR-20', 'Add the SQLite dialect');
    serve(PROJECT_SCOPE);
    const world = serveViews({
      projects: {
        MMR: engineWork({ frontier: { ...engineWork().frontier, runnable: [runnable] } }),
      },
    });
    const echoed = vi.mocked(start).getMockImplementation();
    vi.mocked(start).mockImplementation(async (options) => {
      world.projects.MMR = engineWork({
        now: [makeNowRow({ id: 'MMR-20', title: 'Add the SQLite dialect' })],
      });
      return echoed?.(options) as never;
    });
    await renderRoute(routes, PROJECT_SCOPE.url, quietClient());

    const startButton = await screen.findByRole('button', { name: 'Start MMR-20' });
    startButton.focus();
    fireEvent.click(startButton);

    await section('Now');
    await waitFor(() => {
      expect(screen.getByRole('main')).toHaveFocus();
    });
  });

  it('ends Up next with what unlocks next, opening the prerequisite', async () => {
    await openBusyProject();

    const next = await section('Up next');
    expect(hrefOf(next, 'Unlocks when MMR-11 lands 1')).toBe('/p/MMR/11');
  });

  it('keeps Up next for what unlocks next alone, under a head with no count', async () => {
    const { frontier } = busyWork();
    await open(PROJECT_SCOPE, engineWork({ frontier: { ...frontier, runnable: [] } }));

    const next = await section('Up next');
    expect(within(next).getByRole('heading', { level: 2 })).toHaveTextContent(/^Up next$/);
    expect(cardTitles(next)).toStrictEqual([]);
    expect(hrefOf(next, 'Unlocks when MMR-11 lands 1')).toBe('/p/MMR/11');
  });

  it('holds Start offline, still focusable', async () => {
    serve(
      PHASE_SCOPE,
      engineWork({
        frontier: { ...engineWork().frontier, runnable: [frontierRow('MMR-20', 'Runnable')] },
      }),
    );
    // An errored read over loaded data is the console's offline signal.
    failNotes();
    await renderRoute(routes, '/p/MMR/105', quietClient());

    const startButton = await screen.findByRole('button', { name: 'Start MMR-20' });
    await waitFor(() => {
      expect(startButton).toHaveAttribute('aria-disabled', 'true');
    });
    fireEvent.click(startButton);
    expect(start).not.toHaveBeenCalled();
  });

  it('splits a project’s Shipped by phase as plain rows, and See all opens Shipped this week', async () => {
    await openBusyProject();

    const shipped = await section('Shipped this week');
    const rows = within(shipped).getByRole('list', { name: 'Shipped by part' });
    expect(
      within(rows)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toStrictEqual(['Work page 2', 'Console work 1']);
    expect(within(rows).queryByRole('link')).toBeNull();
    expect(hrefOf(shipped, 'See all in Shipped this week')).toBe('/p/MMR/tasks?show=shipped-week');
  });

  it('lists a phase’s done tasks as its Shipped, each opening its page, with no See all', async () => {
    await open(PHASE_SCOPE, engineWork({ shipped: busyWork().shipped }));

    const shipped = await section('Shipped this week');
    const rows = within(shipped).getByRole('list', { name: 'Shipped tasks' });
    expect(
      within(rows)
        .getAllByRole('link')
        .map((row) => row.getAttribute('href')),
    ).toStrictEqual(['/p/MMR/31', '/p/MMR/33', '/p/MMR/32']);
    expect(within(shipped).queryByRole('link', { name: /See all/ })).toBeNull();
  });

  it('counts a project’s spare-minute work, opening Seeds, Going cold, and Record health', async () => {
    await openBusyProject();

    const minute = await section('When you have a minute');
    expect(hrefOf(minute, 'Seeds to triage 5')).toBe('/p/MMR/seeds?show=to-triage');
    expect(hrefOf(minute, 'Going cold 1')).toBe('/p/MMR/tasks?show=going-cold');
    expect(hrefOf(minute, 'Record health findings 3')).toBe('/doctor?project=MMR');
    // To groom and Waiting on others wait for their presets.
    expect(within(minute).getByText('To groom')).toBeVisible();
    expect(within(minute).getByText('Waiting on others')).toBeVisible();
    expect(within(minute).getAllByRole('link')).toHaveLength(3);
  });

  it('counts a phase’s spare-minute work with no seeds or Record health, every row plain', async () => {
    serveBrowse({ health: recordHealth({ finding_total: 3 }) });
    await open(PHASE_SCOPE, busyWork());

    const minute = await section('When you have a minute');
    expect(
      within(minute)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toStrictEqual(['To groom 1', 'Going cold 1', 'Waiting on others 1']);
    expect(within(minute).queryByRole('link')).toBeNull();
  });

  it('lists a project’s initiatives last, in tree order, the finished ones in a closed fold', async () => {
    await openBusyProject();

    const parts = await section('Parts');
    expect(
      within(parts)
        .getAllByRole('link')
        .map((row) => [row.textContent, row.getAttribute('href')]),
    ).toStrictEqual([
      ['In progress: Console work 1 of 2 done', '/p/MMR/101'],
      ['Ready: Maintenance Empty', '/p/MMR/108'],
      ['Parked: Post-v1 ideas 0 of 1 done', '/p/MMR/109'],
    ]);
    const fold = within(parts).getByRole('button', { name: 'Finished initiatives 1' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(fold);

    expect(hrefOf(parts, /Old arc/)).toBe('/p/MMR/111');
  });

  it('gives a phase no Parts', async () => {
    await open(PHASE_SCOPE, busyWork());

    await section('When you have a minute');
    expect(screen.queryByRole('region', { name: /^Parts/ })).toBeNull();
  });

  it('says once what is quiet, with when the last task finished, above the spare minute and the parts', async () => {
    await open(PROJECT_SCOPE, engineWork({ goingCold: busyWork().goingCold }));

    const panel = screen.getByRole('tabpanel');
    const quiet = await within(panel).findByText(
      'Nothing is running, ready to start, or waiting on you. The last task finished 9 days ago.',
    );
    expect(quiet.tagName).toBe('P');
    expect(within(panel).queryByText('Nothing here needs you.')).toBeNull();
    for (const name of ['Needs you', 'Now', 'Up next', 'Shipped this week']) {
      expect(within(panel).queryByRole('region', { name: new RegExp(`^${name}`) })).toBeNull();
    }
    await expect(section('When you have a minute')).resolves.toBeDefined();
    await expect(section('Parts')).resolves.toBeDefined();
  });

  it('shows skeletons while the work read is pending', async () => {
    serve(PROJECT_SCOPE);
    vi.mocked(projectWork).mockReturnValue(Promise.withResolvers<WorkReport>().promise);
    await renderRoute(routes, PROJECT_SCOPE.url, quietClient());

    await screen.findByRole('heading', { level: 1, name: PROJECT.title });
    expect(document.querySelector('[aria-busy]')).not.toBeNull();
    expect(screen.queryByText(/Nothing is running/)).toBeNull();
  });

  it('says so when the work read fails with nothing cached, while the header and tabs still render', async () => {
    await open(PROJECT_SCOPE, new TypeError('fetch failed'));

    await expect(screen.findByText(/couldn’t load the work page/i)).resolves.toHaveTextContent(
      'is the Mimir host running?',
    );
    expect(screen.getByRole('tab', { name: 'Work', selected: true })).toBeDefined();
    expect(screen.getByRole('button', { name: 'More' })).toBeDefined();
  });

  it.each([
    ['an Engine refusal', new MimirError('validation', 'timeZone is not a time zone')],
    ['a host fault', new HostFaultError()],
  ])(
    'does not ask whether the server is running when it answered with %s',
    async (_kind, error) => {
      await open(PROJECT_SCOPE, error);

      const message = await screen.findByText(/couldn’t load the work page/i);
      expect(message).toHaveTextContent('Couldn’t load the work page.');
      expect(message).not.toHaveTextContent('host running');
    },
  );
});

describe('an initiative’s Work tab (MMR-727)', () => {
  // An idle open-ended phase is out of its initiative's rollup, which then counts no task.
  const INITIATIVE: EngineNode = engineContainer({
    distribution: {},
    id: 'MMR-120',
    parent: 'MMR',
    status: 'ready',
    title: 'Standing work',
    type: 'initiative',
  });
  const tree = engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
    node('MMR-120', 'initiative', 'ready', 'Standing work', [
      node('MMR-121', 'phase', 'ready', 'Maintenance', [], { open_ended: true }),
    ]),
  ]);

  it('shows Work for an initiative whose only part is an open-ended phase, listing it', async () => {
    serveShell({ trees: { MMR: tree } });
    serveNodes({ nodes: [INITIATIVE] });
    serveViews();
    await renderRoute(routes, '/p/MMR/120', quietClient());

    await screen.findByRole('tab', { name: 'Work', selected: true });
    const parts = await section('Parts');
    expect(hrefOf(parts, /Maintenance/)).toBe('/p/MMR/121');
  });
});

describe('work page Details tab (MMR-726)', () => {
  it.each(SCOPES)('holds the Direction, the description, and the dates, $name', async (each) => {
    serve(each);
    await renderRoute(routes, `${each.url}?tab=details`, quietClient());

    const panel = await screen.findByRole('tabpanel');
    const [first, second] = (each.record.next ?? '').split('\n\n');
    await within(panel).findByText(first ?? '');
    expect(within(panel).getByText(second ?? '')).toBeDefined();
    expect(within(panel).getByRole('region', { name: 'Description' })).toHaveTextContent(
      (each.record.description ?? '').replaceAll('**', ''),
    );
    const facts = within(panel).getByRole('region', { name: 'Facts' });
    expect(within(facts).getByText('Created')).toBeDefined();
    expect(within(facts).getByText('Updated')).toBeDefined();
    // More's Edit direction… rewrites it; the section draws no button of its own.
    expect(within(panel).queryByRole('button')).toBeNull();
  });

  it('a phase lists what it depends on and what it blocks, each linking to its page', async () => {
    serve(PHASE_SCOPE);
    await renderRoute(routes, '/p/MMR/105?tab=details', quietClient());

    const depends = await screen.findByRole('region', { name: 'Depends on 1' });
    expect(hrefOf(depends, /MMR-102/)).toBe('/p/MMR/102');
    expect(hrefOf(screen.getByRole('region', { name: 'Blocking 1' }), /MMR-115/)).toBe(
      '/p/MMR/115',
    );
  });

  it('a container with no description or relations shows only its Direction and dates', async () => {
    serve({ ...PHASE_SCOPE, record: { ...PHASE, deps: undefined, description: null } });
    await renderRoute(routes, '/p/MMR/105?tab=details', quietClient());

    const panel = await screen.findByRole('tabpanel');
    await within(panel).findByRole('region', { name: 'Direction' });
    expect(within(panel).queryByRole('region', { name: 'Description' })).toBeNull();
    expect(within(panel).queryByRole('region', { name: /Depends on/ })).toBeNull();
    expect(within(panel).getByRole('region', { name: 'Facts' })).toBeDefined();
  });
});

describe('work page head (MMR-726)', () => {
  it('a project heads its page with no trail, New task, and More, then its tabs', async () => {
    await open(PROJECT_SCOPE);

    const head = screen.getByRole('heading', { level: 1, name: 'Mimir' }).closest('header')!;
    expect(within(head).queryByRole('navigation', { name: 'Ancestors' })).toBeNull();
    expect(head.textContent?.replaceAll(/\s+/g, ' ')).toContain('In progress Project MMR');
    expect(
      within(head)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toStrictEqual(['New task', 'More']);
    expect(screen.getByRole('tablist', { name: 'Record views' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Project settings' })).toBeNull();
  });

  it('a phase trails its ancestors, and files new work into itself', async () => {
    await open(PHASE_SCOPE);

    const trail = await screen.findByRole('navigation', { name: 'Ancestors' });
    await waitFor(() => {
      expect(hrefOf(trail, 'Console work')).toBe('/p/MMR/101');
    });
    expect(hrefOf(trail, 'Mimir')).toBe('/p/MMR');
    const head = trail.closest('header')!;
    expect(head.textContent?.replaceAll(/\s+/g, ' ')).toContain('In progress Phase MMR-105');

    fireEvent.click(within(head).getByRole('button', { name: 'New task' }));
    const sheet = await screen.findByRole('dialog', { name: 'New work item' });
    // The phase is the home, not the first legal one (the initiative above it).
    await waitFor(() => {
      expect(within(sheet).getByRole('button', { name: /Home/ })).toHaveTextContent('Work page');
    });
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

describe('work page Artifacts (MMR-486, MMR-726)', () => {
  it('a project counts its artifacts on the Artifacts tab, which opens its browser', async () => {
    await open({ ...PROJECT_SCOPE, record: { ...PROJECT, artifacts: artifactsOf(7) } });

    expect(screen.getByRole('tab', { name: 'Artifacts 7' })).toBeDefined();
  });

  it('hides the Artifacts tab when there are none', async () => {
    await open({ ...PROJECT_SCOPE, record: { ...PROJECT, artifacts: [] } });

    expect(screen.queryByRole('tab', { name: /Artifacts/ })).toBeNull();
  });

  it('a container lists what is attached to it, uncapped, on its Artifacts tab, folded by day', async () => {
    serve({ ...PHASE_SCOPE, record: { ...PHASE, artifacts: artifactsOf(7) } });
    await renderRoute(routes, '/p/MMR/105?tab=artifacts', quietClient());

    const panel = await screen.findByRole('tabpanel');
    // One artifact a day: the newest day's open, and the six before it fold.
    expect(within(panel).getByRole('link', { name: /Brief 7/ })).toBeDefined();
    const folds = within(panel)
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-expanded'));
    expect(folds).toHaveLength(7);
    for (const fold of folds.slice(1)) {
      fireEvent.click(fold);
    }
    expect(within(panel).getAllByRole('link')).toHaveLength(7);
    expect(within(panel).queryByRole('link', { name: /^All \d+ artifacts$/ })).toBeNull();
  });

  it('lists two artifacts frozen on one day newest first on the Artifacts tab', async () => {
    const artifacts: RecordArtifact[] = [
      {
        createdAt: new Date('2026-06-03T09:00:00.000Z'),
        id: 'MMR-a1',
        tags: [],
        title: 'Morning brief',
      },
      {
        createdAt: new Date('2026-06-03T15:00:00.000Z'),
        id: 'MMR-a2',
        tags: [],
        title: 'Afternoon brief',
      },
    ];
    serve({ ...PHASE_SCOPE, record: { ...PHASE, artifacts } });
    await renderRoute(routes, '/p/MMR/105?tab=artifacts', quietClient());

    const panel = await screen.findByRole('tabpanel');
    await within(panel).findByRole('link', { name: /Afternoon brief/ });
    expect(
      within(panel)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      expect.stringContaining('Afternoon brief'),
      expect.stringContaining('Morning brief'),
    ]);
  });

  it('truncates a long kind within its row on the Artifacts tab rather than widening it', async () => {
    const kind = 'an_improbably_long_kind_that_runs_well_past_the_phone_measure_of_the_row';
    const artifacts: RecordArtifact[] = [
      { ...artifactsOf(1)[0]!, tags: [`kind:${kind}`], title: 'Long kind brief' },
    ];
    serve({ ...PHASE_SCOPE, record: { ...PHASE, artifacts } });
    await renderRoute(routes, '/p/MMR/105?tab=artifacts', quietClient());

    const panel = await screen.findByRole('tabpanel');
    const word = await within(panel).findByText(/^An improbably long kind/);
    expect(word).toHaveClass('min-w-0', 'truncate');
  });
});
