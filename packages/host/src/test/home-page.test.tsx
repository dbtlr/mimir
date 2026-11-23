import type { EngineNode } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { review } from '../api/fns/views';
import type { ReviewReport } from '../api/view-queries';
import { consoleRoutes } from '../router';
import { serveBrowse } from './browse-fns';
import { decision, question, report, stopped } from './needs-you-fixtures';
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
 * Shipped summary, and the spare-minute count rows, with no rail and no See
 * all. The derivations are swept in home-lib.test.ts; the deck's own rules in
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

async function openHome(served: ReviewReport, viewport: Viewport = 'desktop', path = '/') {
  stubViewport(viewport);
  serveViews({ review: served });
  serveShell();
  // A fresh read, as the shell's polling keeps it: the focus queue fixes its list from one.
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } });
  const view = await renderRoute(consoleRoutes, path, client);
  await screen.findByRole('heading', { level: 1 });
  return view;
}

const section = (name: RegExp) => screen.getByRole('region', { name });
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

  it('has no rail, no project health strip, and no See all', async () => {
    await openHome(busy());

    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Project health' })).toBeNull();
    expect(screen.queryByRole('link', { name: /^See all/ })).toBeNull();
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

  it('summarises the shipped week by day and by project, in plain rows', async () => {
    await openHome(busy());

    const week = section(/^Shipped this week/);
    expect(within(week).getByRole('img')).toHaveAccessibleName(
      'Shipped each day for the last 7 days: Tuesday 0, Wednesday 0, Thursday 0, Friday 0, Saturday 1, Sunday 1, and 1 so far today.',
    );
    const rows = within(
      within(week).getByRole('list', { name: 'Shipped by project' }),
    ).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual(['MMR Mimir 2', 'LM Loom CLI 1']);
    expect(within(week).queryByRole('link')).toBeNull();
  });

  it('hides Shipped when nothing shipped this week', async () => {
    await openHome(busy({ shipped: [shipped('MMR-4', daysAgo(1), 'abandoned')] }));

    expect(screen.queryByRole('region', { name: /^Shipped/ })).toBeNull();
  });

  it('counts the spare-minute work in plain rows', async () => {
    await openHome(busy());

    const spare = section(/^When you have a minute/);
    const rows = within(spare).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Seeds to triage 2',
      'Ready to start 1',
      'Going cold 1',
      'Doctor findings 2',
    ]);
    expect(within(spare).queryByRole('link')).toBeNull();
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
