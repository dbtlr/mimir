import { QueryClient, dehydrate, hydrate } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { review } from '../api/fns/views';
import { reviewQuery } from '../api/view-queries';
import type { NeedsYouTask, ReviewReport } from '../api/view-queries';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { renderShell } from './router';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import { engineReview, needsYouRow, stripRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

/**
 * The top-bar alert (ADR 0019, MMR-476 refinement; ADR 0013, MMR-723
 * refinement): the count of needs-you members waiting on the operator across
 * projects, as a link to the Needs you page at every width.
 */

beforeEach(() => {
  serveBrowse();
  vi.clearAllMocks();
  stubViewport('desktop');
  // As on Home: the refetch renders before the mutation settles.
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

describe('the attention alert', () => {
  it.each(['desktop', 'phone'] as const)(
    'is a link to the Needs you page named for the count, on a %s',
    async (viewport) => {
      stubViewport(viewport);
      await renderAt('/p/MMR/tasks', twoProjects());
      const alert = await screen.findByRole('link', { name: '3 need you' });
      expect(alert).toHaveAttribute('href', '/needs-you');
      expect(alert.textContent).toContain('3');
      expect(alert).not.toHaveAttribute('aria-current');
      expect(screen.queryByRole('button', { name: /need you/u })).toBeNull();
    },
  );

  it('reads in the singular for one decision', async () => {
    await renderAt('/p/MMR/tasks', twoProjects({ lm: [loomQuestion] }));
    await expect(screen.findByRole('link', { name: '1 needs you' })).resolves.toBeDefined();
  });

  it('is absent when nothing needs a decision, however much waits in triage', async () => {
    await renderAt(
      '/',
      engineReview({
        projects: [stripRow(MMR, { findings: 12, goingCold: 2, untriaged: 1 })],
      }),
    );
    // Home's quiet line proves the review read has landed.
    await screen.findByText('Nothing needs you.');
    expect(screen.queryByRole('link', { name: /needs? you/u })).toBeNull();
  });

  it('opens the Needs you page', async () => {
    const { testRouter } = await renderAt('/p/MMR/tasks', twoProjects());
    await userEvent.click(await screen.findByRole('link', { name: '3 need you' }));
    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/needs-you');
    });
  });

  it('is the current page on the Needs you page, where activating it keeps the open preview', async () => {
    const { testRouter } = await renderAt('/needs-you', twoProjects());
    const alert = await screen.findByRole('link', { name: '3 need you' });
    expect(alert).toHaveAttribute('aria-current', 'page');
    await userEvent.click(await screen.findByRole('button', { name: 'Ship the plugin' }));
    await screen.findByRole('dialog', { name: 'Ship the plugin' });

    await userEvent.click(alert);
    expect(testRouter.state.location.href).toBe('/needs-you');
    expect(screen.getByRole('dialog', { name: 'Ship the plugin' })).toBeVisible();
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
    await screen.findByRole('link', { name: '1 needs you' });
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
    await screen.findByRole('link', { name: '1 needs you' });
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
    await screen.findByRole('link', { name: '1 needs you' });
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
