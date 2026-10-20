import type { EngineNode } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { done, getNode } from '../api/fns/nodes';
import { tree } from '../api/fns/shell';
import { review } from '../api/fns/views';
import { browserTimeZone } from '../api/queries';
import type { NeedsYouTask, ReviewReport } from '../api/view-queries';
import { consoleRoutes } from '../router';
import { engineTree } from './engine-fixtures';
import { engineNote, engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { renderRoute } from './router';
import { serveShell } from './shell-fns';
import { engineReview, needsYouRow, stripRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/views');

const NOW = Date.parse('2026-10-13T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function decision(
  id: string,
  reason: NeedsYouTask['reason'],
  extra: { title?: string; holdReason?: string; question?: string } = {},
): NeedsYouTask {
  const status = { blocked: 'blocked', needs_answers: 'ready', under_review: 'under_review' }[
    reason
  ] as NeedsYouTask['task']['status'];
  const { question = null, ...node } = extra;
  return needsYouRow({ id, status, ...node }, reason, { question });
}

const LM = { key: 'LM', name: 'Loom CLI' };
const MMR = { key: 'MMR', name: 'Mimir' };

const verdict = decision('LM-196', 'under_review', { title: 'Ship the plugin' });
const block = decision('MMR-52', 'blocked', {
  holdReason: 'Needs an API token',
  title: 'Screenshot a signed-in page',
});
const question = decision('MMR-480', 'needs_answers', {
  question: 'Skip, or drop it?',
  title: 'Pick the skip behavior',
});

/** A review read listing `rows` as decisions in the queue order given, grouped LM then MMR. */
function decisions(...rows: NeedsYouTask[]): ReviewReport {
  const groups = [LM, MMR]
    .map((p) => ({ project: p, rows: rows.filter((r) => r.task.id.startsWith(`${p.key}-`)) }))
    .filter((group) => group.rows.length > 0);
  return engineReview({
    decisions: groups,
    projects: [stripRow(LM, { decisions: groups[0]?.rows.length ?? 0 }), stripRow(MMR)],
    queue: rows.map((r) => r.task.id),
  });
}

/** Each task's detail record, its notes, and its project's tree, as the focus card reads them. */
type Details = Record<
  string,
  { node?: Partial<EngineNode>; notes?: ReturnType<typeof engineNote>[] }
>;

/**
 * Serve `report` as the review read until a write lands, then `after` (when
 * given), with each task's detail and its project's tree (one phase above it).
 */
function serve(
  report: ReviewReport,
  { after, details = {} } = {} as {
    after?: ReviewReport;
    details?: Details;
  },
) {
  let current = report;
  serveViews();
  vi.mocked(review).mockImplementation(async () => current);
  serveShell();
  serveNodes();
  vi.mocked(getNode).mockImplementation(async ({ data }) => {
    const detail = details[data.id];
    const node = engineTask({ id: data.id, status: 'ready', ...detail?.node });
    return data.facets?.length === 1 && data.facets[0] === 'annotations'
      ? { ...node, annotations: detail?.notes ?? [] }
      : node;
  });
  vi.mocked(tree).mockImplementation(async ({ data }) => {
    const key = data.id;
    const leaves = current.queue
      .filter((id) => id.startsWith(`${key}-`))
      .map((id) => engineTree({ id, parent: `${key}-2`, status: 'ready', type: 'task' }));
    const phase = engineTree(
      { id: `${key}-2`, parent: key, status: 'in_progress', title: 'Review page', type: 'phase' },
      leaves,
    );
    return engineTree(
      { id: key, status: 'ready', title: key === 'MMR' ? 'Mimir' : 'Loom CLI', type: 'project' },
      [phase],
    );
  });
  vi.mocked(done).mockImplementation(async ({ data }) => {
    if (after !== undefined) {
      current = after;
    }
    return engineTask({ id: data.id, status: 'done' });
  });
  return {
    /** Serve `next` from the next review read, as a poll would. */
    poll: (next: ReviewReport) => {
      current = next;
    },
  };
}

/** A query client; `cached` seeds the review read as one restored from a day ago. */
function reviewClient(cached?: ReviewReport) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } });
  if (cached !== undefined) {
    client.setQueryData(['review', browserTimeZone()], cached, {
      updatedAt: NOW - 24 * 60 * 60_000,
    });
  }
  return client;
}

describe('the review page head opens the focus queue (MMR-480)', () => {
  it('offers Work through these, with the decision count, at /?mode=focus', async () => {
    serve(decisions(verdict, block, question));
    await renderRoute(consoleRoutes, '/', reviewClient());

    const open = await screen.findByRole('link', { name: 'Work through these · 3' });
    expect(open.getAttribute('href')).toBe('/?mode=focus');
  });

  it('offers no queue when nothing needs you', async () => {
    serve(decisions());
    await renderRoute(consoleRoutes, '/', reviewClient());

    await screen.findByRole('heading', { level: 1, name: 'Nothing needs you' });
    expect(screen.queryByRole('link', { name: /Work through these/ })).toBeNull();
  });
});

/** The focus card, named by the title of the one decision the queue shows. */
const cardFor = (row: NeedsYouTask) => screen.findByRole('region', { name: row.task.title });

describe('the focus queue at /?mode=focus (ADR 0013, MMR-476 refinement)', () => {
  it('shows the first decision with its path, description, and question, and names the next', async () => {
    serve(decisions(question, block), {
      details: {
        'MMR-480': { node: { description: 'Step through **decisions** one at a time.' } },
      },
    });
    await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());

    const shown = await cardFor(question);
    expect(screen.getByRole('heading', { level: 1, name: 'Work through these' })).toBeDefined();
    expect(within(shown).getByRole('heading', { name: 'Pick the skip behavior' })).toBeDefined();
    expect(shown).toHaveTextContent('MMR-480');
    expect(shown).toHaveTextContent('Needs answers');
    expect(shown).toHaveTextContent('Skip, or drop it?');
    await waitFor(() => {
      expect(within(shown).getByText('decisions').tagName).toBe('STRONG');
    });
    const path = within(shown).getByRole('navigation', { name: 'Path' });
    await waitFor(() => {
      expect(path).toHaveTextContent('Mimir›Review page');
    });
    expect(screen.getByText('1 of 2')).toBeDefined();
    const next = screen.getByRole('region', { name: 'Up next' });
    expect(next).toHaveTextContent('MMR-52');
    expect(next).toHaveTextContent('Screenshot a signed-in page');
    // The list's sections are gone while the queue is open.
    expect(screen.queryByRole('region', { name: /^Needs you/ })).toBeNull();
    expect(screen.getByRole('link', { name: '← Back to the list' }).getAttribute('href')).toBe('/');
  });

  it('shows a verdict with the work submitted, and approving moves to the next decision', async () => {
    serve(decisions(verdict, question), {
      after: decisions(question),
      details: {
        'LM-196': {
          node: {
            externalRef: 'https://github.com/dbtlr/loom/pull/12',
            history: [
              {
                at: new Date('2026-10-13T10:00:00.000Z'),
                from: 'in_progress',
                kind: 'lifecycle',
                reason: null,
                to: 'under_review',
              },
            ],
          },
          notes: [engineNote('Plugin ships with docs.', '2026-10-13T10:01:00.000Z')],
        },
      },
    });
    await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());

    const shown = await cardFor(verdict);
    await waitFor(() => {
      expect(shown).toHaveTextContent('Plugin ships with docs.');
    });
    expect(
      within(shown).getByRole('link', { name: /github\.com\/dbtlr\/loom\/pull\/12/ }),
    ).toBeDefined();

    fireEvent.click(within(shown).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(done).toHaveBeenCalledWith({ data: { id: 'LM-196' } });
    });
    await expect(cardFor(question)).resolves.toBeDefined();
    expect(screen.getByText('2 of 2')).toBeDefined();
  });

  it('links a URL in the hold reason, opening in a new tab, with the text around it', async () => {
    const linked = decision('MMR-53', 'blocked', {
      holdReason: 'Waiting on https://example.com/review today',
      title: 'Wait for the review',
    });
    serve(decisions(linked));
    await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());

    const shown = await cardFor(linked);
    const link = within(shown).getByRole('link', { name: 'https://example.com/review' });
    expect(link.getAttribute('href')).toBe('https://example.com/review');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(shown).toHaveTextContent('Waiting on https://example.com/review today');
  });

  it('lands focus on the next decision’s first action after acting', async () => {
    serve(decisions(verdict, question), { after: decisions(question) });
    await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());

    const approve = within(await cardFor(verdict)).getByRole('button', { name: 'Approve' });
    approve.focus();
    fireEvent.click(approve);

    const next = await cardFor(question);
    await waitFor(() => {
      expect(within(next).getByRole('button', { name: 'Answer…' })).toHaveFocus();
    });
  });

  it('shows a block on you with what it waits on, a link to its task, and no action', async () => {
    serve(decisions(block));
    await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());

    const shown = await cardFor(block);
    expect(shown).toHaveTextContent('Blocked · yours');
    expect(shown).toHaveTextContent('Needs an API token');
    const actions = within(shown).getByRole('group', { name: 'Actions for MMR-52' });
    expect(
      within(actions)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Skip']);
    expect(within(actions).getByRole('link', { name: 'Open task page' }).getAttribute('href')).toBe(
      '/p/MMR/52',
    );
  });

  it('skips without writing, and returns to / with the skipped decision still listed', async () => {
    serve(decisions(question, block));
    const { router: testRouter } = await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());

    fireEvent.click(within(await cardFor(question)).getByRole('button', { name: 'Skip' }));
    const second = await cardFor(block);
    fireEvent.click(within(second).getByRole('button', { name: 'Skip' }));

    await screen.findByRole('region', { name: 'Needs you · 2' });
    expect(testRouter.state.location.href).toBe('/');
    expect(done).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Work through these · 2' })).toBeDefined();
  });

  it('keeps the list it opened with: a later decision waits, a settled one is passed over', async () => {
    const later = decision('MMR-490', 'needs_answers', {
      question: 'Which?',
      title: 'Arrived later',
    });
    const serving = serve(decisions(verdict, block));
    const client = reviewClient();
    await renderRoute(consoleRoutes, '/?mode=focus', client);
    await cardFor(verdict);

    // The verdict is settled elsewhere and a new question arrives.
    serving.poll(decisions(block, later));
    await client.invalidateQueries({ queryKey: ['review'] });

    const shown = await cardFor(block);
    expect(screen.getByText('2 of 2')).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Up next' })).toBeNull();
    fireEvent.click(within(shown).getByRole('button', { name: 'Skip' }));
    await screen.findByRole('region', { name: 'Needs you · 2' });
  });

  it('returns to / when nothing needs you', async () => {
    serve(decisions());
    const { router: testRouter } = await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());

    await screen.findByRole('heading', { level: 1, name: 'Nothing needs you' });
    expect(testRouter.state.location.href).toBe('/');
  });

  it('lands focus on the next decision’s first action after Skip', async () => {
    serve(decisions(question, verdict));
    await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());

    const skip = within(await cardFor(question)).getByRole('button', { name: 'Skip' });
    skip.focus();
    fireEvent.click(skip);

    const next = await cardFor(verdict);
    expect(within(next).getByRole('button', { name: 'Approve' })).toHaveFocus();
  });

  it('keeps a passed decision behind it when the decision returns', async () => {
    const serving = serve(decisions(verdict, block, question));
    const client = reviewClient();
    await renderRoute(consoleRoutes, '/?mode=focus', client);
    await cardFor(verdict);

    // The verdict is sent back elsewhere, then resubmitted.
    serving.poll(decisions(block, question));
    await client.invalidateQueries({ queryKey: ['review'] });
    await cardFor(block);
    serving.poll(decisions(verdict, block, question));
    await client.invalidateQueries({ queryKey: ['review'] });

    await expect(cardFor(block)).resolves.toBeDefined();
    expect(screen.queryByRole('region', { name: verdict.task.title })).toBeNull();
    expect(screen.getByText('2 of 3')).toBeDefined();
  });

  it('fixes its list from a fresh read, not a cached one', async () => {
    serve(decisions(question));
    const { router: testRouter } = await renderRoute(
      consoleRoutes,
      '/?mode=focus',
      reviewClient(decisions(verdict)),
    );

    await expect(cardFor(question)).resolves.toBeDefined();
    expect(screen.queryByRole('region', { name: verdict.task.title })).toBeNull();
    expect(testRouter.state.location.href).toBe('/?mode=focus');
  });
});
