import { QueryClient, dehydrate, hydrate } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { groom } from '../api/fns/nodes';
import { review } from '../api/fns/views';
import { reviewQuery } from '../api/view-queries';
import type { NeedsYouTask, ReviewReport } from '../api/view-queries';
import { readMark } from '../lib/walkthrough-mark';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { renderShell } from './router';
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
 * needs-you members waiting on the operator across projects. It opens a popover of
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

async function renderAt(path: string, report: ReviewReport) {
  serve(() => report);
  return renderServed(path);
}

async function renderServed(path: string) {
  const { client, router: testRouter } = await renderShell(path);
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

/** A report with needs-you rows in two project groups: LM's question, then MMR's block and question. */
function twoProjects(
  rows: { lm?: NeedsYouTask[]; mmr?: NeedsYouTask[] } = {
    lm: [loomQuestion],
    mmr: [block, question],
  },
): ReviewReport {
  const needsYou = [
    { project: LM, rows: rows.lm ?? [] },
    { project: MMR, rows: rows.mmr ?? [] },
  ].filter((group) => group.rows.length > 0);
  return engineReview({
    needsYou,
    projects: [
      stripRow(LM, { needsYou: rows.lm?.length ?? 0 }),
      stripRow(MMR, { needsYou: rows.mmr?.length ?? 0 }),
    ],
    queue: needsYou.flatMap((group) =>
      group.rows.map((row) => ({ id: row.task.id, kind: row.kind })),
    ),
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
  it('is a button named for the count of needsYou, not a link', async () => {
    await renderAt('/p/MMR/tasks', twoProjects());
    const alert = await screen.findByRole('button', { name: '3 need you' });
    expect(alert.textContent).toContain('3');
    expect(screen.queryByRole('link', { name: /need you/ })).toBeNull();
  });

  it('reads in the singular for one decision', async () => {
    await renderAt('/p/MMR/tasks', twoProjects({ lm: [loomQuestion] }));
    await expect(screen.findByRole('button', { name: '1 needs you' })).resolves.toBeDefined();
  });

  it('is absent when nothing needs a decision, however much waits in triage', async () => {
    await renderAt(
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
    await renderAt('/p/MMR/tasks', twoProjects());
    expect(screen.queryByRole('dialog')).toBeNull();

    const panel = await openAlert('3 need you');
    const trigger = screen.getByRole('button', { name: '3 need you' });
    expect(panel.contains(document.activeElement)).toBe(true);
    // The alert hands NeedsYouGroups the review read's groups as they are, in the review order.
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
    await renderAt('/p/MMR/480', twoProjects());
    const panel = await openAlert('3 need you');

    expect(within(panel).getAllByText('This page')).toHaveLength(1);
    expect(within(rowOf(panel, 'MMR-480')).getByText('This page')).toBeDefined();
  });

  it('marks nothing on a page that is not a decision’s record', async () => {
    await renderAt('/p/MMR/s480', twoProjects());
    const panel = await openAlert('3 need you');

    expect(within(panel).queryByText('This page')).toBeNull();
  });

  it('links to the review page and the focus queue', async () => {
    await renderAt('/p/MMR/tasks', twoProjects());
    const panel = await openAlert('3 need you');

    expect(within(panel).getByRole('link', { name: 'Open review page' }).getAttribute('href')).toBe(
      '/',
    );
    expect(
      within(panel).getByRole('link', { name: 'Work through these · 3' }).getAttribute('href'),
    ).toBe('/?mode=focus');
  });

  it('closes on navigation', async () => {
    const { testRouter } = await renderAt('/p/MMR/tasks', twoProjects());
    const panel = await openAlert('3 need you');

    await userEvent.click(within(panel).getByRole('link', { name: 'Work through these · 3' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Needs you' })).toBeNull();
    });
    expect(testRouter.state.location.search).toEqual({ mode: 'focus' });
  });

  it('closes when a decisions entry opens the walkthrough, marked with the page it was on', async () => {
    const stamp = new Date('2026-11-16T12:00:00Z');
    const rows: ReviewReport['needsYou'][number]['rows'] = [
      {
        decision: {
          class: 'product',
          created_at: stamp,
          delivery: 'MMR-d3',
          id: 'MMR-q1',
          lifecycle: 'provisional',
          option_details: [null, null],
          options: ['Keep', 'Remove'],
          outcome_note: null,
          overturn_option: null,
          project_key: 'MMR',
          question: 'Keep it?',
          recommended: 1,
          seq: 1,
          taken: 1,
          tasks: [],
          updated_at: stamp,
          why: null,
        },
        kind: 'decision' as const,
        workBuiltOnIt: false,
      },
    ];
    const { testRouter } = await renderAt(
      '/p/MMR/tasks',
      engineReview({
        needsYou: [{ project: MMR, rows }],
        projects: [stripRow(MMR, { needsYou: 1 })],
        queue: [{ id: 'MMR-q1', kind: 'decision' }],
      }),
    );
    const panel = await openAlert('1 needs you');

    await userEvent.click(within(panel).getByRole('link', { name: 'Review 1 decision on MMR-d3' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Needs you' })).toBeNull();
    });
    expect(testRouter.state.location.search).toEqual({ mode: 'decisions' });
    expect(readMark(testRouter.state.location.state)).toStrictEqual({
      entry: 'needs-you',
      opener: '/p/MMR/tasks',
    });
  });

  it('closes on a link to the page already showing', async () => {
    await renderAt('/p/MMR/480', twoProjects());
    const panel = await openAlert('3 need you');

    await userEvent.click(within(panel).getByRole('link', { name: question.task.title }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Needs you' })).toBeNull();
    });
  });

  it('returns focus to Answer… when its dialog is cancelled or escaped', async () => {
    await renderAt('/p/MMR/tasks', twoProjects({ lm: [loomQuestion] }));
    const panel = await openAlert('1 needs you');
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

  it('closes when the viewport crosses the breakpoint, and opens afresh as the sheet', async () => {
    const setViewport = stubViewport('desktop');
    await renderAt('/p/MMR/tasks', twoProjects({ lm: [loomQuestion] }));
    await openAlert('1 needs you');

    setViewport('phone');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Needs you' })).toBeNull();
    });
    const sheet = await openAlert('1 needs you');
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeDefined();
  });

  it('stays open while a row is acted on, and the row leaves when the write lands', async () => {
    let report = twoProjects();
    serve(() => report);
    vi.mocked(groom).mockImplementation(async () => {
      report = twoProjects({ mmr: [block, question] });
      return [engineTask({ id: 'LM-196', status: 'ready' })];
    });
    await renderServed('/p/MMR/tasks');
    const panel = await openAlert('3 need you');

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
    await expect(screen.findByRole('button', { name: '2 need you' })).resolves.toBeDefined();
  });

  it('hands focus to a decision row itself when the task row above it leaves', async () => {
    const record = {
      decision: {
        class: 'product' as const,
        created_at: new Date('2026-11-16T12:00:00Z'),
        delivery: null,
        id: 'MMR-q1',
        lifecycle: 'provisional' as const,
        option_details: [null, null],
        options: ['Keep', 'Remove'],
        outcome_note: null,
        overturn_option: null,
        project_key: 'MMR',
        question: 'Keep the rail?',
        recommended: 1,
        seq: 1,
        taken: 1,
        tasks: ['MMR-5'],
        updated_at: new Date('2026-11-16T12:00:00Z'),
        why: null,
      },
      kind: 'decision' as const,
      workBuiltOnIt: true,
    };
    const withRecord = (lm: NeedsYouTask[]): ReviewReport =>
      engineReview({
        needsYou: [
          ...(lm.length > 0 ? [{ project: LM, rows: lm }] : []),
          { project: MMR, rows: [record] },
        ],
        projects: [stripRow(LM, { needsYou: lm.length }), stripRow(MMR, { needsYou: 1 })],
        queue: [
          ...lm.map((row) => ({ id: row.task.id, kind: row.kind })),
          { id: 'MMR-q1', kind: 'decision' as const },
        ],
      });
    let report = withRecord([loomQuestion]);
    serve(() => report);
    vi.mocked(groom).mockImplementation(async () => {
      report = withRecord([]);
      return [engineTask({ id: 'LM-196', status: 'ready' })];
    });
    await renderServed('/p/MMR/tasks');
    const panel = await openAlert('2 need you');
    within(panel).getByRole('button', { name: 'Answer…' }).focus();
    await answerFrom(within(panel));

    await waitFor(() => {
      expect(within(panel).queryByRole('link', { name: 'Ship the plugin' })).toBeNull();
    });
    expect(rowOf(panel, 'MMR-q1')).toHaveFocus();
    expect(within(rowOf(panel, 'MMR-q1')).getByRole('link', { name: 'MMR-5' })).not.toHaveFocus();
  });

  it('stays to say so, with focus on its heading, when the last decision leaves', async () => {
    let report = twoProjects({ lm: [loomQuestion] });
    serve(() => report);
    vi.mocked(groom).mockImplementation(async () => {
      report = twoProjects({});
      return [engineTask({ id: 'LM-196', status: 'ready' })];
    });
    await renderServed('/p/MMR/tasks');
    const panel = await openAlert('1 needs you');
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
    await renderAt('/p/MMR/tasks', twoProjects());
    const trigger = await screen.findByRole('button', { name: '3 need you' });
    const panel = await openAlert('3 need you');

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

describe('the app icon badge (MMR-710)', () => {
  const setAppBadge = vi.fn(async () => {});
  const clearAppBadge = vi.fn(async () => {});

  beforeEach(() => {
    // jsdom has no Badging API; give its navigator one for the test.
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge });
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearAppBadge });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'setAppBadge');
    Reflect.deleteProperty(navigator, 'clearAppBadge');
  });

  it('sets the badge to the needs-you count after the read lands', async () => {
    await renderAt('/p/MMR/tasks', twoProjects());
    await waitFor(() => {
      expect(setAppBadge).toHaveBeenCalledWith(3);
    });
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it('clears the badge when nothing needs you', async () => {
    await renderAt('/p/MMR/tasks', twoProjects({}));
    await waitFor(() => {
      expect(clearAppBadge).toHaveBeenCalledOnce();
    });
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it('leaves the badge alone on a cached report until this session’s read lands', async () => {
    serve(() => twoProjects());
    // A review read the test answers when it chooses.
    const read = Promise.withResolvers<ReviewReport>();
    vi.mocked(review).mockImplementation(async () => read.promise);
    const client = new QueryClient();
    // A persisted report from an earlier session, which a push may since have outdated.
    client.setQueryData(reviewQuery().queryKey, twoProjects({ lm: [loomQuestion] }), {
      updatedAt: Date.now() - 86_400_000,
    });
    await renderShell('/p/MMR/tasks', client);
    await screen.findByRole('button', { name: '1 needs you' });
    await waitFor(() => {
      expect(review).toHaveBeenCalled();
    });
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();

    read.resolve(twoProjects());
    await waitFor(() => {
      expect(setAppBadge).toHaveBeenCalledWith(3);
    });
    expect(setAppBadge).toHaveBeenCalledOnce();
  });

  it('leaves the badge alone when the persisted cache is restored after mount', async () => {
    serve(() => twoProjects());
    const read = Promise.withResolvers<ReviewReport>();
    vi.mocked(review).mockImplementation(async () => read.promise);
    const client = new QueryClient();
    await renderShell('/p/MMR/tasks', client);
    await waitFor(() => {
      expect(review).toHaveBeenCalled();
    });
    // The persister restores after the shell mounts, through hydrate: an
    // earlier session's report, read a day ago.
    const earlier = new QueryClient();
    earlier.setQueryData(reviewQuery().queryKey, twoProjects({ lm: [loomQuestion] }), {
      updatedAt: Date.now() - 86_400_000,
    });
    hydrate(client, dehydrate(earlier));
    await screen.findByRole('button', { name: '1 needs you' });
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();

    read.resolve(twoProjects());
    await waitFor(() => {
      expect(setAppBadge).toHaveBeenCalledWith(3);
    });
    expect(setAppBadge).toHaveBeenCalledOnce();
  });

  it('leaves the badge alone on a cached report whose refetch fails', async () => {
    serve(() => twoProjects());
    vi.mocked(review).mockImplementation(async () => {
      throw new Error('host unreachable');
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(reviewQuery().queryKey, twoProjects({ lm: [loomQuestion] }), {
      updatedAt: Date.now() - 86_400_000,
    });
    await renderShell('/p/MMR/tasks', client);
    await screen.findByRole('button', { name: '1 needs you' });
    await waitFor(() => {
      expect(client.getQueryState(reviewQuery().queryKey)?.fetchStatus).toBe('idle');
    });
    expect(review).toHaveBeenCalled();
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it('sets the badge again on a later read of the same count', async () => {
    const { client } = await renderAt('/p/MMR/tasks', twoProjects());
    await waitFor(() => {
      expect(setAppBadge).toHaveBeenCalledOnce();
    });
    // A push raised the icon meanwhile; the next read puts it back to the console's count.
    await client.invalidateQueries({ queryKey: reviewQuery().queryKey });
    await waitFor(() => {
      expect(setAppBadge).toHaveBeenCalledTimes(2);
    });
    expect(setAppBadge).toHaveBeenLastCalledWith(3);
  });
});
