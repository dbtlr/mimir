import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  WireNode,
  WireReviewProject,
  WireReviewReport,
  WireSeed,
  WireWorkNeedsYou,
} from '../api/types';
import { router } from '../router';
import { project, reviewReport, seed, task } from './fixtures';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60_000).toISOString();
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

function decision(
  id: string,
  reason: WireWorkNeedsYou['reason'],
  extra: Partial<WireWorkNeedsYou> = {},
): WireWorkNeedsYou {
  const status = { blocked: 'blocked', needs_answers: 'ready', under_review: 'under_review' }[
    reason
  ] as WireWorkNeedsYou['status'];
  return { ...task({ id, status }), question: null, reason, stale: false, ...extra };
}

/** Serve the review payload, the archived shelf, and empty collections for every other read. */
function serve(report: WireReviewReport, archived = [] as ReturnType<typeof project>[]) {
  apiGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/review')) {
      return Promise.resolve(report);
    }
    if (path === '/api/projects?status=archived') {
      return Promise.resolve({ items: archived, total: archived.length });
    }
    return Promise.resolve({ items: [], total: 0 });
  });
}

function renderReview() {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: router.routeTree,
  });
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return client;
}

const RAIL = 'Projects and spare-minute work';

/** A row's action buttons, grouped and named for the record they act on. */
const actionsOf = (id: string) => screen.findByRole('group', { name: `Actions for ${id}` });

/** Press a row's button the way a keyboard does: focused first, then activated. */
const press = async (id: string, name: string) => {
  const button = within(await actionsOf(id)).getByRole('button', { name });
  button.focus();
  fireEvent.click(button);
};

const lmSeed = seed({ id: 'LM-s4', lane: 'untriaged', project: 'LM', title: 'Plugin hooks' });
const firstSeed = seed({ id: 'MMR-s25', lane: 'untriaged', title: 'Oldest idea' });
const secondSeed = seed({ id: 'MMR-s30', lane: 'untriaged', title: 'Newer bug' });

const LM = { key: 'LM', name: 'Loom CLI' };
const MMR = { key: 'MMR', name: 'Mimir' };
const NORN = { key: 'NORN', name: 'Norn' };

/** A project's strip row; override the counts a case sets. */
function stripRow(
  ref: { key: string; name: string },
  counts: Partial<WireReviewProject> = {},
): WireReviewProject {
  return { ...ref, decisions: 0, going_cold: 0, in_flight: 0, live: 0, triage: 0, ...counts };
}

const TWO_PROJECTS = [
  stripRow(LM, { decisions: 1, in_flight: 1 }),
  stripRow(MMR, { decisions: 2, in_flight: 2, triage: 3 }),
];

/** A task running now, tagged with its project the way the review read tags it. */
const nowRow = (id: string, extra: Partial<WireNode> = {}) => ({
  ...task({ id, status: 'in_progress', title: `Running ${id}`, ...extra }),
  latest_note: null,
  project: id.split('-')[0]!,
  scratchpads: [],
  stale: false,
  started_at: hoursAgo(1),
});

const shippedRow = (id: string, at: string, extra: Partial<WireNode> = {}) => ({
  ...task({ id, status: 'done', title: `Shipped ${id}`, ...extra }),
  abandon_reason: null,
  finished_at: at,
  project: id.split('-')[0]!,
  stale: false,
});

const runnableRow = (id: string, title = `Runnable ${id}`) => ({
  ...task({ grooming: 'groomed', id, status: 'ready', title }),
  awaiting_on: [],
  break_down: false,
  project: id.split('-')[0]!,
  stale: false,
});

const coldRow = (id: string, quietDays: number) => ({
  ...task({ id, status: 'in_progress', title: `Cold ${id}`, updated_at: daysAgo(quietDays) }),
  project: id.split('-')[0]!,
});

const getRail = () => screen.getByRole('complementary', { name: RAIL });
const minute = () => within(getRail()).getByRole('region', { name: /^When you have a minute/ });

describe('the review page at / (ADR 0013, MMR-503 refinement)', () => {
  it('heads the page with the decision count and groups decisions by project', async () => {
    serve(
      reviewReport({
        decisions: [
          { project: LM, rows: [decision('LM-196', 'under_review', { title: 'Ship the plugin' })] },
          {
            project: MMR,
            rows: [
              decision('MMR-52', 'blocked', { hold_reason: 'Needs an API token' }),
              decision('MMR-480', 'needs_answers', { question: 'Skip to the end, or drop it?' }),
            ],
          },
        ],
        projects: TWO_PROJECTS,
        queue: ['LM-196', 'MMR-52', 'MMR-480'],
      }),
    );
    renderReview();

    const head = await screen.findByRole('heading', { level: 1, name: /Needs you/ });
    expect(head.textContent).toContain('3');
    const needs = screen.getByRole('region', { name: 'Needs you · 3' });
    const groups = within(needs).getAllByRole('region');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Loom CLI', 'Mimir']);
    expect(within(groups[0]!).getByRole('link', { name: 'Ship the plugin' })).toBeDefined();
    expect(within(groups[0]!).getByText('In review')).toBeDefined();
    expect(within(groups[1]!).getByText('Needs an API token')).toBeDefined();
    expect(within(groups[1]!).getByText('Skip to the end, or drop it?')).toBeDefined();
    // The group heading names the project and opens its work page.
    expect(within(groups[1]!).getByRole('link', { name: /Mimir/ }).getAttribute('href')).toBe(
      '/p/MMR',
    );
    expect(screen.getByRole('link', { name: 'Work through these · 3' }).getAttribute('href')).toBe(
      '/?mode=focus',
    );
  });

  it('orders the main column Needs you, Now, then Shipped', async () => {
    serve(
      reviewReport({
        decisions: [{ project: LM, rows: [decision('LM-196', 'under_review')] }],
        now: [nowRow('MMR-502')],
        projects: TWO_PROJECTS,
        queue: ['LM-196'],
        shipped: [shippedRow('MMR-497', new Date(NOW).toISOString())],
      }),
    );
    renderReview();

    await screen.findByRole('heading', { level: 1, name: /Needs you/ });
    const article = screen.getByRole('article');
    const sections = within(article)
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatch(/^Needs you · 1/);
    expect(sections[1]).toMatch(/^Now · 1/);
    expect(sections[2]).toMatch(/^Shipped · 1/);
  });

  it('lists the work in flight across projects, each row led by its project key', async () => {
    serve(
      reviewReport({
        now: [nowRow('NORN-401', { harness: 'codex' }), nowRow('MMR-502')],
        projects: TWO_PROJECTS,
      }),
    );
    renderReview();

    const now = await screen.findByRole('region', { name: 'Now · 2' });
    const rows = now.querySelectorAll('[data-row-id]');
    expect([...rows].map((r) => r.getAttribute('data-row-id'))).toEqual(['NORN-401', 'MMR-502']);
    expect(within(now).getByRole('link', { name: 'Running NORN-401' }).getAttribute('href')).toBe(
      '/p/NORN/401',
    );
    expect(within(now).getByText('NORN-401')).toBeDefined();
    expect(now).toHaveTextContent('Started 1h ago');
    expect(now).toHaveTextContent('codex');
  });

  it('says nothing is running when no task is in progress', async () => {
    serve(reviewReport({ projects: TWO_PROJECTS }));
    renderReview();

    const now = await screen.findByRole('region', { name: 'Now' });
    expect(now).toHaveTextContent('Nothing running.');
  });

  it('groups what shipped by day, newest first, with each row’s project key and finish time', async () => {
    serve(
      reviewReport({
        projects: TWO_PROJECTS,
        shipped: [
          shippedRow('MMR-497', new Date(NOW).toISOString()),
          shippedRow('LM-228', daysAgo(3)),
          shippedRow('MMR-490', daysAgo(3), { status: 'abandoned', title: 'Dropped idea' }),
        ],
      }),
    );
    renderReview();

    const shipped = await screen.findByRole('region', { name: 'Shipped · 3' });
    const days = within(shipped).getAllByRole('heading', { level: 3 });
    expect(days).toHaveLength(2);
    expect(days[0]!.textContent).toMatch(/^Today · /);
    expect(
      [...shipped.querySelectorAll('[data-row-id]')].map((r) => r.getAttribute('data-row-id')),
    ).toEqual(['MMR-497', 'LM-228', 'MMR-490']);
    expect(within(shipped).getByRole('link', { name: 'Shipped LM-228' }).getAttribute('href')).toBe(
      '/p/LM/228',
    );
    expect(shipped).toHaveTextContent('08:00');
  });

  it('says nothing shipped in the last 7 days', async () => {
    serve(reviewReport({ projects: TWO_PROJECTS }));
    renderReview();

    const shipped = await screen.findByRole('region', { name: 'Shipped' });
    expect(shipped).toHaveTextContent('Nothing shipped in the last 7 days.');
  });

  it('reads calm when nothing needs you, still showing Now and Shipped', async () => {
    serve(
      reviewReport({
        last_finished: {
          ...task({ id: 'MMR-474', status: 'done', title: 'Keep focus in place' }),
          abandon_reason: null,
          finished_at: hoursAgo(2),
          stale: false,
        },
        now: [nowRow('MMR-502')],
        projects: [stripRow(LM, { in_flight: 1 }), stripRow(MMR, { in_flight: 3 })],
        shipped: [shippedRow('MMR-474', hoursAgo(2))],
      }),
    );
    renderReview();

    await expect(
      screen.findByRole('heading', { level: 1, name: 'Nothing needs you' }),
    ).resolves.toBeDefined();
    expect(screen.queryByRole('link', { name: /Work through these/ })).toBeNull();
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(needs.textContent).toContain('Agents are working on 4 tasks.');
    const last = within(needs).getByRole('link', { name: 'Keep focus in place' });
    expect(last.getAttribute('href')).toBe('/p/MMR/474');
    expect(needs.textContent).toContain('2h ago');
    expect(screen.getByRole('region', { name: 'Now · 1' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'Shipped · 1' })).toBeDefined();
  });

  it('names a quiet board plainly when nothing is in flight or finished', async () => {
    serve(reviewReport({ projects: [stripRow(MMR)] }));
    renderReview();

    await screen.findByRole('heading', { level: 1, name: 'Nothing needs you' });
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(needs.textContent).toContain('No task is in progress.');
    expect(needs.textContent).not.toContain('Last finished');
  });

  it('asks for the review in the browser’s time zone', async () => {
    serve(reviewReport({ projects: TWO_PROJECTS }));
    renderReview();

    await screen.findByRole('heading', { level: 1 });
    expect(apiGet.mock.calls.map(([path]) => path as string)).toContain(
      '/api/review?tz=America%2FNew_York',
    );
  });
});

describe('the review rail: the project health strip', () => {
  it('lists every project in report order with its decisions, live, and cold counts', async () => {
    serve(
      reviewReport({
        projects: [
          stripRow(MMR, { decisions: 2, going_cold: 1, live: 7 }),
          stripRow(LM, { live: 3 }),
          stripRow(NORN),
        ],
      }),
    );
    renderReview();

    const rail = await screen.findByRole('complementary', { name: RAIL });
    expect(within(rail).getByRole('heading', { level: 2, name: 'Projects · 3' })).toBeDefined();
    const list = within(rail).getByRole('list', { name: 'Project health' });
    const links = within(list).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/p/MMR', '/p/LM', '/p/NORN']);
    const [mimir, loom, norn] = links;
    expect(mimir!.textContent).toContain('MMR');
    expect(mimir!.textContent).toContain('Mimir');
    expect(mimir!.textContent).toContain('2 decisions');
    expect(mimir!.textContent).toContain('7 live');
    expect(mimir!.textContent).toContain('1 cold');
    // A zero is absent, not nought: the cell is a dash, and a reader hears nothing.
    expect(loom!.textContent).not.toContain('decision');
    expect(loom!.textContent).not.toContain('cold');
    expect(loom!.textContent).toContain('3 live');
    expect(norn!.textContent).not.toMatch(/decision|live|cold/);
  });

  it('is the one project listing: no triage table, archived shelf, or New project on the page', async () => {
    serve(reviewReport({ projects: TWO_PROJECTS }), [
      project({ archived_at: daysAgo(30), id: 'OLD', status: 'done', title: 'Old project' }),
    ]);
    renderReview();

    await screen.findByRole('list', { name: 'Project health' });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: /Archived/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ New project' })).toBeNull();
    expect(screen.queryByText('Old project')).toBeNull();
    expect(screen.queryByRole('region', { name: /Triage when you have a minute/ })).toBeNull();
  });

  it('stacks the rail under the main column on a phone, with no chips', async () => {
    serve(reviewReport({ projects: TWO_PROJECTS }));
    renderReview();

    const rail = await screen.findByRole('complementary', { name: RAIL });
    expect(screen.queryByRole('group', { name: RAIL })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Projects/ })).toBeNull();
    // Shown at every width: it is not the desktop-only `hidden md:flex` rail.
    expect(rail.className.split(' ')).not.toContain('hidden');
    expect(rail.className.split(' ')).toContain('flex');
    expect(within(rail).getByRole('list', { name: 'Project health' })).toBeDefined();
  });
});

describe('the review rail: when you have a minute', () => {
  it('has the four groups, each omitted when empty', async () => {
    serve(
      reviewReport({
        going_cold: [coldRow('LM-219', 12)],
        projects: TWO_PROJECTS,
        runnable: [runnableRow('LM-233', 'Dry-run flag')],
        triage: [
          {
            findings: 3,
            going_cold: 0,
            project: MMR,
            seeds: [seed({ id: 'MMR-s58', lane: 'untriaged', title: 'Name the project' })],
          },
        ],
      }),
    );
    renderReview();

    await screen.findByRole('list', { name: 'Project health' });
    const groups = within(minute())
      .getAllByRole('region')
      .map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['Runnable now', 'To triage', 'Going cold', 'Findings']);
  });

  it('omits the groups that are empty and counts the rows it lists', async () => {
    serve(
      reviewReport({
        projects: TWO_PROJECTS,
        runnable: [runnableRow('LM-233'), runnableRow('MMR-12')],
      }),
    );
    renderReview();

    await screen.findByRole('list', { name: 'Project health' });
    expect(
      within(getRail()).getByRole('heading', { level: 2, name: 'When you have a minute · 2' }),
    ).toBeDefined();
    expect(
      within(minute())
        .getAllByRole('region')
        .map((g) => g.getAttribute('aria-label')),
    ).toEqual(['Runnable now']);
  });

  it('shows a quiet line when every group is empty', async () => {
    serve(reviewReport({ projects: TWO_PROJECTS }));
    renderReview();

    await screen.findByRole('list', { name: 'Project health' });
    const section = within(getRail()).getByRole('region', { name: 'When you have a minute' });
    expect(section).toHaveTextContent('Nothing is waiting for a spare minute.');
    expect(within(section).queryAllByRole('region')).toHaveLength(0);
  });

  it('lists runnable tasks across projects, each with Start', async () => {
    serve(
      reviewReport({
        projects: TWO_PROJECTS,
        runnable: [runnableRow('LM-233', 'Dry-run flag'), runnableRow('NORN-404', 'Orphans')],
      }),
    );
    renderReview();

    await screen.findByRole('list', { name: 'Project health' });
    const runnable = within(minute()).getByRole('region', { name: 'Runnable now' });
    expect(within(runnable).getByRole('link', { name: 'Dry-run flag' }).getAttribute('href')).toBe(
      '/p/LM/233',
    );
    expect(within(runnable).getByText('NORN-404')).toBeDefined();
    expect(within(runnable).getAllByRole('button', { name: 'Start' })).toHaveLength(2);
  });

  it('lists untriaged seeds across projects in the read’s order', async () => {
    serve(
      reviewReport({
        projects: TWO_PROJECTS,
        triage: [
          {
            findings: 0,
            going_cold: 0,
            project: MMR,
            seeds: [
              seed({ id: 'MMR-s25', lane: 'untriaged', title: 'Oldest idea' }),
              seed({ id: 'MMR-s30', lane: 'untriaged', title: 'Newer bug' }),
            ],
          },
          { findings: 0, going_cold: 0, project: LM, seeds: [lmSeed] },
        ],
      }),
    );
    renderReview();

    await screen.findByRole('list', { name: 'Project health' });
    const triageGroup = within(minute()).getByRole('region', { name: 'To triage' });
    const links = within(triageGroup).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Oldest idea', 'Newer bug', 'Plugin hooks']);
    expect(links[0]!.getAttribute('href')).toBe('/p/MMR/s25');
    const labels = within(await actionsOf('MMR-s25'))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels).toStrictEqual(['Promote to task…', 'Reject…', 'Park…']);
  });

  it('lists tasks going cold with how long they have been quiet', async () => {
    serve(
      reviewReport({
        going_cold: [coldRow('LM-219', 12), coldRow('NORN-79', 9)],
        projects: TWO_PROJECTS,
      }),
    );
    renderReview();

    await screen.findByRole('list', { name: 'Project health' });
    const cold = within(minute()).getByRole('region', { name: 'Going cold' });
    expect(within(cold).getByRole('link', { name: 'Cold LM-219' }).getAttribute('href')).toBe(
      '/p/LM/219',
    );
    expect(cold).toHaveTextContent('12d quiet');
    expect(cold).toHaveTextContent('9d quiet');
  });

  it('counts findings per project, each linking to that project’s record health', async () => {
    serve(
      reviewReport({
        projects: TWO_PROJECTS,
        triage: [
          { findings: 12, going_cold: 4, project: MMR, seeds: [] },
          { findings: 0, going_cold: 2, project: LM, seeds: [] },
          { findings: 1, going_cold: 0, project: NORN, seeds: [] },
        ],
      }),
    );
    renderReview();

    await screen.findByRole('list', { name: 'Project health' });
    const findings = within(minute()).getByRole('region', { name: 'Findings' });
    const links = within(findings).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/doctor?project=MMR',
      '/doctor?project=NORN',
    ]);
    expect(links[0]).toHaveTextContent('12 findings');
    expect(links[1]).toHaveTextContent('1 finding');
    // A project with only cold tasks has no findings row, and cold tasks list from `going_cold`.
    expect(within(findings).queryByText('LM')).toBeNull();
    expect(within(minute()).queryByRole('region', { name: 'Going cold' })).toBeNull();
  });

  it('shows the first few rows of a long group and the rest on request', async () => {
    serve(
      reviewReport({
        projects: TWO_PROJECTS,
        runnable: ['LM-1', 'LM-2', 'LM-3', 'LM-4', 'LM-5', 'LM-6', 'LM-7'].map((id) =>
          runnableRow(id),
        ),
      }),
    );
    renderReview();

    await screen.findByRole('list', { name: 'Project health' });
    const runnable = within(minute()).getByRole('region', { name: 'Runnable now' });
    expect(within(runnable).getAllByRole('button', { name: 'Start' })).toHaveLength(5);
    await userEvent.click(within(runnable).getByRole('button', { name: 'Show 2 more runnable' }));
    expect(within(runnable).getAllByRole('button', { name: 'Start' })).toHaveLength(7);
    expect(within(runnable).queryByRole('button', { name: /more runnable/ })).toBeNull();
  });

  it('offers a fresh store its first project', async () => {
    serve(reviewReport());
    renderReview();

    await expect(screen.findByText('No projects yet.')).resolves.toBeDefined();
    expect(screen.queryByRole('region', { name: /Needs you/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: '+ New project' }).length).toBeGreaterThan(0);
  });

  it('does not claim a fresh store before it knows whether projects are archived', async () => {
    apiGet.mockImplementation((path: string) =>
      path.startsWith('/api/review')
        ? Promise.resolve(reviewReport())
        : Promise.reject(new Error('archived read failed')),
    );
    renderReview();

    await screen.findByRole('heading', { level: 1, name: 'Nothing needs you' });
    expect(screen.queryByText('No projects yet.')).toBeNull();
  });
});

/**
 * Serve `before` as the review read until a write lands, then `after`, with the
 * reads the promote sheet makes for its home (MMR's tree, with one initiative).
 */
async function openForWrite(before: WireReviewReport, after: WireReviewReport) {
  let report = before;
  const serving = {
    /** Serve `next` from the next review read, as a poll would. */
    poll: (next: WireReviewReport) => {
      report = next;
      return client.invalidateQueries({ queryKey: ['review'] });
    },
  };
  apiGet.mockImplementation((path: string) => {
    if (path.startsWith('/api/review')) {
      return Promise.resolve(report);
    }
    if (path === '/api/projects') {
      return Promise.resolve({ items: [{ id: 'MMR', title: 'Mimir' }], total: 1 });
    }
    if (path.startsWith('/api/projects/MMR/tree')) {
      const home = { ...task({ id: 'MMR-1', status: 'in_progress', type: 'initiative' }) };
      return Promise.resolve({ ...project({ id: 'MMR' }), children: [{ ...home, children: [] }] });
    }
    return Promise.resolve({ items: [], total: 0 });
  });
  apiSend.mockImplementation(() => {
    report = after;
    return Promise.resolve({});
  });
  const client = renderReview();
  await screen.findByRole('heading', { level: 1 });
  return serving;
}

const verdict = decision('LM-196', 'under_review', { title: 'Ship the plugin' });
const block = decision('MMR-52', 'blocked', { hold_reason: 'Needs an API token' });
const question = decision('MMR-480', 'needs_answers', { question: 'Skip, or drop it?' });

/** Decisions in two project groups: LM's verdict, then MMR's block and question. */
function decisionsFor(rows: { lm?: WireWorkNeedsYou[]; mmr?: WireWorkNeedsYou[] }) {
  const decisions = [
    { project: LM, rows: rows.lm ?? [] },
    { project: MMR, rows: rows.mmr ?? [] },
  ].filter((group) => group.rows.length > 0);
  return reviewReport({
    decisions,
    projects: TWO_PROJECTS,
    queue: decisions.flatMap((group) => group.rows.map((row) => row.id)),
  });
}

describe('review page decisions act in place (MMR-479)', () => {
  it('approves a verdict, and the row leaves Needs you', async () => {
    await openForWrite(decisionsFor({ lm: [verdict] }), decisionsFor({}));

    fireEvent.click(within(await actionsOf('LM-196')).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/LM-196/done', undefined);
    });
    await expect(
      screen.findByRole('heading', { level: 1, name: 'Nothing needs you' }),
    ).resolves.toBeDefined();
  });

  it('sends a verdict back with a reason', async () => {
    await openForWrite(decisionsFor({ lm: [verdict] }), decisionsFor({}));

    fireEvent.click(within(await actionsOf('LM-196')).getByRole('button', { name: 'Send back…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Cover errors' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/LM-196/return', {
        reason: 'Cover errors',
      });
    });
  });

  it('returns focus to Send back… when its dialog is escaped or cancelled', async () => {
    await openForWrite(decisionsFor({ lm: [verdict] }), decisionsFor({}));
    const sendBack = within(await actionsOf('LM-196')).getByRole('button', { name: 'Send back…' });

    await userEvent.click(sendBack);
    await screen.findByRole('dialog', { name: 'Send back' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Send back' })).toBeNull();
    });
    expect(sendBack).toHaveFocus();

    await userEvent.click(sendBack);
    const dialog = await screen.findByRole('dialog', { name: 'Send back' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Send back' })).toBeNull();
    });
    expect(sendBack).toHaveFocus();
  });

  it('answers a question and sets the grooming state', async () => {
    await openForWrite(decisionsFor({ mmr: [question] }), decisionsFor({}));

    fireEvent.click(within(await actionsOf('MMR-480')).getByRole('button', { name: 'Answer…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    expect(dialog).toHaveTextContent('Skip, or drop it?');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /answer/i }), {
      target: { value: 'Drop it.' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^groomed/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Answer' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-480/groom', {
        note: 'Drop it.',
        state: 'groomed',
      });
    });
  });

  it('offers no action on a block on you, which is cleared outside Mimir', async () => {
    serve(decisionsFor({ mmr: [block] }));
    renderReview();

    await screen.findByText('Needs an API token');
    expect(screen.queryByRole('group', { name: 'Actions for MMR-52' })).toBeNull();
  });

  it('lands on the next project’s first action when a group’s last row leaves', async () => {
    await openForWrite(
      decisionsFor({ lm: [verdict], mmr: [question] }),
      decisionsFor({ mmr: [question] }),
    );

    await press('LM-196', 'Approve');

    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Actions for LM-196' })).toBeNull();
    });
    expect(
      within(await actionsOf('MMR-480')).getByRole('button', { name: 'Answer…' }),
    ).toHaveFocus();
  });

  it('lands on a block’s link when the next decision has no action', async () => {
    await openForWrite(
      decisionsFor({ lm: [verdict], mmr: [block] }),
      decisionsFor({ mmr: [block] }),
    );

    await press('LM-196', 'Approve');

    await waitFor(() => {
      expect(screen.getByRole('link', { name: block.title })).toHaveFocus();
    });
  });

  it('lands on the Needs you heading when no decision follows the row that left', async () => {
    await openForWrite(
      decisionsFor({ lm: [verdict], mmr: [question] }),
      decisionsFor({ lm: [verdict] }),
    );

    await press('MMR-480', 'Answer…');
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /answer/i }), {
      target: { value: 'Drop it.' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^groomed/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Answer' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: /^Needs you · 1/ })).toHaveFocus();
    });
  });
});

/** The read with LM's and MMR's untriaged seeds; a project with none drops out. */
function triage(rows: { lm?: WireSeed[]; mmr?: WireSeed[] }) {
  return reviewReport({
    projects: TWO_PROJECTS,
    triage: [
      { findings: 0, going_cold: 0, project: LM, seeds: rows.lm ?? [] },
      { findings: 0, going_cold: 0, project: MMR, seeds: rows.mmr ?? [] },
    ].filter((group) => group.seeds.length > 0),
  });
}

describe('review page seed triage acts in place (MMR-479, MMR-506)', () => {
  it('offers Promote to task…, Reject…, and Park… on each untriaged seed', async () => {
    await openForWrite(triage({ mmr: [firstSeed] }), triage({}));

    const labels = within(await actionsOf('MMR-s25'))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels).toStrictEqual(['Promote to task…', 'Reject…', 'Park…']);
  });

  it('parks a seed with a reason, and it leaves the list', async () => {
    await openForWrite(triage({ mmr: [firstSeed, secondSeed] }), triage({ mmr: [secondSeed] }));

    fireEvent.click(within(await actionsOf('MMR-s25')).getByRole('button', { name: 'Park…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Park seed' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'after v1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Park' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/seeds/MMR-s25/park', {
        reason: 'after v1',
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Oldest idea' })).toBeNull();
    });
    expect(screen.getByRole('link', { name: 'Newer bug' })).toBeDefined();
  });

  it('rejects a seed with the reason it requires', async () => {
    await openForWrite(triage({ mmr: [firstSeed] }), triage({}));

    fireEvent.click(within(await actionsOf('MMR-s25')).getByRole('button', { name: 'Reject…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject seed' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Out of scope' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/seeds/MMR-s25/reject', {
        reason: 'Out of scope',
      });
    });
  });

  it('opens the promote sheet with the seed’s title', async () => {
    await openForWrite(triage({ mmr: [firstSeed] }), triage({}));

    fireEvent.click(
      within(await actionsOf('MMR-s25')).getByRole('button', { name: 'Promote to task…' }),
    );

    await expect(screen.findByDisplayValue('Oldest idea')).resolves.toBeDefined();
  });

  it('lands on the next project’s first seed when a project’s last seed is parked', async () => {
    await openForWrite(
      triage({ lm: [lmSeed], mmr: [firstSeed, secondSeed] }),
      triage({ mmr: [firstSeed, secondSeed] }),
    );

    await press('LM-s4', 'Park…');
    const dialog = await screen.findByRole('dialog', { name: 'Park seed' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Park' }));

    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Actions for MMR-s25' })).getByRole('button', {
          name: 'Promote to task…',
        }),
      ).toHaveFocus();
    });
  });

  it('lands on the next seed after a promote moves its seed out of triage', async () => {
    await openForWrite(triage({ mmr: [firstSeed, secondSeed] }), triage({ mmr: [secondSeed] }));

    await press('MMR-s25', 'Promote to task…');
    const promote = await screen.findByRole('button', { name: 'Promote ↵' });
    await waitFor(() => {
      expect(promote).toBeEnabled();
    });
    fireEvent.click(promote);

    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Actions for MMR-s30' })).getByRole('button', {
          name: 'Promote to task…',
        }),
      ).toHaveFocus();
    });
  });

  it('lands on the When you have a minute heading when no seed follows the one that left', async () => {
    await openForWrite(triage({ lm: [lmSeed], mmr: [firstSeed] }), triage({ lm: [lmSeed] }));

    await press('MMR-s25', 'Reject…');
    const dialog = await screen.findByRole('dialog', { name: 'Reject seed' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'No' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 2, name: /^When you have a minute/ }),
      ).toHaveFocus();
    });
  });

  it('keeps the rail heading for focus when the last seed on the page leaves', async () => {
    await openForWrite(triage({ mmr: [firstSeed] }), triage({}));

    await press('MMR-s25', 'Reject…');
    const dialog = await screen.findByRole('dialog', { name: 'Reject seed' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'No' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 2, name: /^When you have a minute/ }),
      ).toHaveFocus();
    });
    expect(screen.getByText('Nothing is waiting for a spare minute.')).toBeDefined();
  });

  it('moves nothing for a cancelled promote’s seed when it leaves later', async () => {
    const serving = await openForWrite(triage({ mmr: [firstSeed, secondSeed] }), triage({}));

    await press('MMR-s25', 'Promote to task…');
    await screen.findByDisplayValue('Oldest idea');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByDisplayValue('Oldest idea')).toBeNull();
    });
    // The seed was promoted elsewhere meanwhile.
    await serving.poll(triage({ mmr: [secondSeed] }));

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Oldest idea' })).toBeNull();
    });
    expect(document.body).toHaveFocus();
  });

  it('lands on the next seed when the promote sheet is closed before its promote lands', async () => {
    const serving = await openForWrite(
      triage({ mmr: [firstSeed, secondSeed] }),
      triage({ mmr: [firstSeed, secondSeed] }),
    );
    const promoted = Promise.withResolvers<object>();
    apiSend.mockReturnValue(promoted.promise);

    await press('MMR-s25', 'Promote to task…');
    const promote = await screen.findByRole('button', { name: 'Promote ↵' });
    await waitFor(() => {
      expect(promote).toBeEnabled();
    });
    fireEvent.click(promote);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByDisplayValue('Oldest idea')).toBeNull();
    });
    void serving.poll(triage({ mmr: [secondSeed] }));
    promoted.resolve({ created: 'MMR-500', id: 'MMR-s25', lifecycle: 'promoted' });

    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Actions for MMR-s30' })).getByRole('button', {
          name: 'Promote to task…',
        }),
      ).toHaveFocus();
    });
  });

  it('moves nothing later for a promote that fails after its sheet closed', async () => {
    const serving = await openForWrite(
      triage({ mmr: [firstSeed, secondSeed] }),
      triage({ mmr: [firstSeed, secondSeed] }),
    );
    const promoted = Promise.withResolvers<object>();
    apiSend.mockReturnValue(promoted.promise);

    await press('MMR-s25', 'Promote to task…');
    const promote = await screen.findByRole('button', { name: 'Promote ↵' });
    await waitFor(() => {
      expect(promote).toBeEnabled();
    });
    fireEvent.click(promote);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByDisplayValue('Oldest idea')).toBeNull();
    });
    promoted.reject(new Error('promote failed'));
    await screen.findByText('promote failed');
    // The seed was triaged elsewhere meanwhile.
    await serving.poll(triage({ mmr: [secondSeed] }));

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Oldest idea' })).toBeNull();
    });
    expect(document.body).toHaveFocus();
  });
});

/** The read with runnable tasks and, optionally, untriaged seeds after them. */
function runnables(ids: string[], seeds: WireSeed[] = []) {
  return reviewReport({
    projects: TWO_PROJECTS,
    runnable: ids.map((id) => runnableRow(id)),
    triage: seeds.length === 0 ? [] : [{ findings: 0, going_cold: 0, project: MMR, seeds }],
  });
}

describe('review page runnable tasks start in place (MMR-506)', () => {
  it('starts a runnable task, and it leaves the group', async () => {
    await openForWrite(runnables(['LM-233', 'MMR-12']), runnables(['MMR-12']));

    fireEvent.click(within(await actionsOf('LM-233')).getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/LM-233/start', undefined);
    });
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Runnable LM-233' })).toBeNull();
    });
    expect(screen.getByRole('link', { name: 'Runnable MMR-12' })).toBeDefined();
  });

  it('lands on the next runnable task’s Start when one starts', async () => {
    await openForWrite(runnables(['LM-233', 'MMR-12']), runnables(['MMR-12']));

    await press('LM-233', 'Start');

    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Actions for MMR-12' })).getByRole('button', {
          name: 'Start',
        }),
      ).toHaveFocus();
    });
  });

  it('lands on the first seed when the last runnable task starts', async () => {
    await openForWrite(runnables(['LM-233'], [firstSeed]), runnables([], [firstSeed]));

    await press('LM-233', 'Start');

    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Actions for MMR-s25' })).getByRole('button', {
          name: 'Promote to task…',
        }),
      ).toHaveFocus();
    });
  });

  it('lands on the rail heading when nothing follows the last row', async () => {
    await openForWrite(runnables(['LM-233']), runnables([]));

    await press('LM-233', 'Start');

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 2, name: /^When you have a minute/ }),
      ).toHaveFocus();
    });
  });
});
