import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { groom } from '../api/fns/nodes';
import { review } from '../api/fns/views';
import type { NeedsYouTask, ReviewReport } from '../api/view-queries';
import { routeTree } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import { engineReview, needsYouRow, stripRow, triageSeed } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

/**
 * The top-bar alert (ADR 0019, MMR-476 and MMR-492 refinements): the count of
 * decisions waiting on the operator across projects. It opens a popover of
 * them on a desktop and a bottom sheet on a phone.
 */

beforeEach(() => {
  serveBrowse();
  vi.clearAllMocks();
  stubViewport('desktop');
  // As in the review page's tests: the refetch renders before the mutation settles.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Serve the review read from `current()`, so a test can change what the next read returns. */
function serve(current: () => ReviewReport) {
  serveShell();
  serveViews();
  vi.mocked(review).mockImplementation(async () => current());
  // The record pages the alert is opened from.
  serveNodes({
    nodes: [
      engineProject({ distribution: { in_progress: 1, ready: 1 }, id: 'MMR', next: 'Ship it.' }),
      engineTask({ id: 'MMR-480', status: 'ready' }),
    ],
  });
}

function renderAt(path: string, report: ReviewReport) {
  serve(() => report);
  return renderServed(path);
}

function renderServed(path: string) {
  const testRouter = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree,
  });
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return { client, testRouter };
}

const LM = { key: 'LM', name: 'Loom CLI' };
const MMR = { key: 'MMR', name: 'Mimir' };

function decision(
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

const loomQuestion = decision('LM-196', 'needs_answers', {
  question: 'Which name?',
  title: 'Ship the plugin',
});
const block = decision('MMR-52', 'blocked', { holdReason: 'Needs an API token' });
const question = decision('MMR-480', 'needs_answers', { question: 'Skip, or drop it?' });

/** A report with decisions in two project groups: LM's question, then MMR's block and question. */
function twoProjects(
  rows: { lm?: NeedsYouTask[]; mmr?: NeedsYouTask[] } = {
    lm: [loomQuestion],
    mmr: [block, question],
  },
): ReviewReport {
  const decisions = [
    { project: LM, rows: rows.lm ?? [] },
    { project: MMR, rows: rows.mmr ?? [] },
  ].filter((group) => group.rows.length > 0);
  return engineReview({
    decisions,
    projects: [
      stripRow(LM, { decisions: rows.lm?.length ?? 0 }),
      stripRow(MMR, { decisions: rows.mmr?.length ?? 0 }),
    ],
    queue: decisions.flatMap((group) => group.rows.map((row) => row.task.id)),
  });
}

/** A decision's row inside the panel. */
const rowOf = (panel: HTMLElement, id: string): HTMLElement => {
  const row = panel.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
  if (row === null) {
    throw new Error(`no row for ${id}`);
  }
  return row;
};

/** Answer the one decision `scope` holds: open its dialog, fill it in, and submit. */
async function answerFrom(scope: ReturnType<typeof within>) {
  fireEvent.click(scope.getByRole('button', { name: 'Answer…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Answer' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: /answer/i }), {
    target: { value: 'Call it loom.' },
  });
  fireEvent.click(within(dialog).getByRole('radio', { name: /^groomed/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Answer' }));
}

/** Open the alert and return the panel it opens. */
async function openAlert(name: string) {
  await userEvent.click(await screen.findByRole('button', { name }));
  return screen.findByRole('dialog', { name: 'Needs you' });
}

describe('the attention alert trigger', () => {
  it('is a button named for the count of decisions, not a link', async () => {
    renderAt('/p/MMR/tasks', twoProjects());
    const alert = await screen.findByRole('button', { name: '3 decisions need you' });
    expect(alert.textContent).toContain('3');
    expect(screen.queryByRole('link', { name: /need you/ })).toBeNull();
  });

  it('reads in the singular for one decision', async () => {
    renderAt('/p/MMR/tasks', twoProjects({ lm: [loomQuestion] }));
    await expect(
      screen.findByRole('button', { name: '1 decision needs you' }),
    ).resolves.toBeDefined();
  });

  it('is absent when nothing needs a decision, however much waits in triage', async () => {
    renderAt(
      '/',
      engineReview({
        projects: [stripRow(MMR, { triage: 15 })],
        triage: [
          { findings: 12, goingCold: 2, project: MMR, seeds: [triageSeed({ id: 'MMR-s1' })] },
        ],
      }),
    );
    // The page's own heading proves the review read has landed.
    await screen.findByRole('heading', { level: 1, name: 'Nothing needs you' });
    expect(screen.queryByRole('button', { name: /needs? you/ })).toBeNull();
  });
});

describe('the Needs you popover', () => {
  it('opens on the trigger with the review’s groups in order, moves focus in, and closes on Escape back to the trigger', async () => {
    renderAt('/p/MMR/tasks', twoProjects());
    expect(screen.queryByRole('dialog')).toBeNull();

    const panel = await openAlert('3 decisions need you');
    const trigger = screen.getByRole('button', { name: '3 decisions need you' });
    expect(panel.contains(document.activeElement)).toBe(true);
    // The alert hands DecisionGroups the review read's groups as they are, in the review order.
    const groups = within(panel).getAllByRole('region');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Loom CLI', 'Mimir']);
    // A desktop popover has no close control and is not a page footer.
    expect(within(panel).queryByRole('button', { name: 'Close' })).toBeNull();
    expect(within(panel).queryByRole('contentinfo')).toBeNull();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(trigger).toHaveFocus();
  });

  it('marks the decision whose record is the current page', async () => {
    renderAt('/p/MMR/480', twoProjects());
    const panel = await openAlert('3 decisions need you');

    expect(within(panel).getAllByText('This page')).toHaveLength(1);
    expect(within(rowOf(panel, 'MMR-480')).getByText('This page')).toBeDefined();
  });

  it('marks nothing on a page that is not a decision’s record', async () => {
    renderAt('/p/MMR/s480', twoProjects());
    const panel = await openAlert('3 decisions need you');

    expect(within(panel).queryByText('This page')).toBeNull();
  });

  it('links to the review page and the focus queue', async () => {
    renderAt('/p/MMR/tasks', twoProjects());
    const panel = await openAlert('3 decisions need you');

    expect(within(panel).getByRole('link', { name: 'Open review page' }).getAttribute('href')).toBe(
      '/',
    );
    expect(
      within(panel).getByRole('link', { name: 'Work through these · 3' }).getAttribute('href'),
    ).toBe('/?mode=focus');
  });

  it('closes on navigation', async () => {
    const { testRouter } = renderAt('/p/MMR/tasks', twoProjects());
    const panel = await openAlert('3 decisions need you');

    await userEvent.click(within(panel).getByRole('link', { name: 'Work through these · 3' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Needs you' })).toBeNull();
    });
    expect(testRouter.state.location.search).toEqual({ mode: 'focus' });
  });

  it('closes on a link to the page already showing', async () => {
    renderAt('/p/MMR/480', twoProjects());
    const panel = await openAlert('3 decisions need you');

    await userEvent.click(within(panel).getByRole('link', { name: question.task.title }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Needs you' })).toBeNull();
    });
  });

  it('returns focus to Answer… when its dialog is cancelled or escaped', async () => {
    renderAt('/p/MMR/tasks', twoProjects({ lm: [loomQuestion] }));
    const panel = await openAlert('1 decision needs you');
    const answerButton = within(panel).getByRole('button', { name: 'Answer…' });

    await userEvent.click(answerButton);
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Answer' })).toBeNull();
    });
    expect(answerButton).toHaveFocus();

    await userEvent.click(answerButton);
    await screen.findByRole('dialog', { name: 'Answer' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Answer' })).toBeNull();
    });
    expect(answerButton).toHaveFocus();
    // Escape closed only the dialog; the popover is still there.
    expect(screen.getByRole('dialog', { name: 'Needs you' })).toBeDefined();
  });

  it('stays open while a row is acted on, and the row leaves when the write lands', async () => {
    let report = twoProjects();
    serve(() => report);
    vi.mocked(groom).mockImplementation(async () => {
      report = twoProjects({ mmr: [block, question] });
      return [engineTask({ id: 'LM-196', status: 'ready' })];
    });
    renderServed('/p/MMR/tasks');
    const panel = await openAlert('3 decisions need you');

    await answerFrom(within(rowOf(panel, 'LM-196')));

    await waitFor(() => {
      expect(groom).toHaveBeenCalledWith({
        data: { ids: ['LM-196'], note: 'Call it loom.', state: 'groomed' },
      });
    });
    await waitFor(() => {
      expect(within(panel).queryByRole('link', { name: 'Ship the plugin' })).toBeNull();
    });
    expect(screen.getByRole('dialog', { name: 'Needs you' })).toBe(panel);
    expect(within(panel).getByRole('link', { name: 'Open review page' })).toBeDefined();
    await expect(
      screen.findByRole('button', { name: '2 decisions need you' }),
    ).resolves.toBeDefined();
  });

  it('stays to say so, with focus on its heading, when the last decision leaves', async () => {
    let report = twoProjects({ lm: [loomQuestion] });
    serve(() => report);
    vi.mocked(groom).mockImplementation(async () => {
      report = twoProjects({});
      return [engineTask({ id: 'LM-196', status: 'ready' })];
    });
    renderServed('/p/MMR/tasks');
    const panel = await openAlert('1 decision needs you');
    within(panel).getByRole('button', { name: 'Answer…' }).focus();
    await answerFrom(within(panel));

    await waitFor(() => {
      expect(within(panel).queryByRole('link', { name: 'Ship the plugin' })).toBeNull();
    });
    expect(within(panel).getByText('Nothing needs you.')).toBeDefined();
    expect(within(panel).getByRole('heading', { name: /Needs you/ })).toHaveFocus();
    expect(within(panel).queryByRole('link', { name: /Work through these/ })).toBeNull();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /needs? you|need you/ })).toBeNull();
    });
  });
});

describe('the Needs you sheet on a phone', () => {
  it('opens the same list as a bottom sheet, and Escape returns focus to the trigger', async () => {
    stubViewport('phone');
    renderAt('/p/MMR/tasks', twoProjects());
    const trigger = await screen.findByRole('button', { name: '3 decisions need you' });
    const panel = await openAlert('3 decisions need you');

    // The sheet's own close control is what tells it from the popover.
    expect(within(panel).getByRole('button', { name: 'Close' })).toBeDefined();
    expect(within(panel).getAllByRole('button', { name: 'Answer…' })).toHaveLength(2);
    expect(
      within(panel).getByRole('link', { name: 'Work through these · 3' }).getAttribute('href'),
    ).toBe('/?mode=focus');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(trigger).toHaveFocus();
  });
});
