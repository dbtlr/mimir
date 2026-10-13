import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WireReviewReport, WireWorkNeedsYou } from '../api/types';
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
    if (path === '/api/review') {
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
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return testRouter;
}

const LM = { key: 'LM', name: 'Loom CLI' };
const MMR = { key: 'MMR', name: 'Mimir' };

const TWO_PROJECTS = [
  { ...LM, decisions: 1, in_flight: 1, triage: 0 },
  { ...MMR, decisions: 2, in_flight: 2, triage: 3 },
];

describe('the review page at / (ADR 0013, MMR-476 refinement)', () => {
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
    const decide = screen.getByRole('region', { name: 'Decide · 3' });
    const groups = within(decide).getAllByRole('region');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Loom CLI', 'Mimir']);
    expect(within(groups[0]!).getByRole('link', { name: 'Ship the plugin' })).toBeDefined();
    expect(within(groups[0]!).getByText('In review')).toBeDefined();
    expect(within(groups[1]!).getByText('Needs an API token')).toBeDefined();
    expect(within(groups[1]!).getByText('Skip to the end, or drop it?')).toBeDefined();
    // The group heading names the project and opens its work page.
    expect(within(groups[1]!).getByRole('link', { name: /Mimir/ }).getAttribute('href')).toBe(
      '/p/MMR',
    );
  });

  it('says nothing needs you, naming the work in flight and the last finish', async () => {
    serve(
      reviewReport({
        last_finished: {
          ...task({ id: 'MMR-474', status: 'done', title: 'Keep focus in place' }),
          abandon_reason: null,
          finished_at: hoursAgo(2),
          stale: false,
        },
        projects: [
          { ...LM, decisions: 0, in_flight: 1, triage: 0 },
          { ...MMR, decisions: 0, in_flight: 3, triage: 0 },
        ],
      }),
    );
    renderReview();

    await expect(
      screen.findByRole('heading', { level: 1, name: 'Nothing needs you' }),
    ).resolves.toBeDefined();
    const decide = screen.getByRole('region', { name: 'Decide' });
    expect(decide.textContent).toContain('Agents are working on 4 tasks.');
    const last = within(decide).getByRole('link', { name: 'Keep focus in place' });
    expect(last.getAttribute('href')).toBe('/p/MMR/474');
    expect(decide.textContent).toContain('2h ago');
  });

  it('names a quiet board plainly when nothing is in flight or finished', async () => {
    serve(reviewReport({ projects: [{ ...MMR, decisions: 0, in_flight: 0, triage: 0 }] }));
    renderReview();

    await screen.findByRole('heading', { level: 1, name: 'Nothing needs you' });
    const decide = screen.getByRole('region', { name: 'Decide' });
    expect(decide.textContent).toContain('No task is in progress.');
    expect(decide.textContent).not.toContain('Last finished');
  });

  it('tallies triage per project, linking going cold and findings to where they are handled', async () => {
    serve(
      reviewReport({
        projects: TWO_PROJECTS,
        triage: [
          {
            findings: 12,
            going_cold: 4,
            project: MMR,
            seeds: [
              seed({
                created_at: daysAgo(60),
                id: 'MMR-s25',
                lane: 'untriaged',
                title: 'Oldest idea',
              }),
              seed({ created_at: daysAgo(4), id: 'MMR-s30', kind: 'bug', lane: 'untriaged' }),
            ],
          },
          { findings: 0, going_cold: 2, project: LM, seeds: [] },
        ],
      }),
    );
    renderReview();

    const table = await screen.findByRole('table', { name: /Triage/ });
    const [, mimirRow, loomRow] = within(table).getAllByRole('row');
    const cells = within(mimirRow!).getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual(['2', '2mo', '4', '12']);
    expect(within(mimirRow!).getByRole('link', { name: '4' }).getAttribute('href')).toBe('/p/MMR');
    expect(within(mimirRow!).getByRole('link', { name: '12' }).getAttribute('href')).toBe(
      '/doctor?project=MMR',
    );
    // A project with nothing to open shows its counts but no disclosure.
    expect(within(loomRow!).queryByRole('button')).toBeNull();
    expect(
      within(loomRow!)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['—', '—', '2', '—']);
  });

  it("opens a triage row in place to list the project's untriaged seeds, oldest first", async () => {
    serve(
      reviewReport({
        projects: TWO_PROJECTS,
        triage: [
          {
            findings: 0,
            going_cold: 0,
            project: MMR,
            seeds: [
              seed({
                created_at: daysAgo(60),
                id: 'MMR-s25',
                lane: 'untriaged',
                title: 'Oldest idea',
              }),
              seed({
                created_at: daysAgo(4),
                id: 'MMR-s30',
                lane: 'untriaged',
                title: 'Newer bug',
              }),
            ],
          },
        ],
      }),
    );
    renderReview();

    const toggle = await screen.findByRole('button', { name: /Mimir/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link', { name: 'Oldest idea' })).toBeNull();
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const seeds = screen.getByRole('region', { name: 'Untriaged seeds in Mimir' });
    const links = within(seeds).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Oldest idea', 'Newer bug']);
    expect(links[0]!.getAttribute('href')).toBe('/p/MMR/s25');
    await userEvent.click(toggle);
    expect(screen.queryByRole('region', { name: 'Untriaged seeds in Mimir' })).toBeNull();
  });

  it('lists every project in the rail with its decisions, triage, and work in flight', async () => {
    serve(reviewReport({ projects: TWO_PROJECTS }), [
      project({ archived_at: daysAgo(30), id: 'OLD', status: 'done', title: 'Old project' }),
    ]);
    renderReview();

    const rail = await screen.findByRole('complementary', { name: 'Project list' });
    const list = await within(rail).findByRole('list', { name: 'Projects' });
    const items = within(list).getAllByRole('link');
    expect(items.map((a) => a.getAttribute('href'))).toEqual(['/p/LM', '/p/MMR']);
    expect(items[1]!.textContent).toContain('2 decisions');
    expect(items[1]!.textContent).toContain('3 to triage');
    expect(items[1]!.textContent).toContain('2 live');
    expect(items[0]!.textContent).not.toContain('to triage');
    expect(within(rail).getByRole('button', { name: /Archived, 1 project/ })).toBeDefined();
    await userEvent.click(within(rail).getByRole('button', { name: '+ New project' }));
    await expect(screen.findByRole('dialog', { name: /New project/ })).resolves.toBeDefined();
  });

  it('folds the project list into a Projects chip and sheet on a phone', async () => {
    serve(reviewReport({ projects: TWO_PROJECTS }), [
      project({ archived_at: daysAgo(30), id: 'OLD', status: 'done', title: 'Old project' }),
    ]);
    renderReview();

    const chips = await screen.findByRole('group', { name: 'Project list' });
    await userEvent.click(within(chips).getByRole('button', { name: /^Projects/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Projects' });
    expect(
      within(sheet)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/p/LM', '/p/MMR']);
    // Unfolding the archived shelf reveals it in place; it does not close the sheet.
    await userEvent.click(within(sheet).getByRole('button', { name: /Archived, 1 project/ }));
    expect(screen.getByRole('dialog', { name: 'Projects' })).toBeDefined();
    expect(within(sheet).getByText('Old project')).toBeDefined();
  });

  it('offers a fresh store its first project', async () => {
    serve(reviewReport());
    renderReview();

    await expect(screen.findByText('No projects yet.')).resolves.toBeDefined();
    expect(screen.queryByRole('region', { name: /Decide/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: '+ New project' }).length).toBeGreaterThan(0);
  });
});
