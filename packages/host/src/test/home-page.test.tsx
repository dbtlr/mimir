import type { EngineNode } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { review } from '../api/fns/views';
import type { ReviewReport } from '../api/view-queries';
import { consoleRoutes } from '../router';
import { serveBrowse, serveListSelecting } from './browse-fns';
import { decision, question, report, stopped } from './needs-you-fixtures';
import { engineTask } from './node-fixtures';
import { renderRoute } from './router';
import { failShellReads, serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import type { Viewport } from './viewport';
import {
  engineReview,
  frontierRow,
  nowRow as makeNowRow,
  shippedRow as makeShippedRow,
  stripRow,
  tagged,
  triageSeed,
  workTask,
} from './views-fixtures';
import { serveViews } from './views-fns';

/*
 * Home at `/` (ADR 0013, MMR-722 refinement): one feed column of the page
 * title and summary, Needs you as the deck, Now as capped title cards, the
 * Shipped summary, and the spare-minute count rows, with no rail. Only Needs
 * you has See all, to the Needs you page (MMR-723). The derivations are swept in home-lib.test.ts; the deck's own rules in
 * needs-you-deck.test.tsx and feed-deck.test.tsx.
 */

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');
vi.mock('../api/fns/deliveries');
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../components/patterns/notice', () => ({ NoticeHost: () => null, toast }));

// Monday 23 November 2026, 15:00 in New York, the tests' browser zone.
const NOW = Date.parse('2026-11-23T20:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000);
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60_000);

beforeEach(() => {
  serveBrowse();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const PROJECTS = [
  stripRow({ key: 'MMR', name: 'Mimir' }),
  stripRow({ key: 'FLT', name: 'Fleet' }),
  stripRow({ key: 'LM', name: 'Loom CLI' }),
];

/** A task in Now, started `minutes` ago, tagged with its project as the review read tags it. */
const running = (id: string, minutes: number, extra: Partial<EngineNode> = {}) =>
  tagged(makeNowRow({ id, title: `Running ${id}`, ...extra }, { startedAt: minutesAgo(minutes) }));

const shipped = (id: string, at: Date, status: 'done' | 'abandoned' = 'done') =>
  tagged(makeShippedRow({ id, status, title: `Shipped ${id}` }, at));

/** Nine tasks in Now, most recently started first, as the report orders them. */
const NINE = Array.from({ length: 9 }, (_, index) =>
  running(`MMR-${String(700 + index)}`, (index + 1) * 10),
);

/** Three cards holding four records: a stop, a project's two decisions, and a question. */
const NEEDS = report(
  [stopped('FLT-d2'), decision('MMR-q1', {}), decision('MMR-q2', {}), question('MMR-731')],
  { names: { FLT: 'Fleet', LM: 'Loom CLI', MMR: 'Mimir' } },
);

/** A busy Home: what needs you, nine running, shipped work, and spare-minute work. */
function busy(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    ...NEEDS,
    goingCold: [{ project: 'MMR', task: workTask({ id: 'MMR-90', status: 'in_progress' }) }],
    now: NINE,
    projects: PROJECTS,
    runnable: [tagged(frontierRow({ grooming: 'groomed', id: 'LM-5', status: 'ready' }))],
    shipped: [
      shipped('MMR-1', minutesAgo(30)),
      shipped('MMR-2', daysAgo(1)),
      shipped('LM-3', daysAgo(2)),
      shipped('MMR-4', daysAgo(2), 'abandoned'),
    ],
    triage: [
      {
        findings: 2,
        goingCold: 1,
        project: { key: 'MMR', name: 'Mimir' },
        seeds: [triageSeed({ id: 'MMR-s1' }), triageSeed({ id: 'MMR-s2' })],
      },
    ],
    ...overrides,
  };
}

/** An empty Home: nothing needs you, runs, or shipped, and only some spare-minute work. */
function quiet(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return busy({
    goingCold: [],
    needsYou: [],
    now: [],
    queue: [],
    runnable: [],
    shipped: [],
    triage: [
      {
        findings: 0,
        goingCold: 0,
        project: { key: 'MMR', name: 'Mimir' },
        seeds: [triageSeed({ id: 'MMR-s1' })],
      },
    ],
    ...overrides,
  });
}

/** Opens Home at `viewport`; the returned `resize` moves the viewport as a window resize does. */
async function openHome(served: ReviewReport, viewport: Viewport | number = 'desktop', path = '/') {
  const resize = stubViewport(viewport);
  serveViews({ review: served });
  serveShell();
  // A fresh read, as the shell's polling keeps it: the focus queue fixes its list from one.
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } });
  const view = await renderRoute(consoleRoutes, path, client);
  await screen.findByRole('heading', { level: 1 });
  return { ...view, client, resize };
}

const section = (name: RegExp) => screen.getByRole('region', { name });
const nowCards = () => within(section(/^Now/)).getAllByRole('button');
const heads = () => screen.getAllByRole('heading', { level: 2 }).map((head) => head.textContent);

describe('Home at / (ADR 0013, MMR-722 refinement)', () => {
  it('leads with the day and one sentence, then Needs you, Now, Shipped, and the spare minute', async () => {
    await openHome(busy());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Monday, 23 November');
    expect(
      screen.getByText(
        '3 cards need you, holding 4 items. 9 tasks are running, and 3 have shipped this week.',
      ),
    ).toBeVisible();
    expect(heads()).toEqual([
      'Needs you 3 cards, 4 items',
      'Now 6 of 9',
      'Shipped this week 3',
      'When you have a minute',
    ]);
  });

  it('has no rail, no project health strip, and See all on Needs you and a one-project Now', async () => {
    await openHome(busy());

    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Project health' })).toBeNull();
    const seeAll = screen.getAllByRole('link', { name: /^See all/ });
    expect(seeAll.map((link) => link.getAttribute('aria-label'))).toStrictEqual([
      'See all in Needs you',
      'See all in Now',
    ]);
    expect(seeAll[0]).toHaveAttribute('href', '/needs-you');
    expect(seeAll[1]).toHaveAttribute('href', '/p/MMR/tasks?show=in-flight');
  });

  it('counts the deck’s cards beside the records the top-bar alert counts', async () => {
    await openHome(busy());

    const needs = section(/^Needs you/);
    expect(within(needs).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Needs you 3 cards, 4 items',
    );
    expect(within(needs).getByRole('button', { name: 'Clear stop on FLT-d2' })).toBeVisible();
  });

  it('says once that nothing needs you, in the section’s place', async () => {
    await openHome(busy({ needsYou: [], queue: [] }));

    expect(screen.getByText('Nothing needs you.')).toBeVisible();
    expect(screen.queryByRole('region', { name: /^Needs you/ })).toBeNull();
  });

  it.each<[Viewport, string, number]>([
    ['desktop', 'Now 6 of 9', 6],
    ['phone', 'Now 4 of 9', 4],
  ])('caps Now on a %s and counts what it shows of the whole', async (viewport, head, shown) => {
    await openHome(busy(), viewport);

    const now = section(/^Now/);
    expect(within(now).getByRole('heading', { level: 2 })).toHaveTextContent(head);
    const titles = within(now)
      .getAllByRole('button')
      .map((card) => card.textContent);
    expect(titles).toEqual(NINE.slice(0, shown).map((row) => row.task.title));
  });

  it.each<[number, number, string]>([
    [767, 9, 'Now 4 of 9'],
    [767, 5, 'Now 4 of 5'],
    [767, 4, 'Now 4'],
    [768, 9, 'Now 6 of 9'],
    [768, 7, 'Now 6 of 7'],
    [768, 6, 'Now 6'],
  ])(
    'caps Now at four below 768 and six from 768 (%ipx, %i running)',
    async (width, total, head) => {
      await openHome(busy({ now: NINE.slice(0, total) }), width);

      expect(within(section(/^Now/)).getByRole('heading', { level: 2 })).toHaveTextContent(head);
    },
  );

  it('changes Now’s cap live when the viewport crosses 768', async () => {
    const { resize } = await openHome(busy(), 1280);

    const cards = () => within(section(/^Now/)).getAllByRole('button');
    expect(cards()).toHaveLength(6);
    resize(767);
    expect(within(section(/^Now/)).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Now 4 of 9',
    );
    expect(cards()).toHaveLength(4);
    resize(768);
    expect(cards()).toHaveLength(6);
  });

  it('hands focus to a shown Now card when a refetch drops the card that opened the preview', async () => {
    const { client } = await openHome(busy(), 'phone');
    const fourth = nowCards()[3]!;
    await userEvent.click(fourth);
    await screen.findByRole('dialog');
    // A poll brings a newer move to the front, pushing the fourth card past the phone's cap.
    serveViews({ review: busy({ now: [running('MMR-99', 1), ...NINE] }) });
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() => expect(fourth).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(nowCards()).toContain(document.activeElement));
  });

  it('hands focus to a shown Now card when narrowing past 768 drops the preview’s opener', async () => {
    const { resize } = await openHome(busy(), 1280);
    const sixth = nowCards()[5]!;
    await userEvent.click(sixth);
    await screen.findByRole('dialog');
    act(() => {
      resize(767);
    });
    expect(sixth).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(nowCards()).toContain(document.activeElement));
  });

  it('counts Now plainly when every card shows', async () => {
    await openHome(busy({ now: NINE.slice(0, 3) }));

    expect(within(section(/^Now/)).getByRole('heading', { level: 2 })).toHaveTextContent('Now 3');
  });

  it('gives each Now card its status, ID, project, and age, and opens its preview on a tap', async () => {
    await openHome(busy({ now: [running('MMR-709', 12)] }));

    const card = screen.getByRole('button', { name: 'Running MMR-709' });
    expect(card).toHaveAccessibleDescription('In progress MMR-709 Mimir 12m');
    await userEvent.click(card);
    const preview = await screen.findByRole('dialog', { name: 'Running MMR-709' });
    expect(within(preview).getByRole('link', { name: 'Open MMR-709' })).toHaveAttribute(
      'href',
      '/p/MMR/709',
    );
  });

  it('summarises the shipped week by day and by project, each project a door to its finished week', async () => {
    await openHome(busy());

    const week = section(/^Shipped this week/);
    expect(within(week).getByRole('img')).toHaveAccessibleName(
      'Shipped each day for the last 7 days: Tuesday 0, Wednesday 0, Thursday 0, Friday 0, Saturday 1, Sunday 1, and 1 so far today.',
    );
    const rows = within(
      within(week).getByRole('list', { name: 'Shipped by project' }),
    ).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual(['MMR Mimir 2', 'LM Loom CLI 1']);
    expect(
      within(week)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/p/MMR/tasks?show=shipped-week', '/p/LM/tasks?show=shipped-week']);
  });

  it('puts a shipped task on the day it finished in the browser’s zone', async () => {
    // 23:50 on Sunday in New York is 04:50 on Monday in UTC.
    await openHome(busy({ shipped: [shipped('MMR-1', new Date('2026-11-23T04:50:00.000Z'))] }));

    expect(within(section(/^Shipped this week/)).getByRole('img')).toHaveAccessibleName(
      'Shipped each day for the last 7 days: Tuesday 0, Wednesday 0, Thursday 0, Friday 0, Saturday 0, Sunday 1, and 0 so far today.',
    );
  });

  it('hides Shipped when nothing shipped this week', async () => {
    await openHome(busy({ shipped: [shipped('MMR-4', daysAgo(1), 'abandoned')] }));

    expect(screen.queryByRole('region', { name: /^Shipped/ })).toBeNull();
  });

  it('counts the spare-minute work, Seeds to triage, Ready, and Going cold opening their one project’s list', async () => {
    await openHome(busy());

    const spare = section(/^When you have a minute/);
    const rows = within(spare).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Seeds to triage 2',
      'Ready to start 1',
      'Going cold 1',
      'Doctor findings 2',
    ]);
    expect(
      within(spare)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['Seeds to triage 2', '/p/MMR/seeds?show=to-triage'],
      ['Ready to start 1', '/p/LM/tasks?show=ready'],
      ['Going cold 1', '/p/MMR/tasks?show=going-cold'],
    ]);
  });

  it('leaves out a spare-minute row at zero, and the section when every row is zero', async () => {
    const { unmount } = await openHome(quiet());

    expect(
      within(section(/^When you have a minute/))
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual(['Seeds to triage 1']);
    unmount();

    await openHome(quiet({ triage: [] }));
    expect(screen.queryByRole('region', { name: /^When you have a minute/ })).toBeNull();
  });

  it('reads a quiet week on an empty page, with only Needs you’s quiet line and the spare minute', async () => {
    await openHome(quiet());

    expect(
      screen.getByText('A quiet week: nothing is running, and nothing has shipped this week.'),
    ).toBeVisible();
    expect(screen.getByText('Nothing needs you.')).toBeVisible();
    expect(heads()).toEqual(['When you have a minute']);
  });

  it('keeps focus mode as it was: the queue, with no page title or feed', async () => {
    await openHome(busy(), 'desktop', '/?mode=focus');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Work through these');
    expect(screen.queryByText('Monday, 23 November')).toBeNull();
    expect(screen.queryByRole('region', { name: /^Now/ })).toBeNull();
  });
});

describe('Home’s See all doors (MMR-724)', () => {
  it('keeps Now’s count but no See all when its tasks span projects', async () => {
    await openHome(busy({ now: [running('MMR-700', 10), running('LM-701', 20)] }));

    const now = section(/^Now/);
    expect(within(now).getByRole('heading', { level: 2 })).toHaveTextContent('Now 2');
    expect(within(now).queryByRole('link', { name: /^See all/ })).toBeNull();
  });

  it('keeps Seeds to triage, Ready, and Going cold as plain counts when they span projects', async () => {
    await openHome(
      busy({
        goingCold: [
          { project: 'MMR', task: workTask({ id: 'MMR-90', status: 'in_progress' }) },
          { project: 'LM', task: workTask({ id: 'LM-91', status: 'ready' }) },
        ],
        runnable: [
          tagged(frontierRow({ grooming: 'groomed', id: 'LM-5', status: 'ready' })),
          tagged(frontierRow({ grooming: 'groomed', id: 'MMR-6', status: 'ready' })),
        ],
        triage: [
          {
            findings: 0,
            goingCold: 0,
            project: { key: 'MMR', name: 'Mimir' },
            seeds: [triageSeed({ id: 'MMR-s1' })],
          },
          {
            findings: 0,
            goingCold: 0,
            project: { key: 'LM', name: 'Loom' },
            seeds: [triageSeed({ id: 'LM-s1' })],
          },
        ],
      }),
    );

    const spare = section(/^When you have a minute/);
    expect(within(spare).getByText('Seeds to triage').closest('a')).toBeNull();
    expect(within(spare).getByText('Ready to start').closest('a')).toBeNull();
    expect(within(spare).getByText('Going cold').closest('a')).toBeNull();
    expect(within(spare).queryByRole('link')).toBeNull();
  });
});

const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60_000);
const done = (id: string, at: Date) =>
  engineTask({
    completedAt: at,
    id,
    lifecycle: 'done',
    status: 'done',
    title: `Done ${id}`,
    updatedAt: at,
  });
/** An abandoned task: only `done` stamps completed_at, so it settled when it last changed. */
const abandoned = (id: string, at: Date) =>
  engineTask({
    id,
    lifecycle: 'abandoned',
    status: 'abandoned',
    title: `Dropped ${id}`,
    updatedAt: at,
  });

describe('Shipped’s count and the shipped-week list agree (MMR-724)', () => {
  /**
   * One board both reads are drawn from: done work across the week's edges
   * (the first hour of the window's first day, the day before it, and a
   * `completed_at` dated tomorrow, as a skewed clock stamps it), an abandoned
   * task, and another project's work.
   */
  const BOARD = [
    done('MMR-1', minutesAgo(20)),
    done('MMR-2', hoursAgo(20)),
    done('MMR-3', daysAgo(3)),
    // 00:30 on Tuesday 17 November in New York: the first day of the seven.
    done('MMR-4', new Date('2026-11-17T05:30:00.000Z')),
    // 23:30 on Monday 16 November in New York: the day before the window.
    done('MMR-5', new Date('2026-11-17T04:30:00.000Z')),
    // Noon on Tuesday 24 November in New York: tomorrow, past the window's end.
    done('MMR-8', new Date('2026-11-24T17:00:00.000Z')),
    abandoned('MMR-6', hoursAgo(2)),
    done('LM-7', hoursAgo(3)),
  ];

  /** The review's finished rows for the board, as the Engine lists them: done and abandoned alike. */
  const shippedRows = BOARD.map((task) =>
    tagged(makeShippedRow(task, task.completedAt ?? task.updatedAt)),
  );

  it('opens a project’s finished week from its Shipped row, listing as many tasks as the row counts', async () => {
    await openHome(busy({ shipped: shippedRows }));
    serveListSelecting(BOARD);

    const row = within(section(/^Shipped this week/)).getByRole('link', { name: /Mimir/ });
    const shippedCount = Number(/(\d+)$/.exec(row.textContent)?.[1]);
    expect(shippedCount).toBe(4);

    await userEvent.click(row);
    await screen.findByRole('button', { name: 'Remove Shipped, last 7 days' });
    // Each day's fold trigger: "Today 1", "Sunday, 22 November 1".
    const folds = await screen.findAllByRole('button', {
      name: /^(Today|Yesterday|\w+day, \d+ \w+) \d+$/,
    });
    const listed = folds.reduce(
      (n, fold) => n + Number(/(\d+)$/.exec(fold.textContent)?.[1] ?? 0),
      0,
    );
    expect(listed).toBe(shippedCount);
    expect(screen.getByText(`${String(shippedCount)} shipped in the last 7 days`)).toBeVisible();
  });
});

describe('Home before it has projects', () => {
  it('offers a fresh store its first project', async () => {
    serveViews({ review: engineReview() });
    serveShell();
    await renderRoute(consoleRoutes, '/');

    await expect(screen.findByText('No projects yet.')).resolves.toBeDefined();
    expect(screen.queryByRole('region', { name: /Needs you/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: '+ New project' }).length).toBeGreaterThan(0);
  });

  it('does not claim a fresh store before it knows whether projects are archived', async () => {
    serveViews({ review: engineReview() });
    failShellReads(new Error('archived read failed'));
    await renderRoute(consoleRoutes, '/');

    await screen.findByRole('heading', { level: 1, name: 'Monday, 23 November' });
    expect(screen.queryByText('No projects yet.')).toBeNull();
  });

  it('asks for the review in the browser’s time zone', async () => {
    await openHome(quiet());

    expect(review).toHaveBeenCalledWith({ data: { timeZone: 'America/New_York' } });
  });
});
