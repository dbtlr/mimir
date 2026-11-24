import type { EngineNode } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getNode, groom } from '../api/fns/nodes';
import { tree } from '../api/fns/shell';
import { review } from '../api/fns/views';
import { browserTimeZone } from '../api/queries';
import type { NeedsYouTask, ReviewReport } from '../api/view-queries';
import { consoleRoutes } from '../router';
import { engineTree } from './engine-fixtures';
import { engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { renderRoute, renderShell } from './router';
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

function taskRow(
  id: string,
  reason: NeedsYouTask['reason'],
  extra: { title?: string; holdReason?: string; question?: string } = {},
): NeedsYouTask {
  const status = { blocked: 'blocked', needs_answers: 'ready' }[
    reason
  ] as NeedsYouTask['task']['status'];
  const { question = null, ...node } = extra;
  return needsYouRow({ id, status, ...node }, reason, { question });
}

const LM = { key: 'LM', name: 'Loom CLI' };
const MMR = { key: 'MMR', name: 'Mimir' };

const loomQuestion = taskRow('LM-196', 'needs_answers', {
  question: 'Which name?',
  title: 'Name the plugin',
});
const block = taskRow('MMR-52', 'blocked', {
  holdReason: 'Needs an API token',
  title: 'Screenshot a signed-in page',
});
const question = taskRow('MMR-480', 'needs_answers', {
  question: 'Skip, or drop it?',
  title: 'Pick the skip behavior',
});

/** A review read listing `rows` as the needs-you set in the queue order given, grouped LM then MMR. */
function needsYou(...rows: NeedsYouTask[]): ReviewReport {
  const groups = [LM, MMR]
    .map((p) => ({ project: p, rows: rows.filter((r) => r.task.id.startsWith(`${p.key}-`)) }))
    .filter((group) => group.rows.length > 0);
  return engineReview({
    needsYou: groups,
    projects: [stripRow(LM, { needsYou: groups[0]?.rows.length ?? 0 }), stripRow(MMR)],
    queue: rows.map((r) => ({ id: r.task.id, kind: r.kind })),
  });
}

/** Each task's detail record and its project's tree, as the focus card reads them. */
type Details = Record<string, { node?: Partial<EngineNode> }>;

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
    return node;
  });
  vi.mocked(tree).mockImplementation(async ({ data }) => {
    const key = data.id;
    const leaves = current.queue
      .map((r) => r.id)
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
  const echoed = vi.mocked(groom).getMockImplementation();
  vi.mocked(groom).mockImplementation(async (options) => {
    if (after !== undefined) {
      current = after;
    }
    return echoed?.(options) as never;
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

/** The focus card, named by the title of the one member the queue shows. */
const cardFor = (row: NeedsYouTask) => screen.findByRole('region', { name: row.task.title });

describe('the focus queue at /?mode=focus (ADR 0013, MMR-476 refinement)', () => {
  it('shows the first decision with its path, description, and question, and names the next', async () => {
    serve(needsYou(question, block), {
      details: {
        'MMR-480': { node: { description: 'Step through **needsYou** one at a time.' } },
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
      expect(within(shown).getByText('needsYou').tagName).toBe('STRONG');
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
    expect(screen.getByRole('link', { name: '← Back to the list' }).getAttribute('href')).toBe(
      '/needs-you',
    );
  });

  it('answers a question in place, and moves to the next decision', async () => {
    serve(needsYou(loomQuestion, block), { after: needsYou(block) });
    await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());

    const shown = await cardFor(loomQuestion);
    fireEvent.click(within(shown).getByRole('button', { name: 'Answer…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /answer/i }), {
      target: { value: 'Call it loom-plugin.' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^groomed/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Answer' }));

    await waitFor(() => {
      expect(groom).toHaveBeenCalledWith({
        data: { ids: ['LM-196'], note: 'Call it loom-plugin.', state: 'groomed' },
      });
    });
    await expect(cardFor(block)).resolves.toBeDefined();
    expect(screen.getByText('2 of 2')).toBeDefined();
  });

  it('links a URL in the hold reason, opening in a new tab, with the text around it', async () => {
    const linked = taskRow('MMR-53', 'blocked', {
      holdReason: 'Waiting on https://example.com/review today',
      title: 'Wait for the review',
    });
    serve(needsYou(linked));
    await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());

    const shown = await cardFor(linked);
    const link = within(shown).getByRole('link', { name: 'https://example.com/review' });
    expect(link.getAttribute('href')).toBe('https://example.com/review');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(shown).toHaveTextContent('Waiting on https://example.com/review today');
  });

  it('lands focus on the next decision’s first action after acting', async () => {
    serve(needsYou(loomQuestion, question), { after: needsYou(question) });
    await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());

    const answer = within(await cardFor(loomQuestion)).getByRole('button', { name: 'Answer…' });
    answer.focus();
    fireEvent.click(answer);
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /answer/i }), {
      target: { value: 'Call it loom-plugin.' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^groomed/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Answer' }));

    const next = await cardFor(question);
    await waitFor(() => {
      expect(within(next).getByRole('button', { name: 'Answer…' })).toHaveFocus();
    });
  });

  it('shows a block on you with what it waits on, a link to its task, and no action', async () => {
    serve(needsYou(block));
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

  it('skips without writing, and returns to the Needs you page with the skipped decision still listed', async () => {
    serve(needsYou(question, block));
    const { router: testRouter } = await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());

    fireEvent.click(within(await cardFor(question)).getByRole('button', { name: 'Skip' }));
    const second = await cardFor(block);
    fireEvent.click(within(second).getByRole('button', { name: 'Skip' }));

    // The page still holds both: a card for each record.
    await screen.findByText('2 cards, 2 items in 1 project.');
    expect(testRouter.state.location.href).toBe('/needs-you');
    expect(groom).not.toHaveBeenCalled();
  });

  it('keeps the list it opened with: a later decision waits, a settled one is passed over', async () => {
    const later = taskRow('MMR-490', 'needs_answers', {
      question: 'Which?',
      title: 'Arrived later',
    });
    const serving = serve(needsYou(loomQuestion, block));
    const client = reviewClient();
    await renderRoute(consoleRoutes, '/?mode=focus', client);
    await cardFor(loomQuestion);

    // The first question is settled elsewhere and a new one arrives.
    serving.poll(needsYou(block, later));
    await client.invalidateQueries({ queryKey: ['review'] });

    const shown = await cardFor(block);
    expect(screen.getByText('2 of 2')).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Up next' })).toBeNull();
    fireEvent.click(within(shown).getByRole('button', { name: 'Skip' }));
    await screen.findByText('2 cards, 2 items in 1 project.');
  });

  it('replaces itself with the Needs you page when nothing needs you', async () => {
    serve(needsYou());
    const { router: testRouter } = await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());

    await screen.findByText('Nothing needs you.');
    expect(testRouter.state.location.href).toBe('/needs-you');
    expect(testRouter.history).toHaveLength(1);
  });

  it('lands focus on the next decision’s first action after Skip', async () => {
    serve(needsYou(question, loomQuestion));
    await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());

    const skip = within(await cardFor(question)).getByRole('button', { name: 'Skip' });
    skip.focus();
    fireEvent.click(skip);

    const next = await cardFor(loomQuestion);
    expect(within(next).getByRole('button', { name: 'Answer…' })).toHaveFocus();
  });

  it('keeps a passed decision behind it when the decision returns', async () => {
    const serving = serve(needsYou(loomQuestion, block, question));
    const client = reviewClient();
    await renderRoute(consoleRoutes, '/?mode=focus', client);
    await cardFor(loomQuestion);

    // The first question is answered elsewhere, then asked again.
    serving.poll(needsYou(block, question));
    await client.invalidateQueries({ queryKey: ['review'] });
    await cardFor(block);
    serving.poll(needsYou(loomQuestion, block, question));
    await client.invalidateQueries({ queryKey: ['review'] });

    await expect(cardFor(block)).resolves.toBeDefined();
    expect(screen.queryByRole('region', { name: loomQuestion.task.title })).toBeNull();
    expect(screen.getByText('2 of 3')).toBeDefined();
  });

  it('fixes its list from a fresh read, not a cached one', async () => {
    serve(needsYou(question));
    const { router: testRouter } = await renderRoute(
      consoleRoutes,
      '/?mode=focus',
      reviewClient(needsYou(loomQuestion)),
    );

    await expect(cardFor(question)).resolves.toBeDefined();
    expect(screen.queryByRole('region', { name: loomQuestion.task.title })).toBeNull();
    expect(testRouter.state.location.href).toBe('/?mode=focus');
  });
});

/** The page, then Work through all, in the whole console so the shell carries out the return's focus. */
async function openFromPage(report: ReviewReport) {
  serve(report);
  const view = await renderShell('/needs-you', reviewClient());
  await userEvent.click(await screen.findByRole('link', { name: /^Work through/u }));
  await screen.findByRole('heading', { level: 1, name: 'Work through these' });
  return view;
}

describe('the focus queue’s return to the Needs you page (ADR 0013, MMR-723 refinement)', () => {
  it('goes back one entry from Back to the list, to Work through all', async () => {
    const { router: testRouter } = await openFromPage(needsYou(question, block));
    await userEvent.click(screen.getByRole('link', { name: '← Back to the list' }));

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Work through all 2' })).toHaveFocus();
    });
    expect(testRouter.state.location.href).toBe('/needs-you');
    // Back, not a new entry: the history holds the page once, and the queue after it.
    expect(testRouter.history).toHaveLength(2);
  });

  it('goes back one entry once nothing is left', async () => {
    const serving = serve(needsYou(question));
    const client = reviewClient();
    const { router: testRouter } = await renderShell('/needs-you', client);
    await userEvent.click(await screen.findByRole('link', { name: /^Work through/u }));
    await cardFor(question);

    serving.poll(needsYou());
    await client.invalidateQueries({ queryKey: ['review'] });

    await screen.findByText('Nothing needs you.');
    expect(testRouter.state.location.href).toBe('/needs-you');
    expect(testRouter.history).toHaveLength(2);
  });

  it('replaces itself with the page from Back to the list when it was not opened from the page', async () => {
    serve(needsYou(question));
    const { router: testRouter } = await renderRoute(consoleRoutes, '/?mode=focus', reviewClient());
    await cardFor(question);
    await userEvent.click(screen.getByRole('link', { name: '← Back to the list' }));

    await screen.findByText('1 card, 1 item in 1 project.');
    expect(testRouter.history).toHaveLength(1);
  });
});
