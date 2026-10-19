import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { review } from '../api/fns/views';
import type { NeedsYouTask, ReviewReport } from '../api/view-queries';
import { routeTree } from '../router';
import { serveBrowse } from './browse-fns';
import { project, seed, task } from './fixtures';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import { engineReview, needsYouRow, stripRow, triageSeed } from './views-fixtures';
import { serveViews } from './views-fns';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
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
  apiGet.mockReset();
  apiSend.mockReset();
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
  apiGet.mockImplementation((p: string) => {
    // The record pages the alert is opened from.
    if (p === '/api/nodes/MMR-480') {
      return Promise.resolve(task({ id: 'MMR-480', status: 'ready' }));
    }
    if (p === '/api/seeds/MMR-s480') {
      return Promise.resolve(seed({ id: 'MMR-s480', lane: 'untriaged' }));
    }
    if (p === '/api/projects/MMR') {
      return Promise.resolve({
        ...project({ id: 'MMR' }),
        distribution: { in_progress: 1, ready: 1 },
        next: 'Ship it.',
      });
    }
    return Promise.resolve({ items: [], total: 0 });
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
  const status = { blocked: 'blocked', needs_answers: 'ready', under_review: 'under_review' }[
    reason
  ] as NeedsYouTask['task']['status'];
  const { question = null, ...node } = extra;
  return needsYouRow({ id, status, ...node }, reason, { question });
}

const verdict = decision('LM-196', 'under_review', { title: 'Ship the plugin' });
const block = decision('MMR-52', 'blocked', { holdReason: 'Needs an API token' });
const question = decision('MMR-480', 'needs_answers', { question: 'Skip, or drop it?' });

/** A report with decisions in two project groups: LM's verdict, then MMR's block and question. */
function twoProjects(
  rows: { lm?: NeedsYouTask[]; mmr?: NeedsYouTask[] } = {
    lm: [verdict],
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
    renderAt('/p/MMR/tasks', twoProjects({ lm: [verdict] }));
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
  it('opens on the trigger, moves focus in, and closes on Escape back to the trigger', async () => {
    renderAt('/p/MMR/tasks', twoProjects());
    expect(screen.queryByRole('dialog')).toBeNull();

    const panel = await openAlert('3 decisions need you');
    const trigger = screen.getByRole('button', { name: '3 decisions need you' });
    expect(panel.contains(document.activeElement)).toBe(true);

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(trigger).toHaveFocus();
  });

  it('lists the decisions grouped by project, in the review order, with their verbs', async () => {
    renderAt('/p/MMR/tasks', twoProjects());
    const panel = await openAlert('3 decisions need you');

    const groups = within(panel).getAllByRole('region');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Loom CLI', 'Mimir']);
    expect(within(groups[0]!).getByRole('link', { name: 'Ship the plugin' })).toBeDefined();
    expect(within(groups[0]!).getByRole('button', { name: 'Approve' })).toBeDefined();
    expect(within(groups[0]!).getByRole('button', { name: 'Send back…' })).toBeDefined();
    expect(within(groups[1]!).getByText('Needs an API token')).toBeDefined();
    expect(within(groups[1]!).getByRole('button', { name: 'Answer…' })).toBeDefined();
    expect(within(groups[1]!).getByRole('link', { name: /Mimir/ }).getAttribute('href')).toBe(
      '/p/MMR',
    );
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

  it('closes on a row’s link too', async () => {
    const { testRouter } = renderAt('/p/MMR/tasks', twoProjects());
    const panel = await openAlert('3 decisions need you');

    await userEvent.click(within(panel).getByRole('link', { name: 'Ship the plugin' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Needs you' })).toBeNull();
    });
    expect(testRouter.state.location.pathname).toBe('/p/LM/196');
  });

  it('closes on a link to the page already showing', async () => {
    renderAt('/p/MMR/480', twoProjects());
    const panel = await openAlert('3 decisions need you');

    await userEvent.click(within(panel).getByRole('link', { name: question.task.title }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Needs you' })).toBeNull();
    });
  });

  it('closes on the current project’s heading link', async () => {
    const { testRouter } = renderAt('/p/MMR', twoProjects());
    const panel = await openAlert('3 decisions need you');

    await userEvent.click(within(panel).getByRole('link', { name: /Mimir/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Needs you' })).toBeNull();
    });
    expect(testRouter.state.location.pathname).toBe('/p/MMR');
  });

  it('is not announced as a page footer', async () => {
    renderAt('/p/MMR/tasks', twoProjects());
    const panel = await openAlert('3 decisions need you');

    expect(within(panel).queryByRole('contentinfo')).toBeNull();
  });

  it('returns focus to Send back… when its dialog is cancelled or escaped', async () => {
    renderAt('/p/MMR/tasks', twoProjects({ lm: [verdict] }));
    const panel = await openAlert('1 decision needs you');
    const sendBack = within(panel).getByRole('button', { name: 'Send back…' });

    await userEvent.click(sendBack);
    const dialog = await screen.findByRole('dialog', { name: 'Send back' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Send back' })).toBeNull();
    });
    expect(sendBack).toHaveFocus();

    await userEvent.click(sendBack);
    await screen.findByRole('dialog', { name: 'Send back' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Send back' })).toBeNull();
    });
    expect(sendBack).toHaveFocus();
    // Escape closed only the dialog; the popover is still there.
    expect(screen.getByRole('dialog', { name: 'Needs you' })).toBeDefined();
  });

  it('closes, with a row’s open dialog, when the viewport crosses the breakpoint', async () => {
    const setViewport = stubViewport('desktop');
    renderAt('/p/MMR/tasks', twoProjects({ lm: [verdict] }));
    const panel = await openAlert('1 decision needs you');
    await userEvent.click(within(panel).getByRole('button', { name: 'Send back…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back' });
    await userEvent.type(within(dialog).getByRole('textbox'), 'Cover errors');

    setViewport('phone');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // The alert itself stays, closed, and opens afresh as the sheet.
    const sheet = await openAlert('1 decision needs you');
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeDefined();
    expect(screen.queryByRole('dialog', { name: 'Send back' })).toBeNull();
  });

  it('stays open while a row is acted on, and the row leaves when the write lands', async () => {
    let report = twoProjects();
    serve(() => report);
    apiSend.mockImplementation(() => {
      report = twoProjects({ mmr: [block, question] });
      return Promise.resolve({});
    });
    renderServed('/p/MMR/tasks');
    const panel = await openAlert('3 decisions need you');

    fireEvent.click(within(panel).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/LM-196/done', undefined);
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

  it('keeps the popover open behind a row’s own dialog', async () => {
    renderAt('/p/MMR/tasks', twoProjects({ lm: [verdict] }));
    const panel = await openAlert('1 decision needs you');

    await userEvent.click(within(panel).getByRole('button', { name: 'Send back…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back' });
    await userEvent.click(within(dialog).getByRole('textbox'));

    // The row's own dialog is modal, so the popover behind it is hidden from the tree, not gone.
    expect(screen.getByRole('dialog', { hidden: true, name: 'Needs you' })).toBeDefined();
  });

  it('stays to say so, with focus on its heading, when the last decision leaves', async () => {
    let report = twoProjects({ lm: [verdict] });
    serve(() => report);
    apiSend.mockImplementation(() => {
      report = twoProjects({});
      return Promise.resolve({});
    });
    renderServed('/p/MMR/tasks');
    const panel = await openAlert('1 decision needs you');
    const approve = within(panel).getByRole('button', { name: 'Approve' });
    approve.focus();
    fireEvent.click(approve);

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
    expect(within(panel).getByRole('button', { name: 'Approve' })).toBeDefined();
    expect(
      within(panel).getByRole('link', { name: 'Work through these · 3' }).getAttribute('href'),
    ).toBe('/?mode=focus');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(trigger).toHaveFocus();
  });

  it('returns focus to Send back… when its dialog is escaped', async () => {
    stubViewport('phone');
    renderAt('/p/MMR/tasks', twoProjects({ lm: [verdict] }));
    const panel = await openAlert('1 decision needs you');
    const sendBack = within(panel).getByRole('button', { name: 'Send back…' });

    await userEvent.click(sendBack);
    await screen.findByRole('dialog', { name: 'Send back' });
    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Send back' })).toBeNull();
    });
    expect(sendBack).toHaveFocus();
  });

  it('shows the desktop popover without a close control', async () => {
    renderAt('/p/MMR/tasks', twoProjects());
    const panel = await openAlert('3 decisions need you');

    expect(within(panel).queryByRole('button', { name: 'Close' })).toBeNull();
  });
});
